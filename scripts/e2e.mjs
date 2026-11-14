// 端到端验收脚本：直接打 HTTP API，覆盖演示脚本 9 步里的关键路径
// 用法：先 `pnpm build && pnpm start -p 3210`，再 `node scripts/e2e.mjs`
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

function cookieFrom(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return cookieFrom(res);
}

async function main() {
  console.log("== 1. 登录与 RBAC ==");
  const ownerCookie = await login("owner@demo.dev");
  const viewerCookie = await login("viewer@demo.dev");
  ok("owner 登录成功", ownerCookie.includes("ma_user="));

  console.log("== 2. viewer 不能创建会议（第 1 层 RBAC） ==");
  const fd = new FormData();
  fd.append("title", "viewer 尝试创建");
  const viewerCreate = await fetch(`${BASE}/api/meetings`, {
    method: "POST",
    body: fd,
    headers: { cookie: viewerCookie },
  });
  ok("viewer 创建被拒（403）", viewerCreate.status === 403, `status=${viewerCreate.status}`);

  console.log("== 3. owner 创建会议 ==");
  const fd2 = new FormData();
  fd2.append("title", "E2E 验收会议");
  const created = await fetch(`${BASE}/api/meetings`, {
    method: "POST",
    body: fd2,
    headers: { cookie: ownerCookie },
  });
  const createdJson = await created.json();
  const meetingId = createdJson.id;
  ok("会议创建成功", created.status === 200 && Boolean(meetingId), meetingId);

  console.log("== 4. viewer 不能触发 Agent（agent:run） ==");
  const viewerRun = await fetch(`${BASE}/api/meetings/${meetingId}/run`, {
    method: "POST",
    headers: { cookie: viewerCookie },
  });
  ok("viewer 触发被拒（403）", viewerRun.status === 403, `status=${viewerRun.status}`);

  console.log("== 5. owner 触发 Agent + SSE 观察 ==");
  const streamRes = await fetch(`${BASE}/api/meetings/${meetingId}/stream`, {
    headers: { cookie: ownerCookie },
  });
  ok("SSE 连接建立", streamRes.status === 200, `status=${streamRes.status}`);

  const events = [];
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  const runPromise = fetch(`${BASE}/api/meetings/${meetingId}/run`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });

  let buffer = "";
  let done = false;
  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const p of parts) {
      const line = p.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const e = JSON.parse(line.slice(6));
        events.push(e);
        if (e.type === "done" || e.type === "error") done = true;
      } catch {}
    }
  }
  await reader.cancel().catch(() => {});
  await runPromise;

  const stages = events.filter((e) => e.type === "stage").map((e) => e.stage);
  const tools = events.filter((e) => e.type === "tool").map((e) => e.tool);
  ok("SSE 收到阶段事件", stages.length >= 5, stages.join(" → "));
  ok("阶段顺序正确", stages.join(",") === "PREPARING,SUMMARIZING,EXTRACTING,REVIEWING,DONE");
  ok("出现工具调用事件", tools.length > 0, [...new Set(tools)].join(", "));
  ok("收到 done 事件", events.some((e) => e.type === "done"));

  console.log("== 6. 纪要落库与引用 ==");
  const pageRes = await fetch(`${BASE}/meetings/${meetingId}`, { headers: { cookie: ownerCookie } });
  const html = await pageRes.text();
  ok("纪要页面渲染成功", pageRes.status === 200);
  ok("页面包含决议分区", html.includes("决议"));
  ok("页面包含待办与风险", html.includes("待办") && html.includes("风险"));
  ok("页面包含引用按钮", html.includes("#引用"));
  ok("页面包含转写气泡", html.includes("原始转写"));

  console.log("== 7. 跨会议追问 ==");
  const askRes = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ question: "上次关于排期定了什么？" }),
  });
  const askJson = await askRes.json();
  ok("追问接口可用", askRes.status === 200);
  ok("追问返回答案", typeof askJson.answer === "string" && askJson.answer.length > 0);
  ok(
    "追问命中历史记忆/决议并带引用",
    Array.isArray(askJson.references) && askJson.references.length > 0,
    `refs=${askJson.references?.length ?? 0}`,
  );
  ok(
    "追问答案提到排期",
    /排期|版本|迭代/.test(askJson.answer),
  );

  console.log("== 8. 未知问题不编造 ==");
  const askMiss = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ question: "量子计算什么时候上线？" }),
  });
  const missJson = await askMiss.json();
  ok(
    "无命中时不编造（答案里不含问题中的实体）",
    !String(missJson.answer ?? "").includes("量子"),
    missJson.answer?.slice(0, 40),
  );

  console.log("== 9. viewer 不能编辑纪要 ==");
  const viewerEdit = await fetch(`${BASE}/api/meetings/${meetingId}/minutes`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: viewerCookie },
    body: JSON.stringify({ minutesStatus: "confirmed" }),
  });
  ok("viewer 编辑被拒（403）", viewerEdit.status === 403, `status=${viewerEdit.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});