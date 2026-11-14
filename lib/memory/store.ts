// 增量记忆存储 —— 对应 issue #15
// 接口化设计：当前为轻量实现（关键词 + 去重），可无缝替换为 mem0 官方引擎（backlog #24）
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/tools";

export type MemoryItem = {
  kind: "fact" | "preference" | "recurring_issue";
  content: string;
  importance: number;
};

export interface MemoryStore {
  recall(scope: TenantScope, query: string, limit?: number): Promise<{ content: string; meetingId: string | null }[]>;
  remember(scope: TenantScope, meetingId: string, items: MemoryItem[]): Promise<{ added: number; noop: number }>;
}

export const lightweightMemory: MemoryStore = {
  async recall(scope, query, limit = 5) {
    const keywords = query
      .split(/[\s，。？！,?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    const rows = await prisma.memory.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { importance: "desc" },
    });
    return rows
      .filter((r) => keywords.length === 0 || keywords.some((k) => r.content.includes(k)))
      .slice(0, limit)
      .map((r) => ({ content: r.content, meetingId: r.meetingId }));
  },

  async remember(scope, meetingId, items) {
    let added = 0;
    let noop = 0;
    for (const item of items) {
      const dup = await prisma.memory.findFirst({
        where: { tenantId: scope.tenantId, content: item.content },
      });
      if (dup) {
        noop++;
        continue;
      }
      await prisma.memory.create({
        data: {
          tenantId: scope.tenantId,
          meetingId,
          kind: item.kind,
          content: item.content,
          importance: item.importance,
        },
      });
      added++;
    }
    return { added, noop };
  },
};

export const memoryStore: MemoryStore = lightweightMemory;