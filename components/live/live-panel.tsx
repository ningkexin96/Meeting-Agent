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
  Volume2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRealtimeAsr } from "./use-realtime-asr";
import { useLiveRecorder } from "./use-live-recorder";
import { LiveAskPanel } from "./live-ask-panel";
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
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const restored = useRef(false);
  const seqRef = useRef(0);

  // 实时识别结果 → 本地列表
  const onFinal = useCallback(
    (r: { text: string; beginMs: number; endMs: number; seq?: number; speakerLabel?: string }) => {
      const seq = r.seq ?? seqRef.current++;
      setSegments((prev) => [
        ...prev,
        {
          seq,
          // speaker_0 = 我（麦克风），speaker_1 = 会议对方（系统播放音）
          speakerLabel: r.speakerLabel ?? "speaker_0",
          startMs: r.beginMs,
          endMs: r.endMs,
          text: r.text,
          confidence: 0.9,
          needsReview: false,
        },
      ]);
    },
    [],
  );

  const onSession = useCallback((sid: string) => {
    setSessionId(sid);
  }, []);

  const asr = useRealtimeAsr({ meetingId, handlers: { onFinal, onSession } });
  const recorder = useLiveRecorder({
    sessionId: realtime ? null : sessionId,
    onChunkResult: (r) => {
      if (!r.ok) setHint(`分片 #${r.seq} 转写失败：${r.error ?? "未知错误"}`);
    },
  });

  const recording = realtime ? asr.state === "recording" : recorder.state === "recording";
  const busy = realtime ? asr.state === "connecting" : starting || ending;
  const paused = realtime ? asr.state === "paused" : false;

  // 录音期间定期拉取增量纪要（WebSocket 与分片模式共用同一份会话状态）
  useEffect(() => {
    if (!recording || !sessionId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/live?sessionId=${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.items)) setItems(data.items);
        if (!realtime && Array.isArray(data.segments)) setSegments(data.segments);
      } catch {
        /* 网络抖动忽略 */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [recording, realtime, sessionId]);

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

  // 有未结束的实时会话（含刷新后从后端恢复的），都应显示「结束」而不是「开始」
  const activeSession = !recording && !busy && !ended && Boolean(sessionId) && segments.length > 0;
  // 「在录制但收不到声音」需要明确提示，否则用户只会看到数字不动
  const noAudio = realtime && recording && !asr.audioAlive;
  // 对方声音已开启但收不到任何音频，说明共享了画面却没共享音频
  const systemOn = realtime ? asr.systemOn : recorder.systemOn;
  const noSystemAudio = realtime && recording && asr.systemOn && !asr.audio.systemAlive;
  const activeError = realtime ? asr.error : recorder.error;

  async function start() {
    setEnded(false);
    setHint(null);

    if (realtime) {
      void asr.start();
      return;
    }

    // 分片模式必须先创建 LiveSession，再开始 MediaRecorder；以前页面只改了说明文字，
    // 实际仍无条件走 DashScope WebSocket，导致 mock/real/qwen 模式无法录音。
    setStarting(true);
    try {
      const res = await fetch("/api/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingId }),
      });
      const data = await res.json();
      if (!res.ok || !data.sessionId) throw new Error(data.error ?? "创建实时会话失败");
      setSessionId(data.sessionId);
      setSegments([]);
      setItems([]);
      seqRef.current = 0;
      await recorder.start(data.sessionId);
    } catch (e) {
      setHint((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function end() {
    if (!sessionId) {
      setHint("会话尚未创建，无法合并纪要");
      return;
    }

    setEnding(true);
    setHint(null);
    try {
      const stopped = realtime ? await asr.stop() : await recorder.stop();
      if (!stopped) {
        setHint("等待识别服务结束超时，正在合并已落库的内容");
      }

      const res = await fetch("/api/live/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (!res.ok || data.ok !== true) {
        throw new Error(data.error ?? "合并失败");
      }
      setEnded(true);
      router.refresh();
    } catch (e) {
      setHint((e as Error).message);
    } finally {
      setEnding(false);
    }
  }

  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action_item");
  const risks = items.filter((i) => i.kind === "risk");

  // 会中提问的数据源：已落库的定稿片段 + 两路正在识别的中间结果。
  // interim 单独作为「识别中」的片段传下去，服务端会把它当未定稿内容处理，
  // 这样用户问「刚才说了什么」时能覆盖到还没来得及落库的最后一句。
  const qaFeed = [
    ...segments.map((s) => ({
      seq: s.seq as number | null,
      speakerLabel: s.speakerLabel,
      startMs: s.startMs,
      text: s.text,
      interim: false,
    })),
    ...(realtime
      ? Object.entries(asr.interims)
          .filter(([label, text]) => Boolean(text) && !label.startsWith("_"))
          .map(([label, text]) => {
            const last = [...segments].reverse().find((s) => s.speakerLabel === label);
            return {
              seq: null,
              speakerLabel: label,
              startMs: last ? last.endMs : 0,
              text,
              interim: true,
            };
          })
      : []),
  ];

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
                  {ending ? "正在结束" : starting ? "创建会话中" : "连接中"}
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
                ? "麦克风（我）+ 系统播放音（对方）→ 16kHz PCM → DashScope 实时识别，边说边出字"
                : "当前为分片模式（ASR_PROVIDER 非 dashscope）"}
            </p>
          </div>
          {recording || ending || paused || activeSession ? (
            <div className="flex items-center gap-2">
              {recording && (
                <Button
                  onClick={() =>
                    realtime
                      ? asr.systemOn
                        ? void asr.disableSystem()
                        : void asr.enableSystem()
                      : recorder.systemOn
                        ? recorder.stopSystem()
                        : void recorder.startSystem()
                  }
                  size="sm"
                  variant={(realtime ? asr.systemOn : recorder.systemOn) ? "outline" : "default"}
                >
                  <Volume2 className="size-3.5" />
                  {(realtime ? asr.systemOn : recorder.systemOn) ? "停止采集对方声音" : "采集对方声音"}
                </Button>
              )}
              <Button onClick={end} variant="destructive" size="sm" disabled={ending}>
                <Square className="size-3.5" />
                {ending ? "正在结束…" : "结束并生成纪要"}
              </Button>
            </div>
          ) : (
            <Button onClick={start} size="sm" disabled={!canRun || busy}>
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
          {activeError && (
            <div className="flex items-start gap-1.5 rounded-lg bg-error-bg px-2.5 py-2 text-xs text-error">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {activeError}
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

          {/* 会议对方声音：未开启 / 开启了却没声音 */}
          {recording && !systemOn && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-primary/5 px-2.5 py-2 text-xs text-muted-foreground ring-1 ring-primary/20">
              <span className="flex items-start gap-1.5">
                <Volume2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
                目前只采集你的麦克风，线上会议「对方说的话」听不到。点右侧按钮，在共享弹窗里选「整个屏幕」并勾选底部「同时共享系统音频」，即可把对方声音一起转写。
              </span>
              <Button
                size="xs"
                onClick={() => void (realtime ? asr.enableSystem() : recorder.startSystem())}
              >
                采集对方声音
              </Button>
            </div>
          )}
          {noSystemAudio && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-warning-bg px-2.5 py-2 text-xs text-warning">
              <span className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                对方声音已开启，但 3 秒内没有收到任何音频。常见原因：共享弹窗里没勾选「同时共享系统音频」、或外接耳机/声卡把声音直接送到了硬件（不走系统混音）。
              </span>
              <Button size="xs" variant="outline" onClick={() => void asr.enableSystem()}>
                重新采集
              </Button>
            </div>
          )}
          {realtime && asr.systemError && (
            <div className="rounded-lg bg-error-bg px-2.5 py-2 text-xs text-error">{asr.systemError}</div>
          )}
          {!realtime && recorder.systemError && (
            <div className="rounded-lg bg-error-bg px-2.5 py-2 text-xs text-error">{recorder.systemError}</div>
          )}
          {hint && (
            <div className="rounded-lg bg-muted px-2.5 py-2 text-xs text-muted-foreground">{hint}</div>
          )}

          {(recording || busy) && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                icon={Mic}
                label={realtime ? "我已转写" : "已采集"}
                value={
                  realtime
                    ? `${segments.filter((s) => s.speakerLabel === "speaker_0").length} 条`
                    : `${(recorder.elapsedMs / 1000).toFixed(1)}s`
                }
              />
              <Stat
                icon={Volume2}
                label="对方已转写"
                value={realtime ? `${segments.filter((s) => s.speakerLabel === "speaker_1").length} 条` : "—"}
                danger={
                  realtime
                    ? asr.systemOn && segments.every((s) => s.speakerLabel !== "speaker_1")
                    : undefined
                }
              />
              <Stat
                icon={Activity}
                label="音频时长"
                value={realtime ? `${asr.audio.micSeconds.toFixed(1)}s` : `${(recorder.elapsedMs / 1000).toFixed(1)}s`}
              />
              <Stat icon={FileText} label="纪要条目" value={String(items.length)} />
            </div>
          )}

          {/* 实时中间结果：正在识别的文字（按音源分开显示） */}
          {realtime &&
            ["speaker_0", "speaker_1"].map((label) => {
              const text = asr.interims[label] ?? (label === "speaker_0" ? asr.interim : "");
              if (!text) return null;
              return (
                <div key={label} className="rounded-lg border border-dashed border-primary/40 bg-primary/5 px-2.5 py-2">
                  <div className="text-[10px] text-primary/70">
                    正在识别{label === "speaker_1" ? "（对方）" : "（我）"}…
                  </div>
                  <div className="mt-0.5 text-[13px] text-muted-foreground">{text}</div>
                </div>
              );
            })}
        </CardContent>
      </Card>

      {/* 左边看转写，右边直接问：把提问从页面底部提到工作流里，
          这样"看到一句 → 立刻追问"不用来回滚屏 */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
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
              {segments.map((s) => {
                const remote = s.speakerLabel === "speaker_1";
                return (
                  <div
                    key={s.seq}
                    className={cn(
                      "animate-fade-in rounded-lg px-2.5 py-2 ring-1",
                      remote ? "bg-success-bg/40 ring-success/25" : "bg-primary/5 ring-primary/15",
                    )}
                  >
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        {remote ? (
                          <Volume2 className="size-2.5" />
                        ) : (
                          <Mic className="size-2.5" />
                        )}
                        <span className={remote ? "text-success" : "text-primary"}>
                          {remote ? "对方" : "我"}
                        </span>
                        <span>#{s.seq}</span>
                      </span>
                      <span className="font-mono">{formatMs(s.startMs)}</span>
                    </div>
                    <div className="mt-0.5 text-[13px] leading-relaxed">{s.text}</div>
                  </div>
                );
              })}
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

        {/* 会中提问：与转写并排，随时可问，不必等会议结束 */}
        <LiveAskPanel
          sessionId={sessionId}
          meetingId={meetingId}
          feed={qaFeed}
          canAsk={canRun}
        />
      </div>

      {ended && (
        <div className="rounded-lg bg-success-bg px-3 py-2 text-sm text-success">
          实时会议已结束，纪要已合并到会议详情页。
        </div>
      )}

      <div className="text-[11px] leading-relaxed text-muted-foreground">
        回答只依据左侧转写与往期记忆，两者都没有的会明确说「没找到」。
      </div>
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