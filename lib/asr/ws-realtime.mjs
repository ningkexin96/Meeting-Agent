// 纯 ESM 的实时转写实现（供 server.mjs 使用，不经 tsx）
//
// 这份代码刻意不用 TypeScript、不用 @/ 别名，因为它必须被 Node 原生加载。
// 业务上等价于 lib/asr/{dashscope,realtime,bridge}.ts，
// 那三个 TS 文件继续被 Next 的 API 路由与测试使用，两边保持同一套协议。

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SESSION_COOKIE = "ma_user";

const TOOL_ROLES = { run_transcription: ["owner", "member"] };

function canUseTool(role, tool) {
  const allowed = TOOL_ROLES[tool];
  return Boolean(allowed && allowed.includes(role));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function dashConfig() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("缺少 DASHSCOPE_API_KEY");
  return {
    apiKey,
    baseUrl: process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com",
    model: process.env.DASHSCOPE_ASR_MODEL ?? "paraformer-realtime-v2",
  };
}

function wsUrlOf(baseUrl) {
  const u = new URL(baseUrl);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/api-ws/v1/inference`;
}

/**
 * 一条 DashScope 实时会话：连上游、推 PCM、回收结果。
 */
class DashSession {
  constructor(onResult, onError, onClosed) {
    this.onResult = onResult;
    this.onError = onError;
    this.onClosed = onClosed;
    this.ws = null;
    this.taskId = randomUUID().replace(/-/g, "").slice(0, 32);
    this.ready = false;
    this.closed = false;
    this.pending = [];
    this.sentBytes = 0;
  }

  async start() {
    const cfg = dashConfig();
    const WebSocket = (await import("ws")).default;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrlOf(cfg.baseUrl), {
        headers: { Authorization: `bearer ${cfg.apiKey}` },
      });
      this.ws = ws;

      let settled = false;
      const fail = (msg) => {
        if (this.closed) return;
        this.closed = true;
        this.onError(msg);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        }
      };

      const timer = setTimeout(() => fail("连接 DashScope 超时（15s）"), 15000);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model: cfg.model,
              parameters: {
                format: "pcm",
                sample_rate: 16000,
                punctuation_prediction_enabled: true,
              },
              input: {},
            },
          }),
        );
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        let evt;
        try {
          evt = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const event = evt.header?.event;

        if (event === "task-started") {
          clearTimeout(timer);
          this.ready = true;
          for (const b of this.pending) ws.send(b);
          this.pending = [];
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (event === "result-generated") {
          const s = evt.payload?.output?.sentence;
          if (s?.text) {
            this.onResult({
              text: s.text,
              beginMs: s.begin_time ?? 0,
              endMs: s.end_time ?? s.begin_time ?? 0,
              isFinal: Boolean(s.sentence_end),
            });
          }
          return;
        }

        if (event === "task-finished") {
          this.cleanup();
          this.onClosed();
          return;
        }

        if (event === "task-failed") {
          fail(evt.header?.error_message ?? "DashScope 任务失败");
        }
      });

      ws.on("error", (e) => fail(`WebSocket 错误：${e.message}`));

      ws.on("close", (code) => {
        clearTimeout(timer);
        if (!this.closed) {
          this.closed = true;
          this.onError(`连接意外关闭（${code}）`);
        }
        this.onClosed();
        if (!settled) {
          settled = true;
          reject(new Error(`连接在任务启动前关闭（${code}）`));
        }
      });
    });
  }

  push(pcm) {
    if (this.closed) return;
    if (!this.ready) {
      if (this.pending.length < 200) this.pending.push(pcm);
      return;
    }
    try {
      this.ws.send(pcm);
      this.sentBytes += pcm.length;
    } catch {
      /* ignore */
    }
  }

  async end(timeoutMs = 15000) {
    if (this.closed || !this.ws) return;
    const ws = this.ws;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cleanup();
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.cleanup();
        resolve();
      };
      ws.once("close", done);
      try {
        ws.send(
          JSON.stringify({
            header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
            payload: { input: {} },
          }),
        );
      } catch {
        done();
      }
    });
  }

  get durationMs() {
    return Math.round((this.sentBytes / 32000) * 1000);
  }

  cleanup() {
    this.closed = true;
    this.ready = false;
    this.pending = [];
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

/**
 * 处理一个浏览器 WebSocket 连接
 */
export async function handleRealtime(ws, req) {
  let session = null;
  let closed = false;
  let seq = 0;
  let meetingId = null;
  let sessionId = null;

  const send = (msg) => {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  };

  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 20000);

  const teardown = async () => {
    closed = true;
    clearInterval(ping);
    if (session) {
      try {
        await session.end();
      } catch {
        /* ignore */
      }
      session = null;
    }
  };

  ws.on("close", () => void teardown());
  ws.on("error", () => void teardown());

  ws.on("message", async (data, isBinary) => {
    if (closed) return;

    if (isBinary) {
      if (session) session.push(Buffer.from(data));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send({ type: "error", message: "消息不是合法 JSON" });
      return;
    }

    if (msg.type === "start") {
      if (session) {
        send({ type: "error", message: "会话已开始" });
        return;
      }

      const email = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!email) {
        send({ type: "error", message: "未登录" });
        ws.close();
        return;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        send({ type: "error", message: "用户不存在" });
        ws.close();
        return;
      }
      if (!canUseTool(user.role, "run_transcription")) {
        send({ type: "error", message: `角色 ${user.role} 无权限进行实时转写` });
        ws.close();
        return;
      }

      const meeting = await prisma.meeting.findFirst({
        where: { id: msg.meetingId, tenantId: user.tenantId },
      });
      if (!meeting) {
        send({ type: "error", message: "会议不存在或不属于当前租户" });
        ws.close();
        return;
      }

      meetingId = meeting.id;

      let live = await prisma.liveSession.findFirst({
        where: { meetingId: meeting.id, status: "live" },
        orderBy: { createdAt: "desc" },
      });
      if (!live) {
        live = await prisma.liveSession.create({
          data: { tenantId: user.tenantId, meetingId: meeting.id, status: "live" },
        });
      }
      sessionId = live.id;

      session = new DashSession(
        async (r) => {
          send({ type: "result", ...r });
          if (!r.isFinal) return;
          try {
            const seg = await prisma.liveSegment.create({
              data: {
                sessionId,
                meetingId,
                seq: seq++,
                speakerLabel: "speaker_0",
                startMs: r.beginMs,
                endMs: r.endMs,
                text: r.text,
                confidence: 0.9,
                needsReview: false,
              },
            });
            // 说明：这里不推事件总线。
            // 事件总线是 Next 运行时里的内存单例，而 WS 走的是独立 Node 进程模块，
            // 跨运行时共享内存不可靠。前端直接消费本 WS 的 result 消息即可；
            // SSE 通道只负责离线 Agent 的进度事件。
            void seg;
          } catch (e) {
            console.warn(`[realtime] 落库失败：${e.message}`);
          }
        },
        (message) => send({ type: "error", message }),
        () => send({ type: "stopped" }),
      );

      send({ type: "session", sessionId, meetingId });
      try {
        await session.start();
        send({ type: "ready" });
      } catch (e) {
        send({ type: "error", message: e.message });
        session = null;
      }
      return;
    }

    if (msg.type === "stop") {
      const duration = session?.durationMs ?? 0;
      await teardown();
      send({ type: "stopped", durationMs: duration });
      return;
    }

    send({ type: "error", message: `未知消息类型：${msg.type}` });
  });
}