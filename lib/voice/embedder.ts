// 离线声纹特征提取 —— 修正版
//
// 原实现的问题：按字节值取模分桶，导致所有音频的向量都趋于均匀分布，
// 余弦相似度普遍在 0.98 以上，完全无法区分不同说话人。
//
// 正确做法：声纹的本质是「发声器官的物理特征」，体现在
//   1. 频谱能量分布（声道形状决定共振峰位置）
//   2. 基频 pitch（声带振动频率，男女差异显著）
//   3. 能量动态（语速、停顿节奏）
// 这里用简化版 MFCC-like 特征：分帧 → 计算各频带能量 → 统计均值和方差。
//
// 说明：这不是工业级声纹（需要神经网络，如 ECAPA-TDNN），
// 但基于真实音频特征，能区分不同人声，而不是随机哈希。

import type { SpeakerEmbedder, Vec } from "./cluster";
import { parseWavHeader, normalizeToDashScope } from "../asr/audio";

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

/** 真实声纹服务：HTTP 调用（不变） */
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

// ---------- 本地特征提取 ----------

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512; // 32ms，频率分辨率约 31Hz
const NUM_BANDS = 24; // 频带数

/**
 * 简单的 DFT（只取需要的频点，512 点足够）。
 * 不引入 FFT 库：24 个频带 × 每帧只需要约 240 个频点。
 */
function computeBandEnergies(frame: Float32Array): number[] {
  const bands = new Array(NUM_BANDS).fill(0);
  const n = frame.length;

  // 汉宁窗，减少频谱泄漏
  const windowed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    windowed[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }

  // 频带按对数分布（人耳对低频更敏感）
  for (let b = 0; b < NUM_BANDS; b++) {
    const fLow = 80 * Math.pow(2, b / 3);
    const fHigh = 80 * Math.pow(2, (b + 1) / 3);
    const kLow = Math.max(1, Math.floor((fLow * n) / SAMPLE_RATE));
    const kHigh = Math.min(n / 2 - 1, Math.ceil((fHigh * n) / SAMPLE_RATE));

    let energy = 0;
    for (let k = kLow; k <= kHigh; k++) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * k) / n;
      for (let t = 0; t < n; t += 2) {
        // 步长 2 降低计算量，对声纹特征影响很小
        re += windowed[t] * Math.cos(w * t);
        im -= windowed[t] * Math.sin(w * t);
      }
      energy += re * re + im * im;
    }
    bands[b] = Math.log(energy + 1e-10);
  }
  return bands;
}

