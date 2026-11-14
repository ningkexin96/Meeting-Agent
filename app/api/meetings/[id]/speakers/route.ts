// 说话人命名 —— 说话人分离只给出编号，真实姓名由用户手动标注
//
//   GET   /api/meetings/[id]/speakers   列出本场会议的说话人
//   PATCH /api/meetings/[id]/speakers   重命名某个说话人
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/client";
import { audit } from "@/lib/db/scoped";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("meeting:read");
  if (!g.ok) return g.response;

  const { id } = await params;
  const meeting = await prisma.meeting.findFirst({
    where: { id, tenantId: g.session.tenantId },
  });
  if (!meeting) return NextResponse.json({ error: "会议不存在" }, { status: 404 });

  const participants = await prisma.meetingParticipant.findMany({
    where: { meetingId: id },
    include: { _count: { select: { turns: true } } },
    orderBy: { speakerLabel: "asc" },
  });

  return NextResponse.json({
    items: participants.map((p) => ({
      id: p.id,
      speakerLabel: p.speakerLabel,
      displayName: p.displayName,
      nameSource: p.nameSource,
      labeledBy: p.labeledBy,
      labeledAt: p.labeledAt?.toISOString() ?? null,
      turnCount: p._count.turns,
      needsReview: p.confidence < 0.7,
    })),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("minutes:edit");
  if (!g.ok) return g.response;

  const { id } = await params;

  let body: { speakerLabel?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const speakerLabel = String(body.speakerLabel ?? "").trim();
  const displayName = String(body.displayName ?? "").trim();

  if (!speakerLabel) return NextResponse.json({ error: "缺少 speakerLabel" }, { status: 400 });
  if (!displayName) return NextResponse.json({ error: "姓名不能为空" }, { status: 400 });
  if (displayName.length > 32) {
    return NextResponse.json({ error: "姓名过长（上限 32 字）" }, { status: 400 });
  }

  // 第 3 层隔离：会议必须属于当前租户
  const meeting = await prisma.meeting.findFirst({
    where: { id, tenantId: g.session.tenantId },
  });
  if (!meeting) return NextResponse.json({ error: "会议不存在" }, { status: 404 });

  const participant = await prisma.meetingParticipant.findUnique({
    where: { meetingId_speakerLabel: { meetingId: id, speakerLabel } },
  });
  if (!participant) {
    return NextResponse.json({ error: `找不到说话人 ${speakerLabel}` }, { status: 404 });
  }

  const before = participant.displayName;

  const updated = await prisma.meetingParticipant.update({
    where: { id: participant.id },
    data: {
      displayName,
      nameSource: "manual",
      labeledBy: g.session.name,
      labeledAt: new Date(),
    },
  });

  await audit(
    { tenantId: g.session.tenantId, userId: g.session.userId },
    "speaker.renamed",
    { speakerLabel, before, after: displayName },
    id,
  );

  return NextResponse.json({
    ok: true,
    item: {
      speakerLabel: updated.speakerLabel,
      displayName: updated.displayName,
      nameSource: updated.nameSource,
    },
  });
}