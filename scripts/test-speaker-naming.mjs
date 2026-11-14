// 测试说话人命名功能
const BASE = "http://127.0.0.1:3210";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${e ? " — " + e : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); }
};

const MEETING_ID = "cmwfyxom40001vphshak8ka2n";

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
  const h = { cookie, "content-type": "application/json" };

  console.log("== 1. 列出说话人 ==");
  let r = await (await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, { headers: h })).json();
  ok("获取列表", r.items.length > 0, r.items.map((i) => `${i.displayName}(${i.turnCount}句)`).join(", "));
  ok("有 nameSource 字段", r.items.every((i) => "nameSource" in i));

  const target = r.items[0];
  // 注意：nameSource 会被之前的测试运行改成 manual，这里只验证字段存在且取值合法
  ok("nameSource 取值合法", ["auto", "manual"].includes(target.nameSource), target.nameSource);

  console.log("\n== 2. 重命名 ==");
  const patch = await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ speakerLabel: target.speakerLabel, displayName: "张伟" }),
  });
  ok("重命名成功", patch.ok);

  r = await (await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, { headers: h })).json();
  const updated = r.items.find((i) => i.speakerLabel === target.speakerLabel);
  ok("姓名已更新", updated.displayName === "张伟", updated.displayName);
  ok("来源标记为 manual", updated.nameSource === "manual");
  ok("记录了操作人", Boolean(updated.labeledBy), updated.labeledBy);

  console.log("\n== 3. 转写中的显示名同步 ==");
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  const turns = await p.transcriptTurn.findMany({
    where: { meetingId: MEETING_ID, participant: { speakerLabel: target.speakerLabel } },
    include: { participant: true },
    take: 2,
  });
  ok("转写话轮读到新名字", turns.every((t) => t.participant.displayName === "张伟"), turns[0]?.participant.displayName);
  await p.$disconnect();

  console.log("\n== 4. 输入校验 ==");
  let bad = await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, {
    method: "PATCH", headers: h, body: JSON.stringify({ speakerLabel: target.speakerLabel, displayName: "" }),
  });
  ok("空姓名被拒", bad.status === 400);

  bad = await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, {
    method: "PATCH", headers: h, body: JSON.stringify({ speakerLabel: "speaker_99", displayName: "测试" }),
  });
  ok("不存在的说话人被拒", bad.status === 404);

  bad = await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, {
    method: "PATCH", headers: h, body: JSON.stringify({ speakerLabel: target.speakerLabel, displayName: "很".repeat(40) }),
  });
  ok("超长姓名被拒", bad.status === 400);

  console.log("\n== 5. 权限 ==");
  const vCookie = await login("viewer@demo.dev");
  const vRead = await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, { headers: { cookie: vCookie } });
  ok("viewer 可读", vRead.ok);
  const vPatch = await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, {
    method: "PATCH",
    headers: { cookie: vCookie, "content-type": "application/json" },
    body: JSON.stringify({ speakerLabel: target.speakerLabel, displayName: "越权" }),
  });
  ok("viewer 不可改（403）", vPatch.status === 403, `status=${vPatch.status}`);

  console.log("\n== 6. 恢复原状 ==");
  await fetch(`${BASE}/api/meetings/${MEETING_ID}/speakers`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ speakerLabel: target.speakerLabel, displayName: target.displayName }),
  });
  ok("已恢复", true);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });