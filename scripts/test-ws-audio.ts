// 推真实音频测试实时链路（不能用麦克风时用这个）
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { parseWavHeader, normalizeToDashScope } from "../lib/asr/audio.ts";

const BASE = "http://127.0.0.1:3210";

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@demo.dev", password: "demo1234" }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const fd = new FormData();
  fd.append("title", "WS 音频测试 " + new Date().toLocaleTimeString("zh-CN"));
  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie } });
  const { id } = await created.json();
  console.log("会议:", id);

  // 准备音频：转成 16kHz 单声道 PCM
  const wav = readFileSync("storage/dialog-2speakers.wav");
  const info = parseWavHeader(wav);
  const { pcm } = normalizeToDashScope(wav);
  console.log(`音频: ${info.durationMs}ms → ${pcm.length} 字节 PCM`);

  const ws = new WebSocket("ws://127.0.0.1:3210/api/live/ws", { headers: { cookie } });
  let ready = false;
  const results = [];

  const done = new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", meetingId: id })));

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ready") {
        ready = true;
        console.log("✅ DashScope 就绪，开始推送音频");
        void pushAudio();
      }
      if (msg.type === "result") {
        const mark = msg.isFinal ? "✓" : "…";
        console.log(`  ${mark} [${msg.beginMs}-${msg.endMs}ms] ${msg.text}`);
        if (msg.isFinal) results.push(msg.text);
      }
      if (msg.type === "error") {
        console.log("❌ 错误:", msg.message);
      }
      if (msg.type === "stopped") {
        console.log("会话结束");
        resolve();
      }
    });
  });

  async function pushAudio() {
    const CHUNK = 3200; // 100ms
    for (let off = 0; off < pcm.length; off += CHUNK) {
      if (ws.readyState !== WebSocket.OPEN) break;
      ws.send(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
      await new Promise((r) => setTimeout(r, 90));
    }
    console.log("音频推送完毕，等待识别…");
    await new Promise((r) => setTimeout(r, 4000));
    ws.send(JSON.stringify({ type: "stop" }));
  }

  setTimeout(() => {
    console.log("超时退出");
    process.exit(1);
  }, 60000);

  await Promise.race([done, new Promise((r) => setTimeout(r, 40000))]);

  console.log(`\n=== 结果 ===`);
  console.log(`就绪: ${ready}`);
  console.log(`定稿句子: ${results.length} 句`);
  results.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  ws.close();
  process.exit(results.length > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });