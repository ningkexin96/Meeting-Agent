"use client";

// 实时录音 + WebSocket 推流 —— 对应 issue #26
//
// 链路：麦克风 → AudioContext(16kHz) → AudioWorklet → Int16 PCM → WebSocket → 后端
//
// 为什么不用 MediaRecorder：
// MediaRecorder 产出的是 webm/opus（有损压缩容器），DashScope 要的是裸 PCM。
// 解码 webm 需要额外依赖（本机也没 ffmpeg），而 AudioWorklet 能直接拿到原始采样。
//
// 关键：AudioContext 的 sampleRate 显式设成 16000，浏览器会替我们重采样。
//
// 健壮性处理（踩过的坑）：
// 1. AudioContext 会被浏览器自动挂起（切后台标签、系统休眠、省电策略），
//    挂起后 process() 不再回调，表现为「录音中但不再出字」。
//    这里监听 statechange 并自动 resume。
// 2. 麦克风可能被系统静音或静默停用（track ended），
//    这里监听 track.onended 并上报。
// 3. 长时间没有音频产生时，界面需要能提示用户，而不是让用户干等。

import { useCallback, useEffect, useRef, useState } from "react";

export type RealtimeState = "idle" | "connecting" | "recording" | "paused" | "stopped" | "error";

export type RealtimeResultHandlers = {
  onFinal?: (r: { text: string; beginMs: number; endMs: number }) => void;
  onInterim?: (text: string) => void;
};

export function useRealtimeAsr({ meetingId, handlers }: { meetingId: string; handlers: RealtimeResultHandlers }) {
  const [state, setState] = useState<RealtimeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const [pcmSeconds, setPcmSeconds] = useState(0);
  // 音频是否在持续产生（用于提示「没有收到声音」）
  const [audioAlive, setAudioAlive] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const bytesRef = useRef(0);
  const lastFrameAt = useRef(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const cleanup = useCallback(() => {
    try {
      nodeRef.current?.port.postMessage("stop");
      nodeRef.current?.disconnect();
    } catch {
      /* 已断开 */
    }
    nodeRef.current = null;
    sourceRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // 心跳：超过 3 秒没有音频帧，判定为「无音频输入」
  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => {
      const idle = Date.now() - lastFrameAt.current;
      setAudioAlive(idle < 3000);
      // AudioContext 被挂起时主动恢复
      if (ctxRef.current && ctxRef.current.state === "suspended") {
        void ctxRef.current.resume().catch(() => {});
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [state]);

  const start = useCallback(async () => {
    setError(null);
    setInterim("");
    setState("connecting");
    bytesRef.current = 0;
    setPcmSeconds(0);
    lastFrameAt.current = Date.now();

    try {
      // 1. 麦克风
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // 麦克风被系统停用时上报，避免静默失效
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          setError("麦克风已被系统关闭或断开，请重新开始录音");
          setState("error");
        };
      }

      // 2. AudioContext：显式 16kHz，浏览器负责重采样
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      // 挂到 window 便于排查音频问题（用户自查 / 自动化测试）
      (window as unknown as { __liveAudioCtx?: AudioContext }).__liveAudioCtx = ctx;

      // 关键：监听挂起并自动恢复（切后台、休眠后浏览器会挂起）
      ctx.onstatechange = () => {
        if (ctx.state === "suspended") {
          setState((s) => (s === "recording" ? "paused" : s));
          void ctx.resume().catch(() => {});
        } else if (ctx.state === "running") {
          setState((s) => (s === "paused" ? "recording" : s));
        }
      };

      await ctx.audioWorklet.addModule("/pcm-processor.js");

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      nodeRef.current = node;

      // 3. WebSocket 连后端
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/live/ws`);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", meetingId }));
      };

      ws.onmessage = (ev) => {
        let msg: {
          type: string;
          text?: string;
          isFinal?: boolean;
          beginMs?: number;
          endMs?: number;
          message?: string;
        };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }

        if (msg.type === "ready") {
          setState("recording");
          // 4. 开始把 PCM 推流
          node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
            lastFrameAt.current = Date.now();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(e.data);
              bytesRef.current += e.data.byteLength;
              setPcmSeconds(Math.round((bytesRef.current / 32000) * 10) / 10);
            }
          };
          source.connect(node);
          // 不接 destination，避免自己的声音回放
        } else if (msg.type === "result") {
          if (msg.isFinal) {
            setInterim("");
            handlersRef.current.onFinal?.({
              text: msg.text ?? "",
              beginMs: msg.beginMs ?? 0,
              endMs: msg.endMs ?? 0,
            });
          } else {
            setInterim(msg.text ?? "");
            handlersRef.current.onInterim?.(msg.text ?? "");
          }
        } else if (msg.type === "error") {
          setError(msg.message ?? "未知错误");
          setState("error");
        } else if (msg.type === "stopped") {
          setState("stopped");
        }
      };

      ws.onerror = () => {
        setError("WebSocket 连接失败，请确认服务已用 pnpm start 启动（自定义 server 才支持 WS）");
        setState("error");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          setState((s) => (s === "recording" || s === "connecting" ? "stopped" : s));
        }
      };
    } catch (e) {
      setError(`无法开始录音：${(e as Error).message}`);
      setState("error");
      cleanup();
    }
  }, [meetingId, cleanup]);

  /** 手动唤醒：AudioContext 被挂起或长时间静默后调用 */
  const resume = useCallback(async () => {
    try {
      if (ctxRef.current?.state === "suspended") {
        await ctxRef.current.resume();
      }
      // 重建音频图，应对 track 被系统静默停用的情况
      if (sourceRef.current && nodeRef.current && ctxRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {
          /* 未连接 */
        }
        sourceRef.current.connect(nodeRef.current);
      }
      setAudioAlive(true);
      lastFrameAt.current = Date.now();
      setState((s) => (s === "paused" ? "recording" : s));
      setError(null);
    } catch (e) {
      setError(`恢复失败：${(e as Error).message}`);
    }
  }, []);

  const stop = useCallback(() => {
    try {
      nodeRef.current?.port.postMessage("stop");
    } catch {
      /* ignore */
    }
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
    // 给后端 1.5 秒把最后一句吐完，再断开
    setTimeout(() => {
      cleanup();
      wsRef.current?.close();
      wsRef.current = null;
      setState((s) => (s === "recording" || s === "paused" ? "stopped" : s));
    }, 1500);
  }, [cleanup]);

  return { state, error, interim, pcmSeconds, audioAlive, start, stop, resume };
}