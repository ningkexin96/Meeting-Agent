// 验证增量抽取：直接测试抽取函数（不依赖音频）
import { extractIncremental } from "../lib/asr/incremental-esm.mjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 找一个会议建临时会话
  const meeting = await prisma.meeting.findFirst({ orderBy: { createdAt: "desc" } });
  if (!meeting) { console.error("没有会议"); process.exit(1); }

  const live = await prisma.liveSession.create({
    data: { tenantId: meeting.tenantId, meetingId: meeting.id, status: "live" },
  });
  console.log("测试会话:", live.id, "\n");

  // 模拟一段真实的会议对话（含决议、待办、风险）
  const segments = [
    { seq: 0, text: "今天主要对一下纪要功能的上线节奏。" },
    { seq: 1, text: "我倾向先上线离线转写，实时能力往后放，这个事今天就定下来。" },
    { seq: 2, text: "可以，那就这样定了。" },
    { seq: 3, text: "前端这边时间比较紧，两天肯定做不完，能不能先做字段级编辑。" },
    { seq: 4, text: "李娜你负责转写视图的初版，本周四之前给到我。" },
    { seq: 5, text: "还有一个风险，说话人分离我们没有声纹库，可能识别不准。" },
    { seq: 6, text: "如果周五还看不到可跑通的版本，我们就砍掉跨会议追问功能。" },
  ];

  console.log("=== 输入片段 ===");
  segments.forEach((s) => console.log(`  #${s.seq} ${s.text}`));

  console.log("\n=== 抽取结果 ===");
  const items = await extractIncremental(live.id, meeting.id, segments);
  for (const it of items) {
    console.log(`  [${it.kind}] ${it.content}`);
    if (it.owner) console.log(`      负责人: ${it.owner}`);
    if (it.dueAt) console.log(`      截止: ${it.dueAt}`);
    if (it.severity) console.log(`      严重度: ${it.severity}`);
  }
  console.log(`\n共抽取 ${items.length} 条`);

  // 测试去重：再抽一遍应该返回 0
  console.log("\n=== 去重测试（重复抽取同一批）===");
  const again = await extractIncremental(live.id, meeting.id, segments);
  console.log(`第二次抽取: ${again.length} 条（应为 0）`);

  // 清理测试数据
  await prisma.liveSession.delete({ where: { id: live.id } });
  await prisma.$disconnect();

  const ok = items.length >= 3 && again.length === 0;
  console.log(`\n${ok ? "✅ 通过" : "❌ 未达预期"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });