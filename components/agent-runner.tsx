"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  Terminal,
  TriangleAlert,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type RunEvent =
  | { type: "stage"; stage: string; note?: string; at: number }
  | { type: "tool"; tool: string; args: Record<string, unknown>; ok: boolean; at: number }
  | { type: "text"; text: string; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "done"; meetingId: string; at: number };

const STAGES = [
  { key: "PREPARING", label: "准备" },
  { key: "SUMMARIZING", label: "压缩" },
  { key: "EXTRACTING", label: "抽取" },
  { key: "REVIEWING", label: "复核" },
  { key: "DONE", label: "完成" },
];

export function AgentRunner({
  meetingId,
  role,
  initialStage,
  hasMinutes,
  history = [],
}: {
  meetingId: string;
  role: string;
  initialStage: string;
  hasMinutes: boolean;
  history?: { stage: string; note?: string; at: number }[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState<RunEvent[]>(
    // 刷新后用审计日志恢复上次运行的阶段轨迹，而不是显示一片空白
    history.map((h) => ({ type: "stage" as const, stage: h.stage, note: h.note, at: h.at })),
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const canRun = role === "owner" || role === "member";

  useEffect(() => {
    const es = new EventSource(`/api/meetings/${meetingId}/stream`);
    esRef.current = es;
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as RunEvent;
        if (!["stage", "tool", "text", "error", "done"].includes(e.type)) return;
        setEvents((prev) => [...prev, e]);
        if (e.type === "done") {
          setRunning(false);
          router.refresh();
        }
        if (e.type === "error") {
          setRunning(false);
          setError(e.message);
        }
      } catch {
        /* 心跳 */
      }
    };
    return () => es.close();
  }, [meetingId, router]);

  async function start() {
    setError(null);
    setRunning(true);
    // 清掉上一轮的历史轨迹：否则会和本次的新事件叠在一起，出现两组相同阶段
    setEvents([]);
    const res = await fetch(`/api/meetings/${meetingId}/run`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "触发失败");
      setRunning(false);
    }
  }

  const currentStage = [...events].reverse().find((e) => e.type === "stage")?.stage ?? initialStage;
  // FAILED 不在 STAGES 里，findIndex 返回 -1 —— 此时所有阶段都算「未进行」
  const currentIdx = STAGES.findIndex((s) => s.key === currentStage);
  const finished = currentStage === "DONE";
  const failed = currentStage === "FAILED";
  const tools = events.filter((e) => e.type === "tool") as Extract<RunEvent, { type: "tool" }>[];
  const texts = events.filter((e) => e.type === "text") as Extract<RunEvent, { type: "text" }>[];
  const stageEvents = events.filter((e) => e.type === "stage") as Extract<RunEvent, { type: "stage" }>[];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Agent 运行视图
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            状态机控制阶段边界，阶段内由 Agent 自主编排
          </p>
        </div>
        <Button onClick={start} disabled={!canRun || running} size="sm">
          {!canRun ? "无权限触发" : running ? <><Loader2 className="size-3.5 animate-spin" />运行中</> : hasMinutes ? "重新生成" : <><Play className="size-3.5" />生成纪要</>}
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 阶段进度 */}
        <div className="flex items-center gap-1">
          {STAGES.map((s, i) => {
            // 三态优先级：整体完成 > 该阶段已过 > 该阶段进行中
            // 关键修复：currentStage 停在 DONE 时，DONE 不能被判成「进行中」而一直转圈。
            const done = finished || currentIdx > i;
            const active = !finished && !failed && currentIdx === i;
            return (
              <div key={s.key} className="flex flex-1 items-center gap-1">
                <div
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                    done && "bg-primary/10 text-primary",
                    active && "bg-primary text-primary-foreground",
                    !done && !active && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="size-3" />
                  ) : active ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <CircleDashed className="size-3" />
                  )}
                  <span className="truncate">{s.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* 终态提示：明确告诉用户已经跑完，不需要再猜 */}
        {finished && !running && (
          <div className="flex items-center gap-1.5 rounded-lg bg-success-bg px-2.5 py-2 text-xs text-success">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>运行完成，纪要已生成。如需重跑可点右上角「重新生成」。</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1.5 rounded-lg bg-error-bg px-2.5 py-2 text-xs text-error">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>运行失败：{error}</span>
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          {/* 工具调用 */}
          <div className="rounded-lg border border-border bg-muted/30 p-2">
            <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Terminal className="size-3" />
              工具调用
            </div>
            <div className="max-h-40 space-y-0.5 overflow-auto">
              {tools.length === 0 && <div className="text-[11px] text-muted-foreground/60">暂无</div>}
              {tools.map((t, i) => (
                <div key={i} className="flex items-start gap-1 font-mono text-[11px] leading-relaxed">
                  <span className={t.ok ? "text-success" : "text-error"}>{t.ok ? "✓" : "✗"}</span>
                  <span className="font-semibold text-foreground">{t.tool}</span>
                  <span className="truncate text-muted-foreground">{JSON.stringify(t.args)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 模型输出 */}
          <div className="rounded-lg border border-border bg-muted/30 p-2">
            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">模型输出</div>
            <div className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {texts.length === 0 ? "暂无" : texts.map((t, i) => <div key={i}>{t.text}</div>)}
            </div>
          </div>
        </div>

        {/* 事件流 */}
        {stageEvents.length > 0 && (
          <div className="space-y-0.5 rounded-lg border border-border p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">阶段轨迹</span>
              <span className="text-[10px] text-muted-foreground/70">
                {stageEvents.length} 条 · 最新的在最下方
              </span>
            </div>
            <div className="max-h-32 space-y-0.5 overflow-auto">
              {stageEvents.map((s, i) => (
                <div key={`${s.at}-${s.stage}-${i}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="font-mono">{new Date(s.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                  <Badge
                    variant={s.stage === "DONE" ? "success" : s.stage === "FAILED" ? "error" : "neutral"}
                    className="h-4 px-1.5 text-[10px]"
                  >
                    {s.stage}
                  </Badge>
                  <span className="truncate">{s.note}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}