// 会中问答的服务层 —— 对应 issue #27 / #28 / #29
//
// 职责边界：
//   qa-core.ts   纯计算（打分 / 合并 / 兜底 / 提示词），可单测
//   本文件        取数与鉴权、调模型、审计
//   app/api/live/ask/route.ts   HTTP 入口（流式）
//
// 流程被拆成两段，是为了支持流式输出（issue #29）：
//   prepareQuestion()  鉴权 + 检索 + 拼上下文，**不调模型**，几百毫秒内完成
//   streamAnswer()     把上下文交给模型，边生成边吐增量
// 先跑完 prepare 就能立刻把「引用出处」推给前端，用户不用等模型开口
// 才知道这句话是从哪来的。
//
// 取数口径（关键）：会议进行中，权威转写还在 LiveSegment 里，
// TranscriptTurn 要等 endSession() 才合并过去。所以必须优先读 LiveSegment，
// 否则「刚才说了什么」在线上一问全是空的。
import { prisma } from "@/lib/db/client";
import { audit } from "@/lib/db/scoped";
import { isMockLlm, streamText } from "@/lib/llm";
import {
  buildContext,
  buildQaPrompt,
  extractiveAnswer,
  isMetaSummaryQuery,
  isSpeakerOnlyQuery,
  mergeTimeline,
  parseSpeakerQuery,
  stripSpeakerWords,
  rankMemories,
  rankSegments,
  tidyAnswer,
  validateQuestion,
  type MemoryHit,
  type QaCitation,
  type QaHit,
  type QaSegment,
} from "./qa-core";

export type AskInput = {
  tenantId: string;
  userId: string;
  role: string;
  /** 实时会话 id（会中提问时必填） */
  sessionId?: string;
  /** 会议 id（会议已结束、或只拿到 meetingId 时用它） */
  meetingId?: string;
  question: unknown;
  /** 前端随问题一起送来的最新片段（含正在识别的内容） */
  recentSegments?: unknown;
};

export type AskResult = {
  answer: string;
  citations: QaCitation[];
  /** 引用的往期记忆（issue #28），用于界面单独展示「来自往期会议」 */
  memories: MemoryHit[];
  /** model = 真实模型生成；local = 本地检索兜底 */
  source: "model" | "local";
  /** 本次回答依据了多少段转写 */
  segments: number;
  sessionId: string | null;
  meetingId: string;
  /** 当前会话是否还在进行 */
  live: boolean;
  /** 兜底/降级原因，用于界面上的诚实提示 */
  degradedReason?: string;
  durationMs: number;
};

export class AskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AskError";
  }
}

type LocateResult = {
  meetingId: string;
  sessionId: string | null;
  live: boolean;
};

