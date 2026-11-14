// Seed 样例数据 —— 对应 issue #3
// 1 个租户、3 个用户（owner / member / viewer）、1 场待处理会议 + 1 场历史会议
//
// ⚠️ 这个脚本会清空整库后重建。为避免误在真实数据上执行，加了两道保护：
//   1. 只允许本地 SQLite 文件库（DATABASE_URL 必须是 file:）
//   2. 若检测到已有「非演示」数据，必须显式设置 SEED_FORCE=1 才继续
import { PrismaClient } from "@prisma/client";
import { SAMPLE_TRANSCRIPT, SAMPLE_SPEAKERS, HISTORY_TRANSCRIPT } from "../lib/asr/samples";

const prisma = new PrismaClient();

/** 库里有 demo 域名的账号，才认为是本项目自己的演示库 */
const DEMO_EMAIL_DOMAIN = "@demo.dev";

async function guardBeforeWipe() {
  const url = process.env.DATABASE_URL ?? "";
  // 保护一：拒绝在远端数据库上执行（file: 之外一律不认）
  if (!url.startsWith("file:")) {
    throw new Error(
      `拒绝执行：seed 会清空整个数据库，但 DATABASE_URL 不是本地 SQLite 文件（${url || "未设置"}）。\n` +
        "如果你确实要在该库上重建演示数据，请改为手动执行。",
    );
  }

  // 保护二：库里已有非演示数据时，要求显式确认
  const users = await prisma.user.findMany({ select: { email: true } });
  const foreignUsers = users.filter((u) => !u.email.endsWith(DEMO_EMAIL_DOMAIN));
  if (foreignUsers.length > 0 && process.env.SEED_FORCE !== "1") {
    throw new Error(
      `拒绝执行：数据库里已有 ${foreignUsers.length} 个非演示账号（例如 ${foreignUsers[0].email}），` +
        "继续执行会全部删除。\n" +
        "确认要清空重建请加参数：SEED_FORCE=1",
    );
  }
}

async function main() {
  await guardBeforeWipe();

  // 幂等：清空后重建
  await prisma.citation.deleteMany();
  await prisma.actionItem.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.risk.deleteMany();
  await prisma.minutes.deleteMany();
  await prisma.summary.deleteMany();
  await prisma.transcriptTurn.deleteMany();
  await prisma.meetingParticipant.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: "演示团队" } });

  // 演示账号统一密码：demo1234（见 README 的演示账号一节）
  const { hashPassword } = await import("../lib/auth/credentials");
  const demoHash = await hashPassword("demo1234");

  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "owner@demo.dev",
      name: "张伟（产品）",
      role: "owner",
      passwordHash: demoHash,
      avatarEmoji: "🧑‍💼",
      avatarColor: "#0d9488",
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "member@demo.dev",
      name: "李娜（前端）",
      role: "member",
      passwordHash: demoHash,
      avatarEmoji: "👩‍💻",
      avatarColor: "#7c3aed",
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "viewer@demo.dev",
      name: "王强（后端）",
      role: "viewer",
      passwordHash: demoHash,
      avatarEmoji: "👨‍💻",
      avatarColor: "#0891b2",
    },
  });

  // 主会议：未处理，等待演示流程
  const meeting = await prisma.meeting.create({
    data: {
      tenantId: tenant.id,
      title: "会议纪要功能上线节奏对齐",
      status: "uploaded",
      stage: "PREPARING",
      createdBy: owner.id,
    },
  });

  // 历史会议：已完成，用于「跨会议追问」
  const history = await prisma.meeting.create({
    data: {
      tenantId: tenant.id,
      title: "上周排期同步",
      status: "done",
      stage: "DONE",
      createdBy: owner.id,
    },
  });

  await seedTurns(history.id, HISTORY_TRANSCRIPT);
  const historyMinutes = await prisma.minutes.create({
    data: {
      meetingId: history.id,
      overview: "本次会议对齐了第一个可用版本的发布时间点，并明确新增需求一律进入 backlog。",
      status: "confirmed",
    },
  });
  await prisma.decision.create({
    data: {
      minutesId: historyMinutes.id,
      content: "月底发布第一个可用版本，实时转写放到下个迭代。",
    },
  });
  await prisma.actionItem.create({
    data: {
      minutesId: historyMinutes.id,
      content: "新增需求一律进入 backlog，不插队。",
      owner: "张伟（产品）",
    },
  });
  await prisma.memory.create({
    data: {
      tenantId: tenant.id,
      meetingId: history.id,
      kind: "fact",
      content: "排期结论：月底发布第一个可用版本，实时转写放到下个迭代。",
      importance: 0.9,
    },
  });

  console.log("seed 完成：", {
    tenant: tenant.id,
    meeting: meeting.id,
    history: history.id,
    users: ["owner@demo.dev", "member@demo.dev", "viewer@demo.dev"],
  });
}

async function seedTurns(meetingId: string, turns: typeof SAMPLE_TRANSCRIPT) {
  const participants = new Map<string, string>();
  for (const [label, meta] of Object.entries(SAMPLE_SPEAKERS)) {
    const p = await prisma.meetingParticipant.create({
      data: { meetingId, displayName: meta.displayName, speakerLabel: label, confidence: 0.95 },
    });
    participants.set(label, p.id);
  }
  let idx = 0;
  for (const t of turns) {
    await prisma.transcriptTurn.create({
      data: {
        meetingId,
        participantId: participants.get(t.speaker)!,
        idx: idx++,
        startMs: t.startMs,
        endMs: t.endMs,
        text: t.text,
        asrConfidence: t.confidence ?? 0.95,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());