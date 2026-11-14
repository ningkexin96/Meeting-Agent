// 恢复历史会议的记忆与索引（清理脚本误删后修复）
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const HISTORY_MEMORY = "排期结论：月底发布第一个可用版本，实时转写放到下个迭代。";

async function main() {
  const history = await p.meeting.findFirst({ where: { title: "上周排期同步" } });
  if (!history) throw new Error("找不到历史会议");

  const tenant = await p.tenant.findUnique({ where: { id: history.tenantId } });

  // 1. 补回记忆
  const existing = await p.memory.findFirst({
    where: { tenantId: tenant.id, content: HISTORY_MEMORY },
  });
  let memoryId;
  if (existing) {
    memoryId = existing.id;
  } else {
    const m = await p.memory.create({
      data: {
        tenantId: tenant.id,
        meetingId: history.id,
        kind: "fact",
        content: HISTORY_MEMORY,
        importance: 0.9,
      },
    });
    memoryId = m.id;
  }

  // 2. 补回语义索引（memory + decision）
  const { indexObjects } = await import("../lib/rag/retriever.ts");
  const decisions = await p.decision.findMany({
    where: { minutes: { meetingId: history.id } },
  });

  const n = await indexObjects([
    {
      tenantId: tenant.id,
      objectType: "memory",
      objectId: memoryId,
      meetingId: history.id,
      content: HISTORY_MEMORY,
    },
    ...decisions.map((d) => ({
      tenantId: tenant.id,
      objectType: "decision" as const,
      objectId: d.id,
      meetingId: history.id,
      content: d.content,
    })),
  ]);

  console.log(`已恢复：memory=${memoryId}，索引 ${n} 条`);
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});