// 浏览器端到端：验证实时录音时界面能显示增量纪要
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3210";
const PORT = 9430;
mkdirSync("shots", { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--use-file-for-fake-audio-capture=D:\\新建文件夹\\meeting-app\\storage\\meeting-decision.wav",
  "--window-size=1440,1400", "about:blank",
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
  await sleep(3000);
  await send(ws, "Runtime.evaluate", {
    expression: `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@demo.dev',password:'demo1234'})})`,
    awaitPromise: true, returnByValue: true,
  });
  const cr = await send(ws, "Runtime.evaluate", {
    expression: `(async()=>{const fd=new FormData();fd.append('title','增量纪要端到端 '+Date.now());const r=await fetch('/api/meetings',{method:'POST',body:fd});return (await r.json()).id;})()`,
    awaitPromise: true, returnByValue: true,
  });
  console.log("会议:", cr.result.value);

  await send(ws, "Page.navigate", { url: `${BASE}/meetings/${cr.result.value}/live` });
  await sleep(4000);

  await send(ws, "Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find(b => b.textContent.includes('开始实时会议'))?.click()`,
  });
  console.log("已开始录音，等待 50 秒让增量抽取触发…\n");

  for (let i = 1; i <= 10; i++) {
    await sleep(5000);
    const s = await send(ws, "Runtime.evaluate", {
      expression: `
        (() => {
          const t = document.body.innerText;
          const col = t.match(/已采集\\s*([\\d.]+)/);
          const idf = t.match(/已识别\\s*(\\d+)/);
          const items = t.match(/纪要条目\\s*(\\d+)/);
          const endBtn = [...document.querySelectorAll('button')].some(b => b.textContent.includes('结束并生成纪要'));
          return {
            col: col ? col[1] : '-',
            idf: idf ? idf[1] : '-',
            items: items ? items[1] : '-',
            endBtn,
            hasDecision: /决议/.test(t.slice(t.indexOf('增量纪要')))
          };
        })()
      `,
      returnByValue: true,
    });
    const v = s.result.value;
    console.log(`[${String(i * 5).padStart(2)}s] 已采集 ${v.col}s | 已识别 ${v.idf} | 纪要条目 ${v.items} | 结束按钮=${v.endBtn}`);
  }

  // 截图
  const shot = await send(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync("shots/14-live-incremental.png", Buffer.from(shot.data, "base64"));
  console.log("\n截图已保存 shots/14-live-incremental.png");

  ws.close();
  chrome.kill();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });