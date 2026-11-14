// 结束实时会话 —— 对应 issue #26
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { endSession } from "@/lib/live/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const g = await guard("agent:run");
  if (!g.ok) return g.response;
  const { session } = g;

  const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
  if (!body.sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });

  try {
    const result = await endSession(body.sessionId, {
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}