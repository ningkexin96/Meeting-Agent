// 向量存储与混合召回 —— 对应 issue #25
//
// 召回策略：关键词（精确、可解释）+ 向量（语义、模糊）两路各取候选，
// 用 RRF（Reciprocal Rank Fusion）融合排序——不依赖两路分数量纲，
// 这是业界最稳的做法之一，也能在二面讲清楚「为什么不用简单加权求和」。
import { prisma } from "@/lib/db/client";
import { getEmbeddingProvider } from "./embedding";
import { extractWeightedKeywords } from "@/lib/tools/keywords";

export type IndexObjectType = "turn" | "summary" | "memory" | "decision";

export type IndexInput = {
  tenantId: string;
  objectType: IndexObjectType;
  objectId: string;
  meetingId?: string | null;
  content: string;
};

export type RecallHit = {
  objectType: IndexObjectType;
  objectId: string;
  meetingId: string | null;
  content: string;
  /** 融合后的分数（越高越相关） */
  score: number;
  /** 命中来源，便于调试与解释 */
  via: ("keyword" | "vector")[];
  keywordScore?: number;
  vectorScore?: number;
};

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 批量建索引（幂等：同一对象重复索引会覆盖） */
export async function indexObjects(items: IndexInput[]): Promise<number> {
  if (items.length === 0) return 0;
  const provider = getEmbeddingProvider();
  const vectors = await provider.embed(items.map((i) => i.content));

  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const v = vectors[i];
    await prisma.embedding.upsert({
      where: {
        tenantId_objectType_objectId: {
          tenantId: it.tenantId,
          objectType: it.objectType,
          objectId: it.objectId,
        },
      },
      create: {
        tenantId: it.tenantId,
        objectType: it.objectType,
        objectId: it.objectId,
        meetingId: it.meetingId ?? null,
        content: it.content,
        embedding: JSON.stringify(v),
        dim: v.length,
      },
      update: {
        content: it.content,
        embedding: JSON.stringify(v),
        dim: v.length,
        meetingId: it.meetingId ?? null,
      },
    });
    count++;
  }
  return count;
}

/**
 * 关键词召回：按「命中多少个不同的查询词」打分，而不是按比例。
 *
 * 为什么不用比例：查询「上线时间是什么时候」切出 6 个 bigram，
 * 正文只要擦到「时间」一个词就能得 1/6 ≈ 0.17，在长文档里几乎必然发生。
 * 改成绝对命中数后，只擦到一个词的内容分数恒为 1，跨查询可比，门槛才有意义。
 */
/**
 * 关键词召回：按「命中的词权重之和」打分。
 *
 * 为什么不用命中个数或比例：
 *   「量子计算什么时候上线」会命中「先上线录音上传」里的「上线」——
 *   字面重合但语义无关。给通用词低权重后，这种擦边匹配得分很低，
 *   配合后续的强关键词阈值就能被正确过滤掉。
 */
function keywordRecall(
  query: string,
  rows: { objectType: string; objectId: string; content: string }[],
): { objectId: string; score: number; hits: number; weighted: number }[] {
  const kws = extractWeightedKeywords(query);
  if (kws.length === 0) return [];

  const totalWeight = kws.reduce((s, k) => s + k.weight, 0) || 1;

  return rows
    .map((r) => {
      const matched = kws.filter((k) => r.content.includes(k.term));
      const weighted = matched.reduce((s, k) => s + k.weight, 0);
      return {
        objectId: r.objectId,
        hits: matched.length,
        weighted,
        score: weighted / totalWeight,
      };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.weighted - a.weighted || b.hits - a.hits);
}

/** 向量召回：从库里取全部向量后算余弦（十几人规模足够） */
async function vectorRecall(
  query: string,
  tenantId: string,
  objectTypes?: IndexObjectType[],
): Promise<{ objectId: string; score: number }[]> {
  const provider = getEmbeddingProvider();
  const [qvec] = await provider.embed([query]);

  const rows = await prisma.embedding.findMany({
    where: {
      tenantId,
      ...(objectTypes?.length ? { objectType: { in: objectTypes } } : {}),
    },
  });

  return rows
    .map((r) => {
      const vec = JSON.parse(r.embedding) as number[];
      return { objectId: r.objectId, score: cosine(qvec, vec) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * 混合召回：RRF 融合。
 * score = Σ 1/(k + rank)，k 默认 60（RRF 论文经验值）。
 *
 * 关键：向量检索永远会返回「最近的」，哪怕完全不相关。
 * 所以对纯向量命中的结果加一道相似度门槛，避免把无关内容当成依据（幻觉源头）。
 */
export async function hybridRecall(
  tenantId: string,
  query: string,
  opts: { limit?: number; objectTypes?: IndexObjectType[]; rrfK?: number } = {},
): Promise<RecallHit[]> {
  const limit = opts.limit ?? 5;
  const rrfK = opts.rrfK ?? 60;
  // 注意：不要用单一「绝对相似度阈值」过滤向量结果。
  // 实测 bigram 哈希向量的余弦在同一量级内无法区分相关与无关（见下方 keywordHit 分支），
  // 因此这里按「关键词是否命中」分两种策略处理。

  const rows = await prisma.embedding.findMany({
    where: {
      tenantId,
      ...(opts.objectTypes?.length ? { objectType: { in: opts.objectTypes } } : {}),
    },
  });
  if (rows.length === 0) return [];

  const byId = new Map(rows.map((r) => [r.objectId, r]));

  const kw = keywordRecall(query, rows);
  const rawVec = await vectorRecall(query, tenantId, opts.objectTypes);

  // 向量结果的取舍规则（基于实测，而非拍脑袋）：
  // bigram 哈希向量的余弦无法区分相关/无关——实测「今天天气怎么样」得 0.178，
  // 而正确命中的「存储怎么处理」才 0.200。
  //
  // 所以分两种情况：
  //   A. 关键词有「多词命中」（≥ 2 个不同词）→ 向量只作补充，用相对阈值放宽召回
  //   B. 关键词弱（只擦到 1 个词）或没命中 → 向量必须自己够强，否则不召回
  //      「把无关内容当依据」正是幻觉的来源，宁可少召回。
  // 强关键词判定改用「权重之和 ≥ 1.0」：
// 单靠一个通用词（上线/功能/时间，权重 0.2）或一个领域词（转写，0.5）
// 都不足以成立，至少要两个有效词或一个完整实词。
  // 语义闸门：向量分再高，如果查询里的「实词」（权重 1.0 的词）
// 一个都没在正文出现，说明只是局部字面重合（如「量子计算…上线」vs「先上线录音」），
// 这种命中必须丢掉——把无关内容当依据正是幻觉的来源。
  function passesSemanticGate(queryTerms: { term: string; weight: number }[], content: string): boolean {
    const contentWords = queryTerms.filter((k) => k.weight >= 1.0);
    if (contentWords.length === 0) return true; // 查询本身没有实词，无从判断
    return contentWords.some((k) => content.includes(k.term));
  }

  const queryTerms = extractWeightedKeywords(query);

  const strongKeyword = kw.some((k) => k.weighted >= 1.0);
  const relativeMargin = Number(process.env.RAG_RELATIVE_MARGIN ?? 0.5);
  const minVectorScore = Number(process.env.RAG_MIN_VECTOR_SCORE ?? 0.25);
  // 关键词有效性门槛：权重和低于 0.8 视为「擦边」，不参与融合
  const minKeywordWeight = Number(process.env.RAG_MIN_KEYWORD_WEIGHT ?? 0.8);

  const topScore = rawVec[0]?.score ?? 0;
  const cutoff = strongKeyword
    ? topScore * (1 - relativeMargin) // A：靠关键词保底
    : Math.max(minVectorScore, topScore); // B：向量需自身够强

  const vec = rawVec.filter((r) => {
    if (r.score <= 0 || r.score < cutoff) return false;
    const row = byId.get(r.objectId);
    if (!row) return false;
    return passesSemanticGate(queryTerms, row.content);
  });

  const kwFiltered = kw.filter((k) => k.weighted >= minKeywordWeight);

  const fused = new Map<string, RecallHit>();

  const touch = (objectId: string) => {
    let hit = fused.get(objectId);
    if (!hit) {
      const row = byId.get(objectId);
      if (!row) return undefined;
      hit = {
        objectType: row.objectType as IndexObjectType,
        objectId,
        meetingId: row.meetingId,
        content: row.content,
        score: 0,
        via: [],
      };
      fused.set(objectId, hit);
    }
    return hit;
  };

  kwFiltered.forEach((r, rank) => {
    const hit = touch(r.objectId);
    if (!hit) return;
    hit.keywordScore = r.score;
    hit.via.push("keyword");
    hit.score += 1 / (rrfK + rank + 1);
  });

  vec.forEach((r, rank) => {
    const hit = touch(r.objectId);
    if (!hit) return;
    hit.vectorScore = r.score;
    hit.via.push("vector");
    hit.score += 1 / (rrfK + rank + 1);
  });

  // 两路都命中的额外加权：同时被关键词和向量召回，通常更相关
  for (const hit of fused.values()) {
    if (hit.via.length === 2) hit.score *= 1.2;
  }

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 会议结束后统一建索引（话轮 + 摘要 + 决议） */
export async function indexMeeting(tenantId: string, meetingId: string) {
  const [turns, summaries, minutes] = await Promise.all([
    prisma.transcriptTurn.findMany({ where: { meetingId }, orderBy: { idx: "asc" } }),
    prisma.summary.findMany({ where: { meetingId } }),
    prisma.minutes.findUnique({ where: { meetingId }, include: { decisions: true } }),
  ]);

  const items: IndexInput[] = [
    ...turns.map((t) => ({
      tenantId,
      objectType: "turn" as const,
      objectId: t.id,
      meetingId,
      content: t.text,
    })),
    ...summaries.map((s) => ({
      tenantId,
      objectType: "summary" as const,
      objectId: s.id,
      meetingId,
      content: s.content,
    })),
    ...(minutes?.decisions ?? []).map((d) => ({
      tenantId,
      objectType: "decision" as const,
      objectId: d.id,
      meetingId,
      content: d.content,
    })),
  ];

  return indexObjects(items);
}