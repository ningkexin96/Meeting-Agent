// 截图：登录页与注册页
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3210";
const OUT = path.resolve("shots");
mkdirSync(OUT, { recursive: true });
const PORT = 9370;

const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
   `--remote-debugging-port=${PORT}`, "--window-size=1440,1100", "about:blank"],
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
  const r = await send(ws, "Page.captureScreenshot", { format: "png" });
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
    width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false,
  });

  // 清理登录态
  await send(ws, "Network.enable");
  await send(ws, "Network.clearBrowserCookies");

  await send(ws, "Page.navigate", { url: `${BASE}/` });
  await sleep(4500);
  await snap(ws, "10-login");

  // 切到注册
  await send(ws, "Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='注册')?.click()`,
  });
  await sleep(1200);
  // 填个密码展示强度条
  await send(ws, "Runtime.evaluate", {
    expression: `(()=>{const i=document.querySelector('#password');if(i){const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(i,'Demo@2024pass');i.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
  });
  await sleep(900);
  await snap(ws, "11-register");

  ws.close();
  chrome.kill();
  setTimeout(() => process.exit(0), 400);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });