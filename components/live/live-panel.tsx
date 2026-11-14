"use client";

// 实时会议面板 —— 对应 issue #26
// 模式：DashScope 实时流式（ASR_PROVIDER=dashscope）优先，否则用本地分片。

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
import { useRealtimeAsr } from "./use-realtime-asr";
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
  realtime,
}: {
  meetingId: string;
  canRun: boolean;
  lastSessionId?: string | null;
  realtime: boolean;
}) {
  const router = useRouter();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [items, setItems] = useState<MinuteItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const restored = useRef(false);
  const seqRef = useRef(0);

  // 实时识别结果 → 本地列表
  const onFinal = useCallback((r: { text: string; beginMs: number; endMs: number }) => {
    const seq = seqRef.current++;
    setSegments((prev) => [
      ...prev,
      {
        seq,
        speakerLabel: "speaker_0",
        startMs: r.beginMs,
        endMs: r.endMs,
        text: r.text,
        confidence: 0.9,
        needsReview: false,
      },
    ]);
  }, []);

  const onSession = useCallback((sid: string) => {
    setSessionId(sid);
  }, []);

  const asr = useRealtimeAsr({ meetingId, handlers: { onFinal, onSession } });

  // 录音期间定期拉取增量纪要（后端每攒够 4 句抽取一次）
  useEffect(() => {
    if (asr.state !== "recording" || !sessionId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/live?sessionId=${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.items)) setItems(data.items);
      } catch {
        /* 网络抖动忽略 */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [asr.state, sessionId]);

  // 恢复上一场会话内容
  useEffect(() => {
    if (restored.current || !lastSessionId) return;
    restored.current = true;
    void (async () => {
      const res = await fetch(`/api/live?sessionId=${lastSessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSegments(data.segments ?? []);
      setItems(data.items ?? []);
      setSessionId(lastSessionId);
      seqRef.current = (data.segments ?? []).length;
      if (data.status === "ended") setEnded(true);
    })();
  }, [lastSessionId]);

  const recording = asr.state === "recording";
  // 有未结束的实时会话（含刷新后从后端恢复的），都应显示「结束」而不是「开始」
  const activeSession = asr.state !== "recording" && asr.state !== "connecting" && !ended && Boolean(sessionId) && segments.length > 0;
  const busy = asr.state === "connecting";
  const paused = asr.state === "paused";
  // 「在录制但收不到声音」需要明确提示，否则用户只会看到数字不动
  const noAudio = recording && !asr.audioAlive;

  function start() {
    setEnded(false);
    setHint(null);
    void asr.start();
  }

  async function end() {
    asr.stop();
    setEnded(true);
    // 结束实时会话后合并纪要
    if (!sessionId) {
      setHint("会话尚未创建，无法合并纪要");
      return;
    }
    const res = await fetch("/api/live/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setHint(data.error ?? "合并失败");
      return;
    }
    router.refresh();
  }

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
              {busy && (
                <Badge variant="warning" className="gap-1">
                  <Loader2 className="size-2.5 animate-spin" />
                  连接中
                </Badge>
              )}
              {paused && (
                <Badge variant="warning" className="gap-1">
                  <TriangleAlert className="size-2.5" />
                  已暂停
                </Badge>
              )}
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {realtime
                ? "麦克风 → 16kHz PCM → DashScope 实时识别，边说边出字"
                : "当前为分片模式（ASR_PROVIDER 非 dashscope）"}
            </p>
          </div>
          {recording || busy || paused || activeSession ? (
            <Button onClick={end} variant="destructive" size="sm" disabled={busy}>
              <Square className="size-3.5" />
              结束并生成纪要
            </Button>
          ) : (
            <Button onClick={start} size="sm" disabled={!canRun}>
              <Mic className="size-3.5" />
              {ended ? "重新开始" : "开始实时会议"}
            </Button>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {!canRun && (
            <div className="rounded-lg bg-warning-bg px-2.5 py-2 text-xs text-warning">
              当前角色无权限开启实时会议（需要 owner 或 member）
            </div>
          )}
          {asr.error && (
            <div className="flex items-start gap-1.5 rounded-lg bg-error-bg px-2.5 py-2 text-xs text-error">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {asr.error}
            </div>
          )}

          {paused && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-warning-bg px-2.5 py-2 text-xs text-warning">
              <span className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                录音已被浏览器暂停（切到后台或系统休眠时会这样）。点击右侧按钮恢复。
              </span>
              <Button size="xs" variant="outline" onClick={() => void asr.resume()}>
                恢复录音
              </Button>
            </div>
          )}

          {noAudio && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-warning-bg px-2.5 py-2 text-xs text-warning">
              <span className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                已 3 秒没有收到麦克风声音。请检查：麦克风是否被静音、系统是否切换了输入设备、或浏览器权限被收回。
              </span>
              <Button size="xs" variant="outline" onClick={() => void asr.resume()}>
                重新连接
              </Button>
            </div>
          )}
          {hint && (
            <div className="rounded-lg bg-muted px-2.5 py-2 text-xs text-muted-foreground">{hint}</div>
          )}

          {(recording || busy) && (
            <div className="grid grid-cols-3 gap-2">
              <Stat icon={Activity} label="已采集" value={`${asr.pcmSeconds.toFixed(1)}s`} />
              <Stat icon={Mic} label="已识别" value={String(segments.length)} />
              <Stat icon={FileText} label="纪要条目" value={String(items.length)} />
            </div>
          )}

          {/* 实时中间结果：正在识别的文字 */}
          {asr.interim && (
            <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 px-2.5 py-2">
              <div className="text-[10px] text-primary/70">正在识别…</div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">{asr.interim}</div>
            </div>
          )}
        </CardContent>
      </Card>

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
                  结束会议后会在会议详情页生成完整纪要
                </div>
              )}
              <Group icon={Gavel} title="决议" tone="text-success" items={decisions} />
              <Group icon={ListTodo} title="待办" tone="text-primary" items={actions} />
              <Group icon={ShieldAlert} title="风险" tone="text-error" items={risks} />
            </div>
          </CardContent>
        </Card>
      </div>

      {ended && (
        <div className="rounded-lg bg-success-bg px-3 py-2 text-sm text-success">
          实时会议已结束，纪要已合并到会议详情页。
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, danger }: { icon: typeof Activity; label: string; value: string; danger?: boolean }) {
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

function Group({ icon: Icon, title, tone, items }: { icon: typeof Gavel; title: string; tone: string; items: MinuteItem[] }) {
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