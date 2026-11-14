// 端到端：实时会议 → 结束 → 校验正式纪要的引用链路
//
// 这个测试要验证的是 lib/live/session.ts 里最复杂的一段：
//   LiveSegment(seq) → TranscriptTurn(liveSeq → idx) → Decision/Risk/引用
// 核心风险：增量条目的 fromTurnSeq 存的是 LiveSegment.seq，
// 必须正确映射成正式 TranscriptTurn.idx，否则引用会指向错误的话轮。

import { PrismaClient } from "@prisma/client";
import { endSession } from "../lib/live/session.ts";

const p = new PrismaClient();
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

  // 建一个带已上传转写的会议（模拟"会前已有上传转写"的真实场景）
  const fd = new FormData();
  fd.append("title", "E2E引用链路 " + new Date().toLocaleTimeString("zh-CN"));
  const { id: meetingId } = await fetch(`${BASE}/api/meetings`, { method: "POST", body: fd, headers: { cookie } }).then((r) => r.json());
  console.log("会议:", meetingId);

  const meeting = await p.meeting.findUnique({ where: { id: meetingId }, select: { tenantId: true } });
  const user = await p.user.findFirst({ where: { email: "owner@demo.dev" }, select: { id: true, tenantId: true, role: true } });

  // 预置 2 条上传来的话轮（idx 0,1），确保实时话轮不能复用这些 idx
  const participant = await p.meetingParticipant.create({
    data: { meetingId, displayName: "历史转写", speakerLabel: "speaker_0", confidence: 0.9 },
  });
  await p.transcriptTurn.createMany({
    data: [
      { meetingId, participantId: participant.id, idx: 0, startMs: 0, endMs: 3000, text: "会议开始前的上传转写第一句。", asrConfidence: 0.9, needsReview: false },
      { meetingId, participantId: participant.id, idx: 1, startMs: 3000, endMs: 6000, text: "会议开始前的上传转写第二句。", asrConfidence: 0.9, needsReview: false },
    ],
  });

  // 建实时会话并填充 LiveSegment + LiveMinuteItem
  const live = await p.liveSession.create({
    data: { tenantId: meeting.tenantId, meetingId, status: "live" },
  });
  console.log("实时会话:", live.id);

  const segTexts = [
    "这个事就这么定了，先上线离线转写。",
    "李娜你负责转写视图，本周四之前给到我。",
    "还有个风险，声纹库没有，可能识别不准。",
    "今天主要对一下上线节奏。",
  ];
  for (let i = 0; i < segTexts.length; i++) {
    await p.liveSegment.create({
      data: {
        session: { connect: { id: live.id } },
        meeting: { connect: { id: meetingId } },
        seq: i, speakerLabel: "speaker_0",
        startMs: i * 5000, endMs: (i + 1) * 5000,
        text: segTexts[i], confidence: 0.9, needsReview: false,
      },
    });
  }

  // 增量条目：fromTurnSeq 存的是 LiveSegment.seq
  // 决议来自 seq=0，待办来自 seq=1，风险来自 seq=2
  await p.liveMinuteItem.createMany({
    data: [
      { sessionId: live.id, kind: "decision", content: "先上线离线转写", fromTurnSeq: 0, severity: "medium" },
      { sessionId: live.id, kind: "action_item", content: "转写视图初版", owner: "李娜", dueAt: "本周四", fromTurnSeq: 1, severity: "medium" },
      { sessionId: live.id, kind: "risk", content: "声纹库没有，可能识别不准", fromTurnSeq: 2, severity: "high" },
    ],
  });
  console.log(`已填充 ${segTexts.length} 条实时片段 + 3 条增量条目\n`);

  // ===== 执行结束 =====
  console.log("=== 调用 endSession ===");
  const r = await endSession(live.id, { tenantId: meeting.tenantId, userId: user.id, role: user.role });
  ok("endSession 返回 ok", r.ok === true, JSON.stringify(r));

  // ===== 验证 1：会话状态 =====
  const after = await p.liveSession.findUnique({ where: { id: live.id } });
  ok("会话状态为 ended", after.status === "ended", after.status);

  // ===== 验证 2：实时片段成为正式话轮 =====
  const liveTurns = await p.transcriptTurn.findMany({
    where: { meetingId, liveSessionId: live.id },
    orderBy: { liveSeq: "asc" },
  });
  ok("实时片段全部落成正式话轮", liveTurns.length === segTexts.length, `${liveTurns.length}/${segTexts.length}`);

  const idxs = liveTurns.map((t) => t.idx).sort((a, b) => a - b);
  ok("正式 idx 不冲突（从 2 开始，因为已有 0,1）", idxs[0] === 2, `实际 idx: ${idxs.join(",")}`);

  // ===== 验证 3：核心 —— 引用指向正确的话轮 =====
  const minutes = await p.minutes.findUnique({
    where: { meetingId },
    include: { decisions: true, actionItems: true, risks: true },
  });
  ok("纪要已生成", Boolean(minutes));

  if (minutes) {
    const allTurns = await p.transcriptTurn.findMany({ where: { meetingId } });
    const turnById = new Map(allTurns.map((t) => [t.id, t]));
    const citations = await p.citation.findMany({ where: { turnId: { in: [...turnById.keys()] } } });
    const citationByTarget = new Map(citations.map((c) => [`${c.targetType}:${c.targetId}`, c]));

    // 每条纪要条目期望引用的原文
    const expected = [
      { type: "decision", items: minutes.decisions, match: "先上线离线转写", text: segTexts[0] },
      { type: "action_item", items: minutes.actionItems, match: "转写视图", text: segTexts[1] },
      { type: "risk", items: minutes.risks, match: "声纹库", text: segTexts[2] },
    ];

    for (const { type, items, match, text } of expected) {
      const it = items.find((x) => x.content.includes(match));
      if (!it) { ok(`${type}「${match}」存在于纪要`, false); continue; }
      const cit = citationByTarget.get(`${type}:${it.id}`);
      const cited = cit ? turnById.get(cit.turnId) : null;
      ok(
        `${type}「${match}」引用指向正确话轮`,
        cited?.text === text,
        cited ? `引用="${cited.text.slice(0, 18)}" 期望="${text.slice(0, 18)}"` : "无引用"
      );
    }
  }

  // ===== 验证 4：重复结束被拒绝 =====
  console.log("\n=== 重复结束 ===");
  try {
    await endSession(live.id, { tenantId: meeting.tenantId, userId: user.id, role: user.role });
    ok("重复结束被拒绝", false, "竟然成功了");
  } catch (e) {
    ok("重复结束被拒绝", /结束过了|不能结束/.test(e.message), e.message);
  }

  // ===== 验证 5：重复落库幂等 =====
  const turnsAfterRetry = await p.transcriptTurn.count({ where: { meetingId, liveSessionId: live.id } });
  ok("重复调用未产生重复话轮", turnsAfterRetry === segTexts.length, `${turnsAfterRetry} 条`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });