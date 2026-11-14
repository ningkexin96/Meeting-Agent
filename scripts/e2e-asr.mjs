// 真实 ASR 端到端验证：起假 ASR 服务 → 重启应用（real 模式）→ 上传音频 → 走完整 Agent 流程
// 用法：node scripts/e2e-asr.mjs
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ASR_PORT = 8899;
const APP_PORT = 3211;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  // 1. 假 ASR 服务
  const asr = spawn(process.execPath, ["scripts/fake-asr-server.mjs", String(ASR_PORT)], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  // 2. 应用（真实 ASR 模式）
  const app = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ASR_PROVIDER: "real",
        ASR_KIND: "openai",
        ASR_BASE_URL: `http://127.0.0.1:${ASR_PORT}/v1`,
        ASR_FALLBACK_TO_MOCK: "0",
        MOCK_LLM: "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  let appErr = "";
  app.stderr.on("data", (d) => (appErr += d));

  await sleep(6000);

  console.log("== 准备 ==");
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@demo.dev" , password: "demo1234" }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  ok("登录成功", cookie.includes("ma_session="));

  // 造一个音频文件上传
  const dir = path.join(process.cwd(), "storage");
  await mkdir(dir, { recursive: true });
  const tmpAudio = path.join(dir, "e2e-upload.wav");
  await writeFile(tmpAudio, Buffer.alloc(8192, 7));

  console.log("== 上传音频并创建会议 ==");
  const fd = new FormData();
  fd.append("title", "真实 ASR 端到端验证");
  fd.append("audio", new Blob([Buffer.alloc(8192, 7)], { type: "audio/wav" }), "meeting.wav");
  const created = await fetch(`${BASE}/api/meetings`, {
    method: "POST",
    body: fd,
    headers: { cookie },
  });
  const createdJson = await created.json();
  ok("会议创建成功", created.status === 200 && Boolean(createdJson.id), createdJson.id);
  const meetingId = createdJson.id;

  console.log("== 触发 Agent（内部应调用真实 ASR 适配器） ==");
  const run = await fetch(`${BASE}/api/meetings/${meetingId}/run`, {
    method: "POST",
    headers: { cookie },
  });
  ok("Agent 触发成功", run.status === 200);

  // 轮询等待完成
  let done = false;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const page = await fetch(`${BASE}/meetings/${meetingId}`, { headers: { cookie } });
    const html = await page.text();
    if (html.includes("done") && html.includes("会议纪要")) {
      done = true;
      break;
    }
  }
  ok("流程跑完（状态 done）", done);

  const page = await fetch(`${BASE}/meetings/${meetingId}`, { headers: { cookie } });
  const html = await page.text();
  ok("页面上出现了真实 ASR 的文本", html.includes("纪要功能的上线节奏"));
  ok("页面没有降级告警", !html.includes("已降级为预置转写"));

  // 检查数据库里的话轮数与假服务返回的 6 段一致
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const turns = await prisma.transcriptTurn.count({ where: { meetingId } });
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  await prisma.$disconnect();
  ok("话轮数来自真实 ASR（6 段合并后 ≤ 6）", turns > 0 && turns <= 6, `${turns} 条`);
  ok("会议最终状态 done", meeting?.status === "done", meeting?.status);

  app.kill();
  asr.kill();
  await sleep(300);
  if (appErr && fail > 0) console.log("--- app stderr ---\n" + appErr.slice(0, 800));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});