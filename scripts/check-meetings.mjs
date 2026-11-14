import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const ms = await p.meeting.findMany({
  orderBy: { createdAt: "desc" },
  take: 5,
  include: { _count: { select: { turns: true } } },
});
console.log("最近 5 场会议：");
for (const m of ms) {
  console.log(
    `  ${m.title} | 状态=${m.status} | 话轮=${m._count.turns} | 音频=${m.audioPath ?? "无"}`,
  );
}
await p.$disconnect();