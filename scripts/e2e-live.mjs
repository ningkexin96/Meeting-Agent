// 实时流式端到端 —— 对应 issue #26
// 流程：开启会话 → 连续上传分片 → 检查实时 SSE / 增量纪要 → 结束 → 检查最终纪要
// 用法：node scripts/e2e-live.mjs
import { spawn } from "node:child_process";

const APP_PORT = 3213;
const ASR_PORT = 8901;
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
    body: JSON.stringify({ email }),
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

/** 造一段"音频"，内容随 seq 变化，让假 ASR 能按片返回不同文本 */
function fakeAudio(seq) {
  const buf = Buffer.alloc(4096);
  for (let i = 0; i < buf.length; i++) buf[i] = (seq * 29 + i * 13) & 0xff;
  return buf;
}

async function main() {
  // 假 ASR：按分片序号返回不同的句子，模拟"边说边说"
  const asr = spawn(process.execPath, ["scripts/fake-live-asr.mjs", String(ASR_PORT)], {
    stdio: ["ignore", "ignore", "ignore"],
  });

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
        LIVE_EXTRACT_WINDOW: "2",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  let appErr = "";
  app.stderr.on("data", (d) => (appErr += d));
  await sleep(6000);

  const owner = await login("owner@demo.dev");
  const viewer = await login("viewer@demo.dev");

  console.log("== 1. 创建会议并开启实时会话 ==");
  const fd = new FormData();
  fd.append("title", "实时流式验证会议");
  const created = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie: owner } });
  const { id: meetingId } = await created.json();
  ok("会议创建成功", Boolean(meetingId));

  const startRes = await fetch(`${BASE}/api/live`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner },
    body: JSON.stringify({ meetingId }),
  });
  const startJson = await startRes.json();
  ok("实时会话开启成功", startRes.status === 200 && Boolean(startJson.sessionId), startJson.sessionId);
  const sessionId = startJson.sessionId;

  console.log("== 2. RBAC：viewer 不能开启 ==");
  const viewerStart = await fetch(`${BASE}/api/live`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: viewer },
    body: JSON.stringify({ meetingId }),
  });
  ok("viewer 被拒（403）", viewerStart.status === 403, `status=${viewerStart.status}`);

  console.log("== 3. 订阅实时 SSE ==");
  const es = await fetch(`${BASE}/api/live/${sessionId}/stream`, { headers: { cookie: owner } });
  ok("SSE 连接建立", es.status === 200);

  const events = [];
  const reader = es.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  console.log("== 4. 连续上传分片 ==");
  const N = 6;
  for (let seq = 0; seq < N; seq++) {
    const f = new FormData();
    f.append("sessionId", sessionId);
    f.append("seq", String(seq));
    f.append("startMs", String(seq * 4000));
    f.append("endMs", String((seq + 1) * 4000));
    f.append("audio", new Blob([fakeAudio(seq)], { type: "audio/webm" }), `chunk-${seq}.webm`);
    const res = await fetch(`${BASE}/api/live/chunk`, { method: "POST", body: f, headers: { cookie: owner } });
    const data = await res.json();
    // 慢一点，模拟实时节奏
    await sleep(300);
    if (!res.ok) console.log(`    分片 #${seq} 失败：${JSON.stringify(data)}`);
  }

  await sleep(2500);
  await reader.cancel().catch(() => {});
  await pump;

  const segmentEvents = events.filter((e) => e.type === "live:segment");
  const minuteEvents = events.filter((e) => e.type === "live:minutes");
  ok("收到实时转写事件", segmentEvents.length > 0, `${segmentEvents.length} 条`);
  ok("收到增量纪要事件", minuteEvents.length > 0, `${minuteEvents.length} 次`);
  ok("分片状态事件齐全", events.filter((e) => e.type === "live:chunk").length >= N, 
    `${events.filter((e) => e.type === "live:chunk").length} 条`);

  console.log("== 5. 会话状态可恢复 ==");
  const state = await fetch(`${BASE}/api/live?sessionId=${sessionId}`, { headers: { cookie: owner } });
  const stateJson = await state.json();
  ok("状态接口可用", state.status === 200);
  ok("转写按 seq 有序", stateJson.segments.every((s, i) => i === 0 || s.seq > stateJson.segments[i - 1].seq), `${stateJson.segments.length} 条`);
  ok("有增量纪要条目", stateJson.items.length > 0, `${stateJson.items.length} 条`);
  ok("分片全部处理", stateJson.chunks.filter((c) => c.status === "transcribed").length === N,
    `${stateJson.chunks.filter((c) => c.status === "transcribed").length}/${N}`);

  // 时间轴必须按分片累加，而不是每片都从 0 开始
  const starts = stateJson.segments.map((s) => s.startMs);
  ok(
    "时间戳按分片偏移累加（不是全部从 0 开始）",
    new Set(starts).size > 1,
    `startMs: ${starts.join(", ")}`,
  );
  ok(
    "时间戳单调递增",
    starts.every((v, i) => i === 0 || v >= starts[i - 1]),
  );
  ok(
    "最后一条晚于首条至少 8 秒（6 片 × 4s）",
    (starts[starts.length - 1] ?? 0) - (starts[0] ?? 0) >= 8000,
    `跨度 ${(starts[starts.length - 1] ?? 0) - (starts[0] ?? 0)}ms`,
  );

  console.log("== 6. 跨租户隔离 ==");
  const other = await fetch(`${BASE}/api/live?sessionId=${sessionId}`, { headers: { cookie: viewer } });
  ok("viewer 可读（同租户，viewer 有 meeting:read）", other.status === 200);

  console.log("== 7. 结束会话并合并纪要 ==");
  const endRes = await fetch(`${BASE}/api/live/end`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner },
    body: JSON.stringify({ sessionId }),
  });
  const endJson = await endRes.json();
  ok("结束成功", endRes.status === 200 && endJson.ok !== false, JSON.stringify(endJson).slice(0, 120));
  ok("合并出话轮", endJson.segments > 0, `${endJson.segments} 条`);
  ok("生成纪要", Boolean(endJson.minutesId), endJson.minutesId);

  const dupEnd = await fetch(`${BASE}/api/live/end`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner },
    body: JSON.stringify({ sessionId }),
  });
  ok("重复结束被拒（400）", dupEnd.status === 400, `status=${dupEnd.status}`);

  console.log("== 8. 纪要落库 ==");
  const page = await fetch(`${BASE}/meetings/${meetingId}`, { headers: { cookie: owner } });
  const html = await page.text();
  ok("纪要页面有内容", html.includes("会议纪要") && html.includes("决议"));

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: { turns: true, minutes: { include: { decisions: true, actionItems: true, risks: true } } },
  });
  const live = await prisma.liveSession.findUnique({ where: { id: sessionId } });
  await prisma.$disconnect();

  ok("会议状态 done", meeting?.status === "done", meeting?.status);
  ok("话轮已落库", (meeting?.turns.length ?? 0) > 0, `${meeting?.turns.length} 条`);
  ok(
    "最终纪要含条目",
    ((meeting?.minutes?.decisions.length ?? 0) +
      (meeting?.minutes?.actionItems.length ?? 0) +
      (meeting?.minutes?.risks.length ?? 0)) > 0,
  );
  ok("会话状态 ended", live?.status === "ended", live?.status);

  app.kill();
  asr.kill();
  await sleep(300);
  if (fail > 0) console.log("--- app stderr ---\n" + appErr.slice(0, 1500));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});