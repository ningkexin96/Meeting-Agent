// 向量存储与混合召回 —— 对应 issue #25
//
// 召回策略：关键词（精确、可解释）+ 向量（语义、模糊）两路各取候选，
// 用 RRF（Reciprocal Rank Fusion）融合排序——不依赖两路分数量纲，
// 这是业界最稳的做法之一，也能在二面讲清楚「为什么不用简单加权求和」。
import { prisma } from "@/lib/db/client";
import { getEmbeddingProvider } from "./embedding";
import { extractKeywords } from "@/lib/tools/keywords";

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

/** 关键词召回：简单的包含匹配打分 */
function keywordRecall(
  query: string,
  rows: { objectType: string; objectId: string; content: string }[],
): { objectId: string; score: number }[] {
  const kws = extractKeywords(query);
  if (kws.length === 0) return [];
  return rows
    .map((r) => {
      const hits = kws.filter((k) => r.content.includes(k)).length;
      return { objectId: r.objectId, score: hits / kws.length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
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
  // 而正确命中的「存储怎么处理」才 0.200。所以：
  //   - 关键词有命中时：向量只作补充，用相对阈值放宽召回
  //   - 关键词完全没命中时：只接受「强向量命中」（≥ RAG_MIN_VECTOR_SCORE），
  //     否则宁可不召回——把无关内容当依据正是幻觉的来源
  const keywordHit = kw.length > 0;
  const relativeMargin = Number(process.env.RAG_RELATIVE_MARGIN ?? 0.5);
  const minVectorScore = Number(process.env.RAG_MIN_VECTOR_SCORE ?? 0.25);

  const topScore = rawVec[0]?.score ?? 0;
  const cutoff = keywordHit
    ? Math.max(0, topScore * (1 - relativeMargin))
    : Math.max(minVectorScore, topScore);
  const vec = rawVec.filter((r) => r.score > 0 && r.score >= cutoff);

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

  kw.forEach((r, rank) => {
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