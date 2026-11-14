"use client";

// 浏览器录音 + 分片上传 —— 对应 issue #26
//
// MediaRecorder 每 CHUNK_MS 毫秒 stop/start 一次，得到独立的 webm 分片。
// 为什么不直接 timeslice？因为 MediaRecorder 的 timeslice 切出来的后续片
// 缺少 WebM 头，多数服务端解析器（含 ffmpeg / whisper）会直接失败。
// 用 stop/start 每片都是完整可解码的文件——代价是切点处可能丢失几十毫秒。

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "paused" | "stopped";

export function useLiveRecorder(options: {
  sessionId: string | null;
  chunkMs?: number;
  onChunkResult?: (r: { seq: number; ok: boolean; added: number; error?: string }) => void;
}) {
  const { sessionId, chunkMs = 4000, onChunkResult } = options;

  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const seqRef = useRef(0);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rotateRef.current) clearTimeout(rotateRef.current);
    timerRef.current = null;
    rotateRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const uploadChunk = useCallback(
    async (blob: Blob, seq: number, startMs: number, endMs: number) => {
      if (!sessionId) return;
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      fd.append("seq", String(seq));
      fd.append("startMs", String(Math.round(startMs)));
      fd.append("endMs", String(Math.round(endMs)));
      fd.append("audio", blob, `chunk-${seq}.${blob.type.includes("webm") ? "webm" : "wav"}`);

      setPending((p) => p + 1);
      try {
        const res = await fetch("/api/live/chunk", { method: "POST", body: fd });
        const data = await res.json();
        onChunkResult?.({ seq, ok: res.ok && data.ok !== false, added: data.added ?? 0, error: data.error });
      } catch (e) {
        onChunkResult?.({ seq, ok: false, added: 0, error: (e as Error).message });
      } finally {
        setPending((p) => Math.max(0, p - 1));
      }
    },
    [sessionId, onChunkResult],
  );

  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || stoppedRef.current) return;

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    recorderRef.current = recorder;

    const seq = seqRef.current++;
    const startMs = Date.now() - startedAtRef.current;
    const parts: Blob[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };

    recorder.onstop = () => {
      const endMs = Date.now() - startedAtRef.current;
      if (parts.length > 0) {
        const blob = new Blob(parts, { type: recorder.mimeType || "audio/webm" });
        // 太小或太短的片直接丢弃，避免发空包折腾服务端
        if (blob.size > 1024 && endMs - startMs > 800) {
          setChunkCount((c) => c + 1);
          void uploadChunk(blob, seq, startMs, endMs);
        }
      }
      // 继续切下一片
      if (!stoppedRef.current) startSegment();
    };

    recorder.start();
    rotateRef.current = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, chunkMs);
  }, [chunkMs, uploadChunk]);

  const start = useCallback(async () => {
    if (state === "recording") return;
    setError(null);
    stoppedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      streamRef.current = stream;
      startedAtRef.current = Date.now();
      seqRef.current = 0;
      setChunkCount(0);
      setElapsedMs(0);
      setState("recording");

      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 500);

      startSegment();
    } catch (e) {
      setError(`无法访问麦克风：${(e as Error).message}`);
      setState("idle");
    }
  }, [state, startSegment]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    if (rotateRef.current) clearTimeout(rotateRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") recorder.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("stopped");
  }, []);

  return { state, error, chunkCount, pending, elapsedMs, start, stop };
}