"use client";

// 会中提问面板 —— 对应 issue #27
//
// 使用场景决定了两件事：
// 1. 用户是「一边听会一边问」，不是「坐在那里写查询」。所以内置了几个一句话就能点的常用问法，
//    输入框也在 Enter 下直接发送（Shift+Enter 换行）。
// 2. 用户不知道到底转写到了哪一句。所以每次提问都会把**本地已有的最新片段**一起送上去，
//    包括还在识别中的内容——服务端合并后回答才算数。
//
// 界面原则：回答只展示结论 + 出处。「刚才问了什么」按时间倒序排列，最新的在最上面。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CornerDownLeft,
  History,
  Loader2,
  MessageSquareText,
  Quote,
  Sparkles,
  ShieldQuestion,
  Square,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatMs } from "@/lib/utils";

export type QaFeedSegment = {
  seq: number | null;
  speakerLabel: string;
  startMs: number;
  text: string;
  /** 正在识别、尚未定稿 */
  interim?: boolean;
};

type Citation = {
  seq: number | null;
  speakerLabel: string;
  startMs: number;
  text: string;
  interim: boolean;
};

/** 往期会议记忆（issue #28） */
type MemoryRef = {
  id: string;
  kind: string;
  title: string | null;
  content: string;
  status: string;
  meetingId: string | null;
  meetingTitle: string | null;
  when: string;
};

type Turn = {
  id: string;
  question: string;
  answer?: string;
  citations?: Citation[];
  memories?: MemoryRef[];
  source?: "model" | "local";
  degradedReason?: string;
  pending: boolean;
  /** 正在流式接收（决定光标是否闪烁、是否显示「停止」） */
  streaming?: boolean;
  error?: string;
  askedAt: number;
};

const PRESETS = [
  { label: "刚才说了什么", q: "刚才说了什么？" },
  { label: "定了哪些事", q: "到现在为止定了哪些事？" },
  { label: "谁负责什么", q: "会上提到的待办分别由谁负责？" },
  { label: "有哪些风险", q: "会上提到了哪些风险或阻塞？" },
  { label: "以前怎么定的", q: "之前会议里关于这件事是怎么定的？" },
];

const MEMORY_KIND_LABEL: Record<string, string> = {
  decision: "历史决议",
  open_loop: "未闭环",
  fact: "事实",
  lesson: "经验",
};

const MAX_SEGMENTS_SENT = 60;

/** 中文说话人标签统一显示，和实时转写列表保持一致 */
function who(label: string) {
  if (label === "speaker_0") return "我";
  if (label === "speaker_1") return "对方";
  return label;
}

/**
 * 读 SSE 响应体（issue #29）。
 *
 * 这里不用 EventSource：它只支持 GET，而提问要带问题正文和一整串实时片段，
 * 塞进 URL 会被长度限制掐断。改成 fetch + ReadableStream 手动切帧，
 * 换来的是**可以取消**——会中用户看到答案跑偏，要能立刻停下，
 * 停下来的同时服务端也会把上游模型连接一起断掉。
 */
async function* readSse(res: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 事件以空行分隔；一帧可能被拆在多个 chunk 里，所以必须缓冲到分隔符出现
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // 心跳行（": ping"）和空帧直接跳过
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            yield JSON.parse(line.slice(5).trim());
          } catch {
            /* 坏帧忽略，不影响后续 */
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // 取消时主动释放连接，避免浏览器一直挂着这个请求
    reader.cancel().catch(() => {});
  }
}

export function LiveAskPanel({
  sessionId,
  meetingId,
  feed,
  canAsk,
}: {
  sessionId: string | null;
  meetingId: string;
  /** 实时转写列表，用于把最新片段随问题一起送上（含 interim） */
  feed: QaFeedSegment[];
  canAsk: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [openTurn, setOpenTurn] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  // 当前这一问的取消句柄：用户点「停止」或组件卸载时用它中断
  const abortRef = useRef<AbortController | null>(null);

  // 组件卸载（例如离开实时页）时中断正在进行的生成，别让模型白跑
  useEffect(() => () => abortRef.current?.abort(), []);

  // 刚问完自动滚到最新一条
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = 0;
  }, [turns.length]);

  const hasTranscript = feed.length > 0;

  /** 停止当前生成 */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    // 把还在流式的那个问题标记为已取消，避免界面永远停在"正在整理"
    setTurns((prev) =>
      prev.map((t) =>
        t.pending
          ? { ...t, pending: false, streaming: false, error: t.answer ? undefined : "已取消" }
          : t,
      ),
    );
  }, []);

  const ask = useCallback(
    async (raw?: string) => {
      const question = (raw ?? input).trim();
      if (!question || busy) return;

      // 取最近 N 条一起送上去：定稿的用来补库，interim 的用来"追上"最新一句
      const recentSegments = feedRef.current.slice(-MAX_SEGMENTS_SENT).map((s) => ({
        seq: s.seq,
        speakerLabel: s.speakerLabel,
        startMs: s.startMs,
        text: s.text,
        interim: Boolean(s.interim),
      }));

      const id = `${Date.now()}-${turns.length}`;
      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

      setTurns((prev) => [
        { id, question, pending: true, streaming: true, answer: "", askedAt: Date.now() },
        ...prev,
      ]);
      setInput("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/live/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question,
            sessionId: sessionId ?? undefined,
            meetingId,
            recentSegments,
          }),
          signal: controller.signal,
        });

        // 准备阶段失败（未登录 / 会话不存在 / 问题为空）走普通 JSON 错误
        if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
          const data = await res.json().catch(() => ({}));
          patch((t) => ({
            ...t,
            pending: false,
            streaming: false,
            error: data.error ?? `请求失败（${res.status}）`,
          }));
          return;
        }

        for await (const ev of readSse(res, controller.signal)) {
          const e = ev as {
            type?: string;
            text?: string;
            citations?: Citation[];
            memories?: MemoryRef[];
            result?: {
              answer?: string;
              citations?: Citation[];
              memories?: MemoryRef[];
              source?: "model" | "local";
              degradedReason?: string;
            };
            message?: string;
          };

          if (e.type === "meta") {
            // 出处先到：用户在第一帧就能看到依据，不用等整段答案写完
            patch((t) => ({
              ...t,
              citations: e.citations ?? [],
              memories: e.memories ?? [],
            }));
            if ((e.citations?.length ?? 0) > 0) setOpenTurn((cur) => cur ?? id);
            continue;
          }
          if (e.type === "delta" && e.text) {
            patch((t) => ({ ...t, answer: `${t.answer ?? ""}${e.text}` }));
            continue;
          }
          if (e.type === "final" && e.result) {
            const r = e.result;
            patch((t) => ({
              ...t,
              pending: false,
              streaming: false,
              // 用服务端清洗后的全文覆盖：流式过程中可能带出对话开头的客套话
              answer: r.answer || t.answer,
              citations: r.citations ?? t.citations,
              memories: r.memories ?? t.memories,
              source: r.source,
              degradedReason: r.degradedReason,
            }));
            continue;
          }
          if (e.type === "error") {
            patch((t) => ({ ...t, pending: false, streaming: false, error: e.message ?? "生成失败" }));
          }
        }

        // 连接正常结束但没收到 final（例如服务端异常断开）
        patch((t) =>
          t.streaming && !t.error
            ? { ...t, pending: false, streaming: false, error: t.answer ? undefined : "答案没有生成完整，请重试" }
            : { ...t, pending: false, streaming: false },
        );
      } catch (e) {
        if (controller.signal.aborted) {
          // 用户点过「停止」，上面的 stop() 已经更新过界面，这里不重复报错
        } else {
          patch((t) => ({
            ...t,
            pending: false,
            streaming: false,
            error: `网络错误：${(e as Error).message}`,
          }));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, input, meetingId, sessionId, turns.length],
  );

