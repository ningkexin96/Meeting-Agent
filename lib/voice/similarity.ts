// 声纹相似度 —— 特征分区加权距离
//
// 为什么不用单一余弦：
// 实测发现，把基频、频谱、能量混在一个向量里算余弦，
// 所有音频的相似度都在 0.98 以上（不同人 0.979，同一人 0.992），
// 区分度只有 0.013，而判定阈值是 0.72 —— 结果永远是"匹配"。
//
// 根本原因：余弦只看方向不看幅度。基频从 152Hz 变到 390Hz 是巨大差异，
// 但在 192 维向量里只占 3% 的能量。
//
// 解法：按特征区块分别计算差异，再按权重合成。
// 基频权重最高（最能区分人），频谱次之，能量最低。

export type Vec = number[];

/** 向量布局约定，与 embedder.ts 保持一致 */
export const LAYOUT = {
  pitchStart: 0,
  pitchEnd: 32,
  spectralStart: 32,
  spectralEnd: 128,
  restStart: 128,
  restEnd: 192,
} as const;

/**
 * 计算两个声纹向量的相似度（0-1，1 表示完全一致）。
 *
 * 对每个区块单独算余弦，再按权重加权：
 * 基频 0.6（男女声差异显著，最可靠）
 * 频谱 0.3（声道形状，受录音质量影响）
 * 其余 0.1（能量/语速，噪声大）
 */
export function voiceprintSimilarity(a: Vec, b: Vec): number {
  if (a.length !== b.length) return 0;

  // 维度不是标准布局时，退回整体余弦
  if (a.length < LAYOUT.restEnd) return cosine(a, b);

  const blockCos = (s: number, e: number) => cosine(a.slice(s, e), b.slice(s, e));

  const pitchSim = blockCos(LAYOUT.pitchStart, LAYOUT.pitchEnd);
  const specSim = blockCos(LAYOUT.spectralStart, LAYOUT.spectralEnd);
  const restSim = blockCos(LAYOUT.restStart, Math.min(LAYOUT.restEnd, a.length));

  // 加权平均，权重和归一化到 1
  return Math.max(0, 0.6 * pitchSim + 0.3 * specSim + 0.1 * restSim);
}

export function cosine(a: Vec, b: Vec): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}