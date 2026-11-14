// ASR 诊断 —— 检查当前转写链路配置是否可用
// GET /api/diag/asr
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const provider = process.env.ASR_PROVIDER ?? "mock";
  const base = {
    provider,
    realtimeWs: "ws://<host>/api/live/ws",
  };

  if (provider === "mock") {
    return NextResponse.json({
      ok: true,
      ...base,
      mode: "预置转写（不解析音频）",
      message: "当前用预置转写数据，任何音频都会得到同一份文本。",
    });
  }

  if (provider === "dashscope") {
    const hasKey = Boolean(process.env.DASHSCOPE_API_KEY);
    return NextResponse.json({
      ok: hasKey,
      ...base,
      mode: "阿里云百炼实时语音识别",
      model: process.env.DASHSCOPE_ASR_MODEL ?? "paraformer-realtime-v2",
      baseUrl: process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com",
      hasKey,
      requirements: "音频须为 16000Hz / 单声道 / 16bit WAV；实时模式由浏览器直接产出 PCM",
      message: hasKey ? "配置完整" : "缺少 DASHSCOPE_API_KEY",
    });
  }

  if (provider === "real") {
    return NextResponse.json({
      ok: Boolean(process.env.ASR_BASE_URL),
      ...base,
      mode: "自定义 HTTP ASR",
      baseUrl: process.env.ASR_BASE_URL ?? "",
      kind: process.env.ASR_KIND ?? "openai",
      message: process.env.ASR_BASE_URL ? "配置完整" : "缺少 ASR_BASE_URL",
    });
  }

  return NextResponse.json({ ok: false, ...base, message: `未知的 ASR_PROVIDER：${provider}` });
}