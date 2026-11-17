// 会中提问（issue #27）测试
//
// 分两层：
//   A. 纯函数层（findings/timeline/兜底/上下文预算）—— 直接 import lib/live/qa-core.ts
//   B. HTTP 层（鉴权、状态码、租户隔离、端到端问答）—— 需要服务已启动
//
// 用法：
//   pnpm test:live-qa          # 跑 A+B，服务未启动时 B 自动跳过
//   BASE=http://127.0.0.1:3210 pnpm test:live-qa
//
// 说明：为了让 A 部分在 tsx 下能直接跑，这里用 tsx 执行（见 package.json）。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3210";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

// ============================================================ A. 纯函数层

// tsx 在本项目里按 CJS 转译（package.json 没有 "type": "module"），
// 所以不能写顶层 await；用 require 加载被测模块，并显式标注类型。
const core = require(path.join(ROOT, "lib/live/qa-core.ts")) as typeof import("../lib/live/qa-core");

function sampleTimeline() {
  // 一段模拟会议：先讨论排期，再定责任人，最后提到风险
  const lines = [
    ["speaker_0", 0, "我们先过一下这周的排期。"],
    ["speaker_1", 8_000, "后端接口大概周三能给到，前端要等接口。"],
    ["speaker_0", 20_000, "那就定下来，前端先做静态页面，接口周三到位。"],
    ["speaker_1", 35_000, "张伟你负责把联调环境搭好，最晚周四。"],
    ["speaker_0", 48_000, "有个风险，如果周三接口给不出来，整个联调会延期。"],
    ["speaker_1", 61_000, "测试用例我来跟进，下周一前补齐。"],
    ["speaker_0", 75_000, "好，今天就到这里。"],
  ];
  return lines.map(([speakerLabel, startMs, text], i) => ({
    seq: i,
    speakerLabel,
    startMs,
    text,
    interim: false,
  }));
}

