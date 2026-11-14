// 运行记录查询 —— 供 Agent 运行视图在刷新后恢复历史事件（issue #11 的补充）
import { prisma } from "@/lib/db/client";

export type RunHistory = {
  stage: string;
  note?: string;
  at: number;
};

/**
 * 从审计日志还原最近一次运行的阶段轨迹。
 * 事件总线只存在内存里，页面刷新后就没了；审计日志是持久化的权威记录。
 */
export async function getRunHistory(meetingId: string): Promise<RunHistory[]> {
  const logs = await prisma.auditLog.findMany({
    where: { meetingId, action: { in: ["transcription.done", "agent.done", "agent.failed"] } },
    orderBy: { at: "desc" },
    take: 5,
  });

  // 反推一个粗略的阶段轨迹（用于展示，不作为权威状态）
  const out: RunHistory[] = [];
  for (const log of logs.reverse()) {
    if (log.action === "transcription.done") {
      out.push({ stage: "PREPARING", note: "转写完成", at: log.at.getTime() });
    } else if (log.action === "agent.done") {
      out.push(
        { stage: "SUMMARIZING", note: "摘要完成", at: log.at.getTime() },
        { stage: "EXTRACTING", note: "要素抽取完成", at: log.at.getTime() },
        { stage: "REVIEWING", note: "已生成草稿", at: log.at.getTime() },
        { stage: "DONE", note: "纪要已生成", at: log.at.getTime() },
      );
    } else if (log.action === "agent.failed") {
      let msg = "运行失败";
      try {
        msg = (JSON.parse(log.detail) as { message?: string }).message ?? msg;
      } catch {
        /* detail 非 JSON 时用默认文案 */
      }
      out.push({ stage: "FAILED", note: msg, at: log.at.getTime() });
    }
  }
  return out;
}