// 触发 Agent —— 对应 issue #9 #11
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/client";
import { isRunning, runPipeline } from "@/lib/agent/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("agent:run");
  if (!g.ok) return g.response;
  const { session } = g;
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!meeting) return NextResponse.json({ error: "会议不存在" }, { status: 404 });
  if (isRunning(meeting.id)) return NextResponse.json({ skipped: true, reason: "正在处理中" });

  // 异步执行，前端通过 SSE 观察进度（避免请求超时）
  void runPipeline({
    tenantId: session.tenantId,
    userId: session.userId,
    role: session.role,
    meetingId: meeting.id,
  });

  return NextResponse.json({ started: true });
}