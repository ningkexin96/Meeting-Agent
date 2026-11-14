// 真实模型端到端：验证 DeepSeek 能产出有意义且随内容变化的结果
// 用法：node scripts/e2e-real-llm.mjs
const BASE = process.env.BASE ?? "http://127.0.0.1:3210";

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

  console.log("== 创建会议 ==");
  const fd = new FormData();
  fd.append("title", `真实模型验证 ${new Date().toLocaleTimeString("zh-CN")}`);
  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie } });
  const { id } = await created.json();
  ok("会议创建成功", Boolean(id));

  console.log("== 触发 Agent（真实模型，较慢） ==");
  const t0 = Date.now();
  await fetch(`${BASE}/api/meetings/${id}/run`, { method: "POST", headers: { cookie } });

  let done = false;
  let lastStage = "";
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const page = await fetch(`${BASE}/meetings/${id}`, { headers: { cookie } });
    const html = await page.text();
    const m = html.match(/(已完成|失败|草稿)/);
    if (m) lastStage = m[1];
    if (html.includes("会议纪要") && (html.includes("草稿") || html.includes("已完成"))) {
      // 确认真的生成了条目
      if (html.includes("决议") || html.includes("待办")) {
        done = true;
        break;
      }
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ok("流程跑完", done, `耗时 ${elapsed}s，状态 ${lastStage}`);

  console.log("== 检查生成内容 ==");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      minutes: { include: { decisions: true, actionItems: true, risks: true } },
      summaries: true,
    },
  });
  await prisma.$disconnect();

  const mins = meeting.minutes;
  ok("生成了纪要", Boolean(mins));
  ok("概述非空且有一定长度", (mins.overview?.length ?? 0) > 30, `${mins.overview?.length ?? 0} 字`);
  ok("有决议", (mins.decisions.length ?? 0) > 0, `${mins.decisions.length} 条`);
  ok("有待办", (mins.actionItems.length ?? 0) > 0, `${mins.actionItems.length} 条`);
  ok("有风险", (mins.risks.length ?? 0) > 0, `${mins.risks.length} 条`);

  // mock 的固定文案不应出现
  const MOCK_SIGNATURES = [
    "先上线录音上传 + 离线转写，实时转写能力放到后续迭代。",
    "音频先用本地目录存储，后续迁移对象存储。",
  ];
  const allText = JSON.stringify(mins);
  const hasMockText = MOCK_SIGNATURES.some((s) => allText.includes(s));
  ok("不是 mock 的固定文案", !hasMockText);

  console.log("\n=== 模型实际输出 ===");
  console.log("【概述】");
  console.log(mins.overview);
  console.log("\n【决议】");
  mins.decisions.forEach((d, i) => console.log(`  ${i + 1}. ${d.content}`));
  console.log("\n【待办】");
  mins.actionItems.forEach((a, i) =>
    console.log(`  ${i + 1}. ${a.content}${a.owner ? ` [${a.owner}]` : ""}${a.dueAt ? ` (${a.dueAt})` : ""}`),
  );
  console.log("\n【风险】");
  mins.risks.forEach((r, i) => console.log(`  ${i + 1}. [${r.severity}] ${r.content}`));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});