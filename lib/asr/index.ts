// 转写链路 —— 对应 issue #7 / #8 / #22
// ASR adapter 接口化：mock（预置 JSON）、real（HTTP 上游）都实现同一接口
import { SAMPLE_SPEAKERS, SAMPLE_TRANSCRIPT, type SampleTurn } from "./samples";
import { AsrError, transcribeWithRemoteAsr } from "./real";

export type { AsrTurn } from "./real";
import type { AsrTurn } from "./real";

export interface AsrAdapter {
  name: string;
  /** 返回归一化的话轮（毫秒坐标） */
  transcribe(audioPath: string): Promise<AsrTurn[]>;
}

export class AsrUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AsrUnavailableError";
  }
}

/** mock：不真的解析音频，直接返回预置会议转写，保证演示稳定 */
export const mockAsr: AsrAdapter = {
  name: "mock",
  async transcribe() {
    return SAMPLE_TRANSCRIPT.map((t: SampleTurn) => ({
      speakerLabel: t.speaker,
      startMs: t.startMs,
      endMs: t.endMs,
      text: t.text,
      confidence: t.confidence ?? 0.95,
    }));
  },
};

/** real：调用外部 ASR HTTP 服务（OpenAI / FunASR 两种风格，见 lib/asr/real.ts） */
export const realAsr: AsrAdapter = {
  name: "real",
  async transcribe(audioPath: string) {
    return transcribeWithRemoteAsr(audioPath);
  },
};

/** dashscope：阿里云百炼实时语音识别（WebSocket） */
export const dashscopeAsr: AsrAdapter = {
  name: "dashscope",
  async transcribe(audioPath: string) {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { existsSync } = await import("node:fs");
    const { preparePcmForDashScope } = await import("./audio");
    const { transcribePcm } = await import("./dashscope");

    if (!audioPath) throw new AsrError("该会议没有音频文件，无法调用 ASR");

    const storageDir = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
    const resolved = path.isAbsolute(audioPath)
      ? audioPath
      : existsSync(path.join(storageDir, audioPath))
        ? path.join(storageDir, audioPath)
        : path.resolve(audioPath);

    if (!existsSync(resolved)) throw new AsrError("音频文件不存在", resolved);

    const buf = await readFile(resolved);
    // 格式校验失败会抛出带修复建议的 AudioFormatError
    const { pcm, info } = preparePcmForDashScope(buf);
    const turns = await transcribePcm(pcm, info.durationMs);

    if (turns.length === 0) {
      throw new AsrError("DashScope 没有返回任何识别结果（音频可能无有效语音）");
    }

    return turns.map((t) => ({
      speakerLabel: t.speakerLabel,
      startMs: t.beginMs,
      endMs: t.endMs,
      text: t.text,
      confidence: 0.9,
    }));
  },
};

export function getAsr(): AsrAdapter {
  const kind = process.env.ASR_PROVIDER ?? "mock";
  if (kind === "dashscope") return dashscopeAsr;
  if (kind === "real") return realAsr;
  return mockAsr;
}

/**
 * 带降级的转写：真实 ASR 失败时，若允许降级则回退到预置转写。
 * 返回 usedFallback，让上层能把「降级」这件事显示到界面上，而不是静默失败。
 */
export async function transcribeWithFallback(
  audioPath: string | null,
  opts: { allowFallback?: boolean } = {},
): Promise<{ turns: AsrTurn[]; adapter: string; usedFallback: boolean; error?: string }> {
  const adapter = getAsr();

  // mock 模式直接返回
  if (adapter.name === "mock") {
    return { turns: await adapter.transcribe(audioPath ?? ""), adapter: "mock", usedFallback: false };
  }

  try {
    return { turns: await adapter.transcribe(audioPath ?? ""), adapter: adapter.name, usedFallback: false };
  } catch (e) {
    const msg = e instanceof AsrError ? `${e.message}${e.detail ? `：${e.detail}` : ""}` : (e as Error).message;
    const allowFallback = opts.allowFallback ?? process.env.ASR_FALLBACK_TO_MOCK === "1";
    if (!allowFallback) {
      throw new AsrUnavailableError(`ASR 调用失败：${msg}`, e);
    }
    console.warn(`[asr] 真实 ASR 失败，降级到预置转写：${msg}`);
    return {
      turns: await mockAsr.transcribe(audioPath ?? ""),
      adapter: "mock(降级)",
      usedFallback: true,
      error: msg,
    };
  }
}

/**
 * 话轮合并：同 speaker、间隔 < gapMs、且文本不是明显的独立句子时合并。
 *
 * 重要：ASR 若不返回说话人（whisper 全部标 speaker_0），合并会把整场会议
 * 压成一条话轮，摘要和引用就失去意义。所以这里只合并「短句碎片」，
 * 句末标点结尾的完整句子保持独立。
 */
export function mergeTurns(turns: AsrTurn[], gapMs = 2000): AsrTurn[] {
  const out: AsrTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    const isFragment = !/[。！？；]$/.test(last?.text ?? "");
    const continuous = last && t.startMs - last.endMs < gapMs;
    if (last && last.speakerLabel === t.speakerLabel && continuous && isFragment) {
      last.endMs = t.endMs;
      last.text = `${last.text}${t.text}`;
      last.confidence = Math.min(last.confidence, t.confidence);
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/**
 * 说话人 → 参会人映射（issue #8）。
 * 注意：真实 ASR 的 speakerLabel 与预置样例不是同一套编号，
 * 所以这里只对「mock 数据源」使用预置姓名；真实模式下用通用名，
 * 更准确的归属交给 #23 声纹聚类。
 */
export function mapParticipants(turns: AsrTurn[], threshold = 0.6, source: "mock" | "real" = "mock") {
  const labels = Array.from(new Set(turns.map((t) => t.speakerLabel)));
  return labels.map((label, i) => {
    const known = source === "mock" ? SAMPLE_SPEAKERS[label] : undefined;
    const confidence = turns
      .filter((t) => t.speakerLabel === label)
      .reduce((acc, t) => Math.min(acc, t.confidence), 1);
    return {
      speakerLabel: label,
      displayName: known?.displayName ?? `参会者 ${i + 1}`,
      confidence,
      needsReview: confidence < threshold,
    };
  });
}