// 记忆管理功能测试
const BASE = "http://127.0.0.1:3210";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${e ? " — " + e : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); }
};

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@demo.dev", password: "demo1234" }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const h = { cookie, "content-type": "application/json" };

  console.log("== 1. 列表与筛选 ==");
  let r = await (await fetch(`${BASE}/api/memory`, { headers: h })).json();
  ok("获取列表", r.items.length > 0, `${r.total} 条`);
  ok("有分类统计", Object.keys(r.stats.byKind).length > 0, JSON.stringify(r.stats.byKind));

  const decisionCount = r.stats.byKind.decision ?? 0;
  const filtered = await (await fetch(`${BASE}/api/memory?kind=decision`, { headers: h })).json();
  ok("按分类筛选", filtered.items.every((i) => i.kind === "decision"), `${filtered.items.length} 条决议`);

  const searched = await (await fetch(`${BASE}/api/memory?q=转写`, { headers: h })).json();
  ok("关键词搜索", searched.items.length > 0, `命中 ${searched.items.length} 条`);

  console.log("\n== 2. 新增记忆 ==");
  const created = await (await fetch(`${BASE}/api/memory`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ kind: "lesson", content: "测试：异步接口支持长音频比同步更稳" }),
  })).json();
  ok("创建成功", Boolean(created.id), created.id);

  console.log("\n== 3. 详情与变更记录 ==");
  let detail = await (await fetch(`${BASE}/api/memory/${created.id}`, { headers: h })).json();
  ok("获取详情", detail.item.id === created.id);
  ok("有变更记录", detail.item.changes.length > 0, `${detail.item.changes.length} 条`);
  ok("来源标记为手动", detail.item.source === "web_user");

  console.log("\n== 4. 编辑 ==");
  let patch = await fetch(`${BASE}/api/memory/${created.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ action: "edit", content: "测试：长音频应改走异步接口", kind: "lesson" }),
  });
  ok("编辑成功", patch.ok);
  detail = await (await fetch(`${BASE}/api/memory/${created.id}`, { headers: h })).json();
  ok("内容已更新", detail.item.content === "测试：长音频应改走异步接口", detail.item.content);
  ok("变更记录增加", detail.item.changes.length >= 2, `${detail.item.changes.length} 条`);

  console.log("\n== 5. 状态流转 ==");
  patch = await fetch(`${BASE}/api/memory/${created.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ status: "superseded", reason: "已被新方案取代" }),
  });
  ok("标记已过时", patch.ok);
  detail = await (await fetch(`${BASE}/api/memory/${created.id}`, { headers: h })).json();
  ok("状态已变更", detail.item.status === "superseded", detail.item.status);

  console.log("\n== 6. 遗忘与恢复 ==");
  patch = await fetch(`${BASE}/api/memory/${created.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ action: "forget" }),
  });
  ok("遗忘成功", patch.ok);

  // 默认列表不应包含已遗忘
  r = await (await fetch(`${BASE}/api/memory`, { headers: h })).json();
  ok("默认列表不含已遗忘", !r.items.some((i) => i.id === created.id));

  // 显式查 deleted 可以看到
  const deletedList = await (await fetch(`${BASE}/api/memory?status=deleted`, { headers: h })).json();
  ok("可查看已遗忘", deletedList.items.some((i) => i.id === created.id), `${deletedList.items.length} 条`);

  patch = await fetch(`${BASE}/api/memory/${created.id}`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ action: "restore" }),
  });
  ok("恢复成功", patch.ok);
  detail = await (await fetch(`${BASE}/api/memory/${created.id}`, { headers: h })).json();
  ok("恢复后状态为 active", detail.item.status === "active", detail.item.status);

  console.log("\n== 7. 权限 ==");
  const vLogin = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "viewer@demo.dev", password: "demo1234" }),
  });
  const vCookie = (vLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const vRead = await fetch(`${BASE}/api/memory`, { headers: { cookie: vCookie } });
  ok("viewer 不能读记忆（memory:read 未被授予）", vRead.status === 403, `status=${vRead.status}`);

  console.log("\n== 8. 输入校验 ==");
  const empty = await fetch(`${BASE}/api/memory`, {
    method: "POST", headers: h, body: JSON.stringify({ content: "  " }),
  });
  ok("空内容被拒绝", empty.status === 400);

  const badPatch = await fetch(`${BASE}/api/memory/${created.id}`, {
    method: "PATCH", headers: h, body: JSON.stringify({ content: "" }),
  });
  ok("编辑为空被拒绝", badPatch.status === 400);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });