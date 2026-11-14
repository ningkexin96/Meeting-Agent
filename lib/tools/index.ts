// 工具集 —— 对应 issue #7 #13 #15 #16
// 关键约束：纪要只能通过 save_minutes 写入；模型不能直接改库
import { prisma } from "@/lib/db/client";
import { SAMPLE_TRANSCRIPT } from "@/lib/asr/samples";
import { extractKeywords } from "./keywords";

export type ToolContext = {
  tenantId: string;
  userId: string;
  role: string;
  meetingId: string;
};

export type ToolCallLog = { tool: string; args: Record<string, unknown>; ok: boolean; note?: string };

export async function assertMeetingInTenant(tenantId: string, meetingId: string) {
  const meeting = await prisma.meeting.findFirst({ where: { id: meetingId, tenantId } });
  if (!meeting) throw new Error(`会议不存在或不属于当前租户：${meetingId}`);
  return meeting;
}

/** 检索原话（只读，viewer 也可用） */
export async function searchTranscript(ctx: ToolContext, query: string, limit = 5) {
  await assertMeetingInTenant(ctx.tenantId, ctx.meetingId);
  const turns = await prisma.transcriptTurn.findMany({
    where: { meetingId: ctx.meetingId },
    include: { participant: true },
    orderBy: { idx: "asc" },
  });
  const kw = query.trim();
  const hits = kw
    ? turns.filter((t) => t.text.includes(kw))
    : turns.slice(0, limit);
  return (hits.length ? hits : turns.slice(0, limit)).slice(0, limit).map((t) => ({
    turnId: t.id,
    idx: t.idx,
    speaker: t.participant.displayName,
    startMs: t.startMs,
    text: t.text,
  }));
}

/** 读取全部话轮（阶段内部使用，不进模型上下文全量） */
export async function loadTurns(tenantId: string, meetingId: string) {
  await assertMeetingInTenant(tenantId, meetingId);
  return prisma.transcriptTurn.findMany({
    where: { meetingId },
    include: { participant: true },
    orderBy: { idx: "asc" },
  });
}

export type MinutesDraft = {
  overview: string;
  decisions: { content: string; sourceTurnIdx: number }[];
  actionItems: { content: string; owner?: string; dueAt?: string; sourceTurnIdx: number }[];
  risks: { content: string; severity: "low" | "medium" | "high"; sourceTurnIdx: number }[];
};

/** 兜底解析：mock 输出天然结构完整；真实模型输出经此校验 */
export function validateDraft(raw: unknown): MinutesDraft {
  if (!raw || typeof raw !== "object") throw new Error("纪要结构非法：不是对象");
  const d = raw as Partial<MinutesDraft>;
  if (typeof d.overview !== "string" || !d.overview.trim()) throw new Error("纪要结构非法：缺少 overview");
  if (!Array.isArray(d.decisions)) throw new Error("纪要结构非法：缺少 decisions");
  if (!Array.isArray(d.actionItems)) throw new Error("纪要结构非法：缺少 actionItems");
  if (!Array.isArray(d.risks)) throw new Error("纪要结构非法：缺少 risks");
  return {
    overview: d.overview,
    decisions: d.decisions,
    actionItems: d.actionItems,
    risks: d.risks,
  };
}

/** 唯一写入路径（issue #13） */
export async function saveMinutes(ctx: ToolContext, draft: MinutesDraft) {
  const meeting = await assertMeetingInTenant(ctx.tenantId, ctx.meetingId);
  const turns = await prisma.transcriptTurn.findMany({
    where: { meetingId: ctx.meetingId },
    orderBy: { idx: "asc" },
  });
  const turnByIdx = new Map(turns.map((t) => [t.idx, t]));

  // 幂等：重复提交覆盖为最新一份
  const existing = await prisma.minutes.findUnique({ where: { meetingId: ctx.meetingId } });
  if (existing) {
    await prisma.citation.deleteMany({ where: { targetId: { in: await minuteChildIds(existing.id) } } });
    await prisma.actionItem.deleteMany({ where: { minutesId: existing.id } });
    await prisma.decision.deleteMany({ where: { minutesId: existing.id } });
    await prisma.risk.deleteMany({ where: { minutesId: existing.id } });
    await prisma.minutes.delete({ where: { id: existing.id } });
  }

  const minutes = await prisma.minutes.create({
    data: {
      meetingId: ctx.meetingId,
      overview: draft.overview,
      status: "draft",
      editedBy: ctx.userId,
    },
  });

  const citations: { turnId: string; targetType: string; targetId: string }[] = [];

  for (const d of draft.decisions) {
    const turn = turnByIdx.get(d.sourceTurnIdx);
    const row = await prisma.decision.create({
      data: { minutesId: minutes.id, content: d.content, sourceTurnId: turn?.id },
    });
    if (turn) citations.push({ turnId: turn.id, targetType: "decision", targetId: row.id });
  }

  for (const a of draft.actionItems) {
    const turn = turnByIdx.get(a.sourceTurnIdx);
    const unresolved = !a.owner || !a.dueAt;
    const row = await prisma.actionItem.create({
      data: {
        minutesId: minutes.id,
        content: a.content,
        owner: a.owner ?? null,
        dueAt: a.dueAt ?? null,
        unresolved,
        sourceTurnId: turn?.id,
      },
    });
    if (turn) citations.push({ turnId: turn.id, targetType: "action_item", targetId: row.id });
  }

  for (const r of draft.risks) {
    const turn = turnByIdx.get(r.sourceTurnIdx);
    const row = await prisma.risk.create({
      data: {
        minutesId: minutes.id,
        content: r.content,
        severity: r.severity ?? "medium",
        sourceTurnId: turn?.id,
      },
    });
    if (turn) citations.push({ turnId: turn.id, targetType: "risk", targetId: row.id });
  }

  if (citations.length) await prisma.citation.createMany({ data: citations });

  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { status: "done", stage: "DONE" },
  });

  return { minutesId: minutes.id, citations: citations.length };
}

