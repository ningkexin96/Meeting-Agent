// 验证声纹注册后的识别行为
// 期望：离线声纹引擎区分不开时，明确标记"未知参会者 + 原因"，而不是都认成同一个人
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3210";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${e ? " — " + e : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); }
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
  const ownerCookie = await login("owner@demo.dev");
  const memberCookie = await login("member@demo.dev");
  ok("登录成功", Boolean(ownerCookie));

  // 清空旧声纹
  const existing = await (await fetch(`${BASE}/api/voiceprints`, { headers: { cookie: ownerCookie } })).json();
  for (const it of existing.items ?? []) {
    await fetch(`${BASE}/api/voiceprints?userId=${it.userId}`, { method: "DELETE", headers: { cookie: ownerCookie } });
  }
  console.log(`  已清理旧声纹 ${existing.items?.length ?? 0} 个`);

  // 用两段不同音色的语音注册
  const wavA = readFileSync("storage/person-a.wav");
  const wavB = readFileSync("storage/person-b.wav");

  const fdA = new FormData();
  fdA.append("audio", new Blob([wavA], { type: "audio/wav" }), "a.wav");
  const rA = await fetch(`${BASE}/api/voiceprints`, { method: "POST", body: fdA, headers: { cookie: ownerCookie } });
  const jA = await rA.json();
  ok("张伟声纹注册成功", rA.ok, jA.dim ? `${jA.dim} 维` : jA.error);

  const fdB = new FormData();
  fdB.append("audio", new Blob([wavB], { type: "audio/wav" }), "b.wav");
  const rB = await fetch(`${BASE}/api/voiceprints`, { method: "POST", body: fdB, headers: { cookie: memberCookie } });
  const jB = await rB.json();
  ok("李娜声纹注册成功", rB.ok, jB.dim ? `${jB.dim} 维` : jB.error);

  // 检查两个声纹现在是否可区分
  const list = await (await fetch(`${BASE}/api/voiceprints`, { headers: { cookie: ownerCookie } })).json();
  ok("声纹库有 2 个样本", list.items?.length === 2, `引擎=${list.engine}`);

  // 用张伟的音频跑会议，看识别成谁
  const fd = new FormData();
  fd.append("title", `声纹验证 ${new Date().toLocaleTimeString("zh-CN")}`);
  fd.append("audio", new Blob([wavA], { type: "audio/wav" }), "a.wav");
  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie: ownerCookie } });
  const { id } = await created.json();
  ok("会议创建成功", Boolean(id));

  await fetch(`${BASE}/api/meetings/${id}/run`, { method: "POST", headers: { cookie: ownerCookie } });

  let done = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const page = await (await fetch(`${BASE}/meetings/${id}`, { headers: { cookie: ownerCookie } })).text();
    if (page.includes("草稿") || page.includes("已完成")) {
      if (page.includes("决议") || page.includes("转写")) { done = true; break; }
    }
  }
  ok("会议跑完", done);

  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  const m = await p.meeting.findUnique({
    where: { id },
    include: { participants: { include: { user: true } }, turns: true },
  });
  await p.$disconnect();

  console.log("\n=== 说话人识别结果 ===");
  const nameCount = new Map();
  for (const part of m.participants) {
    const name = part.user?.name ?? part.displayName;
    console.log(`  ${part.speakerLabel} → ${name} (needsReview=${part.needsReview})`);
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }

  const allSamePerson = nameCount.size === 1;
  const isUnknown = [...nameCount.keys()].some((k) => k.includes("未知"));

  if (isUnknown) {
    ok("无法识别时标记为未知（正确降级）", true);
  } else if (allSamePerson) {
    ok("没有把所有说话人都认成同一人", false, `全部识别为 ${[...nameCount.keys()][0]}`);
  } else {
    ok("说话人被正确区分", nameCount.size > 1, `${nameCount.size} 个不同说话人`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });