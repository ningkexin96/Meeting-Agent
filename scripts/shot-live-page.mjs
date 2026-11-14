// 实时会议页截图
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3210";
const OUT = path.resolve("shots");
mkdirSync(OUT, { recursive: true });
const PORT = 9356;
const [, , meetingId] = process.argv;

const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
   `--remote-debugging-port=${PORT}`, "--window-size=1440,1400", "about:blank"],
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

async function main() {
  await sleep(2500);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  await send(ws, "Page.enable");
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false,
  });

  await send(ws, "Page.navigate", { url: `${BASE}/` });
  await sleep(2200);
  await send(ws, "Runtime.evaluate", {
    expression: `document.querySelectorAll('button').forEach(b=>{ if(b.textContent.includes('owner')) b.click(); })`,
  });
  await sleep(2600);

  await send(ws, "Page.navigate", { url: `${BASE}/meetings/${meetingId}/live` });
  await sleep(3800);
  const r = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(path.join(OUT, "04-live.png"), Buffer.from(r.data, "base64"));
  console.log("saved 04-live.png");

  ws.close();
  chrome.kill();
}

main()
  .catch((e) => { console.error(e); chrome.kill(); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 400));