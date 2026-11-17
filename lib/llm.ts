// 模型接入 —— 对应 issue #6
// 任意 OpenAI 兼容网关（DeepSeek / Qwen / Kimi / vLLM）都走这里，换网关只改环境变量
import type { Model } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "gateway";

export const isMockLlm = () => process.env.MOCK_LLM === "1";

// pi-ai 是 ESM-only（package.json 只有 import 条件，没有 require）。
// Next/webpack 走 bundle 没问题；但 tsx/CJS 冒烟脚本里静态 import 会解析失败，
// 所以统一改成运行时动态 import，两种执行环境都能用（类型用 as any 规避双条件导出差异）。
//
// 注意导入路径：ProviderStreams 工厂在 api/openai-completions.**lazy**，
// api/openai-completions 只导出 stream / streamSimple 两个函数本体，没有工厂。
// 路径写错会拿到 undefined，运行时表现为 "e is not a function"。
async function loadPi() {
  const [core, api] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/api/openai-completions.lazy"),
  ]);
  return {
    createModels: core.createModels,
    createProvider: core.createProvider,
    envApiKeyAuth: core.envApiKeyAuth,
    openAICompletionsApi: (api as unknown as { openAICompletionsApi: () => unknown })
      .openAICompletionsApi,
  };
}

function buildGatewayModel(): Model<"openai-completions"> {
  const id = process.env.LLM_MODEL || "deepseek-chat";
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

type ModelsLike = {
  setProvider: (p: unknown) => void;
  getModel: (provider: string, id: string) => Model<"openai-completions"> | undefined;
  completeSimple: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
  streamSimple: (model: unknown, context: unknown, options?: unknown) => unknown;
};

let cached: ModelsLike | null = null;

export async function getModels(): Promise<ModelsLike> {
  if (cached) return cached;
  const { createModels, createProvider, envApiKeyAuth, openAICompletionsApi } = await loadPi();
  const models = createModels() as unknown as ModelsLike;
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "OpenAI Compatible Gateway",
      baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
      auth: { apiKey: envApiKeyAuth("LLM API key", ["LLM_API_KEY"]) },
      models: [buildGatewayModel()],
      // 适配器签名在包内是 lazy 包装，这里按运行时形状传入
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: openAICompletionsApi() as any,
    }),
  );
  cached = models;
  return models;
}

export async function getModel() {
  const models = await getModels();
  const model = models.getModel(PROVIDER_ID, process.env.LLM_MODEL || "deepseek-chat");
  if (!model) {
    throw new Error(
      `模型未找到：provider=${PROVIDER_ID} model=${process.env.LLM_MODEL}。请检查 .env 里的 LLM_MODEL。`,
    );
  }
  return model;
}

/** 真实模型一次性补全（mock 模式下不会被调用） */
export async function completeText(
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const models = await getModels();
  const model = await getModel();
  const res = await models.completeSimple(model, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    // 重试由 lib/agent/llm-call.ts 统一控制，避免底层 SDK 与上层重复重试。
    maxRetries: 0,
  });
  const content = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/**
 * 流式增量事件的统一形状（issue #29）。
 *
 * 刻意不暴露 pi-ai 自己的 AssistantMessageEvent：这个类型里有 toolcall、thinking 等
 * 本项目用不到的字段，暴露出去会让调用方被迫关心 SDK 细节。
 * 这里只保留三种：文本增量 / 结束 / 出错。
 */
export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

type RawStream = AsyncIterable<{
  type: string;
  delta?: string;
  content?: string;
  partial?: { content?: { type: string; text?: string }[] };
  error?: { message?: string };
}>;

/**
 * 真实模型流式补全。
 *
 * 三个约束，都是会中问答场景的真实需求：
 * 1. **可以中途放弃**：用户看到答案不对就想换问题，信号一断上游请求必须真的停止，
 *    否则模型仍在计费、连接一直挂着。
 * 2. **首字超时**：只看整体超时不够。上游如果先返回 200 再长时间不吐内容，
 *    用户会盯着一个不动的光标。这里用「整体超时 + 首字超时」双保险。
 * 3. **完整文本要能拿到**：流式只是展示方式的改变，调用方仍然需要完整答案
 *    去写审计、做兜底判断，所以 done 事件也带上全文。
 */
export async function* streamText(
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; firstTokenMs?: number } = {},
): AsyncGenerator<StreamChunk> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  const firstTokenMs = opts.firstTokenMs ?? Number(process.env.LLM_FIRST_TOKEN_MS ?? 15_000);

  const controller = new AbortController();
  const abortWith = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  // 外部信号（用户取消 / 客户端断开）透传给上游
  const onExternalAbort = () => abortWith(new Error("已取消"));
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const totalTimer = setTimeout(
    () => abortWith(new Error(`模型调用超时（${timeoutMs}ms）`)),
    timeoutMs,
  );
  let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => abortWith(new Error(`模型 ${firstTokenMs}ms 内没有返回任何内容`)),
    firstTokenMs,
  );

  let text = "";
  let finished = false;

  try {
    const models = await getModels();
    const model = await getModel();

    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { signal: controller.signal, timeoutMs, maxRetries: 0 },
    ) as RawStream;

    for await (const ev of stream) {
      if (ev.type === "text_delta" && ev.delta) {
        // 首个增量到达：撤掉首字超时
        if (firstTimer) {
          clearTimeout(firstTimer);
          firstTimer = null;
        }
        text += ev.delta;
        yield { type: "delta", text: ev.delta };
        continue;
      }
      if (ev.type === "error") {
        throw new Error(ev.error?.message || "模型返回错误");
      }
      if (ev.type === "done") {
        // 极端情况：上游只发 done、不发任何 text_delta（例如被截断），
        // 这时从 partial 里兜底取一次全文，避免"什么都没输出"
        if (!text) {
          text = (ev.partial?.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
          if (text) yield { type: "delta", text };
        }
        finished = true;
        break;
      }
    }

    if (!text.trim()) throw new Error("模型返回了空内容");
    yield { type: "done", text };
  } catch (e) {
    // 中止时优先报告中止原因（超时/取消），而不是底层抛出的 "aborted"
    const reason = controller.signal.aborted
      ? ((controller.signal.reason as Error)?.message ?? "已取消")
      : finished
        ? (e as Error).message
        : (e as Error).message;
    yield { type: "error", message: reason };
  } finally {
    clearTimeout(totalTimer);
    if (firstTimer) clearTimeout(firstTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    // 无论正常结束还是中途退出，都必须关掉上游，否则连接会泄漏
    abortWith(new Error("结束"));
  }
}