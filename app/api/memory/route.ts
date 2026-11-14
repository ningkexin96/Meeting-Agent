// 记忆管理 API
//   GET  /api/memory            列表（支持 q / kind / status / meetingId 筛选）
//   POST /api/memory            手动新增
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import {
  createMemory,
  listMemories,
  memoryStats,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryKind,
  type MemoryStatus,
} from "@/lib/memory/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard("memory:read");
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const status = url.searchParams.get("status");

  const { items, total } = await listMemories({
    tenantId: g.session.tenantId,
    q: url.searchParams.get("q") ?? undefined,
    kind: kind && MEMORY_KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : undefined,
    status:
      status && MEMORY_STATUSES.includes(status as MemoryStatus) ? (status as MemoryStatus) : undefined,
    meetingId: url.searchParams.get("meetingId") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 50),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });

  const stats = await memoryStats(g.session.tenantId);

  return NextResponse.json({ items, total, stats });
}

export async function POST(req: Request) {
  const g = await guard("minutes:edit");
  if (!g.ok) return g.response;

  let body: { kind?: string; title?: string; content?: string; importance?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const content = String(body.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
  if (content.length > 2000) {
    return NextResponse.json({ error: "内容过长（上限 2000 字）" }, { status: 400 });
  }

  const kind = MEMORY_KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : "fact";

  const m = await createMemory(
    g.session.tenantId,
    { kind, title: body.title?.trim() || undefined, content, importance: body.importance },
    g.session.name,
  );

  return NextResponse.json({ ok: true, id: m.id });
}