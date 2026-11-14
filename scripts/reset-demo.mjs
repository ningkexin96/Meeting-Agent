// 清理测试残留数据，只保留 seed 的干净样例
// 用法：node scripts/reset-demo.mjs
//
// ⚠️ 这个脚本会删除会议数据。加了两道保护：
//   1. 只允许本地 SQLite 文件库（DATABASE_URL 必须是 file:）
//   2. 若检测到非演示账号，必须显式设置 SEED_FORCE=1
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 保留 seed 生成的两场会议
const KEEP_TITLES = ["会议纪要功能上线节奏对齐", "上周排期同步"];
const DEMO_EMAIL_DOMAIN = "@demo.dev";

async function guard() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) {
    throw new Error(
      `拒绝执行：本脚本会删除会议数据，但 DATABASE_URL 不是本地 SQLite 文件（${url || "未设置"}）。`,
    );
  }

  const users = await prisma.user.findMany({ select: { email: true } });
  const foreign = users.filter((u) => !u.email.endsWith(DEMO_EMAIL_DOMAIN));
  if (foreign.length > 0 && process.env.SEED_FORCE !== "1") {
    throw new Error(
      `拒绝执行：检测到 ${foreign.length} 个非演示账号（例如 ${foreign[0].email}），数据可能不是演示库。\n` +
        "确认要继续请加参数：SEED_FORCE=1",
    );
  }
}

async function main() {
  await guard();

  const all = await prisma.meeting.findMany({ select: { id: true, title: true } });
  const drop = all.filter((m) => !KEEP_TITLES.includes(m.title));
  const ids = drop.map((m) => m.id);

  if (ids.length) {
    // 按要删除的会议精确清理，不能无条件 deleteMany——
    // 否则会把保留会议的纪要、引用、记忆一并删掉。
    const minutesOfDropped = await prisma.minutes.findMany({
      where: { meetingId: { in: ids } },
      select: { id: true },
    });
    const minutesIds = minutesOfDropped.map((m) => m.id);

    // 引用按 (targetType, targetId) 关联，需先查出要删的目标 id
    const [decisions, actions, risks, summaries] = await Promise.all([
      prisma.decision.findMany({ where: { minutesId: { in: minutesIds } }, select: { id: true } }),
      prisma.actionItem.findMany({ where: { minutesId: { in: minutesIds } }, select: { id: true } }),
      prisma.risk.findMany({ where: { minutesId: { in: minutesIds } }, select: { id: true } }),
      prisma.summary.findMany({ where: { meetingId: { in: ids } }, select: { id: true } }),
    ]);
    const targets = [
      ...decisions.map((d) => ({ targetType: "decision", targetId: d.id })),
      ...actions.map((a) => ({ targetType: "action_item", targetId: a.id })),
      ...risks.map((r) => ({ targetType: "risk", targetId: r.id })),
      ...summaries.map((s) => ({ targetType: "summary", targetId: s.id })),
    ];
    if (targets.length) {
      await prisma.citation.deleteMany({ where: { OR: targets } });
    }

    await prisma.actionItem.deleteMany({ where: { minutesId: { in: minutesIds } } });
    await prisma.decision.deleteMany({ where: { minutesId: { in: minutesIds } } });
    await prisma.risk.deleteMany({ where: { minutesId: { in: minutesIds } } });
    await prisma.minutes.deleteMany({ where: { id: { in: minutesIds } } });
    await prisma.summary.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.transcriptTurn.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.meetingParticipant.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.liveSegment.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.liveMinuteItem.deleteMany({
      where: { session: { meetingId: { in: ids } } },
    });
    await prisma.liveSession.deleteMany({ where: { meetingId: { in: ids } } });
    // 记忆与审计按来源会议清理，不动其他数据
    await prisma.memory.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { meetingId: { in: ids } } });
    await prisma.embedding.deleteMany({ where: { meetingId: { in: ids } } });
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