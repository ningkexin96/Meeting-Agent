// 清理测试残留数据，只保留 seed 的干净样例
// 用法：node scripts/reset-demo.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 保留 seed 生成的两场会议
const KEEP_TITLES = ["会议纪要功能上线节奏对齐", "上周排期同步"];

async function main() {
  const all = await prisma.meeting.findMany({ select: { id: true, title: true } });
  const drop = all.filter((m) => !KEEP_TITLES.includes(m.title));
  const ids = drop.map((m) => m.id);

  if (ids.length) {
    await prisma.citation.deleteMany();
    await prisma.actionItem.deleteMany();
    await prisma.decision.deleteMany();
    await prisma.risk.deleteMany();
    await prisma.minutes.deleteMany();
    await prisma.summary.deleteMany();
    await prisma.transcriptTurn.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.meetingParticipant.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.liveSegment.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.liveSession.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.liveMinuteItem.deleteMany();
    await prisma.memory.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.embedding.deleteMany();
    await prisma.meeting.deleteMany({ where: { id: { in: ids } } });
  }

  // 把保留的那场会议重置成「未处理」，方便完整演示
  const demo = await prisma.meeting.findFirst({ where: { title: "会议纪要功能上线节奏对齐" } });
  if (demo) {
    await prisma.transcriptTurn.deleteMany({ where: { meetingId: demo.id } });
    await prisma.meetingParticipant.deleteMany({ where: { meetingId: demo.id } });
    await prisma.summary.deleteMany({ where: { meetingId: demo.id } });
    const m = await prisma.minutes.findFirst({ where: { meetingId: demo.id } });
    if (m) {
      await prisma.citation.deleteMany({ where: { targetId: { in: [] } } });
      await prisma.actionItem.deleteMany({ where: { minutesId: m.id } });
      await prisma.decision.deleteMany({ where: { minutesId: m.id } });
      await prisma.risk.deleteMany({ where: { minutesId: m.id } });
      await prisma.minutes.delete({ where: { id: m.id } });
    }
    await prisma.meeting.update({
      where: { id: demo.id },
      data: { status: "uploaded", stage: "PREPARING", error: null },
    });
  }

  const remain = await prisma.meeting.findMany({
    select: { id: true, title: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`已清理 ${ids.length} 场测试会议，保留：`);
  for (const m of remain) console.log(`  ${m.status.padEnd(12)} ${m.title}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});