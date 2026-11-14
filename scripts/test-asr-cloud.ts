// DashScope ASR 协议测试 —— 不依赖真实 key，用本地 WebSocket 服务模拟云端行为
// 用法：pnpm test:asr-cloud
import { WebSocketServer } from "ws";
import { createServer } from "node:http";

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

const PORT = 8899;

/** 模拟 DashScope：校验握手头、回事件、收集音频字节数 */
function startMockServer() {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: "/api-ws/v1/inference" });

  const received = { audioBytes: 0, sawRunTask: false, sawFinishTask: false, authHeader: "" };

  wss.on("connection", (ws, req) => {
    received.authHeader = String(req.headers.authorization ?? "");

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        received.audioBytes += (data as Buffer).length;
        return;
      }
      const msg = JSON.parse(data.toString());
      const action = msg.header?.action;

      if (action === "run-task") {
        received.sawRunTask = true;
        // 回 task-started
        ws.send(
          JSON.stringify({
            header: { event: "task-started", task_id: msg.header.task_id },
            payload: {},
          }),
        );

        // 模拟识别结果：先来一个中间态，再两句话定稿
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              header: { event: "result-generated" },
              payload: {
                output: { sentence: { begin_time: 0, end_time: 300, text: "今天主要", sentence_end: false } },
              },
            }),
          );
        }, 60);

        setTimeout(() => {
          ws.send(
            JSON.stringify({
              header: { event: "result-generated" },
              payload: {
                output: {
                  sentence: { begin_time: 0, end_time: 3200, text: "今天主要对一下纪要功能的上线节奏。", sentence_end: true },
                },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              header: { event: "result-generated" },
              payload: {
                output: {
                  sentence: { begin_time: 3400, end_time: 7000, text: "先上线离线转写，实时能力往后放。", sentence_end: true },
                },
              },
            }),
          );
        }, 160);
      }

      if (action === "finish-task") {
        received.sawFinishTask = true;
        ws.send(
          JSON.stringify({
            header: { event: "task-finished" },
            payload: { usage: { duration: 8 } },
          }),
        );
      }
    });
  });

  return new Promise<{ close: () => void; received: typeof received }>((resolve) => {
    httpServer.listen(PORT, () => {
      resolve({
        close: () => {
          wss.close();
          httpServer.close();
        },
        received,
      });
    });
  });
}

function makePcm(seconds = 1) {
  // 16kHz 单声道 16bit，每秒 32000 字节
  return Buffer.alloc(16000 * 2 * seconds, 1);
}

async function main() {
  const server = await startMockServer();

  // 指向本地模拟服务
  process.env.DASHSCOPE_API_KEY = "test-key-for-mock";
  process.env.DASHSCOPE_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.DASHSCOPE_ASR_MODEL = "paraformer-realtime-v2";

  const { transcribePcm, buildWsUrl } = await import("../lib/asr/dashscope.ts");

  console.log("== URL 推导 ==");
  ok("https 转 wss", buildWsUrl("https://dashscope.aliyuncs.com") === "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  ok("http 转 ws", buildWsUrl("http://127.0.0.1:8899") === "ws://127.0.0.1:8899/api-ws/v1/inference");

  console.log("== 完整转写流程 ==");
  const progress: number[] = [];
  const turns = await transcribePcm(makePcm(1), 1000, {
    onProgress: (p) => progress.push(p.sentMs),
  });

  ok("拿到定稿句子", turns.length === 2, `${turns.length} 句`);
  ok("中间结果被丢弃（只保留句末定稿）", turns.every((t) => t.isFinal));
  ok("首句文本正确", turns[0]?.text.includes("上线节奏"));
  ok("时间戳保留", turns[0]?.beginMs === 0 && turns[0]?.endMs === 3200);
  ok("第二句时间戳", turns[1]?.beginMs === 3400);

  console.log("== 协议细节 ==");
  ok("发送了 run-task", server.received.sawRunTask);
  ok("发送了 finish-task", server.received.sawFinishTask);
  ok("鉴权头格式正确", server.received.authHeader === "bearer test-key-for-mock", server.received.authHeader);
  ok("音频字节数与输入一致", server.received.audioBytes === 32000, `${server.received.audioBytes} 字节`);
  ok("有推流进度回调", progress.length > 0, `${progress.length} 次`);

  console.log("== 错误处理 ==");
  process.env.DASHSCOPE_API_KEY = "";
  let missingKey = false;
  try {
    const mod = await import("../lib/asr/dashscope.ts");
    await mod.transcribePcm(makePcm(1), 1000);
  } catch (e) {
    missingKey = (e as Error).message.includes("DASHSCOPE_API_KEY");
  }
  ok("缺少 key 时给出明确提示", missingKey);

  server.close();
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});