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

import { useCallback, useEffect, useRef, useState } from "react";

export type RealtimeState = "idle" | "connecting" | "recording" | "stopped" | "error";

export type RealtimeResultHandlers = {
  onFinal?: (r: { text: string; beginMs: number; endMs: number }) => void;
  onInterim?: (text: string) => void;
};

export function useRealtimeAsr({ meetingId, handlers }: { meetingId: string; handlers: RealtimeResultHandlers }) {
  const [state, setState] = useState<RealtimeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const [pcmSeconds, setPcmSeconds] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const bytesRef = useRef(0);
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

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    setInterim("");
    setState("connecting");
    bytesRef.current = 0;
    setPcmSeconds(0);

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

      // 2. AudioContext：显式 16kHz，浏览器负责重采样
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-processor.js");

      const source = ctx.createMediaStreamSource(stream);
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
      setState((s) => (s === "recording" ? "stopped" : s));
    }, 1500);
  }, [cleanup]);

  return { state, error, interim, pcmSeconds, start, stop };
}