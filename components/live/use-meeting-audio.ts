"use client";

// 会议双源采集 —— 解决「只认得自己说话，线上会议对方的声音转写不到」
//
// 根因：原来只用 getUserMedia({ audio: true })，拿到的是**本地麦克风**，
// 对方的语音从扬声器/耳机播放出来，压根没进过 audio graph，ASR 自然听不到。
//
// 修复思路：麦克风 + 系统播放音两条独立轨道，分别编码、分别送识别，
// 并用 speakerLabel 区分（speaker_0 = 我，speaker_1 = 会议对方）。
//
// 系统播放音从哪来（浏览器安全模型限制，不能任意录音）：
//   a) getDisplayMedia 共享「本屏幕 + 共享系统音频/标签页音频」→ 推荐，无需装驱动
//   b) 虚拟声卡（VB-Cable / BlackHole）把播放音路由成「话筒」，用 enableMicLoopback
//
// 编码：共用 AudioWorklet(pcm-processor)，输出 16kHz Int16 PCM，
// 每 100ms 一帧，加 1 字节轨道头（0 = mic，1 = system），
// 让同一条 WebSocket 能同时承载两个源的音频而互不串话。
//
// 回采注意事项（重要）：
// - 系统音走 48kHz 的独立 AudioContext 采集（避免某些声卡驱动在 16kHz 下出问题），
//   在 AudioWorklet 里做线性重采样到 16k，**不要**在同一个上下文里同时用自己的
//   麦克风和系统音做「回声消除」，否则 Chrome 可能把系统音当成回声削掉——那正
//   是我们最需要的对方人声。
// - 麦克风那一侧开 echoCancellation，避免扬声器外放时把对方声音也收进去，
//   那样会出现「每句话认两遍」。用耳机则更干净。

import { useCallback, useEffect, useRef, useState } from "react";

/** 0 = 本机麦克风（我），1 = 系统/会议播放音（对方） */
export type AudioSourceId = 0 | 1;

export const MIC_LABEL = "speaker_0";
export const SYSTEM_LABEL = "speaker_1";

const SYSTEM_RATE = 48000;

export type MeetingAudioState = {
  micAlive: boolean;
  systemAlive: boolean;
  micSeconds: number;
  systemSeconds: number;
  micLabel: string | null;
  systemLabel: string | null;
};

