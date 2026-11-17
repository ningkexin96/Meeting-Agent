"use client";

// 实时录音 + WebSocket 推流 —— 对应 issue #26
// 双源版本：本机麦克风（我，speaker_0）+ 系统播放音（会议对方，speaker_1）
//
// 链路：麦克风/系统音 → AudioWorklet → 16kHz Int16 PCM → 加轨道头 → WebSocket → 后端
//
// 为什么不用 MediaRecorder：
// MediaRecorder 产出的是 webm/opus（有损压缩容器），DashScope 要的是裸 PCM。
// 解码 webm 需要额外依赖（本机也没 ffmpeg），而 AudioWorklet 能直接拿到原始采样。
//
// 关键：麦克风用 16kHz AudioContext；系统音用 48kHz AudioContext 并在 worklet 内重采样。
//
// 健壮性处理（踩过的坑）：
// 1. AudioContext 会被浏览器自动挂起（切后台标签、系统休眠、省电策略），
//    挂起后 process() 不再回调，表现为「录音中但不再出字」。
//    这里监听 statechange 并自动 resume。
// 2. 麦克风可能被系统静音或静默停用（track ended），
//    这里监听 track.onended 并上报。
// 3. 长时间没有音频产生时，界面需要能提示用户，而不是让用户干等。
// 4. 系统播放音必须由用户显式授权（getDisplayMedia），且可能在中途被「停止共享」，
//    这时只停对方声音，不影响自己的麦克风继续转写。

import { useCallback, useRef, useState } from "react";
import { useMeetingAudio, type AudioSourceId } from "./use-meeting-audio";

export type RealtimeState = "idle" | "connecting" | "recording" | "paused" | "stopped" | "error";

export type RealtimeResultHandlers = {
  onFinal?: (r: {
    text: string;
    beginMs: number;
    endMs: number;
    seq?: number;
    speakerLabel?: string;
    source?: AudioSourceId;
  }) => void;
  onInterim?: (text: string, speakerLabel?: string) => void;
  /** 后端创建会话后回调，用于拉取增量纪要 */
  onSession?: (sessionId: string) => void;
};

export function useRealtimeAsr({ meetingId, handlers }: { meetingId: string; handlers: RealtimeResultHandlers }) {
  const [state, setState] = useState<RealtimeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  // 两个源的中间结果分开显示，否则同一行的文字会来回跳
  const [interims, setInterims] = useState<Record<string, string>>({});
  const [systemError, setSystemError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const stopResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const audio = useMeetingAudio((frame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
  });

  const cleanup = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    audio.stopAll();
  }, [audio]);

  const start = useCallback(async () => {
    setError(null);
    setSystemError(null);
    setInterim("");
    setInterims({});
    setState("connecting");

    try {
      // 1. WebSocket 先连后端（识别服务）
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/live/ws`);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("识别服务 15 秒未就绪，请确认服务用 pnpm start 启动")), 15000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "start", meetingId }));
        ws.onmessage = (ev) => {
          let msg: {
            type: string;
            text?: string;
            isFinal?: boolean;
            beginMs?: number;
            endMs?: number;
            seq?: number;
            message?: string;
            sessionId?: string;
            speakerLabel?: string;
            source?: number;
          };
          try {
            msg = JSON.parse(ev.data as string);
          } catch {
            return;
          }

          if (msg.type === "session") {
            if (msg.sessionId) handlersRef.current.onSession?.(msg.sessionId);
            return;
          }
          if (msg.type === "ready") {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (msg.type === "result") {
            const label = msg.speakerLabel ?? "speaker_0";
            if (msg.isFinal) {
              setInterims((prev) => {
                const next = { ...prev };
                delete next[label];
                return next;
              });
              handlersRef.current.onFinal?.({
                text: msg.text ?? "",
                beginMs: msg.beginMs ?? 0,
                endMs: msg.endMs ?? 0,
                seq: msg.seq,
                speakerLabel: label,
                source: (msg.source as AudioSourceId | undefined) ?? 0,
              });
            } else {
              const text = msg.text ?? "";
              setInterims((prev) => ({ ...prev, [label]: text }));
              setInterim(text);
              handlersRef.current.onInterim?.(text, label);
            }
            return;
          }
          if (msg.type === "source-error") {
            // 单独一路识别失败（常见：系统声音那一路），不终止整场
            if (msg.source === 1) setSystemError(msg.message ?? "对方声音识别启动失败");
            else setError(msg.message ?? "识别失败");
            return;
          }
          if (msg.type === "error") {
            clearTimeout(timer);
            setError(msg.message ?? "未知错误");
            reject(new Error(msg.message ?? "识别服务报错"));
            setState("error");
            return;
          }
          if (msg.type === "stopped") {
            setState("stopped");
            const resolveStop = stopResolverRef.current;
            stopResolverRef.current = null;
            cleanup();
            if (wsRef.current === ws) wsRef.current = null;
            ws.close();
            resolveStop?.(true);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          setError("WebSocket 连接失败，请确认服务已用 pnpm start 启动（自定义 server 才支持 WS）");
          setState("error");
          reject(new Error("WebSocket 连接失败"));
        };
        ws.onclose = () => {
          setState((s) => (s === "recording" || s === "connecting" ? "stopped" : s));
        };
      });

      // 2. 麦克风（我）。先开麦克风再等 ready：浏览器要求权限弹窗发生在用户手势的同一轮，
      //    一旦 await 了网络就容易被判定为非用户激活而拒绝。
      const micOk = await audio.enableMic();
      await ready;
      if (!micOk) throw new Error(audio.error ?? "无法打开麦克风");

      setState("recording");
    } catch (e) {
      setError((prev) => prev ?? `无法开始录音：${(e as Error).message}`);
      setState("error");
      cleanup();
    }
  }, [meetingId, cleanup, audio]);

  /** 打开会议对方的声音（系统播放音）—— 需要在录音中调用，授权后立即开始识别 */
  const enableSystem = useCallback(async () => {
    setSystemError(null);
    const ok = await audio.enableSystem();
    if (!ok) setSystemError(audio.error ?? "未采集到系统声音");
    return ok;
  }, [audio]);

  const disableSystem = useCallback(async () => {
    await audio.disableSystem();
    setSystemError(null);
  }, [audio]);

  /** 手动唤醒：AudioContext 被挂起或长时间静默后调用 */
  const resume = useCallback(async () => {
    try {
      await audio.resume();
      setState((s) => (s === "paused" ? "recording" : s));
      setError(null);
    } catch (e) {
      setError(`恢复失败：${(e as Error).message}`);
    }
  }, [audio]);

  const stop = useCallback((): Promise<boolean> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      cleanup();
      setState((s) => (s === "recording" || s === "paused" ? "stopped" : s));
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      stopResolverRef.current = resolve;
      try {
        audio.stopAll();
        ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        stopResolverRef.current = null;
        cleanup();
        resolve(false);
        return;
      }

      // 服务端会先等待上游最终结果和落库完成，再回 stopped；这里只兜底异常断连。
      stopTimeoutRef.current = setTimeout(() => {
        const resolveStop = stopResolverRef.current;
        stopResolverRef.current = null;
        cleanup();
        if (wsRef.current === ws) wsRef.current = null;
        ws.close();
        setState((s) => (s === "recording" || s === "paused" ? "stopped" : s));
        resolveStop?.(false);
      }, 20_000);
    });
  }, [cleanup, audio]);

  return {
    state,
    error,
    interim,
    interims,
    systemError,
    audio: audio.stats,
    systemOn: audio.systemOn,
    // 兼容原有调用方
    pcmSeconds: audio.stats.micSeconds,
    audioAlive: audio.stats.micAlive,
    start,
    stop,
    resume,
    enableSystem,
    disableSystem,
  };
}