/** 租户隔离第 3 层：sessionId / meetingId 都必须在本租户内 */
async function locate(input: AskInput): Promise<LocateResult> {
  if (input.sessionId) {
    const live = await prisma.liveSession.findFirst({
      where: { id: input.sessionId, tenantId: input.tenantId },
      select: { id: true, meetingId: true, status: true },
    });
    if (!live) throw new AskError("实时会话不存在或不属于当前租户", 404);
    if (input.meetingId && input.meetingId !== live.meetingId) {
      throw new AskError("会议与实时会话不匹配", 400);
    }
    return {
      meetingId: live.meetingId,
      sessionId: live.id,
      live: live.status === "live" || live.status === "ending",
    };
  }

  if (input.meetingId) {
    const meeting = await prisma.meeting.findFirst({
      where: { id: input.meetingId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!meeting) throw new AskError("会议不存在或不属于当前租户", 404);
    const live = await prisma.liveSession.findFirst({
      where: { meetingId: meeting.id, status: { in: ["live", "ending"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return { meetingId: meeting.id, sessionId: live?.id ?? null, live: Boolean(live) };
  }

  throw new AskError("缺少 sessionId 或 meetingId", 400);
}

/** 前端送来的片段：形状不可信，逐条校验，坏数据直接丢，不让它进模型上下文 */
function sanitizeIncoming(raw: unknown): QaSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: QaSegment[] = [];
  // 上限防止前端一次性灌几万条把上下文撑爆
  for (const item of raw.slice(-120)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    out.push({
      seq: Number.isInteger(r.seq) ? (r.seq as number) : null,
      speakerLabel: typeof r.speakerLabel === "string" ? r.speakerLabel : "speaker_0",
      startMs: Number.isFinite(r.startMs) ? Math.max(0, Math.floor(r.startMs as number)) : 0,
      text: text.slice(0, 2000),
      interim: r.interim === true,
    });
  }
  return out;
}

/**
 * 读取这场会议到目前为止的转写。
 * 会话还在进行 ⇒ 以 LiveSegment 为准；会话已结束 ⇒ 退回 TranscriptTurn（含历史话轮）。
 */
async function loadTimeline(loc: LocateResult): Promise<QaSegment[]> {
  if (loc.sessionId) {
    const segs = await prisma.liveSegment.findMany({
      where: { sessionId: loc.sessionId },
      orderBy: { seq: "asc" },
      select: { seq: true, speakerLabel: true, startMs: true, text: true },
    });
    if (segs.length > 0) return segs.map((s) => ({ ...s, interim: false }));
  }

  const [turnCount, liveCount] = await Promise.all([
    prisma.transcriptTurn.count({ where: { meetingId: loc.meetingId } }),
    prisma.liveSegment.count({ where: { meetingId: loc.meetingId } }),
  ]);

  if (turnCount > 0) {
    const turns = await prisma.transcriptTurn.findMany({
      where: { meetingId: loc.meetingId },
      orderBy: { idx: "asc" },
      select: { idx: true, startMs: true, text: true, participant: { select: { speakerLabel: true } } },
    });
    return turns.map((t) => ({
      seq: t.idx,
      speakerLabel: t.participant?.speakerLabel ?? "speaker_0",
      startMs: t.startMs,
      text: t.text,
      interim: false,
    }));
  }

  if (liveCount > 0) {
    // 没有 sessionId 但库里有实时片段（例如从会议详情页提问），取最近一场会话
    const latest = await prisma.liveSession.findFirst({
      where: { meetingId: loc.meetingId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (latest) {
      const segs = await prisma.liveSegment.findMany({
        where: { sessionId: latest.id },
        orderBy: { seq: "asc" },
        select: { seq: true, speakerLabel: true, startMs: true, text: true },
      });
      return segs.map((s) => ({ ...s, interim: false }));
    }
  }

  return [];
}

/**
 * 可用的往期记忆池（issue #28）。
 *
 * 状态过滤是硬性的，不是"建议"：
 *   已过时（superseded）—— 被新结论取代，再拿出来回答就是误导
 *   有冲突（conflicted）—— 和别的记忆矛盾，不能当依据
 *   已遗忘（deleted）  —— 用户主动要求忘掉
 * 只保留 active / proposed。这和 `recallMemory` 的口径一致（README 里列过这个已知限制，
 * 那条限制讲的是跨会议追问，这里不会再犯）。
 *
 * 为什么把「手动记录」（meetingId 为空）也纳入：
 * 用户在记忆管理页手写的经验和事实，同样是"之前的会议"沉淀下来的知识，
 * 会中提问时没有理由不参考。但它们没有来源会议，界面上会标成「手动记录」。
 */
async function loadMemoryPool(tenantId: string): Promise<(MemoryHit & { importance: number })[]> {
  // 池子设上限：按重要性取，避免租户记忆多了以后每次提问都全量扫表
  const rows = await prisma.memory.findMany({
    where: { tenantId, status: { in: ["active", "proposed"] } },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: Number(process.env.LIVE_QA_MEMORY_POOL ?? 800),
    select: {
      id: true,
      kind: true,
      title: true,
      content: true,
      status: true,
      importance: true,
      meetingId: true,
      updatedAt: true,
      meeting: { select: { title: true } },
    },
  });

  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    title: m.title,
    content: m.content,
    status: m.status,
    meetingId: m.meetingId,
    meetingTitle: m.meeting?.title ?? null,
    when: memoryWhen(m.updatedAt),
    score: 0,
    importance: m.importance,
  }));
}

/**
 * 往期记忆的时间标签。
 *
 * 不能直接用 formatRelative：它对 1 分钟内的内容返回「刚刚」，
 * 但记忆是长期沉淀物，"刚刚"会让人以为是本场会议刚记下的。
 * 这里改为「今天 / N 天前 / N 个月前」这类以天为最小粒度的说法。
 */
function memoryWhen(at: Date): string {
  const ms = Date.now() - at.getTime();
  const day = Math.floor(ms / 86_400_000);
  if (day <= 0) return "今天";
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

/**
 * 一次提问的"准备结果"：鉴权、检索、上下文都已就绪，但还没有调模型。
 *
 * 拆出来的目的见文件头：先把出处推给前端，再开始流式生成。
 */
export type PreparedQuestion = {
  question: string;
  startedAt: number;
  sessionId: string | null;
  meetingId: string;
  live: boolean;
  segments: number;
  hits: QaHit[];
  memories: MemoryHit[];
  citations: QaCitation[];
  /** 本次问法是「概括整场会议」类（issue #31），影响上下文组装与提示词 */
  summarize: boolean;
  /** 问的是某个具体说话人说了什么（issue #32） */
  speaker: { label: string; name: string } | null;
  prompt: string;
  /** 无需调用模型、直接就是最终答案的情况（无内容 / 零命中） */
  terminal?: AskResult;
};

/**
 * 说话人标签 → 显示名（issue #32）。
 *
 * 转写里说话人是 speaker_0 / speaker_1 这类标签，用户只会说「对方」「张伟」。
 * 这里把两者对应起来：
 *   · 实时会话固定 speaker_0 = 我（麦克风）、speaker_1 = 对方（系统播放音）
 *   · 离线/哔哩会话可能有真实人名（用户在详情页手动命名过）
 * 名字是 key，标签是 value。
 */
async function loadSpeakerNames(meetingId: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};

  const parts = await prisma.meetingParticipant.findMany({
    where: { meetingId },
    select: { speakerLabel: true, displayName: true },
  });
  for (const p of parts) {
    // 只收"有意义"的名字：「说话人 A」「未知参会者 1」这种占位名反而会污染匹配
    const name = p.displayName?.trim();
    if (name && !/^(说话人|未知参会者|speaker)/i.test(name) && !map[name]) {
      map[name] = p.speakerLabel;
    }
  }

  // 固定角色名永远可用，优先级最低（真人名会先命中）
  if (!map["对方"]) map["对方"] = "speaker_1";
  if (!map["我"]) map["我"] = "speaker_0";

  return map;
}

/** 准备阶段：鉴权 + 检索 + 拼上下文。不产生模型调用，因此可以在 SSE 里先返回出处。 */
export async function prepareQuestion(input: AskInput): Promise<PreparedQuestion> {
  const startedAt = Date.now();

  const parsed = validateQuestion(input.question);
  if (!parsed.ok) throw new AskError(parsed.error, 400);
  const question = parsed.question;

  const loc = await locate(input);
  const [stored, memoryPool] = await Promise.all([
    loadTimeline(loc),
    // 记忆与会话状态无关，可与会中转写并行取
    loadMemoryPool(input.tenantId),
  ]);
  const timeline = mergeTimeline(stored, sanitizeIncoming(input.recentSegments));

  // 概括类问法（「总结一下会议」）与找话题是两种任务：
  // 前者要全场内容 + 概括指令，后者才需要按相关度挑片段。
  const summarize = isMetaSummaryQuery(question);

  // 「谁说的」是过滤条件，不是检索内容（issue #32）。
  // 先解析出说话人，再在这个人的发言范围内回答；剩下的部分才当作话题。
  const names = await loadSpeakerNames(loc.meetingId);
  const speaker = parseSpeakerQuery(question, names);
  const speakerOnly = speaker ? isSpeakerOnlyQuery(question, speaker, names) : false;
  // 无论有没有追加话题，检索都要去掉"谁说的"这层壳：
  // 否则「对方说了什么」会拿人物词去搜原文（必然零命中），
  // 「对方说联调怎么安排」也会被"对方"这两个字干扰。
  //
  // 注意：剥离后为空是**正常结果**（问法里除了"谁"就没有话题了），
  // 这时要传空串下去——rankSegments 会按"该说话人的全部发言"返回，
  // 不能 `|| question` 兜回原句，那等于把人物词又塞回检索。
  const stripped = speaker ? stripSpeakerWords(question, speaker, names) : "";
  const topicQuery = speaker ? stripped : question;
  void speakerOnly;

  const hits = rankSegments(timeline, topicQuery, summarize ? 10 : 6, { speaker });
  const memories = speaker ? [] : rankMemories(memoryPool, question, 4);
  const context = buildContext(timeline, hits, {}, memories, { summarize, speaker });

  const citations: QaCitation[] = hits.map((h) => ({
    seq: h.seq,
    speakerLabel: h.speakerLabel,
    startMs: h.startMs,
    text: h.text,
    interim: Boolean(h.interim),
  }));

  const base = {
    memories,
    citations,
    sessionId: loc.sessionId,
    meetingId: loc.meetingId,
    live: loc.live,
    segments: timeline.length,
  };

  const prepared: PreparedQuestion = {
    question,
    startedAt,
    sessionId: loc.sessionId,
    meetingId: loc.meetingId,
    live: loc.live,
    segments: timeline.length,
    hits,
    memories,
    citations,
    summarize,
    speaker,
    prompt: buildQaPrompt(question, context, {
      live: loc.live,
      count: timeline.length,
      memoryCount: memories.length,
      summarize,
      speaker,
    }),
  };

  // 1. 既没有转写、也没有可用的往期记忆：直接说清楚，不浪费一次模型调用
  if (timeline.length === 0 && memories.length === 0) {
    const { answer, citations: none } = extractiveAnswer(question, [], 0);
    prepared.citations = none;
    prepared.terminal = {
      ...base,
      citations: none,
      answer,
      source: "local",
      degradedReason: "这场会议还没有转写内容",
      durationMs: Date.now() - startedAt,
    };
    return prepared;
  }

  // 2. 两边都零命中：模型也没有依据，不能给它机会编
  //
  //    两种例外，本质相同——"命不中词"不等于"没有可用的材料"：
  //    a. 概括类问法（issue #31）：用户没指定话题，当然命中不了词，但整场转写就是要概括的对象
  //    b. 说话人问法（issue #32）：已经限定到某个人，材料就是他的全部发言。
  //       「对方提到的风险」若他确实没提风险，应该让模型看着他的原话说"对方没提到风险"，
  //       而不是甩一句"没有找到相关内容"——后者会让人以为整场会都没内容
  if (!summarize && !speaker && hits.length === 0 && memories.length === 0) {
    const { answer, citations: none } = extractiveAnswer(question, [], timeline.length);
    prepared.citations = none;
    prepared.terminal = {
      ...base,
      citations: none,
      answer,
      source: "local",
      degradedReason: "转写和往期记忆里都没有相关内容",
      durationMs: Date.now() - startedAt,
    };
    return prepared;
  }

  return prepared;
}

export type AnswerEvent =
  | { type: "delta"; text: string }
  | { type: "final"; result: AskResult }
  | { type: "error"; message: string };

/**
 * 生成阶段：把准备好的上下文交给模型，逐块吐出。
 *
 * 失败处理的原则是「宁可降级，不要报错」：
 * 模型超时/报错/返回空时，改用本地检索兜底并把结果作为 final 吐出。
 * 会中问答的价值就是随时有回应，让用户对着错误提示干等没有意义。
 */
export async function* streamAnswer(
  prepared: PreparedQuestion,
  ctx: { tenantId: string; userId: string },
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<AnswerEvent> {
  const startedAt = prepared.startedAt;

  // 准备阶段就已确定不需要模型
  if (prepared.terminal) {
    await audit(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      "live.qa.asked",
      { sessionId: prepared.sessionId, question: prepared.question, source: "local", terminal: true },
      prepared.meetingId,
    );
    yield { type: "final", result: prepared.terminal };
    return;
  }

  const base = {
    memories: prepared.memories,
    citations: prepared.citations,
    sessionId: prepared.sessionId,
    meetingId: prepared.meetingId,
    live: prepared.live,
    segments: prepared.segments,
  };

  // mock 模式：没有真实模型可用，直接本地检索
  if (isMockLlm()) {
    const { answer, citations } = extractiveAnswer(prepared.question, prepared.hits, prepared.segments, prepared.memories);
    await audit(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      "live.qa.asked",
      { sessionId: prepared.sessionId, question: prepared.question, source: "local" },
      prepared.meetingId,
    );
    // 本地答案一次性给出，但依然走 delta，前端不需要区分两种协议
    yield { type: "delta", text: answer };
    yield {
      type: "final",
      result: {
        ...base,
        citations,
        answer,
        source: "local",
        degradedReason: "当前是演示模式（MOCK_LLM=1），使用本地检索回答",
        durationMs: Date.now() - startedAt,
      },
    };
    return;
  }

  // 真实模型：流式输出
  let acc = "";
  let failure: string | null = null;

  try {
    for await (const chunk of streamText(prepared.prompt, {
      signal: opts.signal,
      timeoutMs: Number(process.env.LIVE_QA_TIMEOUT_MS ?? 40_000),
      firstTokenMs: Number(process.env.LIVE_QA_FIRST_TOKEN_MS ?? 15_000),
    })) {
      if (chunk.type === "delta") {
        acc += chunk.text;
        yield { type: "delta", text: chunk.text };
        continue;
      }
      if (chunk.type === "error") failure = chunk.message;
      // done 时 acc 已经是全文，不需要再处理
      break;
    }
  } catch (e) {
    failure = (e as Error).message;
  }

  // 用户主动取消：不写审计、不兜底，直接结束（否则取消也会留下一条"模型失败"记录）
  if (opts.signal?.aborted) {
    yield { type: "error", message: "已取消" };
    return;
  }

  const answer = tidyAnswer(acc);
  if (answer && !failure) {
    await audit(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      "live.qa.asked",
      {
        sessionId: prepared.sessionId,
        question: prepared.question,
        source: "model",
        streamed: true,
        segments: prepared.segments,
        memories: prepared.memories.length,
      },
      prepared.meetingId,
    );
    yield {
      type: "final",
      result: {
        ...base,
        answer,
        source: "model",
        durationMs: Date.now() - startedAt,
      },
    };
    return;
  }

  // 到这里说明模型没给出可用答案：改用本地检索
  console.warn(
    `[live-qa] 模型输出不可用，退回本地检索：${failure ?? (answer ? "空内容" : "未知")}`,
  );
  const { answer: local, citations } = extractiveAnswer(
    prepared.question,
    prepared.hits,
    prepared.segments,
    prepared.memories,
  );
  await audit(
    { tenantId: ctx.tenantId, userId: ctx.userId },
    "live.qa.asked",
    { sessionId: prepared.sessionId, question: prepared.question, source: "local", reason: failure ?? "空内容" },
    prepared.meetingId,
  );
  yield {
    type: "final",
    result: {
      ...base,
      citations,
      answer: local,
      source: "local",
      degradedReason: `模型暂时不可用（${failure ?? "返回空内容"}），已用本地检索回答`,
      durationMs: Date.now() - startedAt,
    },
  };
}

/**
 * 非流式入口：内部就是「准备 + 跑完整个流」。
 * 保留它是因为测试、诊断脚本和将来的其它调用方只需要一个 Promise。
 */
export async function answerLiveQuestion(
  input: AskInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AskResult> {
  const prepared = await prepareQuestion(input);
  const ctx = { tenantId: input.tenantId, userId: input.userId };
  let result: AskResult | null = null;
  let error: string | null = null;
  for await (const ev of streamAnswer(prepared, ctx, opts)) {
    if (ev.type === "final") result = ev.result;
    else if (ev.type === "error") error = ev.message;
  }
  if (result) return result;
  throw new AskError(error ?? "生成回答失败", 500);
}

function shortError(e: unknown): string {
  const msg = (e as Error)?.message ?? "未知错误";
  return msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
}