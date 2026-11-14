import { readFileSync } from "node:fs";
// Skill 机制测试：验证不同 Skill 对同一份转写产出不同侧重的纪要
// 用法：node scripts/e2e-skills.mjs
const BASE = "http://127.0.0.1:3210";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@demo.dev" }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  console.log("== Skill 列表 ==");
  const skills = await (await fetch(`${BASE}/api/skills`, { headers: { cookie } })).json();
  ok("接口可用", Array.isArray(skills.items));
  ok("有 3 个内置 Skill", skills.items.length === 3, skills.items.map((s) => s.id).join(", "));
  ok("存在默认 Skill", skills.items.some((s) => s.isDefault));
  console.log("    可用:", skills.items.map((s) => `${s.id}(${s.name})`).join("  "));

  // 对两个 Skill 分别跑同一份转写，比较结果差异
  const results = {};
  for (const skillId of ["standard", "weekly"]) {
    console.log(`\n== 用 ${skillId} 跑一次 ==`);
    const fd = new FormData();
    fd.append("title", `Skill 验证-${skillId}-${Date.now()}`);
    fd.append("skillId", skillId);
    // 真实 ASR 下必须有音频才能转写；用测试 WAV
    const wav = readFileSync("storage/speech-test.wav");
    fd.append("audio", new Blob([wav], { type: "audio/wav" }), "test.wav");
    const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie } });
    const { id } = await created.json();

    await fetch(`${BASE}/api/meetings/${id}/run`, { method: "POST", headers: { cookie } });

    let done = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const page = await fetch(`${BASE}/meetings/${id}`, { headers: { cookie } });
      const html = await page.text();
      if (html.includes("草稿") || html.includes("已完成")) {
        if (html.includes("决议")) {
          done = true;
          break;
        }
      }
    }
    ok(`${skillId} 跑完`, done);

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const m = await prisma.meeting.findUnique({
      where: { id },
      include: { minutes: { include: { decisions: true, actionItems: true, risks: true } } },
    });
    await prisma.$disconnect();

    ok(`${skillId} 关联正确`, m.skillId === skillId, m.skillId);
    results[skillId] = m.minutes;
    console.log(`    概述: ${m.minutes.overview.slice(0, 70)}…`);
    console.log(`    决议 ${m.minutes.decisions.length} / 待办 ${m.minutes.actionItems.length} / 风险 ${m.minutes.risks.length}`);
  }

  console.log("\n== 差异对比 ==");
  const s = results.standard;
  const w = results.weekly;
  ok("两个 Skill 都产出了纪要", Boolean(s && w));

  if (s && w) {
    ok("概述内容不同", s.overview !== w.overview);
    console.log("\n    【标准纪要】");
    console.log("    " + s.overview);
    console.log("\n    【研发周会】");
    console.log("    " + w.overview);

    const sameCount =
      s.decisions.length === w.decisions.length &&
      s.actionItems.length === w.actionItems.length &&
      s.risks.length === w.risks.length;
    ok("条目数量或内容有差异", !sameCount || s.overview !== w.overview);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});