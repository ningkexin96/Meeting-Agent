// SSE 事件流 —— 对应 issue #11
// 断线重连后先补历史事件（runBus.subscribe 会回放），再推送增量
import { runBus } from "@/lib/events";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!meeting) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 客户端已断开：停止所有推送，避免 uncaughtException
          closed = true;
          cleanup();
        }
      };

      const send = (data: unknown) => safeEnqueue(`data: ${JSON.stringify(data)}\n\n`);
      const unsubscribe = runBus.subscribe(id, (e) => send(e));
      const ping = setInterval(() => safeEnqueue(": ping\n\n"), 15_000);

      // 客户端主动断开时立即清理
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      });

      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}