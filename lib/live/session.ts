// 实时会话生命周期 —— 对应 issue #26
import { prisma } from "@/lib/db/client";
import { runBus } from "@/lib/events";
import { extractIncrement } from "./extract";
import { saveMinutes, validateDraft, type MinutesDraft, type ToolContext } from "@/lib/tools";
import { audit } from "@/lib/db/scoped";

export type StartSessionInput = {
  tenantId: string;
  userId: string;
  role: string;
  meetingId: string;
  title?: string;
};

/** 开启实时会话：可挂在已有会议上，也可以顺手新建一场 */
export async function startSession(input: StartSessionInput) {
  // 先把该会议残留的未结束会话收掉，避免同时存在两个 live 会话
  const stale = await prisma.liveSession.findMany({
    where: { meetingId: input.meetingId, tenantId: input.tenantId, status: "live" },
  });
  for (const s of stale) {
    await prisma.liveSession.update({
      where: { id: s.id },
      data: { status: "failed", error: "被新的实时会话取代", endedAt: new Date() },
    });
  }

  let meeting = await prisma.meeting.findFirst({
    where: { id: input.meetingId, tenantId: input.tenantId },
  });

  if (!meeting) {
    meeting = await prisma.meeting.create({
      data: {
        tenantId: input.tenantId,
        title: input.title || "实时会议",
        status: "transcribing",
        stage: "PREPARING",
        createdBy: input.userId,
      },
    });
  } else {
    meeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: "transcribing" },
    });
  }

  const session = await prisma.liveSession.create({
    data: {
      tenantId: input.tenantId,
      meetingId: meeting.id,
      status: "live",
    },
  });

  runBus.reset(meeting.id);
  await audit(
    { tenantId: input.tenantId, userId: input.userId },
    "live.session.started",
    { sessionId: session.id },
    meeting.id,
  );

  return { sessionId: session.id, meetingId: meeting.id };
}

export async function getSession(sessionId: string, tenantId: string) {
  return prisma.liveSession.findFirst({ where: { id: sessionId, tenantId } });
}

/** 结束会话：合并最终纪要，走唯一写库路径 */
export async function endSession(sessionId: string, ctx: { tenantId: string; userId: string; role: string }) {
  const session = await prisma.liveSession.findFirst({
    where: { id: sessionId, tenantId: ctx.tenantId },
  });
  if (!session) throw new Error("实时会话不存在或不属于当前租户");

  if (session.status === "ended") throw new Error("会话已经结束过了");
  if (session.status !== "live") throw new Error(`会话状态为 ${session.status}，不能结束`);

  // ToolContext 的 meetingId 必须来自会话，不能用调用方传的空值
  const toolCtx: ToolContext = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: ctx.role,
    meetingId: session.meetingId,
  };

  // 最后再抽一次，把剩余不足一个窗口的内容也补上
  await extractIncrement(sessionId, { force: true });

  const segments = await prisma.liveSegment.findMany({
    where: { sessionId },
    orderBy: { seq: "asc" },
  });
  const items = await prisma.liveMinuteItem.findMany({ where: { sessionId } });

  if (segments.length === 0) {
    await prisma.liveSession.update({
      where: { id: sessionId },
      data: { status: "failed", error: "没有转写到任何内容", endedAt: new Date() },
    });
    return { ok: false, error: "没有转写到任何内容" };
  }

  // 1. 把实时片段落成正式话轮（供引用回溯）
  //    注意：这里复用会议已有参与者，没有就建一个匿名的
  let participant = await prisma.meetingParticipant.findFirst({
    where: { meetingId: session.meetingId },
  });
  if (!participant) {
    participant = await prisma.meetingParticipant.create({
      data: {
        meetingId: session.meetingId,
        displayName: "实时转写",
        speakerLabel: "speaker_0",
        confidence: 0.8,
      },
    });
  }

  const existingTurns = await prisma.transcriptTurn.count({
    where: { meetingId: session.meetingId },
  });
  if (existingTurns === 0) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      await prisma.transcriptTurn.create({
        data: {
          meetingId: session.meetingId,
          participantId: participant.id,
          idx: i,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          asrConfidence: s.confidence,
          needsReview: s.needsReview,
        },
      });
    }
  }

  // 2. 合并增量条目成最终纪要草案
  const draft: MinutesDraft = {
    overview: buildOverview(segments.length, items),
    decisions: items
      .filter((i) => i.kind === "decision")
      .map((i) => ({ content: i.content, sourceTurnIdx: seqToIdx(i.fromTurnSeq, segments.length) })),
    actionItems: items
      .filter((i) => i.kind === "action_item")
      .map((i) => ({
        content: i.content,
        owner: i.owner ?? undefined,
        dueAt: i.dueAt ?? undefined,
        sourceTurnIdx: seqToIdx(i.fromTurnSeq, segments.length),
      })),
    risks: items
      .filter((i) => i.kind === "risk")
      .map((i) => ({
        content: i.content,
        severity: (i.severity as "low" | "medium" | "high") ?? "medium",
        sourceTurnIdx: seqToIdx(i.fromTurnSeq, segments.length),
      })),
  };

  const validated = validateDraft(draft);
  const saved = await saveMinutes(toolCtx, validated);

  await prisma.liveSession.update({
    where: { id: sessionId },
    data: { status: "ended", endedAt: new Date() },
  });
  runBus.publish(session.meetingId, { type: "live:ended", sessionId, at: Date.now() });
  runBus.publish(session.meetingId, { type: "done", meetingId: session.meetingId, at: Date.now() });
  await audit(toolCtx, "live.session.ended", { sessionId, segments: segments.length }, session.meetingId);

  return { ok: true, minutesId: saved.minutesId, segments: segments.length, items: items.length };
}

function seqToIdx(seq: number, total: number) {
  return Math.max(0, Math.min(seq, total - 1));
}

function buildOverview(count: number, items: { kind: string }[]) {
  const d = items.filter((i) => i.kind === "decision").length;
  const a = items.filter((i) => i.kind === "action_item").length;
  const r = items.filter((i) => i.kind === "risk").length;
  return `本次实时会议共记录 ${count} 条转写，过程中累计识别 ${d} 条决议、${a} 条待办、${r} 条风险。`;
}

/** 前端刷新后恢复当前状态 */
export async function getSessionState(sessionId: string, tenantId: string) {
  const session = await prisma.liveSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) return null;

  const [segments, items, chunks] = await Promise.all([
    prisma.liveSegment.findMany({ where: { sessionId }, orderBy: { seq: "asc" } }),
    prisma.liveMinuteItem.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } }),
    prisma.liveChunk.findMany({ where: { sessionId }, orderBy: { seq: "asc" } }),
  ]);

  return {
    sessionId,
    meetingId: session.meetingId,
    status: session.status,
    cursorMs: session.cursorMs,
    segments,
    items,
    chunks: chunks.map((c) => ({ seq: c.seq, status: c.status, error: c.error, bytes: c.bytes })),
  };
}