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

type RawObject = Record<string, unknown>;

function asObject(value: unknown, label: string): RawObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`纪要结构非法：${label} 不是对象`);
  }
  return value as RawObject;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`纪要结构非法：${label} 缺少非空 content`);
  }
  return value.trim();
}

function requiredTurnIdx(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`纪要结构非法：${label} 的 sourceTurnIdx 必须是非负整数`);
  }
  return value as number;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`纪要结构非法：${label} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** 兜底解析：mock 输出天然结构完整；真实模型输出经此完整校验 */
export function validateDraft(raw: unknown): MinutesDraft {
  const d = asObject(raw, "根节点");
  if (typeof d.overview !== "string" || !d.overview.trim()) {
    throw new Error("纪要结构非法：缺少 overview");
  }
  if (!Array.isArray(d.decisions)) throw new Error("纪要结构非法：缺少 decisions");
  if (!Array.isArray(d.actionItems)) throw new Error("纪要结构非法：缺少 actionItems");
  if (!Array.isArray(d.risks)) throw new Error("纪要结构非法：缺少 risks");

  const decisions = d.decisions.map((item, i) => {
    const row = asObject(item, `decisions[${i}]`);
    return {
      content: requiredText(row.content, `decisions[${i}]`),
      sourceTurnIdx: requiredTurnIdx(row.sourceTurnIdx, `decisions[${i}]`),
    };
  });

  const actionItems = d.actionItems.map((item, i) => {
    const row = asObject(item, `actionItems[${i}]`);
    return {
      content: requiredText(row.content, `actionItems[${i}]`),
      owner: optionalText(row.owner, `actionItems[${i}].owner`),
      dueAt: optionalText(row.dueAt, `actionItems[${i}].dueAt`),
      sourceTurnIdx: requiredTurnIdx(row.sourceTurnIdx, `actionItems[${i}]`),
    };
  });

  const risks = d.risks.map((item, i) => {
    const row = asObject(item, `risks[${i}]`);
    const raw = row.severity ?? "medium";
    // 运行时已校验取值，这里用类型断言把 string 收窄成联合类型
    if (raw !== "low" && raw !== "medium" && raw !== "high") {
      throw new Error(`纪要结构非法：risks[${i}].severity 只能是 low/medium/high`);
    }
    const severity = raw as "low" | "medium" | "high";
    return {
      content: requiredText(row.content, `risks[${i}]`),
      severity,
      sourceTurnIdx: requiredTurnIdx(row.sourceTurnIdx, `risks[${i}]`),
    };
  });

  return { overview: d.overview.trim(), decisions, actionItems, risks };
}

/** 唯一写入路径（issue #13）：先完整校验，再在一个事务里替换旧版本 */
export async function saveMinutes(ctx: ToolContext, draft: MinutesDraft) {
  const meeting = await assertMeetingInTenant(ctx.tenantId, ctx.meetingId);
  const turns = await prisma.transcriptTurn.findMany({
    where: { meetingId: ctx.meetingId },
    orderBy: { idx: "asc" },
  });
  const turnByIdx = new Map(turns.map((t) => [t.idx, t]));

  // 引用索引必须在删除旧纪要之前校验完；否则失败会留下半份新数据。
  const allRefs = [
    ...draft.decisions.map((d) => d.sourceTurnIdx),
    ...draft.actionItems.map((a) => a.sourceTurnIdx),
    ...draft.risks.map((r) => r.sourceTurnIdx),
  ];
  const invalidRef = allRefs.find((idx) => !turnByIdx.has(idx));
  if (invalidRef !== undefined) {
    throw new Error(`纪要结构非法：sourceTurnIdx=${invalidRef} 不存在于当前会议转写中`);
  }

  return prisma.$transaction(async (tx) => {
    // 幂等：重复提交覆盖为最新一份；整个替换过程必须原子化。
    const existing = await tx.minutes.findUnique({ where: { meetingId: ctx.meetingId } });
    if (existing) {
      const [oldActions, oldDecisions, oldRisks] = await Promise.all([
        tx.actionItem.findMany({ where: { minutesId: existing.id }, select: { id: true } }),
        tx.decision.findMany({ where: { minutesId: existing.id }, select: { id: true } }),
        tx.risk.findMany({ where: { minutesId: existing.id }, select: { id: true } }),
      ]);
      const childIds = [...oldActions, ...oldDecisions, ...oldRisks].map((x) => x.id);
      if (childIds.length) {
        await tx.citation.deleteMany({ where: { targetId: { in: childIds } } });
      }
      if (oldDecisions.length) {
        await tx.embedding.deleteMany({
          where: {
            tenantId: ctx.tenantId,
            objectType: "decision",
            objectId: { in: oldDecisions.map((d) => d.id) },
          },
        });
      }
      await tx.actionItem.deleteMany({ where: { minutesId: existing.id } });
      await tx.decision.deleteMany({ where: { minutesId: existing.id } });
      await tx.risk.deleteMany({ where: { minutesId: existing.id } });
      await tx.minutes.delete({ where: { id: existing.id } });
    }

    const minutes = await tx.minutes.create({
      data: {
        meetingId: ctx.meetingId,
        overview: draft.overview,
        status: "draft",
        editedBy: ctx.userId,
      },
    });

    const citations: { turnId: string; targetType: string; targetId: string }[] = [];

    for (const d of draft.decisions) {
      const turn = turnByIdx.get(d.sourceTurnIdx)!;
      const row = await tx.decision.create({
        data: { minutesId: minutes.id, content: d.content, sourceTurnId: turn.id },
      });
      citations.push({ turnId: turn.id, targetType: "decision", targetId: row.id });
    }

    for (const a of draft.actionItems) {
      const turn = turnByIdx.get(a.sourceTurnIdx)!;
      const unresolved = !a.owner || !a.dueAt;
      const row = await tx.actionItem.create({
        data: {
          minutesId: minutes.id,
          content: a.content,
          owner: a.owner ?? null,
          dueAt: a.dueAt ?? null,
          unresolved,
          sourceTurnId: turn.id,
        },
      });
      citations.push({ turnId: turn.id, targetType: "action_item", targetId: row.id });
    }

    for (const r of draft.risks) {
      const turn = turnByIdx.get(r.sourceTurnIdx)!;
      const row = await tx.risk.create({
        data: {
          minutesId: minutes.id,
          content: r.content,
          severity: r.severity,
          sourceTurnId: turn.id,
        },
      });
      citations.push({ turnId: turn.id, targetType: "risk", targetId: row.id });
    }

    if (citations.length) await tx.citation.createMany({ data: citations });

    await tx.meeting.update({
      where: { id: meeting.id },
      data: { status: "done", stage: "DONE" },
    });

    return { minutesId: minutes.id, citations: citations.length };
  }, { timeout: 15_000 });
}

/** 增量记忆（issue #15）：mem0 风格 ADD / UPDATE / NOOP */
export async function rememberFromMinutes(ctx: ToolContext, draft: MinutesDraft) {
  // 分类映射（对应记忆管理的四类）：
  //   决议 → decision（会上拍板的事，最重要的记忆）
  //   风险 → open_loop（未闭环的风险，需要后续跟进）
  //   待办 → open_loop 也合适，但为了避免记忆过载，这里只沉淀决议与风险
  const items: { kind: string; title: string; content: string; importance: number }[] = [];
  for (const d of draft.decisions) {
    items.push({
      kind: "decision",
      // 标题留空：决议内容本身通常不长，再截断一遍会和正文重复
      title: "",
      content: d.content,
      importance: 0.85,
    });
  }
  for (const r of draft.risks) {
    items.push({
      kind: "open_loop",
      // 风险类给个简短标题，便于在列表中区分「风险」与「决议」
      title: "风险",
      content: r.content,
      importance: r.severity === "high" ? 0.75 : 0.55,
    });
  }

  let added = 0;
  let noop = 0;
  for (const item of items) {
    // 去重：同租户下内容完全相同即视为已有
    const dup = await prisma.memory.findFirst({
      where: { tenantId: ctx.tenantId, content: item.content, status: { not: "deleted" } },
    });
    if (dup) {
      noop++;
      continue;
    }
    const created = await prisma.memory.create({
      data: {
        tenantId: ctx.tenantId,
        meetingId: ctx.meetingId,
        kind: item.kind,
        status: "active",
        title: item.title || null,
        content: item.content,
        importance: item.importance,
        source: "agent_runtime",
      },
    });
    await prisma.memoryChange.create({
      data: {
        memoryId: created.id,
        changeType: "create",
        after: JSON.stringify({ kind: item.kind, content: item.content }),
        reason: `来自会议 ${ctx.meetingId} 的纪要`,
      },
    });
    added++;
  }
  return { added, noop, total: items.length };
}

/**
 * 跨会议召回（issue #16 + #25）：混合召回（关键词 + 向量，RRF 融合）。
 *
 * 重要语义区分：
 * - 语义检索「正常执行但返回 0 条」= 确实没有相关内容，必须直接返回空，
 *   不能再用粗糙的关键词兜底——否则「量子计算什么时候上线」会因为
 *   擦到「上线」两个字而召回「先上线录音上传」，把无关内容当依据。
 * - 只有语义索引「不可用」（抛异常 / 未启用）时才退回纯关键词。
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

      // 语义检索跑通了：它的结论就是权威结论，0 条就返回 0 条
      if (hits.length === 0) return [];

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
    } catch (e) {
      console.warn(`[recall] 语义检索不可用，退回关键词：${(e as Error).message}`);
    }
  }

  // 仅当语义索引不可用时才走到这里
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const memories = await prisma.memory.findMany({
    where: { tenantId: ctx.tenantId, status: { in: ["active", "proposed"] } },
  });
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