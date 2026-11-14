// 单条记忆操作
//   GET    /api/memory/[id]   详情（含变更历史）
//   PATCH  /api/memory/[id]   编辑 / 改状态 / 遗忘 / 恢复
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import {
  forgetMemory,
  getMemory,
  restoreMemory,
  updateMemory,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryKind,
  type MemoryStatus,
} from "@/lib/memory/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("memory:read");
  if (!g.ok) return g.response;

  const { id } = await params;
  const m = await getMemory(g.session.tenantId, id);
  if (!m) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });

  return NextResponse.json({ item: m });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard("minutes:edit");
  if (!g.ok) return g.response;

  const { id } = await params;

  let body: {
    action?: "edit" | "forget" | "restore";
    kind?: string;
    status?: string;
    title?: string | null;
    content?: string;
    importance?: number;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  // 快捷动作
  if (body.action === "forget") {
    const r = await forgetMemory(g.session.tenantId, id, g.session.name, body.reason);
    if (!r) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "restore") {
    const r = await restoreMemory(g.session.tenantId, id, g.session.name);
    if (!r) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  // 字段编辑
  if (body.content !== undefined && !String(body.content).trim()) {
    return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
  }

  const r = await updateMemory(
    g.session.tenantId,
    id,
    {
      kind: MEMORY_KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : undefined,
      status: MEMORY_STATUSES.includes(body.status as MemoryStatus)
        ? (body.status as MemoryStatus)
        : undefined,
      title: body.title,
      content: body.content !== undefined ? String(body.content).trim() : undefined,
      importance: body.importance,
      reason: body.reason,
    },
    g.session.name,
  );

  if (!r) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}