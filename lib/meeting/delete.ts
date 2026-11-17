// 会议删除 —— 对应 issue #30
//
// 为什么不能直接 `prisma.meeting.delete()`：
//
// 实测（SQLite）会直接抛 P2003 外键约束错误，删除失败。原因是有三条关系没有配级联删除：
//   Embedding.meetingId   普通字符串列，没有外键也没级联（语义检索索引）
//   Memory.meetingId      没有 onDelete: Cascade（记忆要独立于会议存活，见下）
//   Meeting.audits        没有 onDelete: Cascade（审计记录）
// 另外 Citation 是指向 TranscriptTurn 的外键，删话轮时会被数据库级联掉，但那是隐式的，
// 这里显式删一遍，既让逻辑可读，也不依赖数据库具体实现。
//
// 设计原则：
// 1. **全部在一个事务里**：删一半失败会留下残缺数据，比不删更糟。
// 2. **记忆不删，只解绑**：会议纪要沉淀的记忆属于团队长期知识，
//    用户删会议通常是想清掉"这场会"，不是想把从这场会里学到的结论也一并抹掉。
//    所以只把 meetingId 置空（界面上会显示为「手动记录」之外的独立来源），
//    并在返回结果里告诉用户"有 N 条记忆被保留"。
// 3. **审计要留**：谁在什么时候删了哪场会必须可查。审计里不存会议标题以外的正文，
//    删完会议写入一条 delete 审计（此时 meetingId 已不存在，所以只记在 detail 里）。
// 4. **音频文件不在事务里**：文件系统操作无法回滚，所以放在事务成功之后删，
//    失败只记日志——不能因为删不掉一个音频文件就回滚整次删除。
import { prisma } from "@/lib/db/client";
import { audit } from "@/lib/db/scoped";
import { runBus } from "@/lib/events";

export type DeleteResult = {
  ok: true;
  meetingId: string;
  title: string;
  /** 实际删除的各表行数，便于前端告诉用户"删了什么" */
  deleted: Record<string, number>;
  /** 保留下来的记忆条数（只解绑，不删除） */
  keptMemories: number;
};

export class DeleteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeleteError";
  }
}

export async function deleteMeeting(
  ctx: { tenantId: string; userId: string },
  meetingId: string,
): Promise<DeleteResult> {
  // 第 3 层隔离：只能删本租户的会议
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, tenantId: ctx.tenantId },
    select: { id: true, title: true, audioPath: true },
  });
  if (!meeting) throw new DeleteError("会议不存在或不属于当前租户", 404);

  // 会议一旦删掉，还开着的页面会继续向这个频道拉 SSE，表现为一串 404。
  // 先断开订阅，让前端连接自然结束，而不是每半秒撞一次空会议。
  runBus.drop(meetingId);

  // 实时会话如果还在进行，先收掉：否则删除后前端仍会收到推送
  const activeSessions = await prisma.liveSession.count({
    where: { meetingId, status: { in: ["live", "ending"] } },
  });

  const result = await prisma.$transaction(async (tx) => {
    const deleted: Record<string, number> = {};

    // 1. 引用 —— 指向话轮的引用，必须在删话轮前清掉
    const turns = await tx.transcriptTurn.findMany({ where: { meetingId }, select: { id: true } });
    const turnIds = turns.map((t) => t.id);
    if (turnIds.length) {
      const citations = await tx.citation.deleteMany({ where: { turnId: { in: turnIds } } });
      deleted.citations = citations.count;
    } else {
      deleted.citations = 0;
    }

    // 2. 纪要：条目随 Minutes 级联，但引用还指着这些条目，先按 targetId 清一遍残留
    const minutes = await tx.minutes.findUnique({
      where: { meetingId },
      select: { id: true, decisions: { select: { id: true } }, actionItems: { select: { id: true } }, risks: { select: { id: true } } },
    });
    if (minutes) {
      const itemIds = [...minutes.decisions, ...minutes.actionItems, ...minutes.risks].map((i) => i.id);
      if (itemIds.length) {
        const orphan = await tx.citation.deleteMany({ where: { targetId: { in: itemIds } } });
        deleted.citations += orphan.count;
      }
      // 决议条目在语义索引里也有一条，随下面 embedding 一并清理
      deleted.decisions = minutes.decisions.length;
      deleted.actionItems = minutes.actionItems.length;
      deleted.risks = minutes.risks.length;
      await tx.minutes.delete({ where: { id: minutes.id } });
      deleted.minutes = 1;
    }

    // 3. 语义索引：没有外键，必须显式删，否则会成为永远检索得到的幽灵内容
    const emb = await tx.embedding.deleteMany({ where: { meetingId } });
    deleted.embeddings = emb.count;

    // 4. 实时会话（过程数据）：LiveSegment / LiveMinuteItem / LiveChunk 随会话级联
    const live = await tx.liveSegment.deleteMany({ where: { meetingId } });
    deleted.liveSegments = live.count;
    const liveSessions = await tx.liveSession.deleteMany({ where: { meetingId } });
    deleted.liveSessions = liveSessions.count;

    // 5. 摘要与话轮
    const summaries = await tx.summary.deleteMany({ where: { meetingId } });
    deleted.summaries = summaries.count;
    const turnCount = await tx.transcriptTurn.deleteMany({ where: { meetingId } });
    deleted.turns = turnCount.count;

    // 6. 参与者（说话人）
    const parts = await tx.meetingParticipant.deleteMany({ where: { meetingId } });
    deleted.participants = parts.count;

    // 7. 记忆：只解绑，不删
    const kept = await tx.memory.updateMany({ where: { meetingId }, data: { meetingId: null } });
    deleted.memoriesUnlinked = kept.count;

    // 8. 审计记录本身随会议级联，但先把 delete 事件写进去就没意义了（会一起没）。
    //    所以审计在事务外写，见下方。
    await tx.auditLog.deleteMany({ where: { meetingId } });

    // 9. 最后删会议本体
    await tx.meeting.delete({ where: { id: meetingId } });
    deleted.meetings = 1;

    return { deleted, keptMemories: kept.count };
  }, { timeout: 20_000 });

  // 审计：记在租户维度（会议已不存在，不能再挂在 meetingId 上）
  await audit(
    { tenantId: ctx.tenantId, userId: ctx.userId },
    "meeting.deleted",
    {
      meetingId,
      title: meeting.title,
      hadActiveLive: activeSessions,
      deleted: result.deleted,
      keptMemories: result.keptMemories,
    },
    // 传 undefined：会议已删，挂上去会触发外键错误
    undefined,
  );

  // 音频文件：文件系统无法参与事务，放在最后，失败只记录不影响删除结果
  if (meeting.audioPath) {
    await removeAudioFile(meeting.audioPath);
  }

  return {
    ok: true,
    meetingId,
    title: meeting.title,
    deleted: result.deleted,
    keptMemories: result.keptMemories,
  };
}

/** 删除存储目录下的音频；只允许落在 STORAGE_DIR 内，防止路径穿越删到别处 */
async function removeAudioFile(audioPath: string) {
  try {
    const { unlink } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
    const target = path.resolve(root, path.basename(audioPath));
    if (!target.startsWith(root + path.sep)) {
      console.warn(`[meeting:delete] 拒绝删除存储目录外的文件：${audioPath}`);
      return;
    }
    await unlink(target);
  } catch (e) {
    // 文件可能早已不存在（例如上次删除失败后重试），不影响数据删除
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[meeting:delete] 音频文件删除失败：${(e as Error).message}`);
    }
  }
}