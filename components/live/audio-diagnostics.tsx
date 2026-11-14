"use client";

// 音频诊断面板 —— 实时录音出问题时用它定位断在哪一环
//
// 检查链路：麦克风 → AudioContext → AudioWorklet → WebSocket → 服务端
// 每一环都给出「正常 / 异常」和具体数值，避免只看到「录音中」却不知道问题在哪。

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, CircleDashed, Mic, Radio, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Check = {
  name: string;
  ok: boolean | null;
  detail: string;
};

export function AudioDiagnostics() {
  const [running, setRunning] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [peak, setPeak] = useState(0);
  const [frames, setFrames] = useState(0);
  const [bytes, setBytes] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);

  const setCheck = useCallback((name: string, ok: boolean | null, detail: string) => {
    setChecks((prev) => {
      const next = prev.filter((c) => c.name !== name);
      return [...next, { name, ok, detail }];
    });
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setChecks([]);
    setPeak(0);
    setFrames(0);
    setBytes(0);
    setRunning(true);

    // 1. 麦克风权限
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      setCheck("麦克风权限", true, track?.label || "已授权");
    } catch (e) {
      setCheck("麦克风权限", false, (e as Error).message);
      setRunning(false);
      return;
    }

    // 2. AudioContext
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      setCheck("AudioContext", ctx.state === "running", `${ctx.state} / ${ctx.sampleRate}Hz`);
    } catch (e) {
      setCheck("AudioContext", false, (e as Error).message);
      return;
    }

    // 3. AudioWorklet
    let node: AudioWorkletNode;
    try {
      await ctx.audioWorklet.addModule("/pcm-processor.js");
      node = new AudioWorkletNode(ctx, "pcm-processor");
      setCheck("AudioWorklet", true, "pcm-processor 已加载");
    } catch (e) {
      setCheck("AudioWorklet", false, (e as Error).message);
      return;
    }

    // 4. 实时电平与帧统计
    let frameCount = 0;
    let byteCount = 0;
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      frameCount++;
      byteCount += e.data.byteLength;
      setFrames(frameCount);
      setBytes(byteCount);
      // 算峰值
      const pcm = new Int16Array(e.data);
      let p = 0;
      for (let i = 0; i < pcm.length; i += 8) {
        const v = Math.abs(pcm[i]);
        if (v > p) p = v;
      }
      setPeak(Math.round((p / 32768) * 100));
    };

    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);

    // 5. WebSocket
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/live/ws`);
    wsRef.current = ws;
    let readyAt = 0;

    ws.onopen = () => setCheck("WebSocket", true, "已连接");
    ws.onerror = () => setCheck("WebSocket", false, "连接失败（服务需用 pnpm start 启动）");
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        if (m.type === "ready") {
          readyAt = Date.now();
          setCheck("识别服务", true, "就绪");
        } else if (m.type === "error") {
          setCheck("识别服务", false, m.message);
        }
      } catch {
        /* 非 JSON */
      }
    };

    // 只建立连接做诊断，不推流给识别服务（避免污染会话）
    // 3 秒后检查是否收到 ready
    setTimeout(() => {
      if (!readyAt && ws.readyState === WebSocket.OPEN) {
        setCheck("识别服务", false, "3 秒内未收到就绪信号");
      }
    }, 3000);
  }, [setCheck]);

  const allOk = checks.length > 0 && checks.every((c) => c.ok === true);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            音频链路诊断
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            实时录音异常时，用这里确认问题出在哪一环
          </p>
        </div>
        <Button size="sm" variant={running ? "destructive" : "default"} onClick={running ? stop : start}>
          <Mic className="size-3.5" />
          {running ? "停止诊断" : "开始诊断"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {checks.length === 0 && !running && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            点「开始诊断」检查麦克风、音频处理、连接与识别服务是否正常
          </div>
        )}

        {checks.length > 0 && (
          <div className="space-y-1.5">
            {checks.map((c) => (
              <div key={c.name} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
                {c.ok === true ? (
                  <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                ) : c.ok === false ? (
                  <XCircle className="size-3.5 shrink-0 text-error" />
                ) : (
                  <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="w-24 shrink-0 text-xs font-medium">{c.name}</span>
                <span className={cn("truncate text-xs", c.ok === false ? "text-error" : "text-muted-foreground")}>
                  {c.detail}
                </span>
              </div>
            ))}
          </div>
        )}

        {running && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-muted/50 px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">音量</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full transition-all", peak > 3 ? "bg-success" : "bg-warning")}
                  style={{ width: `${Math.min(100, peak)}%` }}
                />
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">{peak}%</div>
            </div>
            <div className="rounded-lg bg-muted/50 px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">音频帧</div>
              <div className="font-mono text-sm font-semibold">{frames}</div>
            </div>
            <div className="rounded-lg bg-muted/50 px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">数据量</div>
              <div className="font-mono text-sm font-semibold">{(bytes / 32000).toFixed(1)}s</div>
            </div>
          </div>
        )}

        {running && peak <= 1 && frames > 20 && (
          <div className="rounded-lg bg-warning-bg px-2.5 py-2 text-xs text-warning">
            检测到音频帧但没有音量。麦克风可能被静音，或选错了输入设备。
          </div>
        )}

        {running && frames > 0 && bytes / 32000 > 0.5 && (
          <div className="rounded-lg bg-success-bg px-2.5 py-2 text-xs text-success">
            音频链路正常：{frames} 帧 / {(bytes / 32000).toFixed(1)} 秒音频。若正式录音仍识别不出文字，多为识别服务配额或网络问题。
          </div>
        )}
      </CardContent>
    </Card>
  );
}