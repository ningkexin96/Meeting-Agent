// 实时增量抽取 —— 会议进行中周期性从转写里抽决议 / 待办 / 风险
//
// 设计要点：
// 1. 按条数触发而不是定时触发：攒够 4 条新的定稿句子才抽一次，
//    避免短句子频繁调用模型。
// 2. 去重：与已有条目做规范化比对，避免同一句话被重复抽出。
// 3. 抽不到就返回空，不硬凑——宁可右栏是空的，也不要塞进不相干的内容。
// 4. 失败不影响录音：抽取异常只记录，不中断正在进行的会话。

import { prisma } from "@/lib/db/client";
import { isMockLlm } from "@/lib/llm";

export type IncrementalItem = {
  id: string;
  kind: "decision" | "action_item" | "risk";
  content: string;
  owner?: string | null;
  dueAt?: string | null;
  severity?: string | null;
};

/** 判断两句话是否重复（去掉标点与空白后比较） */
function normalize(s: string): string {
  return s.replace(/[\s，。！？、；：,.!?;:""''（）()]/g, "").toLowerCase();
}

/**
 * 从一批新的转写句子中抽取纪要条目。
 * 返回本次新抽取到的条目（已去重）。
 */
export async function extractIncremental(
  tenantId: string,
  sessionId: string,
  meetingId: string,
  newSegments: { seq: number; text: string }[],
): Promise<IncrementalItem[]> {
  if (newSegments.length === 0) return [];

  const text = newSegments.map((s) => `#${s.seq} ${s.text}`).join("\n");

  let raw: { kind?: string; content?: string; owner?: string | null; dueAt?: string | null; severity?: string | null }[];

  if (isMockLlm()) {
    // mock 模式用规则抽取，保证离线可用
    raw = ruleExtract(newSegments);
  } else {
    const { callModel, extractJson } = await import("@/lib/agent/llm-call");
    const resp = await callModel(
      `你是实时会议纪要抽取器。只输出 JSON，不要解释。

从下面的会议片段中抽取【明确出现的】决议、待办、风险。没有就返回空数组，不要编造。

输出格式：
{"items":[{"kind":"decision|action_item|risk","content":"","owner":"","dueAt":"","severity":"low|medium|high","sourceSeq":0}]}

要求：
- 只抽取这段文字里明确表达的内容，"可能会"、"要不"这类讨论中未定的事不算
- owner 和 dueAt 没提到就留空
- 风险要说明会导致什么后果

片段：
${text}`,
      "extract",
      { timeoutMs: 45_000, maxRetries: 1 },
    );

    try {
      const json = extractJson<{ items?: typeof raw }>(resp);
      raw = Array.isArray(json.items) ? json.items : [];
    } catch {
      raw = [];
    }
  }

  // 已存在的条目（用于去重）
  const existing = await prisma.liveMinuteItem.findMany({
    where: { sessionId },
    select: { content: true },
  });
  const existingSet = new Set(existing.map((e) => normalize(e.content)));

  const created: IncrementalItem[] = [];

  for (const it of raw) {
    const content = String(it.content ?? "").trim();
    if (!content) continue;
    if (content.length < 4) continue;

    const key = normalize(content);
    if (existingSet.has(key)) continue;

    const kind = ["decision", "action_item", "risk"].includes(it.kind ?? "")
      ? (it.kind as IncrementalItem["kind"])
      : "decision";

    try {
      const row = await prisma.liveMinuteItem.create({
        data: {
          sessionId,
          kind,
          content,
          owner: it.owner?.trim() || null,
          dueAt: it.dueAt?.trim() || null,
          // severity 是非空字段（默认 medium），空值要回落到默认
          severity: it.severity?.trim() || "medium",
        },
      });
      existingSet.add(key);
      created.push({
        id: row.id,
        kind,
        content: row.content,
        owner: row.owner ?? undefined,
        dueAt: row.dueAt ?? undefined,
        severity: row.severity ?? undefined,
      });
    } catch {
      // 单条失败不影响其他条目
    }
  }

  return created;
}

/** mock 模式下的规则抽取：关键词命中 */
function ruleExtract(segments: { seq: number; text: string }[]) {
  const DECISION = /(决定|定了|就这样|确认|同意|敲定|结论是|先做|改成)/;
  const ACTION = /(负责|跟进|来做|处理|完成|截止|之前给|下周|明天|周五|周四)/;
  const RISK = /(风险|担心|可能来不及|时间紧|阻塞|卡住|延期|砍掉|做不完)/;

  const out: { kind: string; content: string; owner?: string; dueAt?: string; severity?: string }[] = [];

  for (const s of segments) {
    const t = s.text.trim();
    if (t.length < 6) continue;

    if (RISK.test(t)) {
      out.push({
        kind: "risk",
        content: t,
        severity: /(来不及|做不完|延期|砍掉|严重)/.test(t) ? "high" : "medium",
      });
      continue;
    }
    if (DECISION.test(t)) {
      out.push({ kind: "decision", content: t });
      continue;
    }
    if (ACTION.test(t)) {
      const ownerMatch = t.match(/([\u4e00-\u9fa5]{2,4})(?:负责|来做|跟进)/);
      const dueMatch = t.match(/(本周[一二三四五六日]|下周[一二三四五六日]|周[一二三四五六日]|明天|今天)/);
      out.push({
        kind: "action_item",
        content: t,
        owner: ownerMatch?.[1],
        dueAt: dueMatch?.[1],
      });
    }
  }

  return out;
}