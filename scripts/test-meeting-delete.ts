// 会议删除（issue #30）测试
//
// 重点不是"能删掉"，而是"删干净且没伤到不该动的东西"：
//   - 关联数据是否全部清掉（尤其是没有外键的 Embedding）
//   - 记忆是否只解绑、不删除
//   - 审计是否保留（会议没了也要能查是谁删的）
//   - 权限与租户隔离
//
// 用法：pnpm test:meeting-delete（需要服务已启动）

import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://127.0.0.1:3210";
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

async function login(email: string, password = "demo1234") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`登录失败：${email}`);
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function serverUp() {
  try {
    const r = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

/** 造一场"什么都有"的会议：话轮、纪要、决议、实时会话、索引、记忆 */
async function seedMeeting(tenantId: string, userId: string, title: string) {
  const meeting = await prisma.meeting.create({
    data: { tenantId, title, status: "done", stage: "DONE", createdBy: userId },
  });
  const participant = await prisma.meetingParticipant.create({
    data: { meetingId: meeting.id, displayName: "说话人 A", speakerLabel: "speaker_0" },
  });
  const turn = await prisma.transcriptTurn.create({
    data: {
      meetingId: meeting.id,
      participantId: participant.id,
      idx: 0,
      startMs: 0,
      endMs: 3000,
      text: "这是用于测试删除的一场会议。",
    },
  });
  const minutes = await prisma.minutes.create({ data: { meetingId: meeting.id, overview: "测试纪要" } });
  const decision = await prisma.decision.create({
    data: { minutesId: minutes.id, content: "删除测试决议", sourceTurnId: turn.id },
  });
  await prisma.citation.create({ data: { turnId: turn.id, targetType: "decision", targetId: decision.id } });
  await prisma.summary.create({
    data: { meetingId: meeting.id, stage: "final", content: "测试摘要", turnRefs: "[]" },
  });
  const live = await prisma.liveSession.create({
    data: { tenantId, meetingId: meeting.id, status: "ended", endedAt: new Date() },
  });
  await prisma.liveSegment.create({
    data: { sessionId: live.id, meetingId: meeting.id, seq: 0, speakerLabel: "speaker_0", startMs: 0, endMs: 1000, text: "实时片段" },
  });
  await prisma.embedding.create({
    data: {
      tenantId,
      objectType: "turn",
      objectId: turn.id,
      meetingId: meeting.id,
      content: "这是用于测试删除的一场会议。",
      embedding: JSON.stringify([0.1, 0.2]),
      dim: 2,
    },
  });
  const memory = await prisma.memory.create({
    data: { tenantId, meetingId: meeting.id, kind: "decision", content: "删除测试沉淀的记忆", importance: 0.8 },
  });
  return { meeting, turn, decision, live, memory };
}

async function countAll(meetingId: string) {
  const [turns, citations, minutes, decisions, summaries, liveSessions, liveSegments, participants, embeddings, memories, meetings] =
    await Promise.all([
      prisma.transcriptTurn.count({ where: { meetingId } }),
      prisma.citation.count({ where: { turn: { meetingId } } }),
      prisma.minutes.count({ where: { meetingId } }),
      prisma.decision.count({ where: { minutes: { meetingId } } }),
      prisma.summary.count({ where: { meetingId } }),
      prisma.liveSession.count({ where: { meetingId } }),
      prisma.liveSegment.count({ where: { meetingId } }),
      prisma.meetingParticipant.count({ where: { meetingId } }),
      prisma.embedding.count({ where: { meetingId } }),
      prisma.memory.count({ where: { meetingId } }),
      prisma.meeting.count({ where: { id: meetingId } }),
    ]);
  return { turns, citations, minutes, decisions, summaries, liveSessions, liveSegments, participants, embeddings, memories, meetings };
}

async function main() {
  if (!(await serverUp())) {
    console.log(`服务未启动（${BASE}），跳过。请先 pnpm build && pnpm start`);
    process.exit(1);
  }

  const owner = await login("owner@demo.dev");
  const member = await login("member@demo.dev");
  const viewer = await login("viewer@demo.dev");
  const h = (cookie: string) => ({ cookie, "content-type": "application/json" });

  const ownerUser = await prisma.user.findUnique({ where: { email: "owner@demo.dev" } });

  // 独立租户的"外人"，用于验证隔离
  const outsiderEmail = `del-outsider-${Date.now()}@test.dev`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: outsiderEmail, password: "qa-pass-1234", name: "外部租户" }),
  });
  const outsiderCookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const created: string[] = [];
  try {
    console.log("\n== 1. 鉴权与权限 ==");
    {
      const anon = await fetch(`${BASE}/api/meetings/whatever`, { method: "DELETE" });
      ok("未登录返回 401", anon.status === 401, String(anon.status));

      const asViewer = await fetch(`${BASE}/api/meetings/whatever`, { method: "DELETE", headers: h(viewer) });
      ok("viewer 删除返回 403", asViewer.status === 403, String(asViewer.status));

      const asMember = await fetch(`${BASE}/api/meetings/whatever`, { method: "DELETE", headers: h(member) });
      ok("member 删除返回 403（仅 owner 可删）", asMember.status === 403, String(asMember.status));

      const notFound = await fetch(`${BASE}/api/meetings/does-not-exist`, { method: "DELETE", headers: h(owner) });
      ok("不存在的会议返回 404", notFound.status === 404, String(notFound.status));
    }

    console.log("\n== 2. 删除后的数据完整性 ==");
    {
      const seeded = await seedMeeting(ownerUser.tenantId, ownerUser.id, "删除测试会议");
      created.push(seeded.meeting.id);

      const before = await countAll(seeded.meeting.id);
      ok(
        "测试数据齐备",
        before.turns === 1 && before.minutes === 1 && before.decisions === 1 &&
          before.liveSessions === 1 && before.embeddings === 1 && before.memories === 1 && before.citations === 1,
        JSON.stringify(before),
      );

      const res = await fetch(`${BASE}/api/meetings/${seeded.meeting.id}`, { method: "DELETE", headers: h(owner) });
      const body = await res.json().catch(() => ({}));
      ok("删除返回 200", res.status === 200, String(res.status));
      ok("返回被保留的记忆条数", body.keptMemories === 1, String(body.keptMemories));

      const after = await countAll(seeded.meeting.id);
      ok("会议本体已删除", after.meetings === 0, String(after.meetings));
      ok("话轮已清空", after.turns === 0, String(after.turns));
      ok("引用已清空", after.citations === 0, String(after.citations));
      ok("纪要已清空", after.minutes === 0, String(after.minutes));
      ok("决议已清空", after.decisions === 0, String(after.decisions));
      ok("摘要已清空", after.summaries === 0, String(after.summaries));
      ok("实时会话已清空", after.liveSessions === 0, String(after.liveSessions));
      ok("实时片段已清空", after.liveSegments === 0, String(after.liveSegments));
      ok("说话人已清空", after.participants === 0, String(after.participants));
      ok("语义索引已清空（无外键，最容易漏）", after.embeddings === 0, String(after.embeddings));

      const mem = await prisma.memory.findUnique({ where: { id: seeded.memory.id } });
      ok("记忆被保留（不是删除）", Boolean(mem), mem ? "仍存在" : "被删掉了");
      ok("记忆已解绑会议", mem?.meetingId === null, String(mem?.meetingId));

      const audits = await prisma.auditLog.findMany({
        where: { tenantId: ownerUser.tenantId, action: "meeting.deleted" },
        orderBy: { at: "desc" },
        take: 3,
      });
      const mine = audits.find((a) => a.detail.includes(seeded.meeting.id));
      ok("写入删除审计（会议删了也留痕）", Boolean(mine));
      ok("审计包含会议标题", Boolean(mine?.detail.includes("删除测试会议")));

      await prisma.memory.delete({ where: { id: seeded.memory.id } });
      await prisma.auditLog.deleteMany({ where: { detail: { contains: seeded.meeting.id } } });
    }

    console.log("\n== 3. 重复删除与租户隔离 ==");
    {
      const again = await fetch(`${BASE}/api/meetings/${created[0]}`, { method: "DELETE", headers: h(owner) });
      ok("重复删除返回 404（幂等，不报 500）", again.status === 404, String(again.status));

      const seeded = await seedMeeting(ownerUser.tenantId, ownerUser.id, "隔离测试会议");
      created.push(seeded.meeting.id);

      if (reg.status === 403) {
        console.log("  (注册被关闭，跳过跨租户用例)");
      } else {
        const cross = await fetch(`${BASE}/api/meetings/${seeded.meeting.id}`, {
          method: "DELETE",
          headers: h(outsiderCookie),
        });
        ok("跨租户删除返回 404", cross.status === 404, String(cross.status));

        const still = await prisma.meeting.count({ where: { id: seeded.meeting.id } });
        ok("跨租户删除后会议仍在", still === 1);
      }

      // 清理这场（记忆也要一并清掉，避免污染演示数据）
      await prisma.memory.deleteMany({ where: { meetingId: seeded.meeting.id } });
      const res = await fetch(`${BASE}/api/meetings/${seeded.meeting.id}`, { method: "DELETE", headers: h(owner) });
      ok("owner 自己可以删除", res.status === 200, String(res.status));
      await prisma.auditLog.deleteMany({ where: { detail: { contains: seeded.meeting.id } } });
    }
  } finally {
    // 兜底清理
    for (const id of created) {
      await prisma.memory.deleteMany({ where: { meetingId: id } });
      await prisma.embedding.deleteMany({ where: { meetingId: id } });
      await prisma.auditLog.deleteMany({ where: { detail: { contains: id } } });
      await prisma.meeting.deleteMany({ where: { id } }).catch(() => {});
    }
    const u = await prisma.user.findUnique({ where: { email: outsiderEmail } });
    if (u) {
      await prisma.session.deleteMany({ where: { userId: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
      await prisma.tenant.delete({ where: { id: u.tenantId } });
    }
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});