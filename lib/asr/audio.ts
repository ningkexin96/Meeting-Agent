// WAV 音频工具 —— 为 DashScope 实时 ASR 准备合规音频
//
// DashScope 要求：单声道、16kHz、16-bit PCM。
// 浏览器上传的可能是 mp3/m4a/webm，浏览器录音是 webm/opus。
// 本机没有 ffmpeg，所以这里只做「已经是 WAV 时的校验与规整」，
// 非 WAV 格式明确报错并提示需要 ffmpeg 或改用浏览器端直接产 PCM。
//
// 说明：这是刻意的取舍。为了不在生产路径上依赖 ffmpeg，实时链路走
// 「浏览器端录音 → 后端转发原始 PCM」，离线链路要求 WAV。

export class AudioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioFormatError";
  }
}

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
};

/** 解析 WAV 头，不解析内容 */
export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 44) throw new AudioFormatError("音频太短，不是合法 WAV");
  if (buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new AudioFormatError("不是 WAV 文件（缺少 RIFF 头）。请转成 WAV 或使用实时录音模式。");
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new AudioFormatError("不是 WAV 文件（缺少 WAVE 标识）");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      // 有些文件 size 字段写着 0 或越界，按剩余长度兜底
      dataLength = Math.min(size || buf.length - body, buf.length - body);
      break;
    }

    offset = body + size + (size % 2); // chunk 按偶数字节对齐
  }

  if (dataOffset < 0) throw new AudioFormatError("WAV 里找不到 data 段");
  if (!sampleRate || !channels || !bitsPerSample) {
    throw new AudioFormatError("WAV 的 fmt 段不完整");
  }

  const bytesPerFrame = channels * (bitsPerSample / 8);
  const frames = Math.floor(dataLength / bytesPerFrame);

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataLength,
    durationMs: Math.round((frames / sampleRate) * 1000),
  };
}

/** 提取纯 PCM 数据 */
export function extractPcm(buf: Buffer, info: WavInfo): Buffer {
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
}

/** 是否满足 DashScope 要求 */
export function isDashScopeCompatible(info: WavInfo): boolean {
  return info.sampleRate === 16000 && info.channels === 1 && info.bitsPerSample === 16;
}

/**
 * 校验并返回可发送的 PCM。
 * 不合规时给出明确的修复建议，而不是让上游返回难懂的 400。
 */
export function preparePcmForDashScope(buf: Buffer): { pcm: Buffer; info: WavInfo } {
  const info = parseWavHeader(buf);
  if (!isDashScopeCompatible(info)) {
    throw new AudioFormatError(
      `音频格式不满足要求：当前 ${info.sampleRate}Hz / ${info.channels} 声道 / ${info.bitsPerSample}bit，` +
        `需要 16000Hz / 单声道 / 16bit。建议用 ffmpeg 转换：` +
        `ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav`,
    );
  }
  return { pcm: extractPcm(buf, info), info };
}

/** 把 PCM 按固定时长切成帧（DashScope 建议每 100ms 一包） */
export function chunkPcm(pcm: Buffer, sampleRate = 16000, chunkMs = 100): Buffer[] {
  const bytesPerMs = (sampleRate * 2) / 1000; // 单声道 16bit
  const chunkSize = Math.floor(bytesPerMs * chunkMs);
  const out: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize) {
    out.push(pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
  }
  return out;
}

/** 生成一个最简 WAV 头，用于把纯 PCM 包装成可播放/可上传的文件 */
export function buildWavHeader(dataLength: number, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * 线性插值重采样（16bit 单声道 PCM）。
 *
 * 为什么自己写而不用 ffmpeg：
 * 生产环境不该额外依赖外部二进制；会议音频重采样对音质要求不高，
 * 线性插值足够，且能保证「用户上传任意采样率的 WAV 都能用」。
 */
export function resamplePcm(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;

  const inFrames = Math.floor(pcm.length / 2);
  const outFrames = Math.floor((inFrames * toRate) / fromRate);
  const out = Buffer.alloc(outFrames * 2);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outFrames; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inFrames - 1);
    const frac = srcPos - i0;

    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const v = s0 + (s1 - s0) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

/** 下混多声道为单声道 */
export function downmixToMono(pcm: Buffer, channels: number): Buffer {
  if (channels === 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcm.readInt16LE((i * channels + c) * 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return out;
}

/**
 * 把任意 WAV 规整成 DashScope 要求的 16kHz 单声道 16bit。
 * 会自动下混声道、重采样，而不是直接报错要求用户自己转。
 */
export function normalizeToDashScope(buf: Buffer): { pcm: Buffer; durationMs: number; converted: boolean } {
  const info = parseWavHeader(buf);

  if (info.bitsPerSample !== 16) {
    throw new AudioFormatError(
      `仅支持 16bit PCM，当前是 ${info.bitsPerSample}bit。建议用 ffmpeg 转成 16bit。`,
    );
  }

  let pcm = extractPcm(buf, info);
  const needsMono = info.channels !== 1;
  const needsResample = info.sampleRate !== 16000;

  if (needsMono) pcm = downmixToMono(pcm, info.channels);
  if (needsResample) pcm = resamplePcm(pcm, info.sampleRate, 16000);

  const frames = Math.floor(pcm.length / 2);
  return {
    pcm,
    durationMs: Math.round((frames / 16000) * 1000),
    converted: needsMono || needsResample,
  };
}