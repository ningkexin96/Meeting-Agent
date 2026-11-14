// 阿里云百炼 DashScope 实时语音识别 —— 对应 issue #22（云 ASR 接入）
//
// 协议（官方文档）：
//   wss://{baseHost}/api-ws/v1/inference
//   握手头：Authorization: bearer <DASHSCOPE_API_KEY>
//   流程：run-task → 二进制音频流 → finish-task
//   音频：单声道 16kHz 16-bit PCM，建议每 100ms 一包
//
// 事件：
//   task-started / result-generated / task-finished / task-failed
//
// 设计：这是一个「一次性转写」封装（给离线链路用），
// 实时链路复用同一个客户端，只是音频源换成浏览器的流。

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { chunkPcm } from "./audio";

export type DashScopeTurn = {
  text: string;
  beginMs: number;
  endMs: number;
  isFinal: boolean;
  /** DashScope 目前不返回说话人，统一 speaker_0，交给声纹聚类 */
  speakerLabel: string;
};

export type DashScopeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  sampleRate: number;
};

export class DashScopeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DashScopeError";
  }
}

export function getDashScopeConfig(): DashScopeConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new DashScopeError(
      "缺少 DASHSCOPE_API_KEY。在 .env 里填入阿里云百炼 API Key，或将 ASR_PROVIDER 改回 mock。",
    );
  }
  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";
  return {
    apiKey,
    baseUrl,
    model: process.env.DASHSCOPE_ASR_MODEL ?? "paraformer-realtime-v2",
    sampleRate: Number(process.env.DASHSCOPE_ASR_SAMPLE_RATE ?? 16000),
  };
}

/** 从 base url 推导 WebSocket 地址 */
export function buildWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/api-ws/v1/inference`;
}

type ServerEvent = {
  header?: {
    event?: string;
    task_id?: string;
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      sentence?: {
        begin_time?: number | null;
        end_time?: number | null;
        text?: string;
        sentence_end?: boolean;
      };
    };
    usage?: { duration?: number };
  };
};

export type StreamCallbacks = {
  /** 每收到一句识别结果回调 */
  onResult?: (turn: DashScopeTurn) => void;
  /** 任务级进度 */
  onProgress?: (info: { sentMs: number; totalMs: number }) => void;
};

/**
 * 把一段完整 PCM 通过 WebSocket 送给 DashScope，返回全部识别结果。
 * 这是「离线文件转写」用的入口。
 */
export async function transcribePcm(
  pcm: Buffer,
  durationMs: number,
  cb: StreamCallbacks = {},
): Promise<DashScopeTurn[]> {
  const cfg = getDashScopeConfig();
  const wsUrl = buildWsUrl(cfg.baseUrl);
  const taskId = randomUUID().replace(/-/g, "").slice(0, 32);
  const turns: DashScopeTurn[] = [];

  return new Promise<DashScopeTurn[]>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      err ? reject(err) : resolve(turns);
    };

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `bearer ${cfg.apiKey}` },
    });

    // 整场超时：音频时长 + 60 秒余量
    const timeoutMs = Math.max(60_000, durationMs + 60_000);
    const timer = setTimeout(
      () => finish(new DashScopeError(`WebSocket 超时（${timeoutMs}ms）`)),
      timeoutMs,
    );

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: cfg.model,
            parameters: {
              format: "pcm",
              sample_rate: cfg.sampleRate,
              // 让上游自动加标点，会议纪要可读性依赖它
              punctuation_prediction_enabled: true,
              // 口语顺滑（去掉「嗯、啊」这类）
              disfluency_removal_enabled: false,
            },
            input: {},
          },
        }),
      );
    });

    ws.on("message", (raw) => {
      let evt: ServerEvent;
      try {
        evt = JSON.parse(raw.toString()) as ServerEvent;
      } catch {
        return;
      }
      const event = evt.header?.event;

      if (event === "task-started") {
        void streamAudio();
        return;
      }

      if (event === "result-generated") {
        const s = evt.payload?.output?.sentence;
        if (s?.text) {
          const turn: DashScopeTurn = {
            text: s.text,
            beginMs: s.begin_time ?? 0,
            endMs: s.end_time ?? s.begin_time ?? 0,
            isFinal: Boolean(s.sentence_end),
            speakerLabel: "speaker_0",
          };
          // 只保留句末定稿，避免把中间结果重复入库
          if (turn.isFinal) {
            turns.push(turn);
            cb.onResult?.(turn);
          }
        }
        return;
      }

      if (event === "task-finished") {
        finish();
        return;
      }

      if (event === "task-failed") {
        finish(
          new DashScopeError(
            evt.header?.error_message ?? "任务失败",
            evt.header?.error_code,
          ),
        );
      }
    });

    ws.on("error", (err) => {
      finish(new DashScopeError(`WebSocket 连接失败：${err.message}`));
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      // 没收到 task-finished 就断开，视为失败
      finish(
        new DashScopeError(
          `WebSocket 意外关闭（${code}）${reason?.toString() || ""}`.trim(),
        ),
      );
    });

    /** 按 100ms 一包推流，控制节奏避免上游缓冲溢出 */
    async function streamAudio() {
      const frames = chunkPcm(pcm, cfg.sampleRate, 100);
      let sentMs = 0;
      for (const frame of frames) {
        if (settled) return;
        ws.send(frame);
        sentMs += 100;
        cb.onProgress?.({ sentMs: Math.min(sentMs, durationMs), totalMs: durationMs });
        // 稍慢于实时，给上游留处理余量
        await new Promise((r) => setTimeout(r, 80));
      }
      ws.send(
        JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        }),
      );
    }
  });
}