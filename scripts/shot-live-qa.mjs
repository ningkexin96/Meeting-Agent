import fs from 'node:fs';
// 会中提问（issue #27）界面截图 + 交互验证
//
// 流程：登录 → 造一场带实时转写的会议 → 打开实时会议页 → 点「刚才说了什么」→ 再问一个无关问题
// 检查：提问卡片存在、回答渲染出来、出处可展开、无关问题不编造
//
// 用法：node scripts/shot-live-qa.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3210";
const OUT = path.resolve("shots");
mkdirSync(OUT, { recursive: true });
const PORT = 9361;
const prisma = new PrismaClient();

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

async function evaluate(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

/** 造一场"会议进行中"的数据：已定稿的 LiveSegment + 一个 live 会话 */
async function seedMeeting() {
  const owner = await prisma.user.findUnique({ where: { email: "owner@demo.dev" } });
  const meeting = await prisma.meeting.create({
    data: {
      tenantId: owner.tenantId,
      title: "（演示）会中提问验证",
      status: "transcribing",
      stage: "PREPARING",
      createdBy: owner.id,
    },
  });
  const live = await prisma.liveSession.create({
    data: { tenantId: owner.tenantId, meetingId: meeting.id, status: "live" },
  });
  await prisma.liveSegment.createMany({
    data: [
      { sessionId: live.id, meetingId: meeting.id, seq: 0, speakerLabel: "speaker_0", startMs: 0, endMs: 5000, text: "今天主要对一下这个季度的上线排期。" },
      { sessionId: live.id, meetingId: meeting.id, seq: 1, speakerLabel: "speaker_1", startMs: 6000, endMs: 12000, text: "后端接口大概周三能给到，前端要等接口才能联调。" },
      { sessionId: live.id, meetingId: meeting.id, seq: 2, speakerLabel: "speaker_0", startMs: 14000, endMs: 21000, text: "那就定下来，前端先做静态页面，接口周三到位之后立刻联调。" },
      { sessionId: live.id, meetingId: meeting.id, seq: 3, speakerLabel: "speaker_1", startMs: 23000, endMs: 30000, text: "张伟你负责把联调环境搭好，最晚周四给到大家。" },
      { sessionId: live.id, meetingId: meeting.id, seq: 4, speakerLabel: "speaker_0", startMs: 32000, endMs: 40000, text: "这里有个风险，如果周三接口给不出来，整个联调会往后延期一周。" },
      { sessionId: live.id, meetingId: meeting.id, seq: 5, speakerLabel: "speaker_1", startMs: 42000, endMs: 47000, text: "测试用例我来跟进，下周一前补齐。" },
    ],
  });
  // 往期记忆：本场没提到，只有历史里才有
  await prisma.memory.create({
    data: {
      tenantId: owner.tenantId,
      kind: "decision",
      status: "active",
      title: null,
      content: "灰度发布按城市分批推进，先上杭州和成都。",
      importance: 0.85,
      source: "agent_runtime",
    },
  });
  return meeting.id;
}

async function cleanup(meetingId) {
  await prisma.liveMinuteItem.deleteMany({ where: { session: { meetingId } } });
  await prisma.liveSegment.deleteMany({ where: { meetingId } });
  await prisma.liveSession.deleteMany({ where: { meetingId } });
  await prisma.auditLog.deleteMany({ where: { meetingId } });
  await prisma.meeting.deleteMany({ where: { id: meetingId } });
  await prisma.memory.deleteMany({ where: { source: "agent_runtime", content: { contains: "灰度发布按城市分批推进" } } });
}

// 在页面内打点：包一层 fetch，记录 SSE 每帧到达时间，用于客观证明"是逐步到达"
const TRACE_SCRIPT = `
  (() => {
    window.__qaTrace = { frames: [], t0: performance.now() };
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const res = await orig.apply(window, args);
      if (!url.includes('/api/live/ask') || !res.body) return res;
      const reader = res.body.getReader();
      window.__qaTrace.t0 = performance.now();
      const stream = new ReadableStream({
        async pull(ctrl) {
          const { done, value } = await reader.read();
          if (done) { ctrl.close(); return; }
          const t = Math.round(performance.now() - window.__qaTrace.t0);
          const txt = new TextDecoder().decode(value);
          const kind = txt.includes('"delta"') ? 'delta'
            : txt.includes('"final"') ? 'final'
            : txt.includes('"meta"') ? 'meta' : 'other';
          window.__qaTrace.frames.push({ t, kind });
          ctrl.enqueue(value);
        },
      });
      return new Response(stream, { status: res.status, headers: res.headers });
    };
    return true;
  })()
`;

async function main() {
  const meetingId = await seedMeeting();
  console.log("会议：", meetingId);

  const chrome = spawn(
    CHROME,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`, "--window-size=1440,1600", "about:blank"],
    { stdio: "ignore" },
  );

  try {
    await sleep(2500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false });

    // 登录：直接调 API 拿 cookie 再写入浏览器，比操作表单稳
    await send(ws, "Page.navigate", { url: `${BASE}/` });
    await sleep(1500);
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@demo.dev", password: "demo1234" }),
    });
    const token = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("").replace(/^ma_session=/, "");
    if (!token) throw new Error(`登录失败：${login.status}`);
    await send(ws, "Network.enable");
    await send(ws, "Network.setCookie", {
      name: "ma_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true,
    });

    // 打开实时会议页
    await send(ws, "Page.navigate", { url: `${BASE}/meetings/${meetingId}/live` });
    await sleep(4000);

    const cardText = await evaluate(ws, `document.body.innerText`);
    console.log("提问卡片存在：", cardText.includes("会中提问"));
    console.log("显示已转写 6 条：", /6 条/.test(cardText));

    // 在页面内打点，记录 SSE 各帧到达时间
    await evaluate(ws, TRACE_SCRIPT);

    await evaluate(ws, `
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '刚才说了什么');
        if (btn) btn.click();
        return Boolean(btn);
      })()
    `);
    // 流式验证：先等 1.6 秒抓一次，再等写完抓最终结果
    await sleep(1600);
    const mid = await evaluate(ws, `document.body.innerText`);
    const midCut = mid.indexOf("刚才说了什么？", mid.indexOf("会中提问"));
    writeFileSync(path.join(OUT, "05-live-ask-streaming.txt"), mid.slice(midCut, midCut + 800), "utf8");
    fs.writeFileSync(path.join(OUT, "05-live-ask-head.txt"), JSON.stringify({ len: mid.length }), "utf8");

    await sleep(12000);

    const after = await evaluate(ws, `document.body.innerText`);
    writeFileSync(path.join(OUT, "05-live-ask.txt"), after, "utf8");
    const cut = after.indexOf("会中提问");
    console.log("\n--- 会中提问区域 ---\n" + after.slice(cut, cut + 700));

    // 再问一个会里没有的
    await evaluate(ws, `
      (() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '灰度发布是怎么安排的？');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return ta.value;
      })()
    `);
    await sleep(500);
    await evaluate(ws, `
      (() => {
        const btn = [...document.querySelectorAll('form button[type=submit]')][0];
        if (btn) btn.click();
        return Boolean(btn);
      })()
    `);
    await sleep(12000);

    const trace = await evaluate(ws, `JSON.stringify(window.__qaTrace.frames)`);
    writeFileSync(path.join(OUT, "05-live-ask-trace.json"), trace ?? "[]", "utf8");

    const finalText = await evaluate(ws, `document.body.innerText`);
    const cut2 = finalText.indexOf("会中提问");
    console.log("\n--- 追问后的区域 ---\n" + finalText.slice(cut2, cut2 + 900));

    const shot = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(path.join(OUT, "05-live-ask.png"), Buffer.from(shot.data, "base64"));
    console.log("\nsaved shots/05-live-ask.png");

    ws.close();
  } finally {
    chrome.kill();
    await cleanup(meetingId);
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => setTimeout(() => process.exit(0), 600));