// 构造一个「进行中」的实时会话演示数据，用于截图
// 用法：node scripts/demo-live-session.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SEGMENTS = [
  { text: "今天主要对一下纪要功能的上线节奏", start: 200, end: 3600 },
  { text: "，先上线离线转写。", start: 8200, end: 11600 },
  { text: "这个事今天就定下来，实时能力往后放。", start: 16200, end: 19600 },
  { text: "张伟你负责把音频存储的临时方案写进文档。", start: 20200, end: 24800 },
  { text: "还有一个风险，没有声纹库可能不准。", start: 28200, end: 32600 },
  { text: "纪要页先做字段级编辑，富文本下个迭代。", start: 36200, end: 40600 },
];

const ITEMS = [
  { kind: "decision", content: "先上线录音上传 + 离线转写，实时转写能力放到后续迭代。" },
  { kind: "action_item", content: "把音频存储临时使用本地目录的情况写进文档。", owner: "张伟", dueAt: "本周五" },
  { kind: "risk", content: "缺少声纹库，外部参会者说话人识别可能不准。", severity: "medium" },
  { kind: "decision", content: "纪要页先做字段级编辑（待办改负责人/截止时间），富文本下个迭代。" },
  { kind: "risk", content: "前端时间紧张，若周五没有可跑通版本将砍掉跨会议追问。", severity: "high" },
];

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "owner@demo.dev" } });
  if (!user) throw new Error("请先执行 pnpm db:seed");

  const meeting = await prisma.meeting.create({
    data: {
      tenantId: user.tenantId,
      title: "实时演示：纪要功能上线节奏对齐",
      status: "transcribing",
      stage: "PREPARING",
      createdBy: user.id,
    },
  });

  const session = await prisma.liveSession.create({
    data: { tenantId: user.tenantId, meetingId: meeting.id, status: "live" },
  });

  for (let i = 0; i < SEGMENTS.length; i++) {
    const s = SEGMENTS[i];
    await prisma.liveSegment.create({
      data: {
        sessionId: session.id,
        meetingId: meeting.id,
        seq: i,
        speakerLabel: "speaker_0",
        startMs: s.start,
        endMs: s.end,
        text: s.text,
        confidence: 0.93,
      },
    });
  }

  for (let i = 0; i < ITEMS.length; i++) {
    const it = ITEMS[i];
    await prisma.liveMinuteItem.create({
      data: {
        sessionId: session.id,
        kind: it.kind,
        content: it.content,
        owner: it.owner ?? null,
        dueAt: it.dueAt ?? null,
        severity: it.severity ?? "medium",
        sourceText: `#${i}`,
        fromTurnSeq: i,
      },
    });
  }

  for (let i = 0; i < 6; i++) {
    await prisma.liveChunk.create({
      data: {
        sessionId: session.id,
        seq: i,
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        bytes: 18000 + i * 500,
        status: "transcribed",
      },
    });
  }

  console.log(JSON.stringify({ meetingId: meeting.id, sessionId: session.id }));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});