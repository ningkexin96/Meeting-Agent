// Qwen-Audio-ASR 非实时转写（带说话人分离）—— 云 ASR 正式接入
//
// 与 DashScope 实时 WebSocket 的分工：
//   实时（lib/asr/dashscope.ts）  → 边说边出字，会议进行中
//   非实时（本文件）              → 上传音频后整段转写，带说话人分离
//
// 为什么用这个模型做说话人分离：
//   paraformer-realtime-v2 不返回 speaker_id，只能靠声纹聚类猜；
//   qwen-audio-3.1-asr-flash 原生返回 speaker_id，直接得到「谁和谁不是一个人」，
//   不需要注册声纹——这是项目原本缺的能力。

export type DiarizedTurn = {
  text: string;
  beginMs: number;
  endMs: number;
  /** 云服务给出的说话人编号，0/1/2... */
  speakerId: number;
  confidence: number;
};

export class DiarizationError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DiarizationError";
  }
}

type QwenAsrResponse = {
  output?: {
    text?: string;
    sentences?: {
      begin_time?: number;
      end_time?: number;
      text?: string;
      speaker_id?: number;
    }[];
    sentence?: { text?: string };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  code?: string;
  message?: string;
};

function apiKey(): string {
  const k = process.env.DASHSCOPE_API_KEY;
  if (!k) throw new DiarizationError("缺少 DASHSCOPE_API_KEY");
  return k;
}

function endpoint(): string {
  const base = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";
  return `${base.replace(/\/+$/, "")}/api/v1/services/aigc/multimodal-generation/generation`;
}

/**
 * 把整段音频转成带说话人编号的句子列表。
 *
 * 限制（来自官方文档）：
 * - 音频 ≤ 5 分钟、≤ 2GB（同步接口）
 * - 说话人分离只支持单声道
 *   超过 5 分钟需要改用 filetrans 异步接口，见 backlog。
 */
export async function transcribeWithDiarization(
  pcm: Buffer,
  sampleRate = 16000,
  opts: { withSpeaker?: boolean } = {},
): Promise<DiarizedTurn[]> {
  const key = apiKey();
  const withSpeaker = opts.withSpeaker !== false;

  // 服务端接受 base64 data URI
  const b64 = pcm.toString("base64");
  const dataUri = `data:audio/wav;base64,${b64}`;

  const body: Record<string, unknown> = {
    model: process.env.DASHSCOPE_DIARIZE_MODEL ?? "qwen-audio-3.1-asr-flash",
    input: {
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: dataUri } }],
        },
      ],
    },
    parameters: {
      format: "wav",
      sample_rate: String(sampleRate),
      ...(withSpeaker ? { speaker_diarization_enabled: true } : {}),
    },
  };

  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "X-DashScope-SSE": "disable",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.DASHSCOPE_ASR_TIMEOUT_MS ?? 180_000)),
  });

  const text = await res.text();

  if (!res.ok) {
    let hint = "";
    if (/model_not_supported|Unsupported model/i.test(text)) hint = "（该模型不支持此接口，检查 DASHSCOPE_DIARIZE_MODEL）";
    else if (/401|InvalidApiKey/i.test(text)) hint = "（API Key 无效）";
    else if (/403|Forbidden/i.test(text)) hint = "（无权限，检查百炼控制台是否开通该模型）";
    throw new DiarizationError(`ASR 接口返回 ${res.status}${hint}`, text.slice(0, 400));
  }

  let json: QwenAsrResponse;
  try {
    json = JSON.parse(text) as QwenAsrResponse;
  } catch {
    throw new DiarizationError("ASR 响应不是合法 JSON", text.slice(0, 300));
  }

  // 注意：响应可能是 { output: { output: {...} } } 或 { output: {...} }，两种都兼容
  const nested = (json.output as unknown as { output?: QwenAsrResponse["output"] })?.output;
  const out = nested ?? json.output;

  const sentences = out?.sentences;
  if (Array.isArray(sentences) && sentences.length > 0) {
    return sentences
      .filter((s) => s.text && s.text.trim())
      .map((s) => ({
        text: (s.text ?? "").trim(),
        beginMs: s.begin_time ?? 0,
        endMs: s.end_time ?? 0,
        speakerId: s.speaker_id ?? 0,
        confidence: 0.9,
      }));
  }

  // 没有 sentences（未开分离或短音频）时退回整段文本
  const full = out?.text ?? out?.sentence?.text;
  if (full && full.trim()) {
    return [{ text: full.trim(), beginMs: 0, endMs: 0, speakerId: 0, confidence: 0.85 }];
  }

  throw new DiarizationError("ASR 没有返回任何文本", text.slice(0, 300));
}