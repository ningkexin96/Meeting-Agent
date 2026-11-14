// 针对指定会议截图（带登录态并实际触发 Agent）
// 用法：node scripts/shots-demo.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3210";
const OUT = path.resolve("shots");
mkdirSync(OUT, { recursive: true });
const PORT = 9355;

const prisma = new PrismaClient();
const demo = await prisma.meeting.findFirst({ where: { title: "会议纪要功能上线节奏对齐" } });
await prisma.$disconnect();
if (!demo) throw new Error("找不到演示会议，请先运行 pnpm db:seed");
const meetingId = demo.id;
console.log("demo meeting:", meetingId);

const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
   `--remote-debugging-port=${PORT}`, "--window-size=1440,1600", "about:blank"],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
function send(ws, method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === msgId) {
        ws.removeEventListener("message", on);
        d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result);
      }
    };
    ws.addEventListener("message", on);
  });
}

async function snap(ws, name) {
  const r = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log("saved", `${name}.png`);
}

async function main() {
  await sleep(2500);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  await send(ws, "Page.enable");
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false,
  });

  // 登录
  await send(ws, "Page.navigate", { url: `${BASE}/` });
  await sleep(2200);
  await send(ws, "Runtime.evaluate", {
    expression: `document.querySelectorAll('button').forEach(b=>{ if(b.textContent.includes('owner')) b.click(); })`,
  });
  await sleep(2600);

  // 会议详情（未处理）
  await send(ws, "Page.navigate", { url: `${BASE}/meetings/${meetingId}` });
  await sleep(2500);
  await snap(ws, "03-meeting-before");

  // 触发 Agent
  await send(ws, "Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('生成纪要'))?.click()`,
  });
  await sleep(4000);
  await snap(ws, "04-meeting-running");

  // 等完成
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const done = await send(ws, "Runtime.evaluate", {
      expression: `document.body.innerText.includes('DONE') && document.body.innerText.includes('会议纪要')`,
      returnByValue: true,
    }).then((r) => r.result.value);
    if (done) break;
  }
  await send(ws, "Page.navigate", { url: `${BASE}/meetings/${meetingId}` });
  await sleep(2800);
  await snap(ws, "05-meeting-done");

  // 追问
  await send(ws, "Page.navigate", { url: `${BASE}/ask` });
  await sleep(2000);
  await send(ws, "Runtime.evaluate", { expression: `document.querySelector('form button').click()` });
  await sleep(3000);
  await snap(ws, "06-ask");

  // 声纹
  await send(ws, "Page.navigate", { url: `${BASE}/voiceprints` });
  await sleep(2200);
  await snap(ws, "07-voiceprints");

  ws.close();
  chrome.kill();
}

main()
  .catch((e) => { console.error(e); chrome.kill(); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 400));