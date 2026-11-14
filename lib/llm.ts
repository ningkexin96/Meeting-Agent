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
  completeSimple: (model: unknown, context: unknown) => Promise<unknown>;
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
export async function completeText(prompt: string): Promise<string> {
  const models = await getModels();
  const model = await getModel();
  const res = await models.completeSimple(model, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  const content = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}