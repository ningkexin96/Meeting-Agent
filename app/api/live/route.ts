// 实时会话 API —— 对应 issue #26
// POST /api/live            开启会话
// GET  /api/live?sessionId= 恢复会话状态
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { startSession, getSessionState } from "@/lib/live/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("agent:run");
  if (!g.ok) return g.response;
  const { session } = g;

  const body = (await req.json().catch(() => ({}))) as { meetingId?: string; title?: string };
  if (!body.meetingId) {
    return NextResponse.json({ error: "缺少 meetingId" }, { status: 400 });
  }

  const result = await startSession({
    tenantId: session.tenantId,
    userId: session.userId,
    role: session.role,
    meetingId: body.meetingId,
    title: body.title,
  });
  return NextResponse.json(result);
}

export async function GET(req: Request) {
  const g = await guard("meeting:read");
  if (!g.ok) return g.response;
  const { session } = g;

  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });

  const state = await getSessionState(sessionId, session.tenantId);
  if (!state) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  return NextResponse.json(state);
}