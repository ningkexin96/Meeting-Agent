// 声纹与说话人聚类 —— 对应 issue #23
//
// 设计要点：
// 1. 声纹提取要么来自「注册音频」，要么来自「会议中的说话人分段」，统一走 SpeakerEmbedder 接口。
// 2. 聚类用余弦相似度 + 阈值判定，而不是 k-means 这类需要预设簇数的算法——
//    一个会议里究竟几个人说话，事先并不知道。
// 3. 每一步都保留置信度：低于阈值不硬猜，标记 needs_review 交给人工（对应架构里的人工兜底）。
//
// 规模只有十几人，暴力比对足够，不引入向量库（那是 backlog #25 的事）。

export type Vec = number[];

export type ClusteredSpeaker = {
  /** 聚类后的稳定标签 speaker_0 / speaker_1 ... */
  label: string;
  userId: string | null;
  displayName: string;
  confidence: number;
  needsReview: boolean;
  /** 该聚类包含 ASR 原始标签，用于回填话轮 */
  asrLabels: string[];
  segmentCount: number;
};

export type SegmentForClustering = {
  /** ASR 原始说话人标签 */
  speakerLabel: string;
  embedding: Vec;
};

export type GalleryEntry = { userId: string; displayName: string; embedding: Vec };

export type ClusterOptions = {
  /** 判定为同一人的余弦相似度阈值，默认 0.72（ECAPA 经验值） */
  threshold?: number;
  /** 低于该值标记 needs_review */
  reviewThreshold?: number;
  gallery?: GalleryEntry[];
};

export interface SpeakerEmbedder {
  name: string;
  dim: number;
  embed(audioPath: string, startMs?: number, endMs?: number): Promise<Vec>;
}

/* ------------------------------ 向量运算 ------------------------------ */

export function cosine(a: Vec, b: Vec): number {
  if (a.length !== b.length) throw new Error(`维度不一致：${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalize(v: Vec): Vec {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
}

export function centroid(vectors: Vec[]): Vec {
  if (vectors.length === 0) throw new Error("无法对空集合求质心");
  const dim = vectors[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) throw new Error(`质心维度不一致：${v.length} vs ${dim}`);
    v.forEach((x, i) => (acc[i] += x));
  }
  return normalize(acc.map((x) => x / vectors.length));
}

function envNumber(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/* ------------------------------ 聚类 ------------------------------ */

/**
 * 把「ASR 原始说话人标签 + 声纹」聚类成参会人。
 *
 * 步骤：
 * 1. 按原始标签分组求质心（同一标签大概率同一人）
 * 2. 不同标签若相似度 ≥ threshold 则合并（ASR 可能把同一人拆成两个标签）
 * 3. 与声纹库比对认领身份；认不出就保留为「未知参会者」并标 needs_review，绝不硬套
 */
export function clusterSpeakers(
  segments: SegmentForClustering[],
  options: ClusterOptions = {},
): ClusteredSpeaker[] {
  const threshold = options.threshold ?? envNumber("VOICEPRINT_THRESHOLD", 0.72);
  const reviewThreshold = options.reviewThreshold ?? envNumber("VOICEPRINT_REVIEW_THRESHOLD", 0.6);

  if (segments.length === 0) return [];

  // 1. 按原始标签分组
  const byLabel = new Map<string, Vec[]>();
  for (const s of segments) {
    const arr = byLabel.get(s.speakerLabel) ?? [];
    arr.push(s.embedding);
    byLabel.set(s.speakerLabel, arr);
  }

  // 2. 合并相近标签，同时记录每个聚类成员（原始标签 + 计数）
  const merged: { asrLabels: string[]; vecs: Vec[]; count: number }[] = [];
  for (const [label, vecs] of byLabel) {
    const c = centroid(vecs);
    const hit = merged.find((m) => cosine(centroid(m.vecs), c) >= threshold);
    if (hit) {
      hit.asrLabels.push(label);
      hit.vecs.push(...vecs);
      hit.count += vecs.length;
    } else {
      merged.push({ asrLabels: [label], vecs: [...vecs], count: vecs.length });
    }
  }

  // 3. 认领身份
  const speakers: ClusteredSpeaker[] = merged.map((m) => {
    const emb = centroid(m.vecs);
    let best: { userId: string; displayName: string; score: number } | null = null;
    for (const g of options.gallery ?? []) {
      const score = cosine(g.embedding, emb);
      if (!best || score > best.score) best = { userId: g.userId, displayName: g.displayName, score };
    }

    if (best && best.score >= threshold) {
      return {
        label: "",
        userId: best.userId,
        displayName: best.displayName,
        confidence: best.score,
        needsReview: best.score < reviewThreshold,
        asrLabels: m.asrLabels,
        segmentCount: m.count,
      };
    }

    return {
      label: "",
      userId: null,
      displayName: "未知参会者",
      confidence: best?.score ?? 0,
      needsReview: true,
      asrLabels: m.asrLabels,
      segmentCount: m.count,
    };
  });

  // 4. 按发言量排序，主讲人排前面；未知参会者编号
  speakers.sort((a, b) => b.segmentCount - a.segmentCount);
  let unknownIdx = 0;
  return speakers.map((s, i) => {
    if (!s.userId) {
      unknownIdx++;
      return { ...s, label: `speaker_${i}`, displayName: `未知参会者 ${unknownIdx}` };
    }
    return { ...s, label: `speaker_${i}` };
  });
}

/** 原始 ASR 标签 → 聚类后的 label */
export function buildLabelMapping(speakers: ClusteredSpeaker[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of speakers) {
    for (const asrLabel of s.asrLabels) map.set(asrLabel, s.label);
  }
  return map;
}