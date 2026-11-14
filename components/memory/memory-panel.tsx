"use client";

// 记忆管理页面 —— 参考 Miniclaw 的 MemoryPage 设计
//
// 三栏结构：筛选 + 列表 + 详情
// 核心能力：按类别/状态筛选、搜索、编辑、标记过时、遗忘、恢复、查看变更历史

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookMarked,
  Brain,
  CheckCircle2,
  CircleSlash,
  Clock,
  Edit3,
  History,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

type MemoryKind = "fact" | "decision" | "lesson" | "open_loop";
type MemoryStatus = "active" | "proposed" | "conflicted" | "superseded" | "deleted";

type Item = {
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

type Change = {
  id: string;
  changeType: string;
  actor: string | null;
  reason: string | null;
  createdAt: string;
};

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  decision: "决议",
  lesson: "经验",
  open_loop: "未闭环",
};

const STATUS_LABELS: Record<MemoryStatus, string> = {
  active: "生效中",
  proposed: "待确认",
  conflicted: "有冲突",
  superseded: "已过时",
  deleted: "已遗忘",
};

const STATUS_VARIANT: Record<MemoryStatus, "success" | "warning" | "error" | "neutral"> = {
  active: "success",
  proposed: "warning",
  conflicted: "error",
  superseded: "neutral",
  deleted: "neutral",
};

const SOURCE_LABELS: Record<string, string> = {
  web_user: "手动添加",
  agent_runtime: "会议沉淀",
  migration: "历史导入",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return d.toLocaleDateString("zh-CN");
}

export function MemoryPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [stats, setStats] = useState<{ byKind: Record<string, number>; byStatus: Record<string, number>; total: number }>({
    byKind: {},
    byStatus: {},
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [status, setStatus] = useState<MemoryStatus | "">("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<(Item & { changes: Change[] }) | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editKind, setEditKind] = useState<MemoryKind>("fact");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("fact");

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (status) params.set("status", status);
    const res = await fetch(`/api/memory?${params}`);
    if (res.ok) {
      const data = await res.json();
      setItems(data.items ?? []);
      setStats(data.stats ?? { byKind: {}, byStatus: {}, total: 0 });
    }
    setLoading(false);
  }, [q, kind, status]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/memory/${id}`);
    if (res.ok) {
      const data = await res.json();
      setDetail(data.item);
      setEditContent(data.item.content);
      setEditTitle(data.item.title ?? "");
      setEditKind(data.item.kind);
      setEditing(false);
    }
  }, []);

  useEffect(() => {
    if (selected) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg(data.error ?? "操作失败");
      return false;
    }
    await load();
    if (selected) await loadDetail(selected);
    return true;
  }

  async function saveEdit() {
    if (!detail) return;
    const ok = await patch(detail.id, {
      action: "edit",
      content: editContent,
      title: editTitle || null,
      kind: editKind,
    });
    if (ok) {
      setEditing(false);
      setMsg("已保存");
    }
  }

  async function create() {
    if (!newContent.trim()) return;
    setBusy(true);
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: newKind, content: newContent }),
    });
    setBusy(false);
    if (res.ok) {
      setNewContent("");
      setCreating(false);
      setMsg("已添加");
      void load();
    }
  }

  const shownStatus: MemoryStatus | "all" = status || "all";

  return (
    <div className="space-y-4">
      <PageHeader
        title="记忆管理"
        subtitle="会议沉淀的长期记忆，可查看、编辑、标记过时或遗忘"
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus className="size-3.5" />
              手动添加
            </Button>
          ) : undefined
        }
      />

      {/* 手动添加 */}
      {creating && (
        <Card size="sm">
          <CardContent className="space-y-2">
            <div className="flex gap-1.5">
              {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setNewKind(k)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs transition-colors",
                    newKind === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
                  )}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <textarea
              className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
              rows={3}
              placeholder="要记住的内容…"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
            />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void create()} disabled={busy || !newContent.trim()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                添加
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 统计 + 筛选 */}
      <Card size="sm">
        <CardContent className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative flex-1 min-w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8"
                placeholder="搜索记忆内容…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(kind === k ? "" : k)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs transition-colors",
                  kind === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
                )}
              >
                {KIND_LABELS[k]}
                <span className="ml-1 opacity-60">{stats.byKind[k] ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">状态</span>
            {(Object.keys(STATUS_LABELS) as MemoryStatus[]).map((s) => {
              const n = stats.byStatus[s] ?? 0;
              if (n === 0 && s !== "deleted") return null;
              return (
                <button
                  key={s}
                  onClick={() => setStatus(status === s ? "" : s)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                    status === s
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {STATUS_LABELS[s]} {n}
                </button>
              );
            })}
            {(kind || status || q) && (
              <button
                onClick={() => {
                  setKind("");
                  setStatus("");
                  setQ("");
                }}
                className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <X className="size-2.5" />
                清除
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {msg && (
        <div className="rounded-lg bg-success-bg px-3 py-2 text-xs text-success">{msg}</div>
      )}

      {/* 主体：列表 + 详情 */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Brain className="size-4 text-primary" />
              记忆列表
            </CardTitle>
            <Badge variant="neutral">{items.length} 条</Badge>
          </CardHeader>
          <CardContent>
            <div className="max-h-[560px] space-y-1.5 overflow-auto pr-1">
              {loading && items.length === 0 && (
                <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  加载中…
                </div>
              )}
              {!loading && items.length === 0 && (
                <div className="py-10 text-center text-xs text-muted-foreground">
                  {q || kind || status ? "没有符合条件的记忆" : "还没有记忆，会议生成纪要后会自动沉淀"}
                </div>
              )}
              {items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => setSelected(it.id)}
                  className={cn(
                    "w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
                    selected === it.id
                      ? "border-primary/40 bg-primary/5"
                      : "border-border hover:border-primary/30 hover:bg-muted/40",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Badge variant="neutral" className="h-4 shrink-0 px-1 text-[10px]">
                      {KIND_LABELS[it.kind]}
                    </Badge>
                    {it.status !== "active" && (
                      <Badge variant={STATUS_VARIANT[it.status]} className="h-4 shrink-0 px-1 text-[10px]">
                        {STATUS_LABELS[it.status]}
                      </Badge>
                    )}
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {formatTime(it.createdAt)}
                    </span>
                  </div>
                  {it.title && <div className="mt-1 truncate text-[13px] font-medium">{it.title}</div>}
                  <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {it.content}
                  </div>
                  {it.meetingTitle && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/80">
                      <BookMarked className="size-2.5" />
                      {it.meetingTitle}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Edit3 className="size-4 text-primary" />
              详情
            </CardTitle>
            {detail && canEdit && !editing && (
              <div className="flex gap-1">
                {detail.status === "deleted" ? (
                  <Button size="xs" variant="outline" onClick={() => void patch(detail.id, { action: "restore" })} disabled={busy}>
                    <RotateCcw className="size-3" />
                    恢复
                  </Button>
                ) : (
                  <>
                    <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                      <Edit3 className="size-3" />
                      编辑
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-error hover:text-error"
                      onClick={() => void patch(detail.id, { action: "forget" })}
                      disabled={busy}
                    >
                      <Trash2 className="size-3" />
                      遗忘
                    </Button>
                  </>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent>
            {!detail && (
              <div className="py-16 text-center text-xs text-muted-foreground">从左侧选择一条记忆查看详情</div>
            )}

            {detail && !editing && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="neutral">{KIND_LABELS[detail.kind]}</Badge>
                  <Badge variant={STATUS_VARIANT[detail.status]}>{STATUS_LABELS[detail.status]}</Badge>
                  <Badge variant="neutral">{SOURCE_LABELS[detail.source] ?? detail.source}</Badge>
                  <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="size-2.5" />
                    {formatTime(detail.createdAt)}
                  </span>
                </div>

                {detail.title && <div className="text-sm font-medium">{detail.title}</div>}

                <div className="rounded-lg bg-muted/40 px-3 py-2.5 text-[13px] leading-relaxed">
                  {detail.content}
                </div>

                {detail.meetingId && (
                  <a
                    href={`/meetings/${detail.meetingId}`}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <BookMarked className="size-3" />
                    来源会议：{detail.meetingTitle}
                  </a>
                )}

                {canEdit && detail.status === "active" && (
                  <div className="flex flex-wrap gap-1.5 border-t border-border pt-2.5">
                    <span className="w-full text-[11px] text-muted-foreground">标记状态</span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void patch(detail.id, { status: "superseded", reason: "已被新结论取代" })}
                      disabled={busy}
                    >
                      <CircleSlash className="size-3" />
                      已过时
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void patch(detail.id, { status: "conflicted", reason: "与其他记忆冲突" })}
                      disabled={busy}
                    >
                      <TriangleAlert className="size-3" />
                      有冲突
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void patch(detail.id, { status: "proposed", reason: "待人工确认" })}
                      disabled={busy}
                    >
                      <CheckCircle2 className="size-3" />
                      待确认
                    </Button>
                  </div>
                )}

                {detail.changes.length > 0 && (
                  <div className="border-t border-border pt-2.5">
                    <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <History className="size-3" />
                      变更记录
                    </div>
                    <div className="space-y-1">
                      {detail.changes.map((c) => (
                        <div key={c.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className="font-mono text-[10px]">{new Date(c.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                          <Badge variant="neutral" className="h-4 px-1 text-[10px]">
                            {c.changeType === "create" ? "创建" : c.changeType === "forget" ? "遗忘" : c.changeType === "restore" ? "恢复" : "修改"}
                          </Badge>
                          <span className="truncate">{c.reason ?? c.actor ?? ""}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {detail && editing && (
              <div className="space-y-2.5">
                <div className="flex gap-1.5">
                  {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => setEditKind(k)}
                      className={cn(
                        "rounded-lg px-2.5 py-1 text-xs transition-colors",
                        editKind === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
                <Input
                  className="h-8"
                  placeholder="标题（可选）"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
                <textarea
                  className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
                  rows={8}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => void saveEdit()} disabled={busy}>
                    {busy && <Loader2 className="size-3.5 animate-spin" />}
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}