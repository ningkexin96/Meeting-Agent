// 实时增量抽取（纯 ESM 版，供 ws-realtime.mjs 直接调用）
//
// 为什么单独写一份而不是 import lib/live/incremental.ts：
// 自定义 server 由 Node 原生运行，不能直接加载 TypeScript。
// 两份实现逻辑一致，TS 版供 Next 内部使用，ESM 版供 WebSocket 进程使用。
//
// 保持与 lib/live/incremental.ts 相同的：去重规则、最小长度、失败不影响录音。

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const sessionQueues = new Map();

function normalize(s) {
  return s.replace(/[\s，。！？、；：,.!?;:""''（）()]/g, "").toLowerCase();
}

/**
 * 判断两句话是否「实质重复」。
 *
 * 为什么不能只做精确匹配：模型对同一句话可能给出不同措辞
 * （"先上线离线转写" vs "先上线离线转写能力"），精确比较会漏判。
 * 这里用「一个包含另一个且长度接近」或「bigram 重合度 >= 0.6」判重。
 */
function isDuplicate(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // 一个完全包含另一个，且长度差异不大
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    if (shorter / longer >= 0.6) return true;
  }

  // bigram 重合度
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(na);
  const gb = grams(nb);
  if (ga.size === 0 || gb.size === 0) return false;

  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  const overlap = common / Math.min(ga.size, gb.size);

  return overlap >= 0.6;
}

/** mock / 无模型时的规则抽取 */
function ruleExtract(segments) {
  const DECISION = /(决定|定了|就这样|确认|同意|敲定|结论是|先做|改成)/;
  const ACTION = /(负责|跟进|来做|处理|完成|截止|之前给|下周|明天|周五|周四)/;
  const RISK = /(风险|担心|可能来不及|时间紧|阻塞|卡住|延期|砍掉|做不完)/;

  const out = [];
  for (const s of segments) {
    const t = (s.text || "").trim();
    if (t.length < 6) continue;

    if (RISK.test(t)) {
      out.push({
        kind: "risk",
        content: t,
        owner: null,
        dueAt: null,
        severity: /(来不及|做不完|延期|砍掉|严重)/.test(t) ? "high" : "medium",
        sourceSeq: s.seq,
      });
      continue;
    }
    if (DECISION.test(t)) {
      out.push({ kind: "decision", content: t, owner: null, dueAt: null, severity: null, sourceSeq: s.seq });
      continue;
    }
    if (ACTION.test(t)) {
      const ownerMatch = t.match(/([\u4e00-\u9fa5]{2,4})(?:负责|来做|跟进)/);
      const dueMatch = t.match(/(本周[一二三四五六日]|下周[一二三四五六日]|周[一二三四五六日]|明天|今天)/);
      out.push({
        kind: "action_item",
        content: t,
        owner: ownerMatch ? ownerMatch[1] : null,
        dueAt: dueMatch ? dueMatch[1] : null,
        severity: null,
        sourceSeq: s.seq,
      });
    }
  }
  return out;
}

/** 调用真实模型抽取（OpenAI 兼容接口） */
async function llmExtract(text) {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || "deepseek-chat";
  if (!base || !key) return null;

  const prompt = `你是实时会议纪要抽取器。只输出 JSON，不要解释。

从下面的会议片段中抽取【明确出现的】决议、待办、风险。没有就返回空数组，不要编造。

输出格式：
{"items":[{"kind":"decision|action_item|risk","content":"","owner":"","dueAt":"","severity":"low|medium|high","sourceSeq":0}]}

要求：
- 只抽取这段文字里明确表达的内容
- owner 和 dueAt 没提到就留空
- sourceSeq 必须填内容实际来源片段的编号（例如 #3 就填 3）

片段：
${text}`;

  const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) return null;

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "";

  // 容错解析：可能是 ```json 包裹，也可能有前后废话
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : content.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return null;
  }
}

/**
 * 抽取并落库，返回新增条目。
 * 同一会话串行执行，避免并发批次读到同一快照造成重复。
 */
export async function extractIncremental(sessionId, meetingId, segments) {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve([]);
  const next = previous.then(() => extractIncrementalNow(sessionId, meetingId, segments));
  sessionQueues.set(sessionId, next);
  const created = await next;
  if (sessionQueues.get(sessionId) === next) sessionQueues.delete(sessionId);
  return created;
}

function sourceSeqOf(item, segments) {
  const explicit = Number(item.sourceSeq);
  if (Number.isInteger(explicit) && segments.some((s) => s.seq === explicit)) return explicit;

  const content = normalize(String(item.content || ""));
  const hit = segments.find((s) => {
    const text = normalize(String(s.text || ""));
    return content && text && (content.includes(text) || text.includes(content));
  });
  return hit?.seq ?? segments[0].seq;
}

async function extractIncrementalNow(sessionId, meetingId, segments) {
  if (!sessionId || !meetingId || !segments || segments.length === 0) return [];

  const live = await prisma.liveSession.findUnique({
    where: { id: sessionId },
    select: { tenantId: true },
  });
  if (!live) return [];

  const text = segments.map((s) => `#${s.seq} ${s.text}`).join("\n");

  let raw = null;
  if (process.env.MOCK_LLM !== "1") {
    raw = await llmExtract(text);
  }
  if (!raw) raw = ruleExtract(segments);

  const maxSeq = Math.max(...segments.map((s) => s.seq));
  return prisma.$transaction(async (tx) => {
    // 已有条目用于去重；必须在事务内读取，避免 LLM 期间被另一批抢先写入。
    const existing = await tx.liveMinuteItem.findMany({
      where: { sessionId },
      select: { content: true },
    });

    const created = [];
    for (const it of raw) {
      const content = String(it.content || "").trim();
      if (!content || content.length < 4) continue;

      const contents = existing.map((e) => e.content);
      if (contents.some((c) => isDuplicate(c, content))) continue;

      const kind = ["decision", "action_item", "risk"].includes(it.kind) ? it.kind : "decision";
      const sourceSeq = sourceSeqOf(it, segments);
      const row = await tx.liveMinuteItem.create({
        data: {
          sessionId,
          kind,
          content,
          owner: it.owner ? String(it.owner).trim() || null : null,
          dueAt: it.dueAt ? String(it.dueAt).trim() || null : null,
          severity: it.severity ? String(it.severity).trim() || "medium" : "medium",
          sourceText: `#${sourceSeq}`,
          fromTurnSeq: sourceSeq,
        },
      });
      existing.push({ content });
      created.push({
        id: row.id,
        kind: row.kind,
        content: row.content,
        owner: row.owner,
        dueAt: row.dueAt,
        severity: row.severity,
      });
    }

    // 没有抽到条目也算处理过，否则会话结束时会反复重放同一批内容。
    await tx.liveSession.updateMany({
      where: { id: sessionId, lastExtractedSeq: { lt: maxSeq } },
      data: { lastExtractedSeq: maxSeq },
    });
    return created;
  });
}