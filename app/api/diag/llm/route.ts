// 模型连通性诊断 —— 填完 key 后用它一键验证，不用跑整场会议
// GET /api/diag/llm
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isMockLlm } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const cfg = {
    mock: isMockLlm(),
    baseUrl: process.env.LLM_BASE_URL ?? "",
    model: process.env.LLM_MODEL ?? "",
    hasKey: Boolean(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8),
    keyPrefix: process.env.LLM_API_KEY ? `${process.env.LLM_API_KEY.slice(0, 6)}…` : "",
  };

  if (cfg.mock) {
    return NextResponse.json({
      ok: false,
      stage: "config",
      message: "当前 MOCK_LLM=1，走的是确定性模拟输出，不会调用真实模型。把 .env 里 MOCK_LLM 改成 0 并填好 LLM_API_KEY 后重启。",
      config: cfg,
    });
  }

  if (!cfg.hasKey) {
    return NextResponse.json({
      ok: false,
      stage: "config",
      message: "缺少 LLM_API_KEY。请在 .env 里填入你的 DeepSeek key 后重启服务。",
      config: cfg,
    });
  }

  // 真正打一次最小请求
  const startedAt = Date.now();
  try {
    const { completeText } = await import("@/lib/llm");
    const reply = await completeText("只回复两个字：正常");
    return NextResponse.json({
      ok: true,
      stage: "done",
      message: "模型连通正常",
      latencyMs: Date.now() - startedAt,
      reply: reply.slice(0, 100),
      config: cfg,
    });
  } catch (e) {
    const err = e as Error & { message: string };
    // 把最常见的几类错误翻译成人话
    let hint = "";
    const msg = err.message ?? "";
    if (/401|invalid.*key|authenticat/i.test(msg)) hint = "API Key 无效或已过期";
    else if (/402|insufficient|balance/i.test(msg)) hint = "账户余额不足";
    else if (/429|rate.?limit/i.test(msg)) hint = "触发限流，稍后再试";
    else if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) hint = "网络无法访问该地址，检查 LLM_BASE_URL 或代理";
    else if (/model.*not.*found|does not exist/i.test(msg)) hint = "模型名不存在，检查 LLM_MODEL";

    return NextResponse.json({
      ok: false,
      stage: "request",
      message: msg,
      hint,
      latencyMs: Date.now() - startedAt,
      config: cfg,
    });
  }
}