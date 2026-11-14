// 截图：声纹页新文案 + 会议详情页说话人重命名
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3210";
const OUT = path.resolve("shots");
mkdirSync(OUT, { recursive: true });
const PORT = 9420;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1200", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;
function send(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === id) {
        ws.removeEventListener("message", on);
        d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result);
      }
    };
    ws.addEventListener("message", on);
  });
}

async function snap(ws, name) {
  const r = await send(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log("saved", `${name}.png`);
}

async function main() {
  const meetingId = process.argv[2];
  await sleep(2500);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  await send(ws, "Page.enable");
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false,
  });

  await send(ws, "Page.navigate", { url: `${BASE}/` });
  await sleep(3500);
  await send(ws, "Runtime.evaluate", {
    expression: `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@demo.dev',password:'demo1234'})})`,
    awaitPromise: true, returnByValue: true,
  });

  // 声纹页
  await send(ws, "Page.navigate", { url: `${BASE}/voiceprints` });
  await sleep(4500);
  await snap(ws, "14-voiceprint-honest");

  // 会议详情页
  if (meetingId) {
    await send(ws, "Page.navigate", { url: `${BASE}/meetings/${meetingId}` });
    await sleep(4500);
    await snap(ws, "15-speaker-naming");
  }

  ws.close();
  chrome.kill();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });