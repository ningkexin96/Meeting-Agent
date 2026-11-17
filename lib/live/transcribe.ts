// 实时流式转写 —— 对应 issue #26
//
// 架构：浏览器 MediaRecorder 每 ~4s 切一片上传 → 服务端逐片调 ASR → 累加话轮 → SSE 推送
//
// 关键约束：
// 1. 分片是独立的音频文件（webm/opus），单片 ASR 拿不到全局上下文，
//    所以这里做「跨片拼接」：上一片结尾的句子没结束，就把下一片开头拼上去。
// 2. 某一片失败不能断了整场，标记该片 failed，继续处理后续片。
// 3. 时间戳需要按片偏移累加，否则每片都从 0 开始。
import { prisma } from "@/lib/db/client";
import { runBus } from "@/lib/events";
import { transcribeWithFallback } from "@/lib/asr";
import type { AsrTurn } from "@/lib/asr";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const CHUNK_MS = Number(process.env.LIVE_CHUNK_MS ?? 4000);
export const LIVE_WINDOW = Number(process.env.LIVE_EXTRACT_WINDOW ?? 4);

export type ChunkInput = {
  sessionId: string;
  seq: number;
  startMs: number;
  endMs: number;
  audio: Buffer;
  ext: string;
  /** 这一片来自哪个音源：speaker_0 = 本机麦克风，speaker_1 = 会议对方（系统播放音） */
  speakerLabel?: string;
};

// MediaRecorder 分片上传天然可能并发；拼接尾部必须按会话串行，不能基于同一快照重写。
const chunkQueues = new Map<string, Promise<unknown>>();

function storageDir() {
  return path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
}

/** 把分片落盘，返回可被 ASR 适配器读取的路径 */
export async function persistChunk(input: ChunkInput): Promise<string> {
  const dir = path.join(storageDir(), "live", input.sessionId);
  await mkdir(dir, { recursive: true });
  const name = `chunk-${String(input.seq).padStart(4, "0")}.${input.ext}`;
  const abs = path.join(dir, name);
  await writeFile(abs, input.audio);
  // 返回相对 storage 的路径，交给统一的路径解析
  return path.join("live", input.sessionId, name);
}

/**
 * 跨片拼接：上一片以未结束的句子结尾、且这一片开头不是新句 → 合并成一条。
 * 这解决了「一段话被 4 秒切在中间」的问题。
 */
export function stitchTurns(prev: AsrTurn[], next: AsrTurn[], offsetMs: number): AsrTurn[] {
  const shifted = next.map((t) => ({ ...t, startMs: t.startMs + offsetMs, endMs: t.endMs + offsetMs }));
  if (prev.length === 0) return shifted;
  if (shifted.length === 0) return prev;

  const last = prev[prev.length - 1];
  const first = shifted[0];
  const lastOpen = !/[。！？；]$/.test(last.text);
  const sameSpeaker = last.speakerLabel === first.speakerLabel;
  const closeEnough = first.startMs - last.endMs < 1500;

  if (lastOpen && sameSpeaker && closeEnough) {
    const merged: AsrTurn = {
      speakerLabel: last.speakerLabel,
      startMs: last.startMs,
      endMs: first.endMs,
      text: last.text + first.text,
      confidence: Math.min(last.confidence, first.confidence),
    };
    return [...prev.slice(0, -1), merged, ...shifted.slice(1)];
  }
  return [...prev, ...shifted];
}

/** 处理一个分片：转写 → 拼接 → 落库 → 推送 */
export async function processChunk(input: ChunkInput): Promise<{
  ok: boolean;
  added: number;
  error?: string;
  segments: AsrTurn[];
}> {
  const previous = chunkQueues.get(input.sessionId) ?? Promise.resolve();
  const next = previous.then(() => processChunkNow(input));
  const tracked = next.catch(() => undefined);
  chunkQueues.set(input.sessionId, tracked);
  try {
    return await next;
  } finally {
    if (chunkQueues.get(input.sessionId) === tracked) chunkQueues.delete(input.sessionId);
  }
}

async function processChunkNow(input: ChunkInput): Promise<{
  ok: boolean;
  added: number;
  error?: string;
  segments: AsrTurn[];
}> {
  const existingChunk = await prisma.liveChunk.findUnique({
    where: { sessionId_seq: { sessionId: input.sessionId, seq: input.seq } },
  });
  if (existingChunk?.status === "transcribed") {
    return { ok: true, added: 0, segments: [] };
  }

  const chunk = existingChunk ?? await prisma.liveChunk.create({
    data: {
      sessionId: input.sessionId,
      seq: input.seq,
      startMs: input.startMs,
      endMs: input.endMs,
      bytes: input.audio.length,
      status: "pending",
    },
  });

  let relPath: string;
  try {
    relPath = await persistChunk(input);
  } catch (e) {
    const msg = `分片保存失败：${(e as Error).message}`;
    await prisma.liveChunk.update({ where: { id: chunk.id }, data: { status: "failed", error: msg } });
    runBus.publish(await meetingIdOf(input.sessionId), {
      type: "live:chunk",
      seq: input.seq,
      status: "failed",
      error: msg,
      at: Date.now(),
    });
    return { ok: false, added: 0, error: msg, segments: [] };
  }

  try {
    const provider = process.env.ASR_PROVIDER ?? "mock";
    // mock 数据源是整场预置会议；实时分片模式下只在第一片产出，避免每 4 秒重复插入同一套话轮。
    const { turns, usedFallback, error } = provider === "mock" && input.seq > 0
      ? { turns: [] as AsrTurn[], usedFallback: false, error: undefined }
      : await transcribeWithFallback(relPath, {
          allowFallback: process.env.ASR_FALLBACK_TO_MOCK === "1",
        });
    if (usedFallback && error) {
      // 真实 ASR 不可用时降级，但必须让前端知道
      const mid = await meetingIdOf(input.sessionId);
      runBus.publish(mid, { type: "text", text: `⚠️ 分片 #${input.seq} 降级：${error}`, at: Date.now() });
    }
    if (turns.length === 0) {
      await prisma.liveChunk.update({ where: { id: chunk.id }, data: { status: "transcribed" } });
      const mid = await meetingIdOf(input.sessionId);
      runBus.publish(mid, { type: "live:chunk", seq: input.seq, status: "transcribed", at: Date.now() });
      return { ok: true, added: 0, segments: [] };
    }

    const offset = chunkOffsetOf(input);
    // 分片来自哪个音源由客户端上报；ASR 本身不做说话人分离，
    // 直接按音源打标，才能区分「我说的」和「线上会议对方说的」。
    const sourceLabel = input.speakerLabel ?? "speaker_0";
    const tagged = turns.map((t) => ({ ...t, speakerLabel: sourceLabel }));

    // 取该 session 已有的最后几条，做跨片拼接
    // 注意：只跟同一音源的历史拼接，否则会把我的尾巴接到对方的话上。
    const existing = await prisma.liveSegment.findMany({
      where: { sessionId: input.sessionId, speakerLabel: sourceLabel },
      orderBy: { seq: "asc" },
    });
    const prevTurns: AsrTurn[] = existing.map((s) => ({
      speakerLabel: s.speakerLabel,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      confidence: s.confidence,
    }));

    const stitched = stitchTurns(prevTurns, tagged, offset);
    const mergedCount = prevTurns.length + tagged.length - stitched.length;

    // 若发生了合并，把被合并的旧记录删掉后重写尾部
    if (mergedCount > 0 && existing.length > 0) {
      await prisma.liveSegment.deleteMany({
        where: { sessionId: input.sessionId, seq: { gte: existing.length - mergedCount } },
      });
    }

    const startIdx = mergedCount > 0 ? stitched.length - tagged.length : existing.length;
    const toWrite = stitched.slice(startIdx);

    let added = 0;
    const meetingId = await meetingIdOf(input.sessionId);
    for (let i = 0; i < toWrite.length; i++) {
      const t = toWrite[i];
      const seg = await prisma.liveSegment.create({
        data: {
          sessionId: input.sessionId,
          meetingId,
          seq: startIdx + i,
          speakerLabel: t.speakerLabel,
          startMs: t.startMs,
          endMs: t.endMs,
          text: t.text,
          confidence: t.confidence,
          needsReview: t.confidence < 0.6,
        },
      });
      added++;
      runBus.publish(meetingId, {
        type: "live:segment",
        segment: {
          seq: seg.seq,
          speakerLabel: seg.speakerLabel,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          confidence: seg.confidence,
          needsReview: seg.needsReview,
        },
        at: Date.now(),
      });
    }

    await prisma.liveChunk.update({ where: { id: chunk.id }, data: { status: "transcribed" } });
    const live = await prisma.liveSession.findUnique({
      where: { id: input.sessionId },
      select: { chunkSeq: true, cursorMs: true },
    });
    await prisma.liveSession.update({
      where: { id: input.sessionId },
      data: {
        chunkSeq: Math.max(input.seq + 1, live?.chunkSeq ?? 0),
        cursorMs: Math.max(input.endMs, live?.cursorMs ?? 0),
      },
    });
    runBus.publish(meetingId, { type: "live:chunk", seq: input.seq, status: "transcribed", at: Date.now() });

    return { ok: true, added, segments: toWrite };
  } catch (e) {
    const msg = (e as Error).message;
    await prisma.liveChunk.update({ where: { id: chunk.id }, data: { status: "failed", error: msg } });
    const mid = await meetingIdOf(input.sessionId);
    runBus.publish(mid, {
      type: "live:chunk",
      seq: input.seq,
      status: "failed",
      error: msg,
      at: Date.now(),
    });
    // 单片失败不抛出，让后续分片继续
    return { ok: false, added: 0, error: msg, segments: [] };
  }
}

/**
 * 分片 ASR 返回的是「片内相对时间」，必须加上该片在整场会议里的起点，
 * 否则每条话轮都从 0 开始，时间轴完全错乱。
 *
 * 起点来源优先级：
 * 1. 客户端上报的 startMs（MediaRecorder 用 Date.now() 差值算的，最准）
 * 2. 没有就用 seq * CHUNK_MS 估算
 */
function chunkOffsetOf(input: ChunkInput): number {
  if (Number.isFinite(input.startMs) && input.startMs >= 0) return input.startMs;
  return input.seq * CHUNK_MS;
}

async function meetingIdOf(sessionId: string): Promise<string> {
  const s = await prisma.liveSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new Error(`实时会话不存在：${sessionId}`);
  return s.meetingId;
}

/** 读取会话当前全部话轮（前端刷新后恢复用） */
export async function listLiveSegments(sessionId: string) {
  return prisma.liveSegment.findMany({ where: { sessionId }, orderBy: { seq: "asc" } });
}