return (
    <section
      aria-label="会中提问"
      className="ask-surface relative overflow-hidden rounded-2xl lg:sticky lg:top-4"
    >
      {/* 背景：一层极淡的同心弧，暗示"声波"；纯装饰，不承载信息 */}
      <div aria-hidden className="ask-rings pointer-events-none absolute inset-0" />

      <div className="relative px-5 pb-5 pt-5 sm:px-7 sm:pb-6 sm:pt-6">
        {/* 标题行：图标 + 标题，右侧清空 */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="ask-mark flex size-8 items-center justify-center rounded-[10px]">
              <MessageSquareText className="size-4" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-white">
                问这场会
              </h2>
              <p className="mt-0.5 text-[11.5px] leading-tight text-white/[0.52]">
                边开会边问，回答只看本场转写和往期决定
              </p>
            </div>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                setOpenTurn(null);
              }}
              className="ask-quiet flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
            >
              <X className="size-3" />
              清空
            </button>
          )}
        </div>

        {!canAsk && (
          <div className="mt-3 rounded-lg bg-warning/15 px-3 py-2 text-xs text-warning ring-1 ring-warning/30">
            当前角色为只读，不能提问（需要 owner 或 member）。
          </div>
        )}

        {/* 提问框：页面上唯一的深色可交互面，聚焦时有光晕 */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
          className="mt-4"
        >
          <div className="ask-field group/field">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask();
                }
              }}
              disabled={!canAsk || busy}
              rows={2}
              maxLength={500}
              placeholder={
                hasTranscript ? "问点什么…比如「刚才说了什么」" : "会议还没开始转写，先开始实时会议再提问"
              }
              className="ask-input min-h-[76px] resize-none"
            />
            <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
              <span className="text-[10.5px] tabular-nums text-white/[0.38]">
                {input.length > 0 ? `${input.length}/500` : "Enter 发送 · Shift+Enter 换行"}
              </span>
              {busy ? (
                <button type="button" onClick={stop} className="ask-stop">
                  <Square className="size-3" />
                  停止
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canAsk || !input.trim()}
                  className="ask-send"
                >
                  提问
                  <CornerDownLeft className="size-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* 快捷问法：贴着输入框，像一组"起手式" */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.q}
                type="button"
                onClick={() => void ask(p.q)}
                disabled={!canAsk || busy}
                className="ask-chip"
              >
                {p.label}
              </button>
            ))}
          </div>
        </form>

        {/* 会话记录 */}
        <div
          ref={listRef}
          className="mt-4 max-h-[420px] min-h-[120px] space-y-2 overflow-y-auto pr-1"
        >
          {turns.length === 0 && (
            <p className="px-1 text-[12px] leading-relaxed text-white/[0.38]">
              {hasTranscript
                ? `已转写 ${feed.length} 条。问具体的事，或者让它把整场会概括一遍。`
                : "开始实时会议后，转写内容会实时进入这里，此时就能提问了。"}
            </p>
          )}

          {turns.map((t) => (
            <article key={t.id} className="ask-turn">
              <header className="flex items-baseline gap-2">
                <span className="text-[13.5px] font-medium leading-snug text-white/[0.95]">{t.question}</span>
                <time className="ml-auto shrink-0 font-mono text-[10px] text-white/[0.32]">
                  {new Date(t.askedAt).toLocaleTimeString("zh-CN", { hour12: false })}
                </time>
              </header>

              <div className="mt-2">
                {t.pending && !t.answer && (
                  <div className="flex items-center gap-1.5 text-xs text-white/[0.5]">
                    <Loader2 className="size-3 animate-spin" />
                    {t.citations && t.citations.length > 0
                      ? `已找到 ${t.citations.length} 处依据，正在生成回答…`
                      : "正在结合最近的转写整理答案…"}
                  </div>
                )}

                {t.error && (
                  <div className="flex items-start gap-1.5 text-xs text-error">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                    {t.error}
                  </div>
                )}

                {t.answer && (
                  <div
                    data-qa-answer
                    className="whitespace-pre-wrap text-[13.5px] leading-[1.75] text-white/[0.88]"
                  >
                    {t.answer}
                    {t.streaming && <span className="ask-caret" />}
                  </div>
                )}

                {t.answer && t.degradedReason && (
                  <div className="mt-2 flex items-center gap-1 text-[10.5px] text-warning/85">
                    <ShieldQuestion className="size-3 shrink-0" />
                    {t.degradedReason}
                  </div>
                )}

                {t.answer && t.source === "model" && (
                  <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-white/[0.32]">
                    <Bot className="size-3" />
                    依据本场会议转写生成
                  </div>
                )}

                {/* 往期记忆：与"本场出处"分离，用琥珀色标出不属于本场 */}
                {t.answer && (t.memories?.length ?? 0) > 0 && (
                  <div className="mt-2.5 rounded-lg bg-warning/[0.07] px-2.5 py-2 ring-1 ring-warning/20">
                    <div className="flex items-center gap-1 text-[10.5px] font-medium text-warning/90">
                      <History className="size-3" />
                      往期会议记忆 {t.memories!.length} 条
                      <span className="font-normal text-warning/50">不是本场会议的发言</span>
                    </div>
                    <div className="mt-1.5 space-y-1">
                      {t.memories!.map((m) => (
                        <div key={m.id} className="text-[11.5px] leading-relaxed text-white/[0.62]">
                          <span className="mr-1 text-[10px] text-warning/70">
                            {MEMORY_KIND_LABEL[m.kind] ?? m.kind}
                          </span>
                          {m.content}
                          <span className="ml-1 text-[10px] text-white/[0.32]">
                            （{m.meetingTitle ?? "手动记录"} · {m.when}）
                          </span>
                          {m.status === "proposed" && (
                            <span className="ml-1 text-[10px] text-warning/70">待确认</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 出处 */}
                {t.answer && (t.citations?.length ?? 0) > 0 && (
                  <div className="mt-2.5">
                    <button
                      type="button"
                      onClick={() => setOpenTurn((cur) => (cur === t.id ? null : t.id))}
                      className="ask-quiet flex items-center gap-1 text-[11px]"
                    >
                      <Quote className="size-3" />
                      出处 {t.citations!.length} 条
                      <ChevronDown
                        className={cn("size-3 transition-transform", openTurn === t.id && "rotate-180")}
                      />
                    </button>
                    {openTurn === t.id && (
                      <div className="mt-1.5 space-y-1">
                        {t.citations!.map((c, i) => (
                          <div key={`${c.seq ?? "i"}-${i}`} className="ask-cite">
                            <div className="flex items-center gap-1.5 text-[10px] text-white/[0.45]">
                              <span className="font-mono">{formatMs(c.startMs)}</span>
                              <span
                                className={
                                  c.speakerLabel === "speaker_1" ? "text-success/90" : "text-primary/90"
                                }
                              >
                                {who(c.speakerLabel)}
                              </span>
                              {c.seq !== null && <span>#{c.seq}</span>}
                              {c.interim && (
                                <Badge variant="warning" className="h-4 px-1 text-[9px]">
                                  识别中
                                </Badge>
                              )}
                            </div>
                            <div className="mt-0.5 text-[11.5px] leading-relaxed text-white/[0.68]">{c.text}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!t.pending && (
                <footer className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    className="ask-quiet flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]"
                    onClick={() => {
                      setInput(t.question);
                      void ask(t.question);
                    }}
                    disabled={busy}
                  >
                    <Undo2 className="size-3" />
                    再问一次
                  </button>
                </footer>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}