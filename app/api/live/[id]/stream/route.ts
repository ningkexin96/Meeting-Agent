// 实时会话 SSE —— 对应 issue #26
// 复用事件总线：新话轮 / 增量纪要 / 分片状态都从这里推
import { runBus } from "@/lib/events";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });
  const { id } = await params;

  // id 是 sessionId，需要反查出 meetingId 才能订阅对应频道
  const live = await prisma.liveSession.findFirst({
    where: { id, tenantId: session.tenantId },
  });
  if (!live) return new Response("not found", { status: 404 });
  const meetingId = live.meetingId;

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
          closed = true;
          cleanup();
        }
      };

      // 只转发实时相关事件，不把离线状态机的事件混进来
      const send = (e: unknown) => safeEnqueue(`data: ${JSON.stringify(e)}\n\n`);
      const unsubscribe = runBus.subscribe(meetingId, (e) => {
        if (e.type.startsWith("live:") || e.type === "text" || e.type === "done") send(e);
      });

      const ping = setInterval(() => safeEnqueue(": ping\n\n"), 15_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        cleanup();
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