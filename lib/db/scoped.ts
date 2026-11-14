// 租户作用域封装 —— 对应 issue #4（第 3 层：数据层强制 tenant 过滤）
// 约定：所有业务查询都必须经过这里，禁止直接 import prisma 去查租户数据
import { prisma } from "./client";
import type { Prisma } from "@prisma/client";

export type Scoped = { tenantId: string; userId: string; role: string };

export function scopedMeeting(scope: Scoped) {
  return {
    findMany: (args: Prisma.MeetingFindManyArgs = {}) =>
      prisma.meeting.findMany({
        ...args,
        where: { AND: [{ tenantId: scope.tenantId }, args.where ?? {}] },
        orderBy: args.orderBy ?? { createdAt: "desc" },
      }),
    findFirst: (args: Prisma.MeetingFindFirstArgs = {}) =>
      prisma.meeting.findFirst({
        ...args,
        where: { AND: [{ tenantId: scope.tenantId }, args.where ?? {}] },
      }),
    findByIdInTenant: (id: string) =>
      prisma.meeting.findFirst({ where: { id, tenantId: scope.tenantId } }),
  };
}

export function scopedMemory(scope: Scoped) {
  return {
    findMany: (args: Prisma.MemoryFindManyArgs = {}) =>
      prisma.memory.findMany({
        ...args,
        where: { AND: [{ tenantId: scope.tenantId }, args.where ?? {}] },
      }),
    create: (data: Prisma.MemoryUncheckedCreateInput) =>
      prisma.memory.create({ data: { ...data, tenantId: scope.tenantId } }),
  };
}

export async function audit(
  scope: Pick<Scoped, "tenantId"> & { userId?: string },
  action: string,
  detail: Record<string, unknown> = {},
  meetingId?: string,
) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        meetingId: meetingId ?? null,
        actorId: scope.userId ?? null,
        action,
        detail: JSON.stringify(detail),
      },
    });
  } catch (err) {
    // 审计失败不阻断主流程，但必须可见
    console.error("[audit] failed", action, err);
  }
}