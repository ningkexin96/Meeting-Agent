// 实时会议结束链路的边界场景测试
//
// 覆盖：
// 1. 没有转写内容 → 会话标记 failed
// 2. 已有实时话轮后重复调用 → 幂等，不产生重复
// 3. 跨租户调用 → 被拒绝
// 4. 并发结束 → 只有一个成功
// 5. 增量条目引用不存在的 seq → 回退到首条，不崩溃

import { PrismaClient } from "@prisma/client";
import { endSession } from "../lib/live/session.ts";

const p = new PrismaClient();
let pass = 0, fail = 0;
const ok = (n, c, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}${e ? " — " + e : ""}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); }
};

async function makeMeeting(title) {
  const m = await p.meeting.create({
    data: { tenantId: (await p.user.findFirst({ where: { email: "owner@demo.dev" } })).tenantId, title, status: "draft" },
  });
  return m;
}

async function main() {
  const user = await p.user.findFirst({ where: { email: "owner@demo.dev" }, select: { id: true, tenantId: true, role: true } });
  const ctx = { tenantId: user.tenantId, userId: user.id, role: user.role };

  // ===== 1. 没有转写内容 =====
  console.log("=== 1. 没有转写内容 ===");
  {
    const m = await makeMeeting("空会议");
    const live = await p.liveSession.create({ data: { tenantId: user.tenantId, meetingId: m.id, status: "live" } });
    const r = await endSession(live.id, ctx);
    ok("返回 ok:false", r.ok === false, JSON.stringify(r));
    const after = await p.liveSession.findUnique({ where: { id: live.id } });
    ok("会话标记为 failed", after.status === "failed", after.status);
  }

  // ===== 2. 幂等：先建好转写，调用两次 =====
  console.log("\n=== 2. 重复调用幂等 ===");
  {
    const m = await makeMeeting("幂等测试");
    const part = await p.meetingParticipant.create({
      data: { meetingId: m.id, displayName: "实时转写", speakerLabel: "speaker_0", confidence: 0.8 },
    });
    const live = await p.liveSession.create({ data: { tenantId: user.tenantId, meetingId: m.id, status: "live" } });
    for (let i = 0; i < 3; i++) {
      await p.liveSegment.create({
        data: {
          session: { connect: { id: live.id } },
          meeting: { connect: { id: m.id } },
          seq: i, speakerLabel: "speaker_0", startMs: i * 3000, endMs: (i + 1) * 3000,
          text: `第 ${i} 句测试内容。`, confidence: 0.9, needsReview: false,
        },
      });
    }
    void part;

    const r1 = await endSession(live.id, ctx);
    ok("第一次结束成功", r1.ok === true);
    const c1 = await p.transcriptTurn.count({ where: { meetingId: m.id, liveSessionId: live.id } });
    ok("落库 3 条话轮", c1 === 3, `${c1} 条`);

    try {
      await endSession(live.id, ctx);
      ok("第二次被拒绝", false);
    } catch (e) {
      ok("第二次被拒绝", /结束过了/.test(e.message), e.message);
    }
    const c2 = await p.transcriptTurn.count({ where: { meetingId: m.id, liveSessionId: live.id } });
    ok("话轮数量未增加", c2 === 3, `${c2} 条`);
  }

  // ===== 3. 跨租户 =====
  console.log("\n=== 3. 跨租户访问 ===");
  {
    const otherTenant = await p.tenant.create({ data: { name: "别的租户" + Date.now() } });
    const m = await makeMeeting("跨租户测试");
    const live = await p.liveSession.create({ data: { tenantId: user.tenantId, meetingId: m.id, status: "live" } });
    try {
      await endSession(live.id, { tenantId: otherTenant.id, userId: user.id, role: "owner" });
      ok("跨租户被拒绝", false, "竟然成功了");
    } catch (e) {
      ok("跨租户被拒绝", /不存在|不属于/.test(e.message), e.message);
    }
    const after = await p.liveSession.findUnique({ where: { id: live.id } });
    ok("会话状态未被改动", after.status === "live", after.status);
  }

  // ===== 4. 并发结束 =====
  console.log("\n=== 4. 并发结束 ===");
  {
    const m = await makeMeeting("并发测试");
    const live = await p.liveSession.create({ data: { tenantId: user.tenantId, meetingId: m.id, status: "live" } });
    await p.liveSegment.create({
      data: {
        session: { connect: { id: live.id } },
        meeting: { connect: { id: m.id } },
        seq: 0, speakerLabel: "speaker_0", startMs: 0, endMs: 3000,
        text: "并发测试的一句话。", confidence: 0.9, needsReview: false,
      },
    });

    const results = await Promise.allSettled([
      endSession(live.id, ctx),
      endSession(live.id, ctx),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    ok("只有一个成功", succeeded === 1 && rejected === 1, `成功 ${succeeded} / 拒绝 ${rejected}`);

    const turns = await p.transcriptTurn.count({ where: { meetingId: m.id, liveSessionId: live.id } });
    ok("并发未产生重复话轮", turns === 1, `${turns} 条`);
  }

  // ===== 5. 引用不存在的 seq =====
  console.log("\n=== 5. 条目引用不存在的 seq ===");
  {
    const m = await makeMeeting("异常引用测试");
    const live = await p.liveSession.create({ data: { tenantId: user.tenantId, meetingId: m.id, status: "live" } });
    await p.liveSegment.create({
      data: {
        session: { connect: { id: live.id } },
        meeting: { connect: { id: m.id } },
        seq: 0, speakerLabel: "speaker_0", startMs: 0, endMs: 3000,
        text: "唯一的一句话。", confidence: 0.9, needsReview: false,
      },
    });
    // fromTurnSeq = 99 不存在
    await p.liveMinuteItem.create({
      data: { sessionId: live.id, kind: "decision", content: "一个来源不明的决议", fromTurnSeq: 99, severity: "medium" },
    });

    try {
      const r = await endSession(live.id, ctx);
      ok("不崩溃，正常结束", r.ok === true);
      const mins = await p.minutes.findUnique({ where: { meetingId: m.id }, include: { decisions: true } });
      ok("决议被保留", (mins?.decisions.length ?? 0) > 0, `${mins?.decisions.length} 条`);
      // 引用应回退到首条而非指向不存在的 idx
      const dec = mins?.decisions[0];
      if (dec) {
        const cit = await p.citation.findFirst({ where: { targetType: "decision", targetId: dec.id } });
        const turn = cit ? await p.transcriptTurn.findUnique({ where: { id: cit.turnId } }) : null;
        ok("引用回退到有效话轮", turn?.idx === 0 && turn.text === "唯一的一句话。", turn ? `idx=${turn.idx}` : "无引用");
      }
    } catch (e) {
      ok("不崩溃，正常结束", false, e.message);
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });