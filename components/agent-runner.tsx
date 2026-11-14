"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type RunEvent =
  | { type: "stage"; stage: string; note?: string; at: number }
  | { type: "tool"; tool: string; args: Record<string, unknown>; ok: boolean; at: number }
  | { type: "text"; text: string; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "done"; meetingId: string; at: number };

const STAGES = ["PREPARING", "SUMMARIZING", "EXTRACTING", "REVIEWING", "DONE"];

export function AgentRunner({
  meetingId,
  role,
  initialStage,
}: {
  meetingId: string;
  role: string;
  initialStage: string;
}) {
  const router = useRouter();
  const [events, setEvents] = useState<RunEvent[]>([]);
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
        /* 忽略心跳 */
      }
    };
    return () => es.close();
  }, [meetingId, router]);

  async function start() {
    setError(null);
    setRunning(true);
    const res = await fetch(`/api/meetings/${meetingId}/run`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "触发失败");
      setRunning(false);
    }
  }

  const currentStage =
    [...events].reverse().find((e) => e.type === "stage")?.stage ?? initialStage;
  const toolEvents = events.filter((e) => e.type === "tool");
  const textEvents = events.filter((e) => e.type === "text");

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Agent 运行视图</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            状态机控制阶段边界，阶段内由 Agent 自主编排（对应 issue #9 / #11）
          </p>
        </div>
        <button className="btn-primary" onClick={start} disabled={!canRun || running}>
          {!canRun ? "无权限触发" : running ? "运行中…" : "生成纪要"}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-1">
        {STAGES.map((s, i) => {
          const idx = STAGES.indexOf(currentStage);
          const active = i <= idx && idx >= 0;
          return (
            <div key={s} className="flex flex-1 items-center gap-1">
              <div
                className={`flex-1 rounded-md px-2 py-1 text-center text-[11px] ${
                  active ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"
                }`}
              >
                {s}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          运行失败：{error}
        </div>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">工具调用</div>
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg bg-slate-50 p-2">
            {toolEvents.length === 0 && <div className="text-xs text-slate-400">暂无</div>}
            {toolEvents.map((e, i) => {
              const t = e as Extract<RunEvent, { type: "tool" }>;
              return (
                <div key={i} className="mono text-[11px]">
                  <span className={t.ok ? "text-emerald-600" : "text-rose-600"}>
                    {t.ok ? "✓" : "✗"}
                  </span>{" "}
                  <b>{t.tool}</b>{" "}
                  <span className="text-slate-500">{JSON.stringify(t.args)}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">模型输出（摘要）</div>
          <div className="max-h-56 overflow-auto rounded-lg bg-slate-50 p-2 text-xs whitespace-pre-wrap">
            {textEvents.length === 0
              ? "暂无"
              : textEvents.map((e, i) => (
                  <div key={i}>{(e as Extract<RunEvent, { type: "text" }>).text}</div>
                ))}
          </div>
        </div>
      </div>

      <div className="mt-3 max-h-32 overflow-auto rounded-lg border border-slate-100 p-2">
        <div className="mb-1 text-xs font-medium text-slate-500">事件流</div>
        {events.filter((e) => e.type === "stage").map((e, i) => {
          const s = e as Extract<RunEvent, { type: "stage" }>;
          return (
            <div key={i} className="text-[11px] text-slate-600">
              <span className="mono">{new Date(s.at).toLocaleTimeString("zh-CN")}</span>{" "}
              <span className="pill bg-slate-100">{s.stage}</span> {s.note}
            </div>
          );
        })}
      </div>
    </div>
  );
}