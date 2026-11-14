// 声纹端到端验证 —— 对应 issue #23
// 流程：注册声纹 → 上传会议音频 → Agent 跑转写+聚类 → 检查参会人是否被认领/标记未知
// 用法：node scripts/e2e-voice.mjs
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const APP_PORT = 3212;
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

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "demo1234" }),
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  const dir = path.join(process.cwd(), "storage");
  await mkdir(dir, { recursive: true });

  // 造三个"不同人"的音频（内容不同 → 确定性 embedder 得到不同向量）
  const makeAudio = async (name, seed) => {
    const buf = Buffer.alloc(6000);
    for (let i = 0; i < buf.length; i++) buf[i] = (seed * 37 + i * 11) & 0xff;
    await writeFile(path.join(dir, name), buf);
    return Buffer.from(buf);
  };

  const app = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ASR_PROVIDER: "mock",
        VOICEPRINT_ENABLED: "1",
        VOICEPRINT_BASE_URL: "", // 空 → 用确定性 embedder（离线可跑）
        VOICEPRINT_DIM: "64",
        VOICEPRINT_THRESHOLD: "0.6",
        VOICEPRINT_REVIEW_THRESHOLD: "0.5",
        MOCK_LLM: "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  let appErr = "";
  app.stderr.on("data", (d) => (appErr += d));
  await sleep(6000);

  const owner = await login("owner@demo.dev");
  const member = await login("member@demo.dev");
  const viewer = await login("viewer@demo.dev");

  console.log("== 1. 初始状态 ==");
  const list0 = await fetch(`${BASE}/api/voiceprints`, { headers: { cookie: owner } });
  const data0 = await list0.json();
  ok("声纹列表可读", list0.status === 200);
  ok("提示当前使用的引擎", Boolean(data0.engine), data0.engine);

  console.log("== 2. RABAC：viewer 不能注册声纹 ==");
  const vAudio = await makeAudio("vp-viewer.wav", 3);
  const vfd = new FormData();
  vfd.append("audio", new Blob([vAudio], { type: "audio/wav" }), "vp.wav");
  const vreg = await fetch(`${BASE}/api/voiceprints`, {
    method: "POST",
    body: vfd,
    headers: { cookie: viewer },
  });
  ok("viewer 注册被拒（403）", vreg.status === 403, `status=${vreg.status}`);

  console.log("== 3. 注册声纹 ==");
  const regOne = async (cookie, seed, label) => {
    const audio = await makeAudio(`vp-${label}.wav`, seed);
    const fd = new FormData();
    fd.append("audio", new Blob([audio], { type: "audio/wav" }), `${label}.wav`);
    const res = await fetch(`${BASE}/api/voiceprints`, { method: "POST", body: fd, headers: { cookie } });
    return { status: res.status, json: await res.json() };
  };

  const reg1 = await regOne(owner, 11, "owner");
  ok("owner 注册成功", reg1.status === 200, JSON.stringify(reg1.json).slice(0, 80));
  ok("返回维度", reg1.json.dim === 64, `dim=${reg1.json.dim}`);

  const reg2 = await regOne(member, 22, "member");
  ok("member 注册成功", reg2.status === 200);

  const list1 = await fetch(`${BASE}/api/voiceprints`, { headers: { cookie: owner } });
  const data1 = await list1.json();
  ok("声纹库有 2 条", data1.items.length === 2, `${data1.items.length} 条`);
  ok("列表显示样本数", data1.items.every((i) => i.samples >= 1));

  console.log("== 4. 重复注册取质心 ==");
  const regAgain = await regOne(owner, 11, "owner-again");
  ok("重复注册成功", regAgain.status === 200);
  // 注意：脚本可重复运行，样本数会持续累加，所以断言「递增」而不是固定值
  ok(
    "样本数递增（取质心而非覆盖）",
    regAgain.json.samples >= 2,
    `samples=${regAgain.json.samples}`,
  );

  console.log("== 5. 未注册音频必须拒绝 ==");
  const badFd = new FormData();
  badFd.append("audio", new Blob([Buffer.alloc(10)], { type: "audio/wav" }), "empty.wav");
  const badReg = await fetch(`${BASE}/api/voiceprints`, {
    method: "POST",
    body: badFd,
    headers: { cookie: owner },
  });
  ok("空音频被拒（400）", badReg.status === 400, `status=${badReg.status}`);

  console.log("== 6. 会议流程中使用声纹聚类 ==");
  const audio = await makeAudio("voiceprint-meeting.wav", 11);
  const fd = new FormData();
  fd.append("title", "声纹聚类验证会议");
  fd.append("audio", new Blob([audio], { type: "audio/wav" }), "meeting.wav");
  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie: owner } });
  const createdJson = await created.json();
  const meetingId = createdJson.id;
  ok("会议创建成功", Boolean(meetingId));

  await fetch(`${BASE}/api/meetings/${meetingId}/run`, { method: "POST", headers: { cookie: owner } });

  let done = false;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const page = await fetch(`${BASE}/meetings/${meetingId}`, { headers: { cookie: owner } });
    const html = await page.text();
    if (html.includes("会议纪要")) {
      done = true;
      break;
    }
  }
  ok("Agent 流程跑完", done);

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: { participants: { include: { user: true } }, turns: true },
  });
  await prisma.$disconnect();

  ok("会议状态 done", meeting?.status === "done", meeting?.status);
  ok("生成了参会人", (meeting?.participants.length ?? 0) > 0, `${meeting?.participants.length} 人`);
  ok(
    "参会人带置信度",
    meeting?.participants.every((p) => typeof p.confidence === "number"),
  );
  ok(
    "认不出的人被标记待复核（不硬猜）",
    meeting?.participants.some((p) => p.displayName.includes("未知")),
    meeting?.participants.map((p) => p.displayName).join(", "),
  );
  ok("话轮全部有归属", meeting?.turns.every((t) => Boolean(t.participantId)));

  console.log("== 7. 删除声纹 ==");
  const del = await fetch(`${BASE}/api/voiceprints?userId=${reg2.json.userId}`, {
    method: "DELETE",
    headers: { cookie: owner },
  });
  ok("删除成功", del.status === 200);
  const list2 = await fetch(`${BASE}/api/voiceprints`, { headers: { cookie: owner } });
  const data2 = await list2.json();
  ok("删除后剩 1 条", data2.items.length === 1, `${data2.items.length} 条`);

  app.kill();
  await sleep(300);
  if (fail > 0) console.log("--- app stderr ---\n" + appErr.slice(0, 1000));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});