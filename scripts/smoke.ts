// 冒烟脚本：不启动 UI，直接验证「状态机 + 工具 + 落库 + 引用」整条链路
// 用法：pnpm smoke
import { PrismaClient } from "@prisma/client";
import { runPipeline } from "../lib/agent/pipeline";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "owner@demo.dev" } });
  if (!user) throw new Error("请先执行 pnpm db:seed");

  const meeting = await prisma.meeting.create({
    data: {
      tenantId: user.tenantId,
      title: `冒烟测试会议 ${new Date().toLocaleTimeString("zh-CN")}`,
      status: "uploaded",
      stage: "PREPARING",
      createdBy: user.id,
    },
  });
  console.log("meeting:", meeting.id);

  const result = await runPipeline({
    tenantId: user.tenantId,
    userId: user.id,
    role: user.role,
    meetingId: meeting.id,
  });
  console.log("pipeline:", result);

  const check = await prisma.meeting.findUnique({
    where: { id: meeting.id },
    include: {
      turns: true,
      summaries: true,
      minutes: { include: { decisions: true, actionItems: true, risks: true } },
    },
  });

  const citations = await prisma.citation.count();
  console.log("结果:", {
    turns: check?.turns.length,
    summaries: check?.summaries.length,
    decisions: check?.minutes?.decisions.length,
    actionItems: check?.minutes?.actionItems.length,
    risks: check?.minutes?.risks.length,
    unresolved: check?.minutes?.actionItems.filter((a) => a.unresolved).length,
    citations,
    status: check?.status,
    stage: check?.stage,
  });

  const ok =
    (check?.turns.length ?? 0) > 0 &&
    (check?.summaries.length ?? 0) > 0 &&
    (check?.minutes?.decisions.length ?? 0) > 0 &&
    citations > 0 &&
    check?.status === "done";

  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

main().finally(() => prisma.$disconnect());