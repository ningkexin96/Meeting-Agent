"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  FileText,
  Gavel,
  ListTodo,
  Loader2,
  Mic,
  Radio,
  ShieldAlert,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLiveRecorder } from "./use-live-recorder";
import { cn, formatMs } from "@/lib/utils";

type Segment = {
  seq: number;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  needsReview: boolean;
};

type MinuteItem = {
  id: string;
  kind: "decision" | "action_item" | "risk";
  content: string;
  owner?: string | null;
  dueAt?: string | null;
  severity?: string;
};

export function LivePanel({
  meetingId,
  canRun,
  lastSessionId,
}: {
  meetingId: string;
  canRun: boolean;
  lastSessionId?: string | null;
}) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [items, setItems] = useState<MinuteItem[]>([]);
  const [failed, setFailed] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const restored = useRef(false);

  const onChunkResult = useCallback(
    (r: { seq: number; ok: boolean; added: number; error?: string }) => {
      if (!r.ok) {
        setFailed((n) => n + 1);
        if (r.error) setHint(`分片 #${r.seq} 失败：${r.error}（已跳过）`);
      }
    },
    [],
  );

  const recorder = useLiveRecorder({ sessionId, chunkMs: 4000, onChunkResult });

  // 恢复上一场会话
  useEffect(() => {
    if (restored.current || !lastSessionId) return;
    restored.current = true;
    void (async () => {
      const res = await fetch(`/api/live?sessionId=${lastSessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSegments(data.segments ?? []);
      setItems(data.items ?? []);
      setFailed((data.chunks ?? []).filter((c: { status: string }) => c.status === "failed").length);
      setSessionId(lastSessionId);
      if (data.status === "ended") setEnded(true);
    })();
  }, [lastSessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/live/${sessionId}/stream`);
    esRef.current = es;
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data);
        if (e.type === "live:segment") {
          setSegments((prev) => (prev.some((s) => s.seq === e.segment.seq) ? prev : [...prev, e.segment]));
        } else if (e.type === "live:minutes") {
          setItems((prev) => [...prev, ...e.items]);
        } else if (e.type === "live:ended") {
          setEnded(true);
        } else if (e.type === "text") {
          setHint(e.text);
        }
      } catch {
        /* 心跳 */
      }
    };
    return () => es.close();
  }, [sessionId]);

  async function start() {
    setHint(null);
    setEnded(false);
    setSegments([]);
    setItems([]);
    setFailed(0);
    const res = await fetch("/api/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meetingId }),
    });
    const data = await res.json();
    if (!res.ok) return setHint(data.error ?? "开启失败");
    setSessionId(data.sessionId);
    await recorder.start();
  }

  async function end() {
    recorder.stop();
    if (!sessionId) return;
    setEnding(true);
    const res = await fetch("/api/live/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    setEnding(false);
    if (!res.ok) return setHint(data.error ?? "结束失败");
    setEnded(true);
    router.refresh();
  }

  const recording = recorder.state === "recording";
  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action_item");
  const risks = items.filter((i) => i.kind === "risk");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Radio className={cn("size-4", recording ? "text-error" : "text-primary")} />
              实时会议
              {recording && (
                <Badge variant="error" className="gap-1">
                  <span className="size-1.5 animate-pulse-dot rounded-full bg-error" />
                  录音中
                </Badge>
              )}
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              每 4 秒切一片上传，边说边出转写与增量纪要
            </p>
          </div>
          {!sessionId || ended ? (
            <Button onClick={start} disabled={!canRun || ending} size="sm">
              <Mic className="size-3.5" />
              {ended ? "重新开始" : "开始实时会议"}
            </Button>
          ) : (
            <Button onClick={end} disabled={ending} size="sm" variant="destructive">
              {ending ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              {ending ? "合并中…" : "结束并生成纪要"}
            </Button>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {!canRun && (
            <div className="rounded-lg bg-warning-bg px-2.5 py-2 text-xs text-warning">
              当前角色无权限开启实时会议（需要 owner 或 member）
            </div>
          )}
          {recorder.error && (
            <div className="flex items-start gap-1.5 rounded-lg bg-error-bg px-2.5 py-2 text-xs text-error">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {recorder.error}
            </div>
          )}
          {hint && (
            <div className="rounded-lg bg-muted px-2.5 py-2 text-xs text-muted-foreground">{hint}</div>
          )}

          {sessionId && (
            <div className="grid grid-cols-4 gap-2">
              <Stat icon={Activity} label="已录" value={formatMs(recorder.elapsedMs)} />
              <Stat icon={Mic} label="分片" value={String(recorder.chunkCount)} />
              <Stat icon={Loader2} label="上传中" value={String(recorder.pending)} />
              <Stat icon={TriangleAlert} label="失败" value={String(failed)} danger={failed > 0} />
            </div>
          )}
        </CardContent>
      </Card>

      {sessionId && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Mic className="size-4 text-primary" />
                实时转写
              </CardTitle>
              <Badge variant="neutral">{segments.length} 条</Badge>
            </CardHeader>
            <CardContent>
              <div className="max-h-[420px] space-y-1.5 overflow-auto pr-1">
                {segments.length === 0 && (
                  <div className="py-10 text-center text-xs text-muted-foreground">
                    开始说话后会实时出现在这里…
                  </div>
                )}
                {segments.map((s) => (
                  <div key={s.seq} className="animate-fade-in rounded-lg bg-primary/5 px-2.5 py-2 ring-1 ring-primary/15">
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>#{s.seq}</span>
                      <span className="font-mono">{formatMs(s.startMs)}</span>
                    </div>
                    <div className="mt-0.5 text-[13px] leading-relaxed">{s.text}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileText className="size-4 text-primary" />
                增量纪要
              </CardTitle>
              <Badge variant="neutral">{items.length} 条</Badge>
            </CardHeader>
            <CardContent>
              <div className="max-h-[420px] space-y-3 overflow-auto pr-1">
                {items.length === 0 && (
                  <div className="py-10 text-center text-xs text-muted-foreground">
                    每积累 4 条转写会抽一次，随会议进行逐渐出现…
                  </div>
                )}
                <Group icon={Gavel} title="决议" tone="text-success" items={decisions} />
                <Group icon={ListTodo} title="待办" tone="text-primary" items={actions} />
                <Group icon={ShieldAlert} title="风险" tone="text-error" items={risks} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {ended && (
        <div className="rounded-lg bg-success-bg px-3 py-2 text-sm text-success">
          实时会议已结束，纪要已合并到会议详情页。可点击条目上的引用回看原话。
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  danger,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <div className={cn("font-mono text-sm font-semibold", danger && "text-error")}>{value}</div>
    </div>
  );
}

function Group({
  icon: Icon,
  title,
  tone,
  items,
}: {
  icon: typeof Gavel;
  title: string;
  tone: string;
  items: MinuteItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className={cn("size-3.5", tone)} />
        <span className="text-xs font-medium">{title}</span>
        <Badge variant="neutral" className="h-4 px-1 text-[10px]">{items.length}</Badge>
      </div>
      <div className="space-y-1">
        {items.map((i) => (
          <div key={i.id} className="animate-fade-in rounded-lg border border-border px-2 py-1.5 text-xs">
            <div className="leading-relaxed">{i.content}</div>
            {(i.owner || i.dueAt || (i.severity && i.kind === "risk")) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {i.owner && <Badge variant="neutral" className="h-[16px] px-1 text-[10px]">{i.owner}</Badge>}
                {i.dueAt && <Badge variant="neutral" className="h-[16px] px-1 text-[10px]">{i.dueAt}</Badge>}
                {i.severity && i.kind === "risk" && (
                  <Badge variant={i.severity === "high" ? "error" : "warning"} className="h-[16px] px-1 text-[10px]">
                    {i.severity === "high" ? "高" : i.severity === "low" ? "低" : "中"}
                  </Badge>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}