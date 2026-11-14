// 真实 ASR 适配器 —— 对应 issue #22
// 目标：把「重依赖」挡在进程外，Next.js 只负责 HTTP 调用。
//
// 支持的两种上游格式（都通过 env 切换，不改代码）：
//   1. openai   —— POST {baseUrl}/audio/transcriptions（multipart，file + model + response_format=verbose_json）
//                  whisper.cpp server、faster-whisper-server、OpenAI、各类云厂商的兼容网关都走这个
//   2. funasr   —— POST {baseUrl}/transcribe（JSON body，返回 {utterances:[{text,start,end,speaker}]}）
//                  FunASR runtime 的 HTTP 接口，或你自己包一层的结果
//
// 返回值统一成 AsrTurn[]，坐标单位统一成毫秒。

export type AsrTurn = {
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
};

export type AsrProviderKind = "openai" | "funasr";

export type RealAsrConfig = {
  kind: AsrProviderKind;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** 单次请求超时（毫秒），默认 180s，长会议要放宽 */
  timeoutMs?: number;
};

export class AsrError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AsrError";
  }
}

function cfg(): RealAsrConfig {
  const kind = (process.env.ASR_KIND ?? "openai") as AsrProviderKind;
  if (kind !== "openai" && kind !== "funasr") {
    throw new AsrError(`未知 ASR_KIND: ${kind}（只支持 openai / funasr）`);
  }
  const baseUrl = process.env.ASR_BASE_URL;
  if (!baseUrl) {
    throw new AsrError("缺少 ASR_BASE_URL。设为 ASR_PROVIDER=mock 可回退到预置转写。");
  }
  return {
    kind,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: process.env.ASR_API_KEY || undefined,
    model: process.env.ASR_MODEL || undefined,
    timeoutMs: Number(process.env.ASR_TIMEOUT_MS ?? 180_000),
  };
}

/** 秒 → 毫秒；兼容上游返回秒（whisper）或毫秒（funasr） */
function toMs(value: number, unit: "s" | "ms"): number {
  return Math.round(unit === "s" ? value * 1000 : value);
}

/**
 * OpenAI /audio/transcriptions 风格。
 * 期望 verbose_json：{ segments: [{ start, end, text }], ... }
 */
async function transcribeOpenAI(
  c: RealAsrConfig,
  audio: Blob,
  filename: string,
): Promise<AsrTurn[]> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", c.model ?? "whisper-1");
  form.append("response_format", "verbose_json");

  const res = await fetch(`${c.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(c.timeoutMs ?? 180_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AsrError(`ASR 服务返回 ${res.status}`, text.slice(0, 500));
  }

  let json: {
    segments?: { start?: number; end?: number; text?: string; no_speech_prob?: number }[];
    text?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new AsrError("ASR 返回不是合法 JSON", text.slice(0, 300));
  }

  // 有的实现不返回 segments，只有整段 text：退化成一整句，时间未知
  if (!json.segments?.length) {
    if (!json.text) throw new AsrError("ASR 返回既没有 segments 也没有 text");
    return [
      {
        speakerLabel: "speaker_0",
        startMs: 0,
        endMs: 0,
        text: json.text.trim(),
        confidence: 0.5,
      },
    ];
  }

  return json.segments
    .filter((s) => (s.text ?? "").trim())
    .map((s) => {
      const start = s.start ?? 0;
      const end = s.end ?? start;
      // no_speech_prob 越高越可能是静音/噪声，映射成置信度
      const conf = s.no_speech_prob != null ? 1 - s.no_speech_prob : 0.9;
      return {
        speakerLabel: "speaker_0", // whisper 本身不做说话人分离，交给 #23 声纹聚类
        startMs: toMs(start, "s"),
        endMs: toMs(end, "s"),
        text: (s.text ?? "").trim(),
        confidence: Math.max(0, Math.min(1, conf)),
      };
    });
}

/**
 * FunASR 风格：{ utterances: [{ text, start, end, spk }] }
 * FunASR 的 start/end 是毫秒，spk 形如 "0"/"1"。
 */
async function transcribeFunASR(
  c: RealAsrConfig,
  audio: Blob,
  filename: string,
): Promise<AsrTurn[]> {
  const form = new FormData();
  form.append("audio", audio, filename);
  if (c.model) form.append("model", c.model);

  const res = await fetch(`${c.baseUrl}/transcribe`, {
    method: "POST",
    headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(c.timeoutMs ?? 180_000),
  });

  const text = await res.text();
  if (!res.ok) throw new AsrError(`FunASR 返回 ${res.status}`, text.slice(0, 500));

  let json: {
    utterances?: { text?: string; start?: number; end?: number; spk?: string | number }[];
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new AsrError("FunASR 返回不是合法 JSON", text.slice(0, 300));
  }

  if (!json.utterances?.length) throw new AsrError("FunASR 没有返回 utterances");

  return json.utterances
    .filter((u) => (u.text ?? "").trim())
    .map((u) => {
      const spk = u.spk != null ? String(u.spk) : "0";
      return {
        speakerLabel: `speaker_${spk}`,
        startMs: Math.round(u.start ?? 0),
        endMs: Math.round(u.end ?? u.start ?? 0),
        text: (u.text ?? "").trim(),
        confidence: 0.9, // FunASR 的单句置信度不稳定，给固定值，低置信判断交给 #23
      };
    });
}

/** 读本地音频文件为 Blob（Next 的 fetch 支持 FormData + Blob） */
async function readAudio(filePath: string): Promise<{ blob: Blob; name: string }> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { existsSync } = await import("node:fs");

  // meeting.audioPath 存的是文件名（相对 STORAGE_DIR），这里解析成绝对路径。
  // 兼容：绝对路径、相对 STORAGE_DIR 的文件名、相对 storage/ 的路径。
  const storageDir = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : [path.join(storageDir, filePath), path.resolve(filePath)];

  const resolved = candidates.find((p) => existsSync(p));
  if (!resolved) {
    throw new AsrError(
      "音频文件不存在",
      `已尝试：${candidates.join(" | ")}`,
    );
  }

  const buf = await readFile(resolved);
  const name = path.basename(resolved);
  const ext = path.extname(name).toLowerCase();
  const mime =
    ext === ".wav"
      ? "audio/wav"
      : ext === ".mp3"
        ? "audio/mpeg"
        : ext === ".m4a"
          ? "audio/mp4"
          : ext === ".webm"
            ? "audio/webm"
            : "application/octet-stream";
  return { blob: new Blob([new Uint8Array(buf)], { type: mime }), name };
}

/** 真实转写入口：读取本地音频 → 调上游 → 归一化成 AsrTurn[] */
export async function transcribeWithRemoteAsr(audioPath: string): Promise<AsrTurn[]> {
  if (!audioPath) {
    throw new AsrError("该会议没有音频文件，无法调用真实 ASR");
  }
  const c = cfg();
  const { blob, name } = await readAudio(audioPath);

  const turns =
    c.kind === "openai" ? await transcribeOpenAI(c, blob, name) : await transcribeFunASR(c, blob, name);

  if (turns.length === 0) {
    throw new AsrError("ASR 成功但没有任何有效话轮（音频可能为空或全是噪声）");
  }
  return turns;
}