export function useMeetingAudio(onFrame: (frame: ArrayBuffer) => void) {
  const [micOn, setMicOn] = useState(false);
  const [systemOn, setSystemOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<MeetingAudioState>({
    micAlive: true,
    systemAlive: true,
    micSeconds: 0,
    systemSeconds: 0,
    micLabel: null,
    systemLabel: null,
  });

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const micStreamRef = useRef<MediaStream | null>(null);
  const sysStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const sysCtxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<Array<{ source: AudioNode; node: AudioWorkletNode }>>([]);
  const bytesRef = useRef({ mic: 0, system: 0 });
  const lastFrameRef = useRef({ mic: 0, system: 0 });

  const buildTrack = useCallback(
    async (ctx: AudioContext, source: MediaStreamAudioSourceNode, sourceId: AudioSourceId) => {
      // 每个源 100ms 一帧 PCM，交给回调统一发往 WebSocket
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const pcm = e.data;
        lastFrameRef.current[sourceId === 0 ? "mic" : "system"] = Date.now();
        // 轨道头 + PCM：服务端据此决定写到哪个 speakerLabel
        const out = new Uint8Array(pcm.byteLength + 1);
        out[0] = sourceId;
        out.set(new Uint8Array(pcm), 1);
        if (sourceId === 0) bytesRef.current.mic += pcm.byteLength;
        else bytesRef.current.system += pcm.byteLength;
        onFrameRef.current(out.buffer);
      };
      source.connect(node);
      // 不接 destination：避免把自己的声音回放出来造成啸叫
      nodesRef.current.push({ source, node });
      return node;
    },
    [],
  );

  /** 1. 麦克风（我） */
  const enableMic = useCallback(async () => {
    if (micStreamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          setMicOn(false);
          setError("麦克风已被系统关闭或断开，请重新开启");
        };
      }

      const ctx = new AudioContext({ sampleRate: 16000 });
      if (ctx.sampleRate !== 16000) {
        await ctx.close().catch(() => {});
        throw new Error(`浏览器未按 16kHz 采样（实际 ${ctx.sampleRate}Hz），请换用最新版 Chrome/Edge`);
      }
      micCtxRef.current = ctx;
      // 挂到 window 便于排查（沿用原有约定）
      (window as unknown as { __liveAudioCtx?: AudioContext }).__liveAudioCtx = ctx;
      await ctx.audioWorklet.addModule("/pcm-processor.js");
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      await buildTrack(ctx, source, 0);
      setMicOn(true);
      setStats((s) => ({ ...s, micLabel: track?.label || "默认麦克风" }));
      return true;
    } catch (e) {
      setError(`无法打开麦克风：${(e as Error).message}`);
      return false;
    }
  }, [buildTrack]);

  /** 2. 系统播放音（会议对方）：屏幕/标签页共享，带音频 */
  const enableSystem = useCallback(async () => {
    if (sysStreamRef.current) return true;
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c?: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    if (!md.getDisplayMedia) {
      setError("当前浏览器不支持采集系统声音，请改用最新版 Chrome / Edge");
      return false;
    }
    try {
      // 必须带 audio 约束，Chrome 才会在共享弹窗里提供「同时共享系统音频」勾选项。
      // suppressLocalAudioPlayback: false = 共享后本机扬声器照常出声（否则会议就听不见了）
      const stream = await md.getDisplayMedia({
        video: true,
        audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
        // 非标准但 Chrome/Edge 已支持：提示优先共享整个屏幕（可勾选系统音频）
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        setError(
          "已共享画面，但没有勾选「共享系统音频 / 共享标签页音频」。请重新开启：共享整个屏幕 → 勾选底部「同时共享系统音频」。",
        );
        return false;
      }

      sysStreamRef.current = stream;
      // 用户点 Chrome 自带的「停止共享」时，音频轨会 ended
      for (const t of audioTracks) {
        t.onended = () => {
          setSystemOn(false);
          setError("对方声音采集已停止（共享被结束）。需要继续转写请重新开启对方声音。");
        };
      }

      const ctx = new AudioContext({ sampleRate: SYSTEM_RATE });
      sysCtxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-processor.js");
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
      await buildTrack(ctx, source, 1);
      setSystemOn(true);
      setStats((s) => ({ ...s, systemLabel: audioTracks[0].label || "系统音频" }));
      setError(null);
      return true;
    } catch (e) {
      const err = e as Error;
      // 用户在共享弹窗点了取消
      if (err.name === "NotAllowedError" || err.name === "AbortError") {
        setError("未授权共享系统声音（弹窗被取消）");
        return false;
      }
      setError(`采集系统声音失败：${err.message}`);
      return false;
    }
  }, [buildTrack]);

  /** 3. 虚拟声卡回环：把系统播放音当成麦克风源（Windows 装 VB-Cable 后选 CABLE Output） */
  const enableMicLoopback = useCallback(async () => {
    return enableMic();
  }, [enableMic]);

  const disableSystem = useCallback(async () => {
    setSystemOn(false);
    sysStreamRef.current?.getTracks().forEach((t) => t.stop());
    sysStreamRef.current = null;
    await sysCtxRef.current?.close().catch(() => {});
    sysCtxRef.current = null;
  }, []);

  const stopAll = useCallback(() => {
    for (const { source, node } of nodesRef.current) {
      try {
        node.port.postMessage("stop");
        node.port.onmessage = null;
        node.disconnect();
        source.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    nodesRef.current = [];
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    sysStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    sysStreamRef.current = null;
    void micCtxRef.current?.close().catch(() => {});
    void sysCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
    sysCtxRef.current = null;
    setMicOn(false);
    setSystemOn(false);
  }, []);

  useEffect(() => stopAll, [stopAll]);

  // 挂起恢复 + 存活统计（沿用原有 AudioContext 被浏览器挂起的处理）
  useEffect(() => {
    if (!micOn && !systemOn) return;
    const timer = setInterval(() => {
      for (const ctx of [micCtxRef.current, sysCtxRef.current]) {
        if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
      }
      const now = Date.now();
      setStats((s) => ({
        ...s,
        micAlive: micOn ? now - lastFrameRef.current.mic < 3000 : false,
        systemAlive: systemOn ? now - lastFrameRef.current.system < 3000 : false,
        micSeconds: Math.round((bytesRef.current.mic / 32000) * 10) / 10,
        systemSeconds: Math.round((bytesRef.current.system / 32000) * 10) / 10,
      }));
    }, 1500);
    return () => clearInterval(timer);
  }, [micOn, systemOn]);

  const resume = useCallback(async () => {
    for (const ctx of [micCtxRef.current, sysCtxRef.current]) {
      if (ctx?.state === "suspended") await ctx.resume().catch(() => {});
    }
    setError(null);
  }, []);

  return {
    micOn,
    systemOn,
    error,
    stats,
    enableMic,
    enableSystem,
    enableMicLoopback,
    disableSystem,
    resume,
    stopAll,
    setError,
  };
}