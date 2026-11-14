// 声纹提取 —— 对应 issue #23
//
// 生产实现调用外部声纹服务（ECAPA-TDNN / 火山 / 阿里 / 自建），统一 HTTP 接口：
//   POST {VOICEPRINT_BASE_URL}/embed  multipart(audio[, start_ms, end_ms])
//   → { embedding: number[], dim: number }
//
// 没有声纹服务时用 deterministicEmbedder：
// 它从音频字节里算一个稳定的伪向量——不是真声纹，但能验证「上传音频 → 提取 →
// 聚类 → 标注待复核」整条链路可运行，也让演示不依赖外部服务。

import type { SpeakerEmbedder, Vec } from "./cluster";

export const voiceprintDim = () => Number(process.env.VOICEPRINT_DIM ?? 192);

class VoiceprintError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "VoiceprintError";
  }
}

/** 真实声纹服务：HTTP 调用 */
export const httpEmbedder: SpeakerEmbedder = {
  name: "http",
  get dim() {
    return voiceprintDim();
  },
  async embed(audioPath, startMs, endMs) {
    const base = process.env.VOICEPRINT_BASE_URL;
    if (!base) throw new VoiceprintError("缺少 VOICEPRINT_BASE_URL");

    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { existsSync } = await import("node:fs");

    const storageDir = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
    const resolved = path.isAbsolute(audioPath)
      ? audioPath
      : existsSync(path.join(storageDir, audioPath))
        ? path.join(storageDir, audioPath)
        : path.resolve(audioPath);

    const buf = await readFile(resolved);
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), path.basename(resolved));
    if (startMs != null) form.append("start_ms", String(startMs));
    if (endMs != null) form.append("end_ms", String(endMs));

    const res = await fetch(`${base.replace(/\/+$/, "")}/embed`, {
      method: "POST",
      headers: process.env.VOICEPRINT_API_KEY
        ? { Authorization: `Bearer ${process.env.VOICEPRINT_API_KEY}` }
        : undefined,
      body: form,
      signal: AbortSignal.timeout(Number(process.env.VOICEPRINT_TIMEOUT_MS ?? 60_000)),
    });

    const text = await res.text();
    if (!res.ok) throw new VoiceprintError(`声纹服务返回 ${res.status}`, text.slice(0, 300));

    const json = JSON.parse(text) as { embedding?: number[]; dim?: number };
    if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
      throw new VoiceprintError("声纹服务没有返回 embedding", text.slice(0, 300));
    }
    return json.embedding;
  },
};

/**
 * 确定性伪声纹（离线兜底）。
 *
 * 做法：把音频字节按维度分桶做非线性哈希，得到稳定向量。
 * 同一文件必得同一向量 → 可以用来验证聚类与入库；
 * 不同内容得到不同向量 → 模拟「不同人声纹不同」。
 * 注意：这不是真声纹，无法跨设备复用。
 */
export const deterministicEmbedder: SpeakerEmbedder = {
  name: "deterministic",
  get dim() {
    return voiceprintDim();
  },
  async embed(audioPath, startMs = 0, endMs = 0) {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { existsSync } = await import("node:fs");

    const storageDir = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
    const resolved = path.isAbsolute(audioPath)
      ? audioPath
      : existsSync(path.join(storageDir, audioPath))
        ? path.join(storageDir, audioPath)
        : path.resolve(audioPath);

    const buf = await readFile(resolved);
    const dim = voiceprintDim();
    const vec = new Array(dim).fill(0);

    // 把时间窗也混进去，让同一文件的不同片段得到不同向量
    const seed = (startMs * 31 + endMs * 17) % 9973;

    for (let i = 0; i < buf.length; i++) {
      const b = buf[i] ^ ((seed + i * 7) & 0xff);
      vec[b % dim] += (b & 0x0f) + 1;
    }
    // 混入片段特征，避免不同片段的向量完全一致
    for (let i = 0; i < dim; i++) {
      vec[i] += ((seed * (i + 1)) % 13) / 13;
    }

    // L2 归一化，便于直接算余弦
    const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return vec.map((x) => x / n) as Vec;
  },
};

export function getEmbedder(): SpeakerEmbedder {
  return process.env.VOICEPRINT_BASE_URL ? httpEmbedder : deterministicEmbedder;
}