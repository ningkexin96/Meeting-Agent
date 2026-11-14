// 纪要字段编辑 —— 对应 issue #13 #14（人工复核 + 审计）
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/client";
import { audit } from "@/lib/db/scoped";

const MINUTES_STATUSES = new Set(["draft", "confirmed"]);

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

  if (body.owner !== undefined && typeof body.owner !== "string") {
    return NextResponse.json({ error: "owner 必须是字符串" }, { status: 400 });
  }
  if (body.dueAt !== undefined && typeof body.dueAt !== "string") {
    return NextResponse.json({ error: "dueAt 必须是字符串" }, { status: 400 });
  }
  if (body.minutesStatus !== undefined && !MINUTES_STATUSES.has(body.minutesStatus)) {
    return NextResponse.json({ error: "minutesStatus 只能是 draft 或 confirmed" }, { status: 400 });
  }

  let actionItemId: string | null = null;
  let notFound = false;

  try {
    await prisma.$transaction(async (tx) => {
      if (body.actionItemId) {
        // 关键权限边界：不能只信 URL 里的 meetingId。
        // ActionItem 必须同时属于该 URL 会议和当前租户，否则就是跨租户 IDOR。
        const existing = await tx.actionItem.findFirst({
          where: {
            id: body.actionItemId,
            minutes: {
              meetingId: meeting.id,
              meeting: { tenantId: session.tenantId },
            },
          },
          select: { id: true, owner: true, dueAt: true },
        });
        if (!existing) {
          notFound = true;
          return;
        }

        const owner = body.owner !== undefined ? body.owner || null : existing.owner;
        const dueAt = body.dueAt !== undefined ? body.dueAt || null : existing.dueAt;
        const updated = await tx.actionItem.updateMany({
          where: {
            id: existing.id,
            minutes: {
              meetingId: meeting.id,
              meeting: { tenantId: session.tenantId },
            },
          },
          data: {
            owner,
            dueAt,
            unresolved: !owner || !dueAt,
          },
        });
        if (updated.count !== 1) {
          notFound = true;
          return;
        }

        await tx.minutes.updateMany({
          where: { meetingId: meeting.id },
          data: { editedBy: session.userId },
        });
        actionItemId = existing.id;
      }

      if (body.minutesStatus) {
        await tx.minutes.updateMany({
          where: { meetingId: meeting.id },
          data: { status: body.minutesStatus },
        });
      }
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "保存失败" }, { status: 500 });
  }

  if (notFound) {
    return NextResponse.json({ error: "待办不存在或不属于当前会议" }, { status: 404 });
  }

  if (actionItemId) {
    await audit(session, "minutes.action_item.updated", { id: actionItemId }, meeting.id);
  }
  if (body.minutesStatus) {
    await audit(session, "minutes.status.changed", { status: body.minutesStatus }, meeting.id);
  }

  return NextResponse.json({ ok: true });
}