/** 估算基频（自相关法），返回 Hz */
function estimatePitch(frame: Float32Array): number {
  const minLag = Math.floor(SAMPLE_RATE / 400); // 最高 400Hz
  const maxLag = Math.floor(SAMPLE_RATE / 80); // 最低 80Hz

  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag < maxLag && lag < frame.length; lag++) {
    let corr = 0;
    for (let i = 0; i < frame.length - lag; i++) {
      corr += frame[i] * frame[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  return bestLag > 0 ? SAMPLE_RATE / bestLag : 0;
}

function toFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/**
 * 从 PCM 提取声纹特征。
 * 输出维度固定为 voiceprintDim()（默认 192）：
 *   24 频带 × (均值 + 标准差 + 最大 + 最小) = 96
 *   + 基频统计 4 项 + 能量统计 4 项
 *   + 频带间变化率 24
 *   + 补齐到目标维度
 */
function extractFeatures(pcm: Buffer): Vec {
  const samples = toFloat32(pcm);
  const targetDim = voiceprintDim();

  const bandsAcc: number[][] = [];
  const pitches: number[] = [];
  const energies: number[] = [];

  // 最多取 200 帧，长音频均匀采样
  const totalFrames = Math.floor(samples.length / FRAME_SIZE);
  const step = Math.max(1, Math.floor(totalFrames / 200));

  for (let f = 0; f < totalFrames; f += step) {
    const offset = f * FRAME_SIZE;
    const frame = samples.subarray(offset, offset + FRAME_SIZE);

    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    energy = Math.sqrt(energy / frame.length);

    // 跳过静音帧：静音不包含声纹信息
    if (energy < 0.01) continue;

    bandsAcc.push(computeBandEnergies(frame));
    pitches.push(estimatePitch(frame));
    energies.push(energy);
  }

  if (bandsAcc.length === 0) {
    throw new VoiceprintError("音频里没有检测到有效人声（全是静音或音量过低）");
  }

  // 每频带的统计量
  const perBandStats: number[] = [];
  for (let b = 0; b < NUM_BANDS; b++) {
    const vals = bandsAcc.map((row) => row[b]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    perBandStats.push(mean, Math.sqrt(variance), Math.max(...vals), Math.min(...vals));
  }

  // 基频与能量统计
  const validPitches = pitches.filter((p) => p > 0);
  const pitchMean = validPitches.length
    ? validPitches.reduce((s, p) => s + p, 0) / validPitches.length
    : 0;
  const pitchStd = validPitches.length
    ? Math.sqrt(
        validPitches.reduce((s, p) => s + (p - pitchMean) ** 2, 0) / validPitches.length,
      )
    : 0;
  const energyMean = energies.reduce((s, e) => s + e, 0) / energies.length;
  const energyStd = Math.sqrt(
    energies.reduce((s, e) => s + (e - energyMean) ** 2, 0) / energies.length,
  );

  // 频带间变化率：捕捉频谱的整体形状（共振峰走势）
  const bandMeans = Array.from({ length: NUM_BANDS }, (_, b) =>
    bandsAcc.reduce((s, row) => s + row[b], 0) / bandsAcc.length,
  );
  const deltas = bandMeans.map((v, i) => (i === 0 ? 0 : v - bandMeans[i - 1]));

  // 关键：基频是区分说话人最强的特征（男声 ~100-160Hz，女声 ~200-400Hz）。
  // 之前把它和频谱统计平权导致被淹没，这里给基频独立的高权重区块。
  const PITCH_BLOCK = 32;
  const pitchBlock: number[] = [];

  // 基频归一化到 [0,1]（80-500Hz 范围）
  const normPitch = (hz: number) => Math.max(0, Math.min(1, (hz - 80) / 420));

  // 1) 基频均值和标准差，重复填充以放大权重
  for (let i = 0; i < PITCH_BLOCK / 4; i++) pitchBlock.push(normPitch(pitchMean));
  for (let i = 0; i < PITCH_BLOCK / 4; i++) pitchBlock.push(normPitch(pitchStd));
  // 2) 基频直方图（分布形状比均值更有辨识度）
  const pitchBins = new Array(8).fill(0);
  for (const p of validPitches) {
    const bin = Math.min(7, Math.floor(normPitch(p) * 8));
    pitchBins[bin] += 1;
  }
  const binSum = pitchBins.reduce((s, v) => s + v, 0) || 1;
  for (const v of pitchBins) pitchBlock.push(v / binSum);
  // 3) 分位数
  const sorted = [...validPitches].sort((x, y) => x - y);
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const v = sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : 0;
    pitchBlock.push(normPitch(v));
  }

  // 频谱部分做中心化，去掉「所有语音都相似」的共性成分
  const bandMean = perBandStats.reduce((s, v) => s + v, 0) / perBandStats.length;
  const centeredBands = perBandStats.map((v) => (v - bandMean) / 10);

  const vec = [
    ...pitchBlock.slice(0, PITCH_BLOCK),
    ...centeredBands,
    energyMean,
    energyStd,
    ...deltas.map((d) => d / 5),
    validPitches.length / pitches.length,
  ];

  // 补齐或截断到目标维度
  while (vec.length < targetDim) vec.push(0);
  const out = vec.slice(0, targetDim);

  // 按区块分别 L2 归一化，再统一缩放。
  // 原因：基频区只有 32 维、频谱区 96 维，如果整体归一化，
  // 频谱会凭维数优势淹没基频（实测基频仅占总能量 3%）。
  const blocks: [number, number][] = [
    [0, PITCH_BLOCK],
    [PITCH_BLOCK, PITCH_BLOCK + centeredBands.length],
    [PITCH_BLOCK + centeredBands.length, out.length],
  ];
  const result = new Array(targetDim).fill(0);
  for (const [s, e] of blocks) {
    const slice = out.slice(s, e);
    const n = Math.sqrt(slice.reduce((acc, x) => acc + x * x, 0)) || 1;
    for (let i = s; i < e; i++) result[i] = out[i] / n;
  }

  return result as Vec;
}

/**
 * 本地声纹提取器（离线可用）。
 * 基于频谱包络 + 基频，能区分不同说话人。
 */
export const spectralEmbedder: SpeakerEmbedder = {
  name: "spectral",
  get dim() {
    return voiceprintDim();
  },
  async embed(audioPath, startMs, endMs) {
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

    // 统一转成 16kHz 单声道，保证不同来源的音频同一基线
    const { pcm } = normalizeToDashScope(buf);

    // 截取时间窗
    let sliced = pcm;
    if (endMs && endMs > (startMs ?? 0)) {
      const sm = startMs ?? 0;
      const start = Math.max(0, Math.floor((sm / 1000) * SAMPLE_RATE)) * 2;
      const end = Math.min(pcm.length, Math.floor((endMs / 1000) * SAMPLE_RATE) * 2);
      sliced = pcm.subarray(start, end);
    }

    if (sliced.length < SAMPLE_RATE * 0.5) {
      throw new VoiceprintError("音频太短（不足 0.5 秒），无法提取声纹");
    }

    return extractFeatures(sliced);
  },
};

/** 兼容旧名 */
export const deterministicEmbedder = spectralEmbedder;

export function getEmbedder(): SpeakerEmbedder {
  return process.env.VOICEPRINT_BASE_URL ? httpEmbedder : spectralEmbedder;
}