"use client";

// 实时会议面板 —— 对应 issue #26
// 左：录音控制 / 右：实时转写 + 增量纪要

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveRecorder } from "./use-live-recorder";

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

type ChunkStatus = { seq: number; status: string; error?: string | null };

export function LivePanel({
  meetingId,
  title,
  canRun,
  lastSessionId,
  lastSessionEnded,
}: {
  meetingId: string;
  title: string;
  canRun: boolean;
  lastSessionId?: string | null;
  lastSessionEnded?: boolean;
}) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [items, setItems] = useState<MinuteItem[]>([]);
  const [chunks, setChunks] = useState<ChunkStatus[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const restoredRef = useRef(false);

  // 页面加载时恢复上一场已结束的实时会话内容（避免刷新后什么都看不到）
  useEffect(() => {
    if (restoredRef.current || !lastSessionId) return;
    restoredRef.current = true;
    void (async () => {
      const res = await fetch(`/api/live?sessionId=${lastSessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSegments(data.segments ?? []);
      setItems(data.items ?? []);
      setChunks(data.chunks ?? []);
      setSessionId(lastSessionId);
      if (data.status === "ended") setEnded(true);
    })();
  }, [lastSessionId]);

  const onChunkResult = useCallback((r: { seq: number; ok: boolean; added: number; error?: string }) => {
    setChunks((prev) => [...prev.filter((c) => c.seq !== r.seq), { seq: r.seq, status: r.ok ? "transcribed" : "failed", error: r.error }]);
    if (!r.ok && r.error) setHint(`分片 #${r.seq} 失败：${r.error}（已跳过，后续继续）`);
  }, []);

  const recorder = useLiveRecorder({ sessionId, chunkMs: 4000, onChunkResult });

  // 订阅实时事件
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/live/${sessionId}/stream`);
    esRef.current = es;
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data);
        if (e.type === "live:segment") {
          setSegments((prev) =>
            prev.some((s) => s.seq === e.segment.seq) ? prev : [...prev, e.segment],
          );
        } else if (e.type === "live:minutes") {
          setItems((prev) => [...prev, ...e.items]);
        } else if (e.type === "live:chunk") {
          setChunks((prev) => [
            ...prev.filter((c) => c.seq !== e.seq),
            { seq: e.seq, status: e.status, error: e.error },
          ]);
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
    const res = await fetch("/api/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meetingId, title }),
    });
    const data = await res.json();
    if (!res.ok) {
      setHint(data.error ?? "开启实时会议失败");
      return;
    }
    setSessionId(data.sessionId);
    setSegments([]);
    setItems([]);
    setChunks([]);
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
    if (!res.ok) {
      setHint(data.error ?? "结束失败");
      return;
    }
    setEnded(true);
    router.refresh();
  }

  const recording = recorder.state === "recording";
  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action_item");
  const risks = items.filter((i) => i.kind === "risk");

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">实时会议</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              每 4 秒切一片上传，边说边出转写与增量纪要（issue #26）
            </p>
          </div>
          <div className="flex items-center gap-2">
            {recording && (
              <span className="pill animate-pulse bg-rose-100 text-rose-700">● 录音中</span>
            )}
            {!sessionId || ended ? (
              <button className="btn-primary" onClick={start} disabled={!canRun || ending}>
                {ended ? "重新开始实时会议" : "开始实时会议"}
              </button>
            ) : (
              <button className="btn-primary bg-rose-600 hover:bg-rose-700" onClick={end} disabled={ending}>
                {ending ? "合并纪要中…" : "结束并生成纪要"}
              </button>
            )}
          </div>
        </div>

        {!canRun && (
          <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-700">
            当前角色无权限开启实时会议（需要 owner 或 member）
          </p>
        )}

        {recorder.error && (
          <p className="mt-2 rounded bg-rose-50 p-2 text-xs text-rose-700">{recorder.error}</p>
        )}
        {hint && <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-600">{hint}</p>}

        {sessionId && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <Stat label="已录时长" value={fmt(recorder.elapsedMs)} />
            <Stat label="分片数" value={String(recorder.chunkCount)} />
            <Stat label="上传中" value={String(recorder.pending)} />
            <Stat label="失败分片" value={String(chunks.filter((c) => c.status === "failed").length)} />
          </div>
        )}
      </div>

      {sessionId && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">实时转写</h3>
              <span className="pill bg-slate-100 text-slate-600">{segments.length} 条</span>
            </div>
            <div className="mt-3 max-h-[420px] space-y-1.5 overflow-auto pr-1">
              {segments.length === 0 && (
                <p className="text-xs text-slate-400">开始说话后会在这里实时出现…</p>
              )}
              {segments.map((s) => (
                <div key={s.seq} className="rounded-lg bg-blue-50 px-3 py-2">
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>#{s.seq}</span>
                    <span className="mono">{fmt(s.startMs)}</span>
                  </div>
                  <div className="mt-0.5 text-sm">{s.text}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">增量纪要</h3>
              <span className="pill bg-slate-100 text-slate-600">{items.length} 条</span>
            </div>
            <div className="mt-3 max-h-[420px] space-y-3 overflow-auto pr-1">
              <Group title="决议" color="text-emerald-700" items={decisions} />
              <Group title="待办" color="text-blue-700" items={actions} />
              <Group title="风险" color="text-rose-700" items={risks} />
              {items.length === 0 && (
                <p className="text-xs text-slate-400">
                  每积累 4 条转写会抽一次，随着会议进行逐渐出现…
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {ended && (
        <div className="card border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          实时会议已结束，纪要已合并到下方「会议纪要」。可点击条目上的引用回看原话。
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mono text-sm font-medium">{value}</div>
    </div>
  );
}

function Group({ title, color, items }: { title: string; color: string; items: MinuteItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`mb-1 text-xs font-medium ${color}`}>{title}（{items.length}）</div>
      <div className="space-y-1">
        {items.map((i) => (
          <div key={i.id} className="rounded border border-slate-200 px-2 py-1.5 text-xs">
            <div>{i.content}</div>
            {(i.owner || i.dueAt || i.severity) && (
              <div className="mt-1 flex gap-1">
                {i.owner && <span className="pill bg-slate-100 text-slate-600">{i.owner}</span>}
                {i.dueAt && <span className="pill bg-slate-100 text-slate-600">{i.dueAt}</span>}
                {i.severity && i.kind === "risk" && (
                  <span className="pill bg-rose-100 text-rose-700">{i.severity}</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}