async function testCore() {
  console.log("\n== A1. 问句分词 ==");
  {
    const t = core.tokenizeQuery("谁负责联调环境？");
    ok("抽出实体词 联调/环境", t.some((x) => x.includes("联调")) || t.some((x) => x.includes("环境")), t.slice(0, 8).join("/"));

    const t2 = core.tokenizeQuery("刚才说了什么？");
    ok(
      "纯虚问句只剩同义词白名单，没有「什么」「刚才」",
      !t2.includes("什么") && !t2.includes("刚才"),
      t2.join("/"),
    );
    ok("纯虚问句的无实体词判定生效", t2.filter((x) => !core.isStopword(x)).length === 0, t2.join("/"));

    const t3 = core.tokenizeQuery("deadline 是什么时候");
    ok("英文词整体保留", t3.includes("deadline"), t3.join("/"));
    ok("时间类问句补上同义词", t3.some((x) => x.includes("周") || x.includes("截止")), t3.join("/"));

    ok("空问句返回空词表", core.tokenizeQuery("   ").length === 0);
  }

  console.log("\n== A2. 检索排序 ==");
  const timeline = sampleTimeline();
  {
    const hits = core.rankSegments(timeline, "上周排期定了什么", 5);
    ok("命中排期相关内容", hits.length > 0, hits.map((h) => h.text.slice(0, 12)).join(" | "));
    ok("最相关的是「排期」或「定下来」那句", /排期|定下来|定/.test(hits[0]?.text ?? ""), hits[0]?.text);

    const who = core.rankSegments(timeline, "联调环境谁负责", 3);
    ok("责任人问题命中张伟那句", /张伟/.test(who[0]?.text ?? ""), who[0]?.text);

    const risk = core.rankSegments(timeline, "有什么风险", 3);
    ok("风险问题命中风险那句", /风险|延期/.test(risk[0]?.text ?? ""), risk[0]?.text);

    const nothing = core.rankSegments(timeline, "量子计算什么时候上线", 5);
    ok("无关问题检索不到内容（不硬凑）", nothing.length === 0, `${nothing.length} 条`);

    const vague = core.rankSegments(timeline, "刚才说了什么", 3);
    ok("无实体词时返回最近的片段", vague.length === 3 && vague[0].startMs >= vague[2].startMs, vague.map((v) => v.startMs).join(","));
  }

  console.log("\n== A3. 候选合并 ==");
  {
    const stored = sampleTimeline().slice(0, 3);
    const incoming = [
      // 与库里 seq=0 重复的内容（前端更旧/相同的快照）：不能覆盖、不能重复
      { seq: 0, speakerLabel: "speaker_0", startMs: 0, text: "我们先过一下这周的排期。", interim: false },
      // 库里还没有的新定稿
      { seq: 3, speakerLabel: "speaker_1", startMs: 35_000, text: "张伟你负责把联调环境搭好。", interim: false },
      // 正在识别、尚未落库
      { seq: null, speakerLabel: "speaker_0", startMs: 48_000, text: "有个风险，接口给不出来就延期", interim: true },
    ];
    const merged = core.mergeTimeline(stored, incoming);
    ok("库里不存在的新片段被补上", merged.some((s) => s.seq === 3));
    ok("相同 seq 不重复", merged.filter((s) => s.seq === 0).length === 1);
    ok("interim 片段进入时间线且标记为未定稿", merged.some((s) => s.interim === true && s.seq === null));
    ok("定稿内容以库为准，不会被前端覆盖", merged.find((s) => s.seq === 0)?.interim === false);
    ok("按时间排序", merged.every((s, i) => i === 0 || s.startMs >= merged[i - 1].startMs));

    const dupInterim = core.mergeTimeline(stored, [
      { seq: null, speakerLabel: "speaker_0", startMs: 10, text: "我们先过一下这周的排期", interim: true },
    ]);
    ok("与定稿内容重复的 interim 被丢弃", dupInterim.length === stored.length);
  }

  console.log("\n== A4. 上下文与预算 ==");
  {
    const hits = core.rankSegments(timeline, "风险", 3);
    const ctx = core.buildContext(timeline, hits);
    ok("上下文包含命中片段", ctx.includes("风险"));
    const stamps = [...ctx.matchAll(/^\[(\d{2}:\d{2})\]/gm)].map((m) => m[1]);
    ok("上下文按时间顺序", stamps.length > 0 && stamps.join() === [...stamps].sort().join(), stamps.join(","));
    ok("每行带时间与说话人", /\[\d{2}:\d{2}\].*(我|对方)：/.test(ctx));

    const long = Array.from({ length: 400 }, (_, i) => ({
      seq: i,
      speakerLabel: i % 2 ? "speaker_1" : "speaker_0",
      startMs: i * 5000,
      text: `这是第${i}句话，用来测试上下文预算裁剪是否正确，内容本身没有意义但是要够长。`,
      interim: false,
    }));
    const longCtx = core.buildContext(long, core.rankSegments(long, "预算", 5), { maxChars: 1200, headRecent: 10 });
    ok("超出预算会裁剪", longCtx.length <= 1200, `${longCtx.length} 字`);
    ok("裁剪后保留最新的内容", longCtx.includes("第399句"), "末尾片段在");
    ok("空时间线返回空上下文", core.buildContext([], []) === "");
  }

  console.log("\n== A5. 本地兜底回答 ==");
  {
    const none = core.extractiveAnswer("今天吃什么", [], 0);
    ok("无转写时说明还没内容", /还没有转写/.test(none.answer));
    ok("无转写时不编造引用", none.citations.length === 0);

    const noHit = core.extractiveAnswer("量子计算什么时候上线", [], 12);
    ok("查不到时明确说没找到", /没有找到/.test(noHit.answer), noHit.answer.slice(0, 40));

    const hits = core.rankSegments(timeline, "风险", 3);
    const ans = core.extractiveAnswer("有什么风险", hits, timeline.length);
    ok("兜底回答列出原话", ans.citations.length > 0 && ans.answer.includes("·"));
    ok("兜底回答不虚构结论", !/可以确认|结论已经/.test(ans.answer));
    ok("兜底引用带说话人与时间", ans.citations.every((c) => typeof c.startMs === "number" && c.speakerLabel));
  }

  console.log("\n== A6. 提示词与输入校验 ==");
  {
    const prompt = core.buildQaPrompt("刚才说了什么？", "[00:35] #3 对方：张伟负责联调", { live: true, count: 6 });
    ok("提示词包含问题", prompt.includes("刚才说了什么？"));
    ok("提示词包含转写", prompt.includes("张伟负责联调"));
    ok("提示词要求不编造", /绝不编造|不要编造|没有提到/.test(prompt));
    ok("提示词标注会议状态", prompt.includes("正在进行中"));

    ok("空问题被拒", core.validateQuestion("  ").ok === false);
    ok("非字符串被拒", core.validateQuestion(123).ok === false);
    ok("超长问题被拒", core.validateQuestion("问".repeat(core.MAX_QUESTION_CHARS + 1)).ok === false);
    ok("正常问题通过并 trim", core.validateQuestion("  谁负责？  ").question === "谁负责？");

    ok("清洗模型客套话", core.tidyAnswer("好的，会上定了周三交付。") === "会上定了周三交付。");
    ok("压缩多余空行", !core.tidyAnswer("A\n\n\n\nB").includes("\n\n\n"));
  }

  console.log("\n== A7. 往期记忆检索（issue #28）==");
  {
    const mem = (over = {}) => ({
      id: `m${Math.random().toString(36).slice(2, 8)}`,
      kind: "decision",
      title: null,
      content: "",
      status: "active",
      meetingId: "mtg-1",
      meetingTitle: "上周产品评审",
      when: "3 天前",
      score: 0,
      importance: 0.8,
      ...over,
    });
    const pool = [
      mem({ content: "联调环境由张伟负责搭建，最晚周四。" }),
      mem({ content: "上线排期定在月底，实时转写往后放一个迭代。" }),
      mem({ kind: "open_loop", title: "风险", content: "接口文档未就绪会影响前端并行开工。" }),
      mem({ kind: "fact", content: "客户侧对接人是王经理。" }),
    ];

    const hit = core.rankMemories(pool, "联调环境谁负责", 4);
    ok("能召回相关记忆", hit.length > 0, hit.map((h) => h.content.slice(0, 14)).join(" | "));
    ok("最相关的是联调那条", /联调/.test(hit[0]?.content ?? ""), hit[0]?.content);

    const none = core.rankMemories(pool, "量子计算什么时候上线", 4);
    ok("无关问题不召回记忆（不硬凑）", none.length === 0, `${none.length} 条`);

    const vague = core.rankMemories(pool, "刚才说了什么", 4);
    ok("问「刚才」时不召回往期记忆", vague.length === 0, `${vague.length} 条`);

    ok("空池子返回空", core.rankMemories([], "联调谁负责", 4).length === 0);
    ok("条数上限生效", core.rankMemories(
      [
        mem({ content: "周会定了排期在月底" }),
        mem({ content: "周会确认排期是月底" }),
        mem({ content: "排期月底再确认一次" }),
        mem({ content: "排期已改为下月初" }),
        mem({ content: "排期需要客户确认" }),
      ],
      "排期", 2,
    ).length <= 2);

    const dupPool = [
      mem({ content: "先上线离线转写能力" }),
      mem({ content: "先上线离线转写能力。" }),
    ];
    const dedup = core.rankMemories(dupPool, "上线离线转写", 4);
    ok("重复记忆只保留一条", dedup.length === 1, `${dedup.length} 条`);

    // 上下文为记忆单独成段，且明确标注"不是本场发言"
    const ctx = core.buildContext(timeline, core.rankSegments(timeline, "风险", 3), {}, hit);
    ok("上下文里记忆单独成段", ctx.includes("往期会议记忆"));
    ok("上下文标注记忆不属于本场", /不是本场会议的发言/.test(ctx));
    ok("上下文同时包含本场转写", ctx.includes("本场会议转写"));
    ok("记忆段带来源会议与时间", ctx.includes("上周产品评审") && ctx.includes("3 天前"));

    const memOnly = core.buildContext([], [], {}, hit);
    ok("只有记忆时也生成上下文", memOnly.includes("往期会议记忆") && !memOnly.includes("本场会议转写"));

    // 提示词必须包含记忆归属与冲突处理规则
    const p = core.buildQaPrompt("之前联调谁负责？", ctx, { live: true, count: 7, memoryCount: 1 });
    ok("提示词包含记忆使用规则", p.includes(core.MEMORY_RULES));
    ok("规则要求说明归属", /之前|上次/.test(p) && p.includes("更早的会议"));
    ok("规则要求冲突以本场为准", /冲突/.test(p) && /以本场为准/.test(p));
    const p2 = core.buildQaPrompt("刚才说了什么？", "[00:01] 我：你好", { live: true, count: 1 });
    ok("没有记忆时不注入记忆规则", !p2.includes(core.MEMORY_RULES));

    // 兜底回答：记忆和转写分开展示
    const fallback = core.extractiveAnswer("联调谁负责", core.rankSegments(timeline, "联调", 2), 7, hit);
    ok("兜底回答含本场内容", fallback.answer.includes("本次会议"));
    ok("兜底回答含往期记忆且分开标注", fallback.answer.includes("往期会议里也有相关记录"));
    ok("兜底只把本场转写作为引用", fallback.citations.length <= 2);

    const memFallback = core.extractiveAnswer("联调环境谁负责", [], 0, hit);
    ok("只有记忆时也能兜底回答", memFallback.answer.includes("往期会议") && memFallback.citations.length === 0);
  }

  console.log("\n== A8. 概括类问法（issue #31）==");
  {
    // 回归：test01 那场会里用户问「总结一下会议」，曾经被回答「没有找到相关内容」
    const meta = ["总结一下会议", "会上讲了什么", "帮我概括一下", "这场会主要说了啥", "复盘一下"];
    for (const q of meta) ok(`识别为概括类：${q}`, core.isMetaSummaryQuery(q) === true);

    // 「刚才说了什么」要的是时间窗，不能被当成概括
    ok("「刚才说了什么」不算概括类", core.isMetaSummaryQuery("刚才说了什么") === false);
    ok("「现在说到哪了」不算概括类", core.isMetaSummaryQuery("现在说到哪了") === false);
    ok("「谁负责联调」不算概括类", core.isMetaSummaryQuery("谁负责联调") === false);

    const q = "总结一下会议";
    const hits = core.rankSegments(timeline, q, 10);
    ok("概括类问法不会零命中（不能回答没找到）", hits.length > 0, `${hits.length} 段`);
    ok("概括类取的是全场分布而不是最近几条", new Set(hits.map((h) => h.seq)).size === hits.length);

    // 「总结」不该被当成实体词去原文里找：纯概括问法不应产生任何可检索词
    const terms = core.tokenizeQuery(q).filter((t) => !core.isStopword(t) && !core.isSummaryWord(t));
    ok("纯概括问法没有可检索的实体词", terms.length === 0, terms.join("/"));
    ok("概括时上下文含全场内容", core.buildContext(timeline, hits, {}, [], { summarize: true }).includes("本场会议转写"));

    // 带具体话题的概括仍应聚焦该话题
    const scoped = core.rankSegments(timeline, "总结一下联调环境", 5);
    ok("「总结一下联调环境」按话题检索", scoped.length > 0 && /联调/.test(scoped[0]?.text ?? ""), scoped[0]?.text);

    const prompt = core.buildQaPrompt(q, "ctx", { live: false, count: 9, summarize: true });
    ok("提示词含概括指令", prompt.includes(core.SUMMARY_RULES));
    ok("指令要求材料本身就是概括对象", /材料就是你想概括的对象/.test(prompt));
    const plain = core.buildQaPrompt("谁负责", "ctx", { live: false, count: 9 });
    ok("非概括问法不含概括指令", !plain.includes(core.SUMMARY_RULES));

    // 均匀抽样：首尾都必须在
    const long = Array.from({ length: 100 }, (_, i) => ({
      seq: i, speakerLabel: "speaker_0", startMs: i * 1000, text: `第${i}句`, interim: false,
    }));
    const sampled = core.sampleTermsForSummary(long, 8);
    ok("抽样包含开头", sampled[0]?.seq === 0);
    ok("抽样包含结尾", sampled[sampled.length - 1]?.seq === 99);
    ok("抽样数量受控", sampled.length === 8, String(sampled.length));
    ok("短会议全部返回", core.sampleTermsForSummary(long.slice(0, 5), 8).length === 5);
  }

  console.log("\n== A9. 说话人问法（issue #32）==");
  {
    // 回归：用户问「对方说了什么」「我说了什么」「张伟说了什么」都答"找不到"
    const names = { 对方: "speaker_1", 我: "speaker_0", 张伟: "speaker_1", 李娜: "speaker_0" };
    const tl = [
      { seq: 0, speakerLabel: "speaker_0", startMs: 0, text: "今天对一下上线排期。", interim: false },
      { seq: 1, speakerLabel: "speaker_1", startMs: 6000, text: "张伟你负责把联调环境搭好，最晚周四。", interim: false },
      { seq: 3, speakerLabel: "speaker_1", startMs: 23000, text: "测试用例我来跟进，下周一前补齐。", interim: false },
      { seq: 4, speakerLabel: "speaker_0", startMs: 30000, text: "我这里有个风险，接口给不出来会延期。", interim: false },
      { seq: 5, speakerLabel: "speaker_1", startMs: 40000, text: "提一个风险，声纹库缺失会导致识别不准。", interim: false },
    ];
    const run = (q: string) => {
      const sp = core.parseSpeakerQuery(q, names);
      const topic = sp ? core.stripSpeakerWords(q, sp, names) : q;
      return { sp, topic, hits: core.rankSegments(tl, topic, 8, { speaker: sp }).map((h) => h.seq) };
    };

    ok("「对方说了什么」识别到说话人", run("对方说了什么").sp?.label === "speaker_1");
    ok("「我说了什么」识别到说话人", run("我说了什么").sp?.label === "speaker_0");
    ok("「张伟说了什么」按人名识别", run("张伟说了什么").sp?.label === "speaker_1");
    ok("「李娜说了什么」按人名识别", run("李娜说了什么").sp?.label === "speaker_0");

    ok("「对方说了什么」只返回对方的发言", JSON.stringify(run("对方说了什么").hits) === "[1,3,5]", JSON.stringify(run("对方说了什么").hits));
    ok("「我说了什么」只返回我的发言", JSON.stringify(run("我说了什么").hits) === "[0,4]", JSON.stringify(run("我说了什么").hits));
    ok("「对方说了什么」按时间顺序而非倒序", JSON.stringify(run("对方说了什么").hits) === "[1,3,5]");
    ok("「对方刚才说了什么」不残留时间词", run("对方刚才说了什么").topic === "", `"${run("对方刚才说了什么").topic}"`);

    // 带话题的说话人问法：只在那个人的话里找
    ok("「对方说联调怎么安排」只命中联调那句", JSON.stringify(run("对方说联调怎么安排").hits) === "[1]", JSON.stringify(run("对方说联调怎么安排").hits));
    ok("「对方提到了风险」只命中对方的风险", JSON.stringify(run("对方提到了风险").hits) === "[5]", JSON.stringify(run("对方提到了风险").hits));
    ok("「我说风险」只命中我的风险", JSON.stringify(run("我说风险").hits) === "[4]");

    // 不能误伤普通问法
    ok("「我觉得这个需求有问题」不判为说话人问法", core.parseSpeakerQuery("我觉得这个需求有问题", names) === null);
    ok("「对方的需求是什么」不判为说话人问法（问的是话题）", core.parseSpeakerQuery("对方的需求是什么", names) === null);
    ok("「刚才说了什么」不判为说话人问法", core.parseSpeakerQuery("刚才说了什么", names) === null);

    // 上下文必须只含该说话人的话，否则模型会给出错误归属
    const sp = core.parseSpeakerQuery("对方说了什么", names)!;
    const hits = core.rankSegments(tl, "", 8, { speaker: sp });
    const ctx = core.buildContext(tl, hits, {}, [], { speaker: { label: "speaker_1", name: "对方" } });
    ok("上下文只含该说话人的发言", !ctx.includes("上线排期") && !ctx.includes("接口给不出来"), "");
    ok("上下文标注了说话人范围", ctx.includes("只含「对方」的发言"));

    // 这个人没发过言时，要说明是这个原因，而不是"整场会没内容"
    const emptyCtx = core.extractiveAnswer("对方说了什么", [], 10, [], { label: "speaker_1", name: "对方" });
    ok("说话人无发言时给出针对性说明", /还没有「对方」的发言记录/.test(emptyCtx.answer), emptyCtx.answer.slice(0, 40));

    const prompt = core.buildQaPrompt("对方说了什么", ctx, {
      live: true, count: 5, speaker: { label: "speaker_1", name: "对方" },
    });
    ok("提示词声明了说话人限制", /「对方」说过的话/.test(prompt));
  }
}

// ============================================================ B. HTTP 层

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "demo1234" }),
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

async function testHttp() {
  const up = await serverUp();
  if (!up) {
    console.log(`\n== B. HTTP 层：服务未启动（${BASE}），跳过 ==`);
    return;
  }

  console.log("\n== B1. 鉴权与状态码 ==");
  const anon = await fetch(`${BASE}/api/live/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meetingId: "x", question: "说了什么" }),
  });
  ok("未登录返回 401", anon.status === 401, String(anon.status));

  const cookie = await login("owner@demo.dev");
  const h = { cookie, "content-type": "application/json" };

  const badJson = await fetch(`${BASE}/api/live/ask`, { method: "POST", headers: h, body: "not-json" });
  ok("非法 JSON 返回 400", badJson.status === 400, String(badJson.status));

  const empty = await fetch(`${BASE}/api/live/ask`, {
    method: "POST", headers: h, body: JSON.stringify({ meetingId: "x", question: "   " }),
  });
  ok("空问题返回 400", empty.status === 400, String(empty.status));

  const noTarget = await fetch(`${BASE}/api/live/ask`, {
    method: "POST", headers: h, body: JSON.stringify({ question: "说了什么" }),
  });
  ok("缺少 sessionId/meetingId 返回 400", noTarget.status === 400, String(noTarget.status));

  const notFound = await fetch(`${BASE}/api/live/ask`, {
    method: "POST", headers: h, body: JSON.stringify({ meetingId: "does-not-exist", question: "说了什么" }),
  });
  ok("不存在的会议返回 404", notFound.status === 404, String(notFound.status));

  const tooLong = await fetch(`${BASE}/api/live/ask`, {
    method: "POST", headers: h, body: JSON.stringify({ meetingId: "does-not-exist", question: "问".repeat(600) }),
  });
  ok("超长问题返回 400", tooLong.status === 400, String(tooLong.status));

  console.log("\n== B2. 权限 ==");
  const viewerCookie = await login("viewer@demo.dev");
  const asViewer = await fetch(`${BASE}/api/live/ask`, {
    method: "POST",
    headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify({ meetingId: "x", question: "说了什么" }),
  });
  ok("viewer 提问返回 403", asViewer.status === 403, String(asViewer.status));

  console.log("\n== B3. 真实一问一答 ==");
  // 项目没有"会议列表"API，所以这里现场开一场实时会话，
  // 并直接向库内写入两条真实话轮，再通过 API 提问 —— 这是最接近真实使用的路径。
  const created = await fetch(`${BASE}/api/live`, {
    method: "POST", headers: h, body: JSON.stringify({ meetingId: `qa-test-${Date.now()}`, title: "QA 测试会议" }),
  });
  const createdBody = await created.json().catch(() => ({}));
  ok("可以开启实时会话", created.ok && Boolean(createdBody.sessionId), String(created.status));

  const { sessionId: qaSessionId, meetingId: qaMeetingId } = createdBody;
  if (qaSessionId) {
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    try {
      await prisma.liveSegment.createMany({
        data: [
          { sessionId: qaSessionId, meetingId: qaMeetingId, seq: 0, speakerLabel: "speaker_0", startMs: 0, endMs: 4000, text: "今天主要对一下上线排期。" },
          { sessionId: qaSessionId, meetingId: qaMeetingId, seq: 1, speakerLabel: "speaker_1", startMs: 5000, endMs: 9000, text: "张伟你负责把联调环境搭好，最晚周四。" },
          { sessionId: qaSessionId, meetingId: qaMeetingId, seq: 2, speakerLabel: "speaker_0", startMs: 12000, endMs: 16000, text: "有个风险，接口给不出来整体会延期。" },
        ],
      });

      const ask = async (question, extra = {}) => {
        const r = await fetch(`${BASE}/api/live/ask`, {
          method: "POST", headers: h, body: JSON.stringify({ sessionId: qaSessionId, question, ...extra }),
        });
        const text = await r.text().catch(() => "");
        // 流式接口返回 SSE：把事件流汇总成 final，断言方式与一次性响应保持一致
        if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
          const events = text
            .split("\n\n")
            .filter((f) => f.startsWith("data:"))
            .map((f) => {
              try {
                return JSON.parse(f.slice(5).trim());
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          const meta = events.find((e) => e.type === "meta");
          const final = events.find((e) => e.type === "final");
          const errored = events.find((e) => e.type === "error");
          return {
            status: r.status,
            streamed: true,
            deltas: events.filter((e) => e.type === "delta").length,
            meta,
            body: final?.result ?? { error: errored?.message ?? "没有收到 final" },
          };
        }
        try {
          return { status: r.status, streamed: false, body: JSON.parse(text) };
        } catch {
          return { status: r.status, streamed: false, body: {} };
        }
      };

      const r1 = await ask("刚才说了什么？");
      ok("会中提问返回 200", r1.status === 200, String(r1.status));
      ok("响应是流式事件流", r1.streamed === true, String(r1.streamed));
      ok("先收到 meta（出处）", Boolean(r1.meta), `citations=${r1.meta?.citations?.length ?? 0}`);
      ok("meta 在 final 之前给出依据", (r1.meta?.citations?.length ?? 0) > 0, String(r1.meta?.citations?.length));
      ok("返回 answer", typeof r1.body.answer === "string" && r1.body.answer.length > 0, (r1.body.answer ?? "").slice(0, 50));
      ok("模型回答是分块流式返回的", (r1.deltas ?? 0) > 1, `${r1.deltas ?? 0} 块`);
      ok("返回 source 标记", ["model", "local"].includes(r1.body.source), r1.body.source);
      ok("读到了库里的实时转写", (r1.body.segments ?? 0) === 3, `${r1.body.segments} 段`);
      ok("标记为进行中", r1.body.live === true, String(r1.body.live));

      const r2 = await ask("谁负责联调环境？");
      ok("责任人问题能答", /张伟|联调/.test(r2.body.answer ?? ""), (r2.body.answer ?? "").slice(0, 60));

      const r3 = await ask("会上有没有讨论火星殖民计划？");
      ok(
        "无关问题明确说没找到（不编造）",
        // 模型措辞不固定：没有提到 / 没提到 / 没有找到 / 没找到 都算如实回答
        /没(有)?(找)?(到|提到)/.test(r3.body.answer ?? ""),
        (r3.body.answer ?? "").slice(0, 50),
      );

      const r4 = await ask("谁负责测试报告？", {
        recentSegments: [{ speakerLabel: "speaker_0", startMs: 20000, text: "李娜负责把测试报告在周五前交上来", interim: true }],
      });
      ok("接受前端送来的识别中片段", r4.status === 200, String(r4.status));
      ok("识别中片段能作为依据", /李娜|测试报告/.test(r4.body.answer ?? ""), (r4.body.answer ?? "").slice(0, 60));

      // ---------------- 往期会议记忆（issue #28）----------------
      // 本场会议里没有"灰度发布"这件事，只有在往期记忆里才有。
      // 问它应当能答出来，并且必须说明来自往期、而不是本场。
      const owner = await prisma.user.findUnique({ where: { email: "owner@demo.dev" } });
      const past = await prisma.memory.create({
        data: {
          tenantId: owner.tenantId,
          kind: "decision",
          status: "active",
          title: null,
          content: "灰度发布按城市分批推进，先上杭州和成都。",
          importance: 0.85,
          source: "agent_runtime",
        },
      });
      const stale = await prisma.memory.create({
        data: {
          tenantId: owner.tenantId,
          kind: "decision",
          status: "superseded",
          title: null,
          content: "灰度发布先上北京，再推全国。",
          importance: 0.85,
          source: "agent_runtime",
        },
      });

      try {
        const r5 = await ask("灰度发布是怎么安排的？");
        ok("能答出往期记忆里的内容", /杭州|成都|灰度/.test(r5.body.answer ?? ""), (r5.body.answer ?? "").slice(0, 70));
        ok("接口回传了引用的记忆", Array.isArray(r5.body.memories) && r5.body.memories.length > 0, `${r5.body.memories?.length ?? 0} 条`);
        ok("记忆带来源与时间", Boolean(r5.body.memories?.[0]?.when), JSON.stringify(r5.body.memories?.[0]?.content ?? "").slice(0, 40));

        // 已过时的记忆不能被当成答案（否则就是拿旧结论误导用户）
        ok(
          "已过时记忆不作为依据",
          !(r5.body.memories ?? []).some((m) => m.id === stale.id),
          "superseded 已排除",
        );
        ok(
          "模型说明了这是往期结论",
          /之前|上次|往期|以前|历史/.test(r5.body.answer ?? "") || r5.body.source === "local",
          (r5.body.answer ?? "").slice(0, 70),
        );
      } finally {
        await prisma.memory.deleteMany({ where: { id: { in: [past.id, stale.id] } } });
      }

      // 跨租户隔离：演示账号都在同一个「演示团队」租户里，
      // 所以必须另注册一个独立租户的账号，才能验证第 3 层隔离。
      const outsiderEmail = `qa-outsider-${Date.now()}@test.dev`;
      const reg = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: outsiderEmail, password: "qa-pass-1234", name: "外部租户" }),
      });
      if (reg.status === 403) {
        console.log("  (注册被关闭，跳过跨租户用例)");
      } else {
        const outsiderCookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
        const cross = await fetch(`${BASE}/api/live/ask`, {
          method: "POST",
          headers: { cookie: outsiderCookie, "content-type": "application/json" },
          body: JSON.stringify({ sessionId: qaSessionId, question: "刚才说了什么" }),
        });
        ok("跨租户读取会话返回 404", cross.status === 404, String(cross.status));

        const crossMeeting = await fetch(`${BASE}/api/live/ask`, {
          method: "POST",
          headers: { cookie: outsiderCookie, "content-type": "application/json" },
          body: JSON.stringify({ meetingId: qaMeetingId, question: "刚才说了什么" }),
        });
        ok("跨租户按 meetingId 提问也返回 404", crossMeeting.status === 404, String(crossMeeting.status));

        // 清理临时账号，不留脏数据
        const { PrismaClient: PC } = require("@prisma/client");
        const p2 = new PC();
        try {
          const u = await p2.user.findUnique({ where: { email: outsiderEmail } });
          if (u) {
            await p2.session.deleteMany({ where: { userId: u.id } });
            await p2.user.delete({ where: { id: u.id } });
            await p2.tenant.delete({ where: { id: u.tenantId } });
          }
        } finally {
          await p2.$disconnect();
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  }
}

// ============================================================ main

main();

async function main() {
  await testCore();
  await testHttp();

  console.log();
  console.log(`结果：${pass} 通过，${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}
