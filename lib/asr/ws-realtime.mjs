// 纯 ESM 的实时转写实现（供 server.mjs 使用，不经 tsx）
//
// 这份代码刻意不用 TypeScript、不用 @/ 别名，因为它必须被 Node 原生加载。
// 业务上等价于 lib/asr/{dashscope,realtime,bridge}.ts，
// 那三个 TS 文件继续被 Next 的 API 路由与测试使用，两边保持同一套协议。

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SESSION_COOKIE = "ma_session";

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
 *
 * 每条会话对应「一个音源」：speaker_0 = 本机麦克风，speaker_1 = 会议对方的声音。
 * 两个音源各开一条上游会话，避免混在同一路音频里导致说话人无法区分。
 */
class DashSession {
  constructor(onResult, onError, onClosed, { sampleRate = 16000, speakerLabel = "speaker_0" } = {}) {
    this.onResult = onResult;
    this.onError = onError;
    this.onClosed = onClosed;
    this.sampleRate = sampleRate;
    this.speakerLabel = speakerLabel;
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
                sample_rate: this.sampleRate,
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
    // 16kHz 16bit 单声道 = 每秒 32000 字节
    return Math.round((this.sentBytes / (this.sampleRate * 2)) * 1000);
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
/**
 * 调用增量抽取。
 * ws-realtime.mjs 是纯 ESM，不能静态 import TS 文件；
 * 用 Next 运行时的模块解析器动态加载编译后的实现。
 *
 * 失败必须向上抛出：只有成功后才推进 LiveSession.lastExtractedSeq，
 * 否则后一批成功会把前一批失败的话轮错误跳过。
 */
async function runIncrementalExtraction(sessionId, meetingId, batch) {
  if (!sessionId || !batch?.length) return;
  const { extractIncremental } = await import("./incremental-esm.mjs");
  const items = await extractIncremental(sessionId, meetingId, batch);
  if (items.length > 0) {
    console.log(`[ws] 增量抽取到 ${items.length} 条纪要`);
  }
}

/** 多客户端复用同一会话时，序号必须由服务端按当前最大值分配，并用唯一约束兜底。 */
async function createLiveSegment(data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const max = await prisma.liveSegment.aggregate({
      where: { sessionId: data.sessionId },
      _max: { seq: true },
    });
    const seq = (max._max.seq ?? -1) + 1;
    try {
      return await prisma.liveSegment.create({ data: { ...data, seq } });
    } catch (e) {
      if (e?.code === "P2002" && attempt < 4) continue;
      throw e;
    }
  }
  throw new Error("分配实时话轮序号失败");
}

export async function handleRealtime(ws, req) {
  // 音源 → DashScope 会话。浏览器给每帧数据加了 1 字节轨道头（0 = 麦克风，1 = 系统播放音）。
  // 两个源各开一条上游会话，互不干扰；哪个源开起来算哪个，不因一方失败整场失败。
  const sources = new Map();
  let closed = false;
  let meetingId = null;
  let sessionId = null;
  // 攒待抽取的句子，满 4 条触发一次增量抽取
  const pendingSegments = [];
  // 收到的音频帧计数（关闭时用于诊断）
  let frames = 0;
  const framesBySource = { 0: 0, 1: 0 };
  let segmentWriteChain = Promise.resolve();
  let extractionChain = Promise.resolve();
  let extractionFailed = false;
  let finalizePromise = null;

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

  const queueExtraction = (batch) => {
    if (!sessionId || !meetingId || extractionFailed || batch.length === 0) return;
    extractionChain = extractionChain.then(async () => {
      try {
        await runIncrementalExtraction(sessionId, meetingId, batch);
      } catch (e) {
        extractionFailed = true;
        console.warn(`[ws] 增量抽取失败，等待结束时统一补抽：${e.message}`);
        throw e;
      }
    });
  };

  // 结束顺序必须是：停止上行 → 等上游最终结果 → 等所有 LiveSegment 落库 →
  // 抽完剩余增量 → 才通知浏览器 stopped。否则最后一句可能只留在过程表里。
  const finalize = async () => {
    if (finalizePromise) return finalizePromise;
    finalizePromise = (async () => {
      closed = true;
      clearInterval(ping);
      // 以收到音频最多的那个源计算时长（麦克风通常最长）
      let duration = 0;
      for (const s of sources.values()) duration = Math.max(duration, s.durationMs);

      // 所有源并行收尾：关上游 → 等最终结果
      await Promise.all(
        [...sources.values()].map((s) =>
          s.end().catch(() => {
            /* 上游关闭失败也继续落库收尾 */
          }),
        ),
      );
      sources.clear();

      await segmentWriteChain.catch((e) => {
        console.warn(`[realtime] 末段话轮落库失败：${e.message}`);
      });

      if (pendingSegments.length > 0) {
        queueExtraction(pendingSegments.splice(0, pendingSegments.length));
      }
      await extractionChain.catch(() => {});

      send({ type: "stopped", durationMs: duration });
    })();
    return finalizePromise;
  };

  ws.on("close", () => void finalize());
  ws.on("error", () => void finalize());

  ws.on("message", async (data, isBinary) => {
    if (closed) return;

    if (isBinary) {
      frames++;
      const buf = Buffer.from(data);
      // 1 字节轨道头：0 = 麦克风，1 = 系统播放音（会议对方）
      // 没有轨道头的旧客户端按麦克风处理，保持向后兼容。
      const sourceId = buf.length > 0 && (buf[0] === 0 || buf[0] === 1) ? buf[0] : 0;
      const payload = buf.subarray(1);
      framesBySource[sourceId]++;
      const session = sources.get(sourceId);
      if (session) session.push(payload);
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
      if (sources.size > 0) {
        send({ type: "error", message: "会话已开始" });
        return;
      }

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) {
        send({ type: "error", message: "未登录" });
        ws.close();
        return;
      }

      // 与 HTTP 侧一致：cookie 存 token，库里存 sha256(token)
      const { createHash } = await import("node:crypto");
      const sessionKey = createHash("sha256").update(token).digest("hex");
      const dbSession = await prisma.session.findUnique({
        where: { id: sessionKey },
        include: { user: true },
      });

      if (!dbSession || dbSession.expiresAt.getTime() < Date.now()) {
        send({ type: "error", message: "会话已失效，请重新登录" });
        ws.close();
        return;
      }

      const user = dbSession.user;
      if (user.status !== "active") {
        send({ type: "error", message: "账号已被禁用" });
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

      /** 为一个音源开一条上游会话；speakerLabel 决定落库归属 */
      const SOURCE_META = {
        0: { speakerLabel: "speaker_0", name: "本机麦克风（我）" },
        1: { speakerLabel: "speaker_1", name: "会议对方（系统播放音）" },
      };

      const openSource = async (sourceId) => {
        const meta = SOURCE_META[sourceId];
        // 上游任务正常结束（task-finished）时才可能意味着整场结束；
        // 用 started 标记避免「启动阶段就 close」把整场提前 finalize。
        let started = false;
        const ds = new DashSession(
          (r) => {
            // 中间结果直接推给前端；最终结果先落库，再带服务端分配的 seq 推给前端。
            if (!r.isFinal) {
              send({ type: "result", ...r, speakerLabel: meta.speakerLabel, source: sourceId });
              return;
            }

            segmentWriteChain = segmentWriteChain
              .then(async () => {
                const seg = await createLiveSegment({
                  sessionId,
                  meetingId,
                  speakerLabel: meta.speakerLabel,
                  startMs: r.beginMs,
                  endMs: r.endMs,
                  text: r.text,
                  confidence: 0.9,
                  needsReview: false,
                });
                send({ type: "result", ...r, seq: seg.seq, speakerLabel: meta.speakerLabel, source: sourceId });

                pendingSegments.push({ seq: seg.seq, text: seg.text });
                if (pendingSegments.length >= 4) {
                  queueExtraction(pendingSegments.splice(0, pendingSegments.length));
                }
              })
              .catch((e) => {
                console.warn(`[realtime] 落库失败：${e.message}`);
                send({ type: "error", message: `实时转写落库失败：${e.message}` });
              });
          },
          // 单个音源的上游失败只影响这个音源，另一个继续工作
          (message) => {
            sources.delete(sourceId);
            send({ type: "source-error", source: sourceId, speakerLabel: meta.speakerLabel, message });
          },
          () => {
            // task-finished / 上游正常关闭：只有真正启动过、且已从活跃表移除后才判断。
            if (!started) return;
            sources.delete(sourceId);
            if (sources.size === 0) void finalize();
          },
          { speakerLabel: meta.speakerLabel },
        );
        try {
          await ds.start();
        } catch (e) {
          // 启动失败：从活跃表移除（失败回调里也会删，这里兜底）
          sources.delete(sourceId);
          throw e;
        }
        started = true;
        sources.set(sourceId, ds);
        return ds;
      };

      send({ type: "session", sessionId, meetingId });

      // 先开两个音源；至少一个成功才算 ready。浏览器若只开了一个（比如没共享系统音频），
      // 另一个源永远收不到帧，这是正常的。
      const results = await Promise.allSettled([openSource(0), openSource(1)]);
      const failures = results
        .map((r, i) => ({ r, source: i }))
        .filter((x) => x.r.status === "rejected");

      if (sources.size === 0) {
        const reason = failures.map((f) => f.r.reason?.message).filter(Boolean).join("；");
        send({ type: "error", message: reason || "实时识别服务启动失败" });
        return;
      }

      // 某个源启动失败时告知前端，但另一个源可以继续用
      for (const f of failures) {
        send({
          type: "source-error",
          source: f.source,
          speakerLabel: SOURCE_META[f.source].speakerLabel,
          message: f.r.reason?.message ?? "启动失败",
        });
      }

      send({
        type: "ready",
        sources: [...sources.keys()],
        labels: [...sources.keys()].map((k) => SOURCE_META[k].speakerLabel),
      });
      return;
    }

    if (msg.type === "stop") {
      await finalize();
      return;
    }

    send({ type: "error", message: `未知消息类型：${msg.type}` });
  });
}