// 端到端验证：浏览器 WebSocket → 后端 → DashScope 真实识别
// 用法：node scripts/e2e-realtime.mjs
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3210";
const WS_URL = "ws://127.0.0.1:3210/api/live/ws";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 登录拿 cookie
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@demo.dev" }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  ok("登录成功", cookie.includes("ma_user="));

  // 建会议
  const fd = new FormData();
  fd.append("title", `实时链路验证 ${new Date().toLocaleTimeString("zh-CN")}`);
  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie } });
  const { id: meetingId } = await created.json();
  ok("会议创建成功", Boolean(meetingId), meetingId);

  // 连 WS
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  const events = [];
  let ready = false;
  let gotResult = false;

  const done = new Promise((resolve) => {
    ws.on("open", () => {
      console.log("  WS 已连接");
      ws.send(JSON.stringify({ type: "start", meetingId }));
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      events.push(msg);

      if (msg.type === "session") {
        ok("服务端返回会话 ID", Boolean(msg.sessionId), msg.sessionId);
      }
      if (msg.type === "ready") {
        ready = true;
        console.log("  ✅ DashScope 就绪，开始推送音频");
      }
      if (msg.type === "result") {
        gotResult = true;
        console.log(`  📝 [${msg.beginMs}-${msg.endMs}ms] ${msg.text}${msg.isFinal ? " ✓" : ""}`);
      }
      if (msg.type === "error") {
        console.log(`  ❌ 错误: ${msg.message}`);
      }
      if (msg.type === "stopped") {
        resolve();
      }
    });

    ws.on("error", (e) => {
      console.log(`  WS 错误: ${e.message}`);
      resolve();
    });
  });

  // 等 ready
  for (let i = 0; i < 40 && !ready; i++) await sleep(500);
  ok("DashScope 会话就绪", ready);

  if (ready) {
    // 推一段 PCM（测试音频是正弦波，不会有识别结果，但能验证整条推流链路）
    const wav = readFileSync("storage/test-tone-3s.wav");
    const pcm = wav.subarray(44);
    const CHUNK = 3200;
    for (let off = 0; off < pcm.length; off += CHUNK) {
      ws.send(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
      await sleep(60);
    }
    console.log(`  已推送 ${pcm.length} 字节 PCM`);
    await sleep(2000);
    ws.send(JSON.stringify({ type: "stop" }));
    await Promise.race([done, sleep(20000)]);
  }

  ws.close();

  console.log("\n=== 事件序列 ===");
  console.log(events.map((e) => e.type).join(" → "));

  ok("收到 session 事件", events.some((e) => e.type === "session"));
  ok("收到 ready 事件", events.some((e) => e.type === "ready"));
  ok("收到 stopped 事件", events.some((e) => e.type === "stopped"));
  ok("整条链路无错误", !events.some((e) => e.type === "error"), 
     events.filter(e => e.type === "error").map(e => e.message).join("; ") || "无");

  // 检查会话是否落库
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const live = await prisma.liveSession.findFirst({ where: { meetingId }, orderBy: { createdAt: "desc" } });
  const segCount = live ? await prisma.liveSegment.count({ where: { sessionId: live.id } }) : 0;
  await prisma.$disconnect();
  ok("会话已落库", Boolean(live), live?.id);
  console.log(`  转写片段数: ${segCount}（正弦波无语音，0 属正常）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});