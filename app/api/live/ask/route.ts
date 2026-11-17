// 会中问答 API —— 对应 issue #27 / #28 / #29
// POST /api/live/ask   （SSE 流式响应）
//   body: { sessionId?, meetingId?, question, recentSegments? }
//   事件: meta → delta* → final（或 error）
//
// 为什么用 SSE 而不是 WebSocket：
//   1. 这是一问一答的单向推送，不需要全双工；
//   2. 项目里已有 SSE 先例（/api/meetings/[id]/stream、/api/live/[id]/stream），
//      包括 15 秒心跳防止代理层把空闲连接掐掉，直接沿用同一套写法；
//   3. EventSource 不支持 POST，所以这里用 fetch + ReadableStream 读，
//      换来的是可以取消（AbortController）——会中用户看到答案不对就要能立刻停。
//
// 权限：与「触发 Agent」同一能力（agent:run），viewer 只读不能提问——
// 提问会产生模型调用成本并写入审计，属于会中交互行为，不是浏览行为。
import { guard } from "@/lib/auth/guard";
import { prepareQuestion, streamAnswer, AskError } from "@/lib/live/qa";

export const dynamic = "force-dynamic";
// 流式响应可以开很久，但总时长仍受 LIVE_QA_TIMEOUT_MS 控制；这里给足余量
export const maxDuration = 60;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 反向代理（nginx 等）默认会缓冲响应，必须显式关掉，否则"流式"会变成一次性吐出
  "X-Accel-Buffering": "no",
};

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(req: Request) {
  const g = await guard("agent:run");
  if (!g.ok) return g.response;
  const { session } = g;

  let body: {
    sessionId?: unknown;
    meetingId?: unknown;
    question?: unknown;
    recentSegments?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "请求体不是合法 JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // 准备阶段可能抛出可读的业务错误（400/404）。
  // 这一步必须在建立 SSE 之前完成，否则状态码只能写成 200，
  // 前端拿不到「会话不存在」这类明确信息。
  let prepared;
  try {
    prepared = await prepareQuestion({
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
      sessionId: typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined,
      meetingId: typeof body.meetingId === "string" && body.meetingId ? body.meetingId : undefined,
      question: body.question,
      recentSegments: body.recentSegments,
    });
  } catch (e) {
    if (e instanceof AskError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status,
        headers: { "content-type": "application/json" },
      });
    }
    console.error("[live-qa] 准备阶段异常", e);
    return new Response(JSON.stringify({ error: `提问失败：${(e as Error)?.message ?? "未知错误"}` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const ctx = { tenantId: session.tenantId, userId: session.userId };
  // 客户端断开时用它通知上游模型停止生成
  const abort = new AbortController();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(payload)));
        } catch {
          closed = true;
        }
      };

      // 心跳：长任务期间保持连接活跃（沿用项目里其它 SSE 的 15 秒间隔）
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(ping);
        abort.abort();
      });

      try {
        // 1. 先把出处推给前端：用户在第一帧就知道依据是什么，
        //    不用等模型把整段话写完才看到来源。
        send({
          type: "meta",
          citations: prepared.citations,
          memories: prepared.memories,
          segments: prepared.segments,
          live: prepared.live,
          sessionId: prepared.sessionId,
          meetingId: prepared.meetingId,
        });

        // 2. 流式生成
        for await (const ev of streamAnswer(prepared, ctx, { signal: abort.signal })) {
          if (closed) break;
          if (ev.type === "delta") send({ type: "delta", text: ev.text });
          else if (ev.type === "final") send({ type: "final", result: ev.result });
          else send({ type: "error", message: ev.message });
        }
      } catch (e) {
        console.error("[live-qa] 流式阶段异常", e);
        send({ type: "error", message: `生成回答失败：${(e as Error)?.message ?? "未知错误"}` });
      } finally {
        clearInterval(ping);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        }
      }
    },
    cancel() {
      // 浏览器点「停止」或关闭页面
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}