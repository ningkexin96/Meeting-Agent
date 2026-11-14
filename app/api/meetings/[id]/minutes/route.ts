// 纪要字段编辑 —— 对应 issue #13 #14（人工复核 + 审计）
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/client";
import { audit } from "@/lib/db/scoped";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("minutes:edit");
  if (!g.ok) return g.response;
  const { session } = g;
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!meeting) return NextResponse.json({ error: "会议不存在" }, { status: 404 });

  const body = await req.json() as {
    actionItemId?: string;
    owner?: string;
    dueAt?: string;
    minutesStatus?: string;
  };

  if (body.actionItemId) {
    const updated = await prisma.actionItem.update({
      where: { id: body.actionItemId },
      data: {
        ...(body.owner !== undefined ? { owner: body.owner || null } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt || null } : {}),
      },
    });
    await prisma.actionItem.update({
      where: { id: updated.id },
      data: { unresolved: !updated.owner || !updated.dueAt },
    });
    await prisma.minutes.updateMany({
      where: { meetingId: meeting.id },
      data: { editedBy: session.userId },
    });
    await audit(session, "minutes.action_item.updated", { id: updated.id }, meeting.id);
  }

  if (body.minutesStatus) {
    await prisma.minutes.updateMany({
      where: { meetingId: meeting.id },
      data: { status: body.minutesStatus },
    });
    await audit(session, "minutes.status.changed", { status: body.minutesStatus }, meeting.id);
  }

  return NextResponse.json({ ok: true });
}