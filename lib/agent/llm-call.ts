// 真实模型调用的健壮性封装 —— 对应 issue #22（真实 LLM 路径加固）
//
// 真实模型和 mock 的差别不只是"会不会生成"，而是：
// 1. 输出可能是 markdown 包裹的 JSON、可能带解释文字、可能截断
// 2. 会超时、会限流、会偶尔返回空
// 3. 调用有成本，需要记录 token 用量
// 这些都必须在这里兜住，否则一接真实模型整条链路就崩。

import { isMockLlm } from "@/lib/llm";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** 调用记录，用于可观测（token / 耗时） */
export type LlmCallRecord = {
  purpose: "summarize" | "extract" | "answer";
  promptChars: number;
  outputChars: number;
  durationMs: number;
  ok: boolean;
  error?: string;
};

const records: LlmCallRecord[] = [];

export function recordCall(r: LlmCallRecord) {
  records.push(r);
  if (records.length > 200) records.shift();
}

export function getCallRecords() {
  return [...records];
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 真实模型常见返回形态：
 *   ```json\n{...}\n```
 *   好的，结果如下：\n{...}
 *   {...}\n希望有帮助
 * 这里按「先找代码块，再找首个 { 到最后一个 }」的顺序尝试。
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = raw.trim();

  // 1. markdown 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* 继续尝试 */
    }
  }

  // 2. 首个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      return JSON.parse(slice) as T;
    } catch (e) {
      // 3. 常见问题：JSON 里有尾随逗号
      const cleaned = slice.replace(/,\s*([}\]])/g, "$1");
      try {
        return JSON.parse(cleaned) as T;
      } catch {
        throw new LlmError(
          "模型返回的内容不是合法 JSON",
          `解析失败：${(e as Error).message}；原文前 200 字：${text.slice(0, 200)}`,
        );
      }
    }
  }

  throw new LlmError("模型返回里找不到 JSON 对象", text.slice(0, 200));
}

/** 带超时与错误包装的真实模型调用 */
export async function callModel(
  prompt: string,
  purpose: LlmCallRecord["purpose"],
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<string> {
  if (isMockLlm()) throw new LlmError("当前是 MOCK_LLM=1，不应调用真实模型");

  const timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  const maxRetries = opts.maxRetries ?? Number(process.env.LLM_MAX_RETRIES ?? 2);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new LlmError(`模型调用超时（${timeoutMs}ms）`));
    }, timeoutMs);

    try {
      const { completeText } = await import("@/lib/llm");
      // AbortSignal 会传给底层 HTTP 请求；超时不是“停止等待”，而是真正取消请求。
      const text = await completeText(prompt, { signal: controller.signal, timeoutMs });

      if (!text || !text.trim()) throw new LlmError("模型返回了空内容");
      clearTimeout(timeout);

      recordCall({
        purpose,
        promptChars: prompt.length,
        outputChars: text.length,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
      return text;
    } catch (e) {
      clearTimeout(timeout);
      lastErr = controller.signal.aborted
        ? new LlmError(`模型调用超时（${timeoutMs}ms）`)
        : e;
      recordCall({
        purpose,
        promptChars: prompt.length,
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: (lastErr as Error).message,
      });
      // 最后一次失败直接抛出，否则退避重试
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }

  throw new LlmError(
    `模型调用失败（已重试 ${maxRetries} 次）：${(lastErr as Error)?.message ?? "未知错误"}`,
    (lastErr as { detail?: string })?.detail,
  );
}