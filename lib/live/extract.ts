// 增量纪要抽取 —— 对应 issue #26
//
// 核心问题：会议进行中，每来几个话轮就该更新一次纪要。
// 但「每次全量重抽」会让成本随时长线性上涨，而且同一条决议会被反复抽出来变成重复条目。
//
// 解法：
// 1. 按「窗口」抽：只看新增的 N 个话轮，不重复看历史
// 2. 抽完去重：新条目与已有序条目做文本相似度比对，重复的丢掉
// 3. 增量结果落 LiveMinuteItem（过程数据），不进权威 Minutes 表
import { prisma } from "@/lib/db/client";
import { runBus, type LiveMinutePayload } from "@/lib/events";
import { isMockLlm } from "@/lib/llm";
import { tokenize } from "@/lib/rag/embedding";

export const WINDOW_SIZE = Number(process.env.LIVE_EXTRACT_WINDOW ?? 4);

export type ExtractedItem = {
  kind: "decision" | "action_item" | "risk";
  content: string;
  owner?: string;
  dueAt?: string;
  severity?: string;
  sourceText?: string;
};

/** 文本相似度：Jaccard on bigram tokens，用于增量去重 */
export function textSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 去重阈值：高于此值视为同一条 */
export const DEDUP_THRESHOLD = Number(process.env.LIVE_DEDUP_THRESHOLD ?? 0.6);

export function dedupe(
  incoming: ExtractedItem[],
  existing: ExtractedItem[],
  threshold = DEDUP_THRESHOLD,
): ExtractedItem[] {
  const kept: ExtractedItem[] = [];
  for (const item of incoming) {
    const dupOfExisting = existing.some(
      (e) => e.kind === item.kind && textSimilarity(e.content, item.content) >= threshold,
    );
    if (dupOfExisting) continue;
    const dupOfBatch = kept.some(
      (e) => e.kind === item.kind && textSimilarity(e.content, item.content) >= threshold,
    );
    if (dupOfBatch) continue;
    kept.push(item);
  }
  return kept;
}

const DECISION_HINTS = ["就定", "这个决定", "我决定", "确定", "就这么定", "同意", "按这个", "结论是"];
const ACTION_HINTS = ["负责", "我来", "我来盯", "给到", "之前给", "周四", "周五", "下周", "截止", "跟进"];
// 高危词要包含在 RISK_HINTS 里，否则「砍掉」这类句子会被 ACTION_HINTS 的「周五」抢走
const RISK_HINTS = [
  "风险", "问题", "担心", "可能不准", "不稳定", "紧张", "来不及",
  "砍掉", "必须", "硬要求", "做不完", "延期",
];

/**
 * 规则抽取（mock 模式与真实模式的兜底都走这里）。
 *
 * 为什么用规则而不是只靠模型？
 * 实时场景下每 4 个话轮就要抽一次，模型延迟会直接体现为「纪要卡住」。
 * 规则是毫秒级的，能在真实模型回来之前先把结果补上；真实模型结果替换它。
 */
export function extractByRules(
  turns: { seq: number; text: string; speaker: string }[],
): ExtractedItem[] {
  const items: ExtractedItem[] = [];

  for (const t of turns) {
    const text = t.text.trim();
    if (text.length < 6) continue;

    if (RISK_HINTS.some((h) => text.includes(h))) {
      const severity = /来不及|来不及了|砍掉|必须|硬要求/.test(text) ? "high" : "medium";
      items.push({
        kind: "risk",
        content: text,
        severity,
        sourceText: `#${t.seq}`,
      });
      continue;
    }

    if (ACTION_HINTS.some((h) => text.includes(h))) {
      // 从「张伟你负责」里抽负责人
      const ownerMatch = text.match(/([\u4e00-\u9fa5]{2,4})你?(?:负责|来)/);
      const dueMatch = text.match(/(周[一二三四五六日]|下周[一二三四五六日]?|月底|本周)/);
      items.push({
        kind: "action_item",
        content: text,
        owner: ownerMatch?.[1],
        dueAt: dueMatch?.[1],
        sourceText: `#${t.seq}`,
      });
      continue;
    }

    if (DECISION_HINTS.some((h) => text.includes(h))) {
      items.push({
        kind: "decision",
        content: text,
        sourceText: `#${t.seq}`,
      });
    }
  }

  return items;
}

