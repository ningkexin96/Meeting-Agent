// 自定义 Next.js server —— 支持 WebSocket 实时转写
//
// 为什么必须用它：Next.js Route Handler 不支持 WebSocket 升级，
// 而实时转写需要全双工（浏览器持续推 PCM、服务端持续推识别结果）。
//
// 关键约束：**不能用 tsx 启动**。
//   tsx 会劫持 require，导致 Next 的 AsyncLocalStorage 报
//   "Invariant: AsyncLocalStorage accessed in runtime where it is not available"。
//   所以本文件与它用到的 WS 逻辑全部写成纯 ESM JS，由 Node 原生运行。
//
// 启动：pnpm build && node server.mjs

import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { handleRealtime } from "./lib/asr/ws-realtime.mjs";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3210);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/api/live/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  handleRealtime(ws, req);
});

server.listen(port, hostname, () => {
  console.log(`> Ready on http://${hostname}:${port}`);
  console.log(`> WebSocket 实时转写: ws://${hostname}:${port}/api/live/ws`);
});