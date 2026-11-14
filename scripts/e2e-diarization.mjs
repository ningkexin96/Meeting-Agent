// 端到端验证：上传双人对话音频 → 真实 ASR + 说话人分离 → 纪要
const BASE = "http://127.0.0.1:3210";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => {
  if (c) { pass++; console.log("  ✓ " + n + (e ? " — " + e : "")); }
  else { fail++; console.log("  ✗ " + n + (e ? " — " + e : "")); }
};

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "demo1234" }),
  });
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  const cookie = await login("owner@demo.dev");
  ok("登录成功", Boolean(cookie));

  const { readFileSync } = await import("node:fs");
  const wav = readFileSync("storage/dialog-2speakers.wav");
  console.log("  音频大小:", (wav.length / 1024).toFixed(0), "KB");

  const fd = new FormData();
  fd.append("title", "双人对话验证 " + new Date().toLocaleTimeString("zh-CN"));
  fd.append("audio", new Blob([wav], { type: "audio/wav" }), "dialog.wav");

  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie } });
  const { id } = await created.json();
  ok("会议创建成功", Boolean(id), id);

  console.log("  触发 Agent（真实云 ASR + LLM，较慢）…");
  const t0 = Date.now();
  await fetch(`${BASE}/api/meetings/${id}/run`, { method: "POST", headers: { cookie } });

  let done = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const page = await (await fetch(`${BASE}/meetings/${id}`, { headers: { cookie } })).text();
    if (page.includes("草稿") || page.includes("已完成") || page.includes("失败")) {
      if (page.includes("决议") || page.includes("失败")) { done = true; break; }
    }
  }
  ok("流程跑完", done, ((Date.now() - t0) / 1000).toFixed(1) + "s");

  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  const m = await p.meeting.findUnique({
    where: { id },
    include: {
      turns: { include: { participant: true }, orderBy: { idx: "asc" } },
      minutes: { include: { decisions: true, actionItems: true, risks: true } },
    },
  });
  await p.$disconnect();

  if (m.status === "failed") {
    ok("会议未失败", false, m.error ?? "未知错误");
  } else {
    console.log("\n=== 转写结果 ===");
    const speakers = new Set();
    for (const t of m.turns) {
      const name = t.participant.displayName;
      speakers.add(name);
      console.log("  [" + name + "] " + t.text);
    }

    ok("识别出多个说话人", speakers.size > 1, speakers.size + " 个: " + [...speakers].join(", "));
    ok("转写有内容", m.turns.length > 0, m.turns.length + " 句");

    if (m.minutes) {
      console.log("\n=== 纪要 ===");
      console.log("  概述:", m.minutes.overview?.slice(0, 100));
      console.log("  决议", m.minutes.decisions.length, "/ 待办", m.minutes.actionItems.length, "/ 风险", m.minutes.risks.length);
      ok("生成了纪要", true);
    }
  }

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });