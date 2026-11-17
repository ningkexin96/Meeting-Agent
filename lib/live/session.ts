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
    where: { meetingId: input.meetingId, tenantId: input.tenantId, status: { in: ["live", "ending"] } },
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
  // 原子认领结束权，避免浏览器重试或双击导致两个 endSession 并发跑。
  const claimed = await prisma.liveSession.updateMany({
    where: { id: sessionId, tenantId: ctx.tenantId, status: "live" },
    data: { status: "ending" },
  });
  if (claimed.count === 0) {
    const current = await prisma.liveSession.findFirst({
      where: { id: sessionId, tenantId: ctx.tenantId },
      select: { status: true },
    });
    if (!current) throw new Error("实时会话不存在或不属于当前租户");
    if (current.status === "ended") throw new Error("会话已经结束过了");
    throw new Error(`会话状态为 ${current.status}，不能结束`);
  }

  const session = await prisma.liveSession.findFirst({
    where: { id: sessionId, tenantId: ctx.tenantId },
  });
  if (!session) throw new Error("实时会话不存在或不属于当前租户");

  // ToolContext 的 meetingId 必须来自会话，不能用调用方传的空值
  const toolCtx: ToolContext = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: ctx.role,
    meetingId: session.meetingId,
  };

  try {
    // 最后再抽一次，把剩余不足一个窗口的内容也补上。
    // WebSocket 服务端在发送 stopped 前已等待最终落库；这里再兜底一次。
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

    // 1. 本次实时会话的话轮必须追加到正式 TranscriptTurn。
    //    不能因为会议已有上传转写就跳过，否则纪要引用会指向旧话轮。
    //    speaker_0 = 本机麦克风（我），speaker_1 = 会议对方（系统播放音），各建一个参与者。
    const participantOf = async (speakerLabel: string, displayName: string) => {
      const existing = await prisma.meetingParticipant.findFirst({
        where: { meetingId: session.meetingId, speakerLabel },
      });
      if (existing) return existing;
      return prisma.meetingParticipant.create({
        data: {
          meetingId: session.meetingId,
          displayName,
          speakerLabel,
          confidence: 0.8,
        },
      });
    };

    // 只有该 speakerLabel 真的出现在话轮里才建档，避免造出空的「会议对方」
    const usedLabels = new Set(segments.map((s) => s.speakerLabel ?? "speaker_0"));
    const participantByLabel = new Map<string, Awaited<ReturnType<typeof participantOf>>>();
    if (usedLabels.has("speaker_0")) {
      participantByLabel.set("speaker_0", await participantOf("speaker_0", "实时转写（我）"));
    }
    if (usedLabels.has("speaker_1")) {
      participantByLabel.set("speaker_1", await participantOf("speaker_1", "会议对方"));
    }
    const fallbackParticipant = participantByLabel.get("speaker_0") ?? [...participantByLabel.values()][0];

    const existingLiveTurns = await prisma.transcriptTurn.findMany({
      where: { meetingId: session.meetingId, liveSessionId: session.id },
      orderBy: { liveSeq: "asc" },
    });
    const turnIdxByLiveSeq = new Map<number, number>();
    for (const turn of existingLiveTurns) {
      if (turn.liveSeq !== null) turnIdxByLiveSeq.set(turn.liveSeq, turn.idx);
    }

    if (turnIdxByLiveSeq.size < segments.length) {
      const maxIdx = await prisma.transcriptTurn.aggregate({
        where: { meetingId: session.meetingId },
        _max: { idx: true },
      });
      let nextIdx = (maxIdx._max.idx ?? -1) + 1;
      for (const segment of segments) {
        if (turnIdxByLiveSeq.has(segment.seq)) continue;
        const label = segment.speakerLabel ?? "speaker_0";
        const participant = participantByLabel.get(label) ?? fallbackParticipant;
        if (!participant) throw new Error("无法建立会议参与者，实时话轮落库失败");
        await prisma.transcriptTurn.create({
          data: {
            meetingId: session.meetingId,
            participantId: participant.id,
            idx: nextIdx++,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text: segment.text,
            asrConfidence: segment.confidence,
            needsReview: segment.needsReview,
            liveSessionId: session.id,
            liveSeq: segment.seq,
          },
        });
        turnIdxByLiveSeq.set(segment.seq, nextIdx - 1);
      }
    }

    const fallbackIdx = turnIdxByLiveSeq.get(segments[0].seq);
    if (fallbackIdx === undefined) throw new Error("实时话轮落库失败，无法生成引用");
    const sourceIdxOf = (liveSeq: number) => turnIdxByLiveSeq.get(liveSeq) ?? fallbackIdx;

    // 2. 合并增量条目成最终纪要草案；引用使用正式 TranscriptTurn.idx，而不是 LiveSegment 局部序号。
    const draft: MinutesDraft = {
      overview: buildOverview(segments.length, items),
      decisions: items
        .filter((i) => i.kind === "decision")
        .map((i) => ({ content: i.content, sourceTurnIdx: sourceIdxOf(i.fromTurnSeq) })),
      actionItems: items
        .filter((i) => i.kind === "action_item")
        .map((i) => ({
          content: i.content,
          owner: i.owner ?? undefined,
          dueAt: i.dueAt ?? undefined,
          sourceTurnIdx: sourceIdxOf(i.fromTurnSeq),
        })),
      risks: items
        .filter((i) => i.kind === "risk")
        .map((i) => ({
          content: i.content,
          severity: (i.severity as "low" | "medium" | "high") ?? "medium",
          sourceTurnIdx: sourceIdxOf(i.fromTurnSeq),
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
  } catch (e) {
    await prisma.liveSession.update({
      where: { id: sessionId },
      data: { status: "failed", error: (e as Error).message, endedAt: new Date() },
    }).catch(() => {});
    throw e;
  }
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