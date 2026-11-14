// 文本向量化 —— 对应 issue #25
//
// 生产实现走外部 embedding 服务（OpenAI /text/embeddings 兼容，BGE / text-embedding-3 都行）：
//   POST {EMBEDDING_BASE_URL}/embeddings { model, input: string[] }
//   → { data: [{ embedding: number[] }] }
//
// 没有 embedding 服务时用 deterministicEmbedder：
// 中文按字符 bigram 做哈希向量（hashing trick），虽不是语义向量，
// 但能让「检索 → 排序 → 引用」整条链路离线跑通并做基线对比。

export type EmbeddingProvider = {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
};

export const embeddingDim = () => Number(process.env.EMBEDDING_DIM ?? 256);

class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** 中文友好的文本切分：字符 bigram + 英文按词 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // 英文/数字按词
  for (const m of lower.matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);

  // 中文按 bigram
  for (const seg of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = seg[0];
    if (s.length === 1) {
      tokens.push(s);
      continue;
    }
    for (let i = 0; i + 2 <= s.length; i++) tokens.push(s.slice(i, i + 2));
  }
  return tokens;
}

/** 稳定的字符串哈希（FNV-1a），保证跨进程一致 */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 离线兜底：bigram 哈希向量 + L2 归一化 */
export const deterministicEmbedder: EmbeddingProvider = {
  name: "bigram-hash",
  get dim() {
    return embeddingDim();
  },
  async embed(texts: string[]) {
    const dim = embeddingDim();
    return texts.map((text) => {
      const vec = new Array(dim).fill(0);
      for (const tok of tokenize(text)) {
        vec[hash(tok) % dim] += 1;
      }
      const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
      return vec.map((x) => x / n);
    });
  },
};

/** 真实 embedding 服务（OpenAI 兼容） */
export const httpEmbedder: EmbeddingProvider = {
  name: "http",
  get dim() {
    return embeddingDim();
  },
  async embed(texts: string[]) {
    const base = process.env.EMBEDDING_BASE_URL;
    if (!base) throw new EmbeddingError("缺少 EMBEDDING_BASE_URL");

    const res = await fetch(`${base.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.EMBEDDING_API_KEY
          ? { Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: texts,
      }),
      signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS ?? 60_000)),
    });

    const text = await res.text();
    if (!res.ok) throw new EmbeddingError(`embedding 服务返回 ${res.status}：${text.slice(0, 200)}`);

    const json = JSON.parse(text) as { data?: { embedding: number[] }[] };
    if (!json.data?.length) throw new EmbeddingError("embedding 服务没有返回 data");

    return json.data.map((d) => {
      const v = d.embedding;
      if (!Array.isArray(v) || v.length === 0) throw new EmbeddingError("返回了空向量");
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
  },
};

export function getEmbeddingProvider(): EmbeddingProvider {
  if (process.env.EMBEDDING_PROVIDER === "http" && process.env.EMBEDDING_BASE_URL) return httpEmbedder;
  return deterministicEmbedder;
}