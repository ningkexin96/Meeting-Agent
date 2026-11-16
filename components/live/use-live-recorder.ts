"use client";

// 浏览器录音 + 分片上传 —— 对应 issue #26
// 双源版本：麦克风（我，speaker_0）+ 系统播放音（会议对方，speaker_1）
//
// MediaRecorder 每 CHUNK_MS 毫秒 stop/start 一次，得到独立的 webm 分片。
// 为什么不直接 timeslice？因为 MediaRecorder 的 timeslice 切出来的后续片
// 缺少 WebM 头，多数服务端解析器（含 ffmpeg / whisper）会直接失败。
// 用 stop/start 每片都是完整可解码的文件——代价是切点处可能丢失几十毫秒。
//
// 两个源各用一条 MediaRecorder（分别上传、分别标 speakerLabel），
// 不要混成一条立体声——那样服务端无法区分谁在说话。

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "paused" | "stopped";

/** 0 = 本机麦克风（我），1 = 系统播放音（对方） */
export type SourceId = 0 | 1;

type SourceRuntime = {
  stream: MediaStream;
  recorder: MediaRecorder | null;
  seq: number;
  rotate: ReturnType<typeof setTimeout> | null;
};

export function useLiveRecorder(options: {
  sessionId: string | null;
  chunkMs?: number;
  onChunkResult?: (r: { seq: number; ok: boolean; added: number; error?: string }) => void;
}) {
  const { sessionId, chunkMs = 4000, onChunkResult } = options;

  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [systemOn, setSystemOn] = useState(false);
  const [chunkCount, setChunkCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const sourcesRef = useRef<Record<SourceId, SourceRuntime | null>>({ 0: null, 1: null });
  const activeSessionIdRef = useRef<string | null>(null);
  const uploadsRef = useRef<Set<Promise<void>>>(new Set());
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const onChunkResultRef = useRef(onChunkResult);
  onChunkResultRef.current = onChunkResult;

  const uploadChunk = useCallback(
    (blob: Blob, sourceId: SourceId, seq: number, startMs: number, endMs: number): Promise<void> => {
      const effectiveSessionId = activeSessionIdRef.current ?? sessionId;
      if (!effectiveSessionId) return Promise.resolve();
      const fd = new FormData();
      fd.append("sessionId", effectiveSessionId);
      fd.append("seq", String(seq));
      fd.append("startMs", String(Math.round(startMs)));
      fd.append("endMs", String(Math.round(endMs)));
      // 服务端据此决定落到 speaker_0 还是 speaker_1
      fd.append("source", sourceId === 0 ? "mic" : "system");
      fd.append("audio", blob, `chunk-${seq}.${blob.type.includes("webm") ? "webm" : "wav"}`);

      const task = (async () => {
        setPending((p) => p + 1);
        try {
          const res = await fetch("/api/live/chunk", { method: "POST", body: fd });
          const data = await res.json();
          onChunkResultRef.current?.({ seq, ok: res.ok && data.ok !== false, added: data.added ?? 0, error: data.error });
        } catch (e) {
          onChunkResultRef.current?.({ seq, ok: false, added: 0, error: (e as Error).message });
        } finally {
          setPending((p) => Math.max(0, p - 1));
        }
      })();
      uploadsRef.current.add(task);
      void task.finally(() => uploadsRef.current.delete(task));
      return task;
    },
    [sessionId],
  );

  const startSegment = useCallback(
    (sourceId: SourceId) => {
      const rt = sourcesRef.current[sourceId];
      if (!rt || stoppedRef.current) return;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = new MediaRecorder(rt.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      rt.recorder = recorder;

      // 两个源各自独立编号（服务端按 session+seq 去重，不能撞号）
      const seq = rt.seq++;
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
            void uploadChunk(blob, sourceId, seq, startMs, endMs);
          }
        }
        // 继续切下一片；主动结束时不再续片
        if (!stoppedRef.current) startSegment(sourceId);
      };

      recorder.start();
      rt.rotate = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, chunkMs);
    },
    [chunkMs, uploadChunk],
  );

  const openMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    sourcesRef.current[0] = { stream, recorder: null, seq: 0, rotate: null };
    return stream;
  }, []);

  /** 开始录音（仅麦克风）。对方声音用 startSystem 单独打开。 */
  const start = useCallback(
    async (sessionIdOverride?: string) => {
      if (state === "recording") return;
      const effectiveSessionId = sessionIdOverride ?? sessionId;
      if (!effectiveSessionId) {
        setError("实时会话尚未创建");
        return;
      }
      activeSessionIdRef.current = effectiveSessionId;
      setError(null);
      setSystemError(null);
      stoppedRef.current = false;
      try {
        await openMic();
        startedAtRef.current = Date.now();
        setChunkCount(0);
        setElapsedMs(0);
        setState("recording");

        timerRef.current = setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current);
        }, 500);

        startSegment(0);
      } catch (e) {
        setError(`无法访问麦克风：${(e as Error).message}`);
        setState("idle");
      }
    },
    [state, startSegment, sessionId, openMic],
  );

  /** 打开会议对方声音（系统播放音 / 共享标签页音频），独立成一路分片上传 */
  const startSystem = useCallback(async () => {
    if (!activeSessionIdRef.current || sourcesRef.current[1]) return false;
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c?: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    if (!md.getDisplayMedia) {
      setSystemError("当前浏览器不支持采集系统声音，请改用最新版 Chrome / Edge");
      return false;
    }
    try {
      const display = await md.getDisplayMedia({
        video: true,
        audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
      } as DisplayMediaStreamOptions);

      const tracks = display.getAudioTracks();
      if (tracks.length === 0) {
        display.getTracks().forEach((t) => t.stop());
        setSystemError("没勾选「同时共享系统音频」。请重新开启并在弹窗底部勾选它。");
        return false;
      }
      // 只要音频，画面立刻停掉，避免额外的编码开销
      display.getVideoTracks().forEach((t) => t.stop());

      const stream = new MediaStream(tracks);
      for (const t of tracks) {
        t.onended = () => {
          setSystemOn(false);
          setSystemError("对方声音采集已停止（共享被结束）");
        };
      }
      sourcesRef.current[1] = { stream, recorder: null, seq: 0, rotate: null };
      setSystemOn(true);
      setSystemError(null);
      if (!stoppedRef.current) startSegment(1);
      return true;
    } catch (e) {
      const err = e as Error;
      setSystemError(
        err.name === "NotAllowedError" || err.name === "AbortError"
          ? "未授权共享系统声音（弹窗被取消）"
          : `采集系统声音失败：${err.message}`,
      );
      return false;
    }
  }, [startSegment]);

  const stopSystem = useCallback(() => {
    const rt = sourcesRef.current[1];
    sourcesRef.current[1] = null;
    setSystemOn(false);
    if (!rt) return;
    if (rt.rotate) clearTimeout(rt.rotate);
    if (rt.recorder && rt.recorder.state === "recording") rt.recorder.stop();
    rt.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const stop = useCallback(async (): Promise<boolean> => {
    stoppedRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    for (const rt of Object.values(sourcesRef.current)) {
      if (rt?.rotate) clearTimeout(rt.rotate);
    }

    // 两个源同时收尾，各自最后一片照常上传
    await Promise.all(
      ([0, 1] as SourceId[]).map(async (id) => {
        const rt = sourcesRef.current[id];
        if (!rt) return;
        const recorder = rt.recorder;
        if (recorder && recorder.state === "recording") {
          await new Promise<void>((resolve) => {
            recorder.onstop = ((prev) => {
              return (ev: Event) => {
                prev?.call(recorder, ev);
                resolve();
              };
            })(recorder.onstop);
            recorder.stop();
          });
        }
      }),
    );

    for (const rt of Object.values(sourcesRef.current)) {
      rt?.stream.getTracks().forEach((t) => t.stop());
    }
    sourcesRef.current = { 0: null, 1: null };
    setSystemOn(false);
    setState("stopped");

    // 最后一片可能刚刚触发上传；必须等它完成，才能调用结束合并。
    await Promise.allSettled([...uploadsRef.current]);
    activeSessionIdRef.current = null;
    return true;
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    for (const rt of Object.values(sourcesRef.current)) {
      if (rt?.rotate) clearTimeout(rt.rotate);
      rt?.stream.getTracks().forEach((t) => t.stop());
    }
    sourcesRef.current = { 0: null, 1: null };
    activeSessionIdRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  return { state, error, systemError, systemOn, chunkCount, pending, elapsedMs, start, stop, startSystem, stopSystem };
}