async function minuteChildIds(minutesId: string) {
  const [a, d, r] = await Promise.all([
    prisma.actionItem.findMany({ where: { minutesId }, select: { id: true } }),
    prisma.decision.findMany({ where: { minutesId }, select: { id: true } }),
    prisma.risk.findMany({ where: { minutesId }, select: { id: true } }),
  ]);
  return [...a, ...d, ...r].map((x) => x.id);
}

/** 增量记忆（issue #15）：mem0 风格 ADD / UPDATE / NOOP */
export async function rememberFromMinutes(ctx: ToolContext, draft: MinutesDraft) {
  const items: { kind: string; content: string; importance: number }[] = [];
  for (const d of draft.decisions) {
    items.push({ kind: "fact", content: `决议：${d.content}`, importance: 0.8 });
  }
  for (const r of draft.risks) {
    items.push({ kind: "recurring_issue", content: `风险：${r.content}`, importance: 0.6 });
  }

  let added = 0;
  let noop = 0;
  for (const item of items) {
    const dup = await prisma.memory.findFirst({
      where: { tenantId: ctx.tenantId, content: item.content },
    });
    if (dup) {
      noop++;
      continue;
    }
    await prisma.memory.create({
      data: {
        tenantId: ctx.tenantId,
        meetingId: ctx.meetingId,
        kind: item.kind,
        content: item.content,
        importance: item.importance,
      },
    });
    added++;
  }
  return { added, noop, total: items.length };
}

/**
 * 跨会议召回（issue #16 + #25）：混合召回（关键词 + 向量，RRF 融合）。
 *
 * 顺序：
 * 1. 优先走语义索引（lib/rag）——能处理「排期」≈「上线时间」这类不同说法
 * 2. 索引为空或未启用时，退回纯关键词匹配（保证不依赖索引也能用）
 */
export async function recallMemory(ctx: TenantScope, query: string, limit = 5) {
  const useSemantic = process.env.SEMANTIC_SEARCH !== "0";
  if (useSemantic) {
    try {
      const { hybridRecall } = await import("@/lib/rag/retriever");
      const hits = await hybridRecall(ctx.tenantId, query, {
        limit,
        objectTypes: ["memory", "decision"],
      });
      if (hits.length > 0) {
        // 补充 meeting 标题，前端展示更友好
        const meetingIds = hits.map((h) => h.meetingId).filter(Boolean) as string[];
        const meetings = meetingIds.length
          ? await prisma.meeting.findMany({ where: { id: { in: meetingIds } } })
          : [];
        const titleOf = new Map(meetings.map((m) => [m.id, m.title]));
        return hits.map((h, i) => ({
          meetingId: h.meetingId ?? "",
          title:
            h.objectType === "memory"
              ? "历史记忆"
              : (titleOf.get(h.meetingId ?? "") ?? "历史会议"),
          text: h.content,
          importance: 1 - i * 0.1,
          via: h.via,
          score: Number(h.score.toFixed(4)),
        }));
      }
    } catch (e) {
      console.warn(`[recall] 语义检索失败，退回关键词：${(e as Error).message}`);
    }
  }

  // 兜底：纯关键词
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const memories = await prisma.memory.findMany({ where: { tenantId: ctx.tenantId } });
  const hit = memories.filter((m) => keywords.some((k) => m.content.includes(k)));

  const decisions = await prisma.decision.findMany({
    where: { minutes: { meeting: { tenantId: ctx.tenantId } } },
    include: { minutes: { include: { meeting: true } } },
  });
  const dHit = decisions.filter((d) => keywords.some((k) => d.content.includes(k)));

  const results = [
    ...hit.map((m) => ({
      meetingId: m.meetingId ?? "",
      title: "历史记忆",
      text: m.content,
      importance: m.importance,
      via: ["keyword"] as string[],
      score: 0,
    })),
    ...dHit.map((d) => ({
      meetingId: d.minutes.meetingId,
      title: d.minutes.meeting.title,
      text: d.content,
      importance: 0.7,
      via: ["keyword"] as string[],
      score: 0,
    })),
  ];
  return results.sort((a, b) => b.importance - a.importance).slice(0, limit);
}

export type TenantScope = { tenantId: string; userId: string; role: string };

/** mock 模式下的兜底话轮（ASR 不可用时仍能演示） */
export function fallbackTurns() {
  return SAMPLE_TRANSCRIPT;
}