/** 用真实模型抽取（失败时返回 null，由调用方退回规则结果） */
async function extractWithLlm(
  turns: { seq: number; text: string; speaker: string }[],
): Promise<ExtractedItem[] | null> {
  try {
    const { callModel, extractJson } = await import("@/lib/agent/llm-call");
    const body = turns.map((t) => `#${t.seq} ${t.speaker}: ${t.text}`).join("\n");
    const raw = await callModel(
      `你是实时会议纪要抽取器。只输出 JSON，不要解释。格式：
{"items":[{"kind":"decision|action_item|risk","content":"","owner":"","dueAt":"","severity":"low|medium|high","sourceSeq":0}]}
只抽取明确出现的决议、待办、风险，不确定就少抽，不要编造。owner/dueAt 不知道就留空。

${body}`,
      "extract",
      { timeoutMs: 45_000, maxRetries: 1 },
    );
    const json = extractJson<{
      items?: {
        kind: string;
        content: string;
        owner?: string;
        dueAt?: string;
        severity?: string;
        sourceSeq?: number;
      }[];
    }>(raw);
    if (!Array.isArray(json.items)) return null;
    return json.items
      .filter((i) => i.content && ["decision", "action_item", "risk"].includes(i.kind))
      .map((i) => ({
        kind: i.kind as ExtractedItem["kind"],
        content: i.content,
        owner: i.owner || undefined,
        dueAt: i.dueAt || undefined,
        severity: i.severity || "medium",
        sourceText: i.sourceSeq != null ? `#${i.sourceSeq}` : undefined,
      }));
  } catch {
    return null;
  }
}

/**
 * 触发一次增量抽取。
 * 返回本次新增的条目（已去重、已落库、已推送）。
 */
export async function extractIncrement(
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<LiveMinutePayload[]> {
  const session = await prisma.liveSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error(`实时会话不存在：${sessionId}`);

  const existingRows = await prisma.liveMinuteItem.findMany({ where: { sessionId } });
  const existing: ExtractedItem[] = existingRows.map((r) => ({
    kind: r.kind as ExtractedItem["kind"],
    content: r.content,
  }));

  // 只看「上次抽取之后新增」的话轮
  const lastSeq = existingRows.reduce((max, r) => Math.max(max, r.fromTurnSeq), -1);
  const fresh = await prisma.liveSegment.findMany({
    where: { sessionId, seq: { gt: lastSeq } },
    orderBy: { seq: "asc" },
  });

  if (fresh.length < WINDOW_SIZE && !opts.force) return [];

  const turns = fresh.map((f) => ({ seq: f.seq, text: f.text, speaker: f.speakerLabel }));
  if (turns.length === 0) return [];

  let items: ExtractedItem[] = [];
  if (!isMockLlm()) {
    const llm = await extractWithLlm(turns);
    if (llm) items = llm;
  }
  if (items.length === 0) items = extractByRules(turns);

  const kept = dedupe(items, existing);

  const created: LiveMinutePayload[] = [];
  for (const item of kept) {
    const row = await prisma.liveMinuteItem.create({
      data: {
        sessionId,
        kind: item.kind,
        content: item.content,
        owner: item.owner ?? null,
        dueAt: item.dueAt ?? null,
        severity: item.severity ?? "medium",
        sourceText: item.sourceText ?? "",
        fromTurnSeq: fresh[fresh.length - 1].seq,
      },
    });
    created.push({
      id: row.id,
      kind: item.kind,
      content: item.content,
      owner: row.owner,
      dueAt: row.dueAt,
      severity: row.severity,
    });
  }

  if (created.length > 0) {
    runBus.publish(session.meetingId, { type: "live:minutes", items: created, at: Date.now() });
  }
  return created;
}