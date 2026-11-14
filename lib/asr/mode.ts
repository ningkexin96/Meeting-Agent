// 服务端读取当前 ASR 模式，供页面展示提示
export function getAsrModeInfo(): { provider: string; mode: string; demo: boolean } {
  const provider = process.env.ASR_PROVIDER ?? "mock";

  if (provider === "mock") {
    return {
      provider,
      mode: "预置转写（不解析音频）",
      demo: true,
    };
  }

  if (provider === "dashscope") {
    return {
      provider,
      mode: `阿里云百炼 ${process.env.DASHSCOPE_ASR_MODEL ?? "paraformer-realtime-v2"}`,
      demo: false,
    };
  }

  if (provider === "real") {
    return {
      provider,
      mode: `自定义 HTTP ASR（${process.env.ASR_KIND ?? "openai"}）`,
      demo: false,
    };
  }

  return { provider, mode: `未知模式：${provider}`, demo: true };
}