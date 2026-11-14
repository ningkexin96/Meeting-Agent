// 记忆服务 —— 参考 Miniclaw 的 workspace memory 设计
//
// 与原来 rememberFromMinutes 的区别：
// 原实现只往表里插，插完就再也动不了，时间一长变成一堆无法分辨真伪的文本。
// 这里补上「可管理」需要的东西：
//   分类筛选、状态流转、编辑、遗忘、恢复、变更追溯。

import { prisma } from "@/lib/db/client";

export const MEMORY_KINDS = ["fact", "decision", "lesson", "open_loop"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["active", "proposed", "conflicted", "superseded", "deleted"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  decision: "决议",
  lesson: "经验",
  open_loop: "未闭环",
};

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  active: "生效中",
  proposed: "待确认",
  conflicted: "有冲突",
  superseded: "已过时",
  deleted: "已遗忘",
};

export const SOURCE_LABELS: Record<string, string> = {
  web_user: "手动添加",
  agent_runtime: "会议沉淀",
  migration: "历史导入",
};

export type MemoryListItem = {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  title: string | null;
  content: string;
  importance: number;
  source: string;
  meetingId: string | null;
  meetingTitle: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryQuery = {
  tenantId: string;
  /** 关键词搜索，匹配标题与内容 */
  q?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  meetingId?: string;
  limit?: number;
  offset?: number;
};

export async function listMemories(query: MemoryQuery): Promise<{ items: MemoryListItem[]; total: number }> {
  const where: Record<string, unknown> = { tenantId: query.tenantId };

  if (query.kind) where.kind = query.kind;
  // 默认只看未删除的；显式传 deleted 才看已遗忘的
  if (query.status) where.status = query.status;
  else where.status = { not: "deleted" };

  if (query.meetingId) where.meetingId = query.meetingId;

  if (query.q) {
    where.OR = [{ content: { contains: query.q } }, { title: { contains: query.q } }];
  }

  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  const [rows, total] = await Promise.all([
    prisma.memory.findMany({
      where,
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      take: limit,
      skip: offset,
      include: { meeting: { select: { id: true, title: true } } },
    }),
    prisma.memory.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind as MemoryKind,
      status: r.status as MemoryStatus,
      title: r.title,
      content: r.content,
      importance: r.importance,
      source: r.source,
      meetingId: r.meetingId,
      meetingTitle: r.meeting?.title ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    total,
  };
}

/** 统计各分类/状态的数量，用于页面上的筛选计数 */
export async function memoryStats(tenantId: string) {
  const rows = await prisma.memory.groupBy({
    by: ["kind", "status"],
    where: { tenantId },
    _count: { _all: true },
  });

  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const r of rows) {
    // 已遗忘的不计入分类统计
    if (r.status === "deleted") {
      byStatus.deleted = (byStatus.deleted ?? 0) + r._count._all;
      continue;
    }
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r._count._all;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r._count._all;
  }

  return { byKind, byStatus, total: Object.values(byKind).reduce((s, n) => s + n, 0) };
}

export async function getMemory(tenantId: string, id: string) {
  const m = await prisma.memory.findFirst({
    where: { id, tenantId },
    include: {
      meeting: { select: { id: true, title: true } },
      changes: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!m) return null;

  return {
    id: m.id,
    kind: m.kind as MemoryKind,
    status: m.status as MemoryStatus,
    title: m.title,
    content: m.content,
    importance: m.importance,
    source: m.source,
    meetingId: m.meetingId,
    meetingTitle: m.meeting?.title ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    changes: m.changes.map((c) => ({
      id: c.id,
      changeType: c.changeType,
      actor: c.actor,
      reason: c.reason,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

export type UpdateInput = {
  kind?: MemoryKind;
  status?: MemoryStatus;
  title?: string | null;
  content?: string;
  importance?: number;
  reason?: string;
};

export async function updateMemory(
  tenantId: string,
  id: string,
  input: UpdateInput,
  actor: string,
) {
  const before = await prisma.memory.findFirst({ where: { id, tenantId } });
  if (!before) return null;

  const data: Record<string, unknown> = {};
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.status !== undefined) data.status = input.status;
  if (input.title !== undefined) data.title = input.title;
  if (input.content !== undefined) data.content = input.content;
  if (input.importance !== undefined) data.importance = Math.max(0, Math.min(1, input.importance));

  if (Object.keys(data).length === 0) return { unchanged: true as const };

  const indexOps = input.status === "deleted"
    ? [prisma.embedding.deleteMany({ where: { tenantId, objectType: "memory", objectId: id } })]
    : input.content !== undefined
      ? [prisma.embedding.updateMany({
          where: { tenantId, objectType: "memory", objectId: id },
          data: { content: input.content },
        })]
      : [];

  const [updated] = await prisma.$transaction([
    prisma.memory.update({ where: { id }, data }),
    prisma.memoryChange.create({
      data: {
        memoryId: id,
        changeType: input.status === "deleted" ? "forget" : "update",
        before: JSON.stringify({
          kind: before.kind,
          status: before.status,
          title: before.title,
          content: before.content,
          importance: before.importance,
        }),
        after: JSON.stringify(data),
        actor,
        reason: input.reason ?? null,
      },
    }),
    ...indexOps,
  ]);

  return { updated };
}

/** 遗忘：软删除，可恢复 */
export async function forgetMemory(tenantId: string, id: string, actor: string, reason?: string) {
  return updateMemory(tenantId, id, { status: "deleted", reason }, actor);
}

/** 恢复：从已遗忘状态恢复为生效 */
export async function restoreMemory(tenantId: string, id: string, actor: string) {
  return updateMemory(tenantId, id, { status: "active", reason: "从遗忘中恢复" }, actor);
}

/** 手动新增一条记忆 */
export async function createMemory(
  tenantId: string,
  input: { kind: MemoryKind; title?: string; content: string; importance?: number },
  actor: string,
) {
  const m = await prisma.memory.create({
    data: {
      tenantId,
      kind: input.kind,
      status: "active",
      title: input.title ?? null,
      content: input.content,
      importance: input.importance ?? 0.6,
      source: "web_user",
      createdBy: actor,
    },
  });

  await prisma.memoryChange.create({
    data: {
      memoryId: m.id,
      changeType: "create",
      after: JSON.stringify({ kind: m.kind, content: m.content }),
      actor,
      reason: "手动添加",
    },
  });

  return m;
}