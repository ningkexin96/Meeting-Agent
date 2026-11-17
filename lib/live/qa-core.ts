// 会中问答的检索引擎 —— 对应 issue #27 / #28
//
// 这个文件刻意**不碰数据库**，只做纯计算（打分、合并、裁剪、兜底回答）。
// 原因：会中问答的检索质量是这条链路唯一真正需要调的东西，
// 而它在真实会议里极难复现（说话人、断句、ASR 错字都在变）。
// 把打分逻辑抽成纯函数，就能用固定语料把边界情况钉死在单元测试里。
//
// 数据来源由调用方负责，这里是它下游：
//   LiveSegment（实时转写定稿） + interim（正在识别，未定稿） → 排序 → 拼上下文 → 出答案
//   往期记忆（历史会议沉淀的决议/风险/经验）→ 独立一条线，不参与本场排名，见 buildContext

/** 一条可检索的转写片段 */
export type QaSegment = {
  /** LiveSegment.seq；interim 片段为 null（还没有落库） */
  seq: number | null;
  speakerLabel: string;
  startMs: number;
  text: string;
  /** 是否仍在识别中（未定稿）。未定稿内容会让模型知道「这句可能还会变」 */
  interim?: boolean;
};

export type QaHit = QaSegment & { score: number };

/** 本地兜底回答里的引用 */
export type QaCitation = {
  seq: number | null;
  speakerLabel: string;
  startMs: number;
  text: string;
  interim: boolean;
};

/**
 * 往期记忆（issue #28）。
 *
 * 与会中转写严格区分：这不是「这场会说了什么」，而是「以前的会定了什么」。
 * 两条线在提示词里也分开摆放，避免模型把历史结论说成本场结论。
 */
export type MemoryHit = {
  id: string;
  kind: string;
  title: string | null;
  content: string;
  status: string;
  meetingId: string | null;
  meetingTitle: string | null;
  /** 相对时间，例如「3 天前」 */
  when: string;
  /** 记忆自身重要性 0~1；同等相关时优先更重要的结论 */
  importance?: number;
  score: number;
};

// ---------------------------------------------------------------- 分词与词表

// 中文功能词。问句里大量出现「什么 / 刚才 / 说了 / 吗」，
// 不剔掉的话「刚才说了什么」会命中任何一句含「说」的话，排序彻底失效。
const STOPWORDS = [
  "什么", "怎么", "怎样", "如何", "哪些", "哪个", "哪里", "为什么", "是不是", "有没有",
  "可以", "请问", "一下", "我们", "你们", "他们", "这个", "那个", "这些", "那些",
  "刚才", "刚刚", "现在", "目前", "之前", "然后", "所以", "但是", "因为", "如果",
  "已经", "还是", "就是", "知道", "告诉", "说说", "说下", "讲讲",
  "上次", "上次的", "上次那个", "以前", "以前那个", "上回", "之前那个", "历史",
  "吗", "呢", "吧", "啊", "的", "了", "着", "过", "是", "在", "和", "与", "也", "就",
  "都", "很", "要", "会", "能", "有", "没", "被", "把", "对", "从", "到", "个",
  "我", "你", "他", "她", "它", "这", "那", "么", "呀", "哦", "嗯",
  "说", "讲", "问", "答", "聊", "谈", "看", "听",
];

const STOPWORD_SET = new Set(STOPWORDS);

/**
 * 元问法：用户要的是"这场会整体说了什么"，而不是某个具体话题。
 *
 * 这三类必须分开处理，否则会出现最尴尬的一种失败——
 * 用户说「总结一下会议」，系统回「没有找到相关内容」，
 * 而屏幕上明明就摆着 42 条转写。
 *
 * 根因：「总结」「概括」被当成了实体词，系统以为要去转写里找"总结"这两个字。
 * 可会上没人会说"总结"，所以永远零命中。
 */
const META_PATTERNS = [
  /总结|概括|归纳|梳理|汇总|复盘/,
  /(会议|会上|前面|刚刚|刚才|目前)(都|主要|大概)?(说|讲|聊|谈|讨论)了?(什么|哪些|啥)/,
  /(进展|情况|结论)(是)?(怎么样|如何|到什么)/,
  /(都|主要)(说|讲|聊|讨论)了?(什么|哪些|啥)/,
  /(整场|整个会议|这场会|本次会议).{0,4}(讲|说|内容|要点)/,
  /(要点|重点|核心|大要|大概内容|主要内容的?(概括|总结)?)$/,
  /^(说说|讲讲|讲一下|说一下|聊聊)/,
];

/**
 * 判断这句问法是不是"要整体概括"。
 *
 * 注意区分两个容易混淆的意图：
 *   「刚才说了什么」 → 用户想看**最近**几句（时间窗），不是要概括全场
 *   「总结一下会议」 → 用户要**全场**的概括
 * 两者都命中「说了什么」的句式，所以时间词优先判定为前者。
 */
export function isMetaSummaryQuery(query: string): boolean {
  const q = query.replace(/[\s，。？！,.?!/、；;：:]/g, "");
  // 明确带"最近/刚才/刚刚"的，是问时间窗，不是要概括
  if (/刚才|刚刚|最近|现在说到|说到哪/.test(q)) return false;
  return META_PATTERNS.some((re) => re.test(q));
}

/**
 * 概括类问法里的"元词"：它们描述的是"要什么形式的答案"，不是"要哪个话题"。
 * 检索时不能拿它们去匹配转写原文——会上没人会说"总结""概括"。
 */
const SUMMARY_WORDS = new Set([
  "总结", "概括", "归纳", "梳理", "汇总", "复盘", "结论", "要点", "重点",
  "核心", "内容", "大概", "整体", "会议", "这次", "本次", "整场", "进程",
  "议", "结", "概",
]);

export function isSummaryWord(term: string): boolean {
  return SUMMARY_WORDS.has(term);
}

// ---------------------------------------------------------------- 说话人意图（issue #32）

/**
 * 识别「谁说的」这类问法。
 *
 * 根因回顾：转写里说话人是**角色标签**（speaker_0 = 我，speaker_1 = 对方），
 * 用户问「对方说了什么」时，旧逻辑把「方」当成实体词去原文里找，必然零命中；
 * 问「李娜说了什么」时，又拿「李娜」去搜原文，可原文里只有「我/对方」。
 *
 * 正确做法：「谁」是**过滤条件**，不是检索内容。先定位说话人，
 * 再在该说话人的片段里回答——既有话题就按话题找，没话题就全给。
 */
export type SpeakerQuery = {
  /** 说话人标签，如 speaker_0 / speaker_1 */
  label: string;
  /** 提问里出现的人名（无则用标签默认名） */
  name: string;
};

/** 指向"我"（本机麦克风）的说法 */
const SELF_ALIASES = ["我", "本人", "自己", "麦克风", "本机"];
/** 指向"对方"（系统播放音）的说法 */
const OTHER_ALIASES = ["对方", "会议对方", "对面", "别人", "他人", "其他人"];

// 表示"说话"的动词/助词：它们出现在"谁说了什么"里，不构成话题
const SPEECH_WORDS = [
  "说了什么", "说的是", "说了", "说过的", "说过", "说什么",
  "讲了什么", "讲了", "讲的", "讲什么",
  "提到过", "提到了", "提到", "提起",
  "聊了什么", "聊了", "聊的", "谈了什么", "谈了", "谈的",
  "发言", "说的是什么", "说的什么", "说的",
];
// 时间/顺序类虚词：单独出现时不需要保留成话题
const TIME_FILLERS = ["刚才", "刚刚", "最近", "前面", "之前", "现在", "都", "主要", "大概", "又", "还", "到底", "具体"];

/**
 * 解析"谁说的"。
 *
 * @param names 名字 → 标签的映射（来自会议参与者），用于识别「李娜说了什么」
 */
export function parseSpeakerQuery(
  query: string,
  names: Record<string, string> = {},
): SpeakerQuery | null {
  const q = query.replace(/[\s，。？！,.?!/、；;：:]/g, "");
  if (!q) return null;

  // 必须出现"说话"类词汇，否则「对方的需求是什么」是在问话题，不是问谁说的
  const talkVerb = /说|讲|提到|提过|发言|聊|谈/.test(q);
  if (!talkVerb) return null;

  // 1. 先匹配具体人名（长的优先，避免"李"抢走"李娜"）
  const nameHits = Object.entries(names)
    .filter(([n]) => n && n.length >= 1 && q.includes(n))
    .sort((a, b) => b[0].length - a[0].length);
  if (nameHits.length > 0) {
    const [name, label] = nameHits[0];
    return { label, name };
  }

  // 2. 再匹配角色说法
  for (const alias of OTHER_ALIASES) {
    if (q.includes(alias)) return { label: "speaker_1", name: "对方" };
  }

  // 3. 第一人称必须紧邻说话动词，否则「我觉得这个需求有问题」会被误判
  for (const alias of ["我", "本人", "自己"]) {
    const near = new RegExp(`(^|[^\\u4e00-\\u9fa5])?${alias}(刚才|刚刚|前面|都|主要)?(说|讲|提到|提过|聊|谈|发言)`);
    if (near.test(q)) return { label: "speaker_0", name: "我" };
  }

  return null;
}

/** 从「对方刚才说了什么」里去掉"谁说的"部分，剩下的才是真正的话题 */
export function stripSpeakerWords(query: string, speaker: SpeakerQuery, names: Record<string, string> = {}): string {
  let q = query;

  // 1. 人名：只剥真正的人名（长度 >= 2 且不是角色词），
  //    角色词交给下一步统一处理，否则「对方」这种 2 字键会被当成人名跳过
  for (const n of Object.keys(names)) {
    if (n.length < 2) continue;
    if (OTHER_ALIASES.includes(n) || SELF_ALIASES.includes(n)) continue;
    q = q.split(n).join(" ");
  }

  // 2. 角色词：一律按正则剥，避免遍历顺序问题
  const roleRe = new RegExp([...OTHER_ALIASES, ...SELF_ALIASES].sort((a, b) => b.length - a.length).join("|"), "g");
  q = q.replace(roleRe, " ");

  // 3. 说话动词（长的先，避免"说了什么"被"说了"截断半截）
  for (const w of [...SPEECH_WORDS].sort((a, b) => b.length - a.length)) q = q.split(w).join(" ");

  // 4. 时间/顺序虚词
  for (const w of TIME_FILLERS) q = q.split(w).join(" ");

  // 5. 剥离后常留下"说""的""吗""了"这类单字碎片。
  //    不清理的话，它们会被当成实体词参与匹配（单字在转写里几乎必然出现），
  //    造成"明明只问联调，却召回测试用例"这种误召回。
  //    这里对所有单字虚词一律清掉，不管出现在开头、中间还是结尾。
  return q
    .replace(/[说讲的了吗呢吧啊是在有都又还个这那]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 该问法是否只要该说话人的**全部**发言（没有追加话题）。
 * 「对方说了什么」→ 全给；「对方说联调怎么安排」→ 还要按话题筛。
 */
export function isSpeakerOnlyQuery(query: string, speaker: SpeakerQuery, names: Record<string, string> = {}): boolean {
  const rest = stripSpeakerWords(query, speaker, names);
  // 去掉剩余的虚词后为空，就是"只要这个人说的话"
  const meaningful = rest
    .replace(/[刚才刚刚最近前面之前现在都主要大概又还现在了的在有的吗呢吧啊是]/gu, "")
    .replace(/\s+/g, "")
    .trim();
  return meaningful.length === 0;
}

/**
 * 对"整体概括"类问法构造检索词。
 *
 * 优先取"具体话题"（例如「总结一下联调这块」里的「联调」）；
 * 拿不到任何话题时，用会议里真实出现过的关键词去覆盖抽样——
 * 这样拼出来的上下文既覆盖开场、中段、结尾，又不会因为随机抽取而漏掉重点。
 */
export function sampleTermsForSummary(timeline: QaSegment[], count = 8): QaSegment[] {
  if (timeline.length <= count) return timeline;
  // 均匀抽样：保证首尾都在，中间按比例取，避免只取到开场寒暄
  const picked: QaSegment[] = [];
  const step = (timeline.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) picked.push(timeline[Math.round(i * step)]);
  return picked;
}

// 疑问词 ⇒ 展开成与会议用语同义的关键词。
// 「谁负责」问的是责任人，但转写里没人会说「谁负责」，说的是「张伟来跟」。
const SYNONYMS: [RegExp, string[]][] = [
  [/谁|哪个(人|同事)|负责人|责任人|owner/i, ["负责", "跟进", "盯", "来做", "认领", "owner"]],
  [/什么时候|哪天|几号|截止|deadline|时限|工期/i, ["周", "下周", "月底", "今天", "明天", "截止", "之前", "日期"]],
  [/风险|问题|隐患|担心/i, ["风险", "问题", "担心", "不稳定", "延期", "来不及", "阻塞", "砍掉"]],
  [/决定|结论|定了|拍板/i, ["决定", "定了", "结论", "确认", "同意", "敲定", "改成", "先做"]],
  [/待办|任务|做什么|安排|计划/i, ["负责", "待办", "跟进", "下周", "完成", "处理"]],
  [/进度|到哪|完成了吗|进展/i, ["进度", "完成", "已经", "还没", "下周", "延期"]],
];

// 上面这批是"泛词"：它们揭示的是**意图**（想找时间、想找风险、想找责任人），
// 不是**实体**。一场十来分钟的会议几乎必然会提到「今天」「负责」「下周」，
// 拿它们当命中依据，会把「下周有什么风险」判成"答得出"，
// 更糟的是把「量子计算什么时候上线」判成命中「今天就到这里」。
//
// 因此规则是：只擦到时间词的片段不算命中；意图词命中只作为加分项，
// 并且只有在片段本身还有别的实体词命中时才起效（见 rankSegments）。
const WEAK_TERMS = new Set([
  "时候", "周", "下周", "月底", "今天", "明天", "截止", "之前", "日期",
  "负责", "跟进", "盯", "来做", "认领",
  "风险", "问题", "担心", "不稳定", "延期", "来不及", "阻塞", "砍掉",
  "决定", "定了", "结论", "确认", "同意", "敲定", "改成", "先做",
  "待办", "完成", "处理", "进度", "已经", "还没",
  // 通用业务词：几乎每条决议/待办都会提到，单独命中没有区分度。
  // 「量子计算什么时候上线」曾经因为擦到「上线」而召回「上线排期定在月底」。
  "上线", "功能", "需求", "方案", "版本", "项目", "开发", "设计",
]);

/**
 * 泛词里的时间类。
 * 一场会几乎必然提到时间，所以时间词单独命中不能作为「这段话相关」的依据，
 * 否则「量子计算什么时候上线」会命中「下班吧」。它们只用于加分。
 */
const TIME_TERMS = new Set(["时候", "周", "下周", "月底", "今天", "明天", "截止", "之前", "日期"]);

/** 停用词表：同义词展开时会用它判断某个词是不是"实体词" */
export function isStopword(term: string): boolean {
  return STOPWORD_SET.has(term);
}

/** 时间类泛词：单独命中不足以判定相关 */
export function isTimeTerm(term: string): boolean {
  return TIME_TERMS.has(term);
}

/**
 * 中文没有空格，用 bigram 切分：
 *   「排期定的什么时候」 → 排期 / 期定 / 定的 / 的什 / 什么 …
 * 再剔除停用词与单字噪声，留下的就是这句问句的「实体词」。
 */
export function tokenizeQuery(query: string): string[] {
  const text = query
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, " ")
    .trim();
  if (!text) return [];

  const out = new Set<string>();
  const keptChunks: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    // 英文/数字整体保留，长度 >= 2 才有意义（单字母如 "a" 全是噪声）
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 2) keptChunks.push(chunk);
      continue;
    }
    // 中文：先按停用词切开，避免「什么」「刚才」污染 bigram
    let rest = chunk;
    for (const w of STOPWORDS) {
      if (rest.length > w.length && rest.includes(w)) rest = rest.split(w).join(" ");
    }
    for (const piece of rest.split(/\s+/)) {
      if (!piece) continue;
      if (piece.length === 1) {
        // 单字只在不是停用词时才保留
        if (!STOPWORD_SET.has(piece) && /[\u4e00-\u9fa5]/.test(piece)) keptChunks.push(piece);
        continue;
      }
      for (let i = 0; i + 1 < piece.length; i++) {
        const bg = piece.slice(i, i + 2);
        if (!STOPWORD_SET.has(bg)) keptChunks.push(bg);
      }
    }
  }
  for (const c of keptChunks) out.add(c);

  // 问句里出现疑问意图时，把同义关键词补进来，提升召回。
  // 注意：同义词是「关键词白名单」，即使含停用词（如「什么时候」）也必须保留，
  // 否则「时间类问题 ⇒ 时间词」这条召回规则会被上面的停用词过滤整条删掉。
  for (const [re, words] of SYNONYMS) {
    if (re.test(query)) for (const w of words) out.add(w.toLowerCase());
  }

  return [...out];
}

/** 转写片段的分词：bigram，不做停用词剔除（原话里每个字都是证据） */
export function tokenizeSegment(text: string): string[] {
  const s = text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, "");
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  if (s.length === 1) out.push(s);
  return out;
}

// ---------------------------------------------------------------- 检索打分

/**
 * 时间近因权重。
 *
 * 用户问「刚才说了什么」时，60 秒前的内容显然比 20 分钟前的更该排前面。
 * 但不能让近因压过相关性 —— 否则问「谁负责」只会答最后一句无关的话。
 * 所以近因只做**乘性微调**（0.75 ~ 1.0），主排序仍由词命中决定。
 */
export function recencyWeight(startMs: number, latestMs: number): number {
  const ageMin = Math.max(0, (latestMs - startMs) / 60_000);
  return 0.75 + 0.25 * Math.exp(-ageMin / 8);
}

/**
 * 单条文本的打分。
 *
 * 返回 null 表示「不相关」，宁可返回空也不要硬凑 —— 这是 issue #25 的教训：
 * 「量子计算什么时候上线」曾经因为擦到「上线」而召回「先上线录音上传」。
 *
 * 打分 = Σ 命中词权重（长词权重更高，因为中文里 3~4 字词比 bigram 更具体）
 *      × 覆盖率
 *      × 意图加分
 */
function scoreText(
  text: string,
  terms: string[],
  coreTermCount: number,
): { score: number; entityHit: boolean } | null {
  const grams = tokenizeSegment(text);
  if (grams.length === 0) return null;
  const gramSet = new Set(grams);
  const lower = text.toLowerCase();

  let raw = 0;
  let matched = 0;
  let entityHit = false;
  let intentHit = 0;
  let timeHit = 0;

  for (const t of terms) {
    const hit = t.length >= 2 ? lower.includes(t) : gramSet.has(t);
    if (!hit) continue;
    matched++;
    raw += t.length >= 2 ? t.length : 1;
    if (!WEAK_TERMS.has(t)) entityHit = true;
    else if (TIME_TERMS.has(t)) timeHit++;
    else intentHit++;
  }

  if (matched === 0) return null;
  // 没有任何实体词命中、只擦到时间词 ⇒ 不相关，不硬凑
  if (!entityHit && timeHit > 0 && intentHit === 0) return null;
  // 时间词权重最低：它不能把不相关的句子顶上来
  raw -= timeHit;

  const coverage = Math.min(1, matched / Math.max(1, coreTermCount));
  const score = raw * (0.6 + 0.4 * coverage) * (1 + 0.5 * Math.min(intentHit, 3));
  return { score, entityHit };
}

/**
 * 检索并排序（本场转写）。
 *
 * 两个底线，靠打分结构而不是靠"感觉"保证：
 * 1. 不硬凑：只靠时间词勉强擦到的片段不计分，
 *    否则「量子计算」会因擦到「算」而召回无关内容。
 * 2. 纯问法（「刚才说了什么」）没有实体词时，退化为"最近的片段"，
 *    这时不判断相不相关，因为用户问的就是「最近」。
 */
export function rankSegments(
  segments: QaSegment[],
  query: string,
  limit = 6,
  opts: { speaker?: { label: string } | null } = {},
): QaHit[] {
  if (segments.length === 0) return [];
  const latestMs = segments.reduce((m, s) => Math.max(m, s.startMs), 0);

  // 先按说话人过滤（issue #32）：用户问「对方说了什么」时，
  // 只在这一个人的发言里找，否则答案会混进别人的话。
  // 过滤后如果这个人在本场没说过话，要如实返回空，让上层回答"对方还没发言"。
  const pool = opts.speaker
    ? segments.filter((s) => s.speakerLabel === opts.speaker!.label)
    : segments;

  if (opts.speaker && pool.length === 0) return [];

  // 整体概括类问法（「总结一下会议」）要的是全貌，不是"最相关的那 6 句"。
  // 这里按时间均匀抽样：如果只取最相关的片段，概括出来的"会议总结"会完全跑偏——
  // 最相关的那几句往往是同一个话题反复出现的地方。
  if (isMetaSummaryQuery(query)) {
    // 但如果问法里带了具体话题（「总结一下联调这块」），仍按话题检索
    const topicTerms = tokenizeQuery(query).filter(
      (t) => !isStopword(t) && !SUMMARY_WORDS.has(t),
    );
    if (topicTerms.length === 0) {
      return sampleTermsForSummary(pool, Math.max(limit, 10)).map((s) => ({
        ...s,
        score: Number(recencyWeight(s.startMs, latestMs).toFixed(4)),
      }));
    }
  }

  const terms = tokenizeQuery(query);

  // 同义词展开带来的「什么时候」「我」这类词不是实体词，不能作为唯一命中依据
  const coreTerms = terms.filter((t) => !isStopword(t) && !SUMMARY_WORDS.has(t));
  if (coreTerms.length === 0) {
    // 问句里没有实体词（如「刚才说了什么」）＝ 用户想要最近的内容
    // 但「对方说了什么」要的是**这个人说过的话**（按时间顺序），不是"最近几句"
    if (opts.speaker) {
      return pool
        .slice()
        .sort((a, b) => a.startMs - b.startMs)
        .slice(0, Math.max(limit, 12))
        .map((s) => ({ ...s, score: Number(recencyWeight(s.startMs, latestMs).toFixed(4)) }));
    }
    return [...pool]
      .sort((a, b) => b.startMs - a.startMs)
      .slice(0, limit)
      .map((s) => ({ ...s, score: Number(recencyWeight(s.startMs, latestMs).toFixed(4)) }));
  }

  // 已限定说话人、且问法里还有具体实体词（「对方说联调怎么安排」里的"联调"）：
  // 此时必须真的提到该实体才算相关。意图词（"安排""负责"）不算——
  // 范围已经缩小到一个人了，再靠意图词凑数只会召回到不相干的句子。
  const entityTerms = terms.filter((t) => t.length >= 2 && !WEAK_TERMS.has(t));
  const scoped = Boolean(opts.speaker);
  const needsEntityHit = scoped && entityTerms.length > 0;

  const scored: QaHit[] = [];
  for (const seg of pool) {
    const lower = seg.text.toLowerCase();

    // ① 需要实体命中时，先看实体词在不在
    if (needsEntityHit) {
      const hitEntity = entityTerms.some((t) => lower.includes(t));
      if (!hitEntity) continue;
      const score = 4 * recencyWeight(seg.startMs, latestMs) * (seg.interim ? 0.95 : 1);
      scored.push({ ...seg, score: Number(score.toFixed(4)) });
      continue;
    }

    // ② 常规打分
    const r = scoreText(seg.text, terms, coreTerms.length);
    if (r) {
      const score = r.score * recencyWeight(seg.startMs, latestMs) * (seg.interim ? 0.95 : 1);
      scored.push({ ...seg, score: Number(score.toFixed(4)) });
      continue;
    }

    // ③ 说话人已限定、但问法里的词都属于意图类（「对方提到了风险」）：
    //    范围很小，只要字面上出现该词就算——否则会把答案藏起来。
    //    注意这里只对"没有实体词"的问法生效，避免上面那种误召回。
    if (scoped && entityTerms.length === 0) {
      const loose = terms.some((t) => t.length >= 2 && lower.includes(t));
      if (loose) {
        scored.push({ ...seg, score: Number((2 * recencyWeight(seg.startMs, latestMs)).toFixed(4)) });
      }
    }
  }

  return scored.sort((a, b) => b.score - a.score || b.startMs - a.startMs).slice(0, limit);
}

// ---------------------------------------------------------------- 往期记忆检索（issue #28）

/**
 * 在往期记忆里找相关内容。
 *
 * 与会中转写用同一套打分逻辑（同一份词表、同一套"不硬凑"规则），
 * 这样用户换着问「谁负责」和「之前谁负责」时，判断口径是一致的。
 *
 * 但记忆不能像转写那样退化成「最近的几条」：
 * 用户问「刚才说了什么」时不该冒出上个月的决议。
 * 所以记忆检索**只接受真正命中的条目**，命不中就是空。
 */
export function rankMemories(memories: MemoryHit[], query: string, limit = 4): MemoryHit[] {
  if (memories.length === 0) return [];
  const terms = tokenizeQuery(query);
  const coreTerms = terms.filter((t) => !isStopword(t));
  // 没有实体词 ⇒ 用户问的是"本场最近"，不是"往期"，不召回记忆
  if (coreTerms.length === 0) return [];

  const scored: MemoryHit[] = [];
  for (const m of memories) {
    // 标题 + 内容一起看：决议类记忆标题为空，风险类标题是「风险」这种泛词
    const text = [m.title, m.content].filter(Boolean).join(" ");
    const r = scoreText(text, terms, coreTerms.length);
    if (!r) continue;

    // 记忆比本场转写更严格：必须命中实体词，不能只靠意图词（风险/负责/上线…）。
    // 记忆是长期知识，「上线」这个词几乎每条决议都有，放行它等于每条都召回 ——
    // 实测「量子计算什么时候上线」会因为擦到「上线」召回「上线排期定在月底」。
    if (!r.entityHit) continue;

    // 记忆本身的重要性（0~1）作为微弱乘性因子：同样相关时优先更重要的结论
    const importance = 0.85 + 0.15 * Math.max(0, Math.min(1, m.importance ?? 0.5));
    scored.push({ ...m, score: Number((r.score * importance).toFixed(4)) });
  }

  // 同一条结论在多个会议里被沉淀过（内容高度重合）时只留一条，避免答案里重复三遍
  const kept: MemoryHit[] = [];
  for (const m of scored.sort((a, b) => b.score - a.score)) {
    const norm = normalizeForDedup(m.content).slice(0, 24);
    if (kept.some((k) => normalizeForDedup(k.content).slice(0, 24).includes(norm.slice(0, 12)))) continue;
    kept.push(m);
    if (kept.length >= limit) break;
  }
  return kept;
}

// ---------------------------------------------------------------- 去重与合并

function normalizeForDedup(s: string): string {
  return s.replace(/[\s，。！？、；：,.!?;:"'（）()「」]/g, "").toLowerCase();
}

/**
 * 合并候选片段并按时间排序。
 *
 * 会中有两个来源要合成一份时间线：
 *   1. 库里已定稿的 LiveSegment
 *   2. 前端随问题一起送上来的最新片段（含 interim）
 * 第 2 类只用来**填补库中缺失的序号**——因为它可能是同一个 seq 的更旧快照。
 * 定稿永远以库为准；interim 只有库里完全没有对应内容时才会进入上下文。
 */
export function mergeTimeline(
  stored: QaSegment[],
  incoming: QaSegment[] = [],
): QaSegment[] {
  const bySeq = new Map<number, QaSegment>();
  const overflow: QaSegment[] = [];

  for (const s of stored) {
    if (s.seq === null) continue;
    bySeq.set(s.seq, { ...s, interim: false });
  }
  for (const s of incoming) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    if (s.seq === null || s.interim) {
      // 未定稿：库里有同样内容就不要（避免同一句话出现两遍）
      overflow.push({ ...s, text, interim: true });
      continue;
    }
    if (!bySeq.has(s.seq)) bySeq.set(s.seq, { ...s, text, interim: false });
  }

  const timeline = [...bySeq.values()].sort((a, b) => a.startMs - b.startMs || (a.seq ?? 0) - (b.seq ?? 0));

  // interim 与已定稿内容重复就丢弃（模型对同一句可能先给中间结果再给定稿）
  const seen = new Set(timeline.map((s) => normalizeForDedup(s.text)));
  const extra = overflow.filter((s) => {
    const key = normalizeForDedup(s.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 未定稿片段在时间线上通常排在最后
  return [...timeline, ...extra.sort((a, b) => a.startMs - b.startMs)];
}

// ---------------------------------------------------------------- 上下文

export type ContextBudget = {
  /** 字符上限。中文 1 字 ≈ 1 token 量级，10k 字远小于模型窗口，但能挡住超长会议 */
  maxChars?: number;
  /** 最近多少条无论如何都要带上（用户最常问「刚才说了什么」） */
  headRecent?: number;
};

export const DEFAULT_BUDGET: Required<ContextBudget> = {
  maxChars: 9000,
  headRecent: 40,
};

export function speakerName(label: string): string {
  if (label === "speaker_0") return "我";
  if (label === "speaker_1") return "对方";
  return label;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 拼上下文：命中的片段优先，剩余预算给最近的片段。
 *
 * 为什么不是「全量塞进去」：一场两小时的会议转写有几万字，
 * 全量塞会让每次提问都变慢变贵，而且模型反而容易在噪声里丢重点。
 * 先命中、再最近，是对「问细节」和「问刚才」两类问题都成立的折中。
 *
 * 往期记忆单独成段、有固定条数上限（issue #28）：
 * 它属于"背景知识"而不是"本场证据"，混在本场转写里会让模型分不清哪句是今天说的。
 */
export function buildContext(
  timeline: QaSegment[],
  hits: QaHit[],
  budget: ContextBudget = {},
  memories: MemoryHit[] = [],
  opts: { summarize?: boolean; speaker?: { label: string; name: string } | null } = {},
): string {
  const { maxChars, headRecent } = { ...DEFAULT_BUDGET, ...budget };
  const sections: string[] = [];

  // 按说话人提问时，上下文也必须只含这个人的发言。
  // 否则模型会把别人的话也当成"对方说的"——比召回失败更糟，
  // 那是直接给出错误归属。
  const scoped = opts.speaker
    ? timeline.filter((s) => s.speakerLabel === opts.speaker!.label)
    : timeline;

  if (memories.length > 0) {
    const lines = memories.map((m) => {
      const kind = MEMORY_KIND_LABELS[m.kind] ?? m.kind;
      const src = m.meetingTitle ? `《${m.meetingTitle}》` : "手动记录";
      return `· [${kind}] ${m.content}（${src}，${m.when}）`;
    });
    sections.push(
      [
        "【往期会议记忆】（来自更早的会议，不是本场会议的发言，引用时务必说明「之前」）",
        ...lines,
      ].join("\n"),
    );
  }

  if (scoped.length > 0) {
    // 概括类问法要全貌：此时"命中"没有意义（用户没指定话题），
    // 所以把整场内容都纳入，按预算从头裁剪——至少能覆盖到会议的开头。
    const picked = opts.summarize || opts.speaker
      ? new Set<QaSegment>(scoped)
      : (() => {
          const s = new Set<QaSegment>(hits);
          for (const r of scoped.slice(-headRecent)) s.add(r);
          return s;
        })();

    // 按时间线顺序输出：模型看到的是会议的自然流，而不是被打散的相关度排名
    const ordered = scoped.filter((s) => picked.has(s));

    // 命中的更关键，先保证末尾（最新）与命中都在预算内：从新到旧裁剪
    const kept: QaSegment[] = [];
    let used = 0;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const s = ordered[i];
      const line = formatLine(s);
      if (used + line.length > maxChars) break;
      used += line.length;
      kept.unshift(s);
    }

    if (kept.length > 0) {
      const head = opts.speaker
        ? `【本场会议转写 · 只含「${opts.speaker.name}」的发言】共 ${scoped.length} 段${
            kept.length < scoped.length ? `，为控制长度只提供最近 ${kept.length} 段` : ""
          }`
        : opts.summarize
          ? `【本场会议转写】（共 ${scoped.length} 段${
              kept.length < scoped.length ? `，为控制长度只提供最近 ${kept.length} 段` : "，全部提供"
            }）`
          : "【本场会议转写】";
      sections.push([head, ...kept.map(formatLine)].join("\n"));
    }
  }

  return sections.join("\n\n");
}

export const MEMORY_KIND_LABELS: Record<string, string> = {
  decision: "历史决议",
  open_loop: "未闭环",
  fact: "事实",
  lesson: "经验",
};

export function formatLine(s: QaSegment): string {
  const who = speakerName(s.speakerLabel);
  const mark = s.interim ? "（识别中）" : "";
  const tag = s.seq === null ? "" : `#${s.seq} `;
  return `[${fmtClock(s.startMs)}] ${tag}${who}${mark}：${s.text}`;
}

// ---------------------------------------------------------------- 兜底回答

/**
 * 本地抽取式回答：模型不可用时使用。
 *
 * 不做任何归纳，只把最相关的原话按时间顺序摆出来。
 * 「不归纳」是刻意的：归纳会引入幻觉，而这条链路的底线是「宁可答得笨，也不要答错」。
 */
export function extractiveAnswer(
  query: string,
  hits: QaHit[],
  totalSegments: number,
  memories: MemoryHit[] = [],
  speaker?: { label: string; name: string } | null,
): { answer: string; citations: QaCitation[] } {
  if (hits.length === 0 && memories.length === 0) {
    // 按说话人提问、但这个人没发过言：要说清楚是这个原因，
    // 不能让用户以为"整场会都没内容"
    const who = speaker?.name;
    return {
      answer:
        totalSegments === 0
          ? "这场会议还没有转写到任何内容，暂时没法回答。等开始说话后会自动出现转写。"
          : who
            ? `本场会议里还没有「${who}」的发言记录。可能是这个音源没有采集到声音，或者这个人还没开始说话。`
            : `本次会议的转写和往期记忆里都没有找到和「${query}」相关的内容。可以换个说法再问一次。`,
      citations: [],
    };
  }

  const parts: string[] = [];
  if (hits.length > 0) {
    const ordered = [...hits].sort((a, b) => a.startMs - b.startMs);
    const lines = ordered.map((h) => `· ${fmtClock(h.startMs)} ${speakerName(h.speakerLabel)}：${h.text}`);
    parts.push(
      speaker
        ? `「${speaker.name}」在本场会议里说的是：\n${lines.join("\n")}`
        : `根据本次会议已经转写到的内容，和「${query}」相关的是：\n${lines.join("\n")}`,
    );
  }
  if (memories.length > 0) {
    const lines = memories.map((m) => {
      const kind = MEMORY_KIND_LABELS[m.kind] ?? m.kind;
      const src = m.meetingTitle ? `《${m.meetingTitle}》` : "手动记录";
      return `· [${kind}] ${m.content}（${src}，${m.when}）`;
    });
    parts.push(`往期会议里也有相关记录：\n${lines.join("\n")}`);
  }

  return {
    answer: parts.join("\n\n"),
    citations: hits
      .slice()
      .sort((a, b) => a.startMs - b.startMs)
      .map((h) => ({
        seq: h.seq,
        speakerLabel: h.speakerLabel,
        startMs: h.startMs,
        text: h.text,
        interim: Boolean(h.interim),
      })),
  };
}

// ---------------------------------------------------------------- 模型提示词

export const SYSTEM_PROMPT = [
  "你是正在一场会议旁的助理。用户随时会提问，你手上只有两块材料：本场会议到目前为止的转写，以及往期会议沉淀的记忆。",
  "规则：",
  "1. 只依据给定材料回答。两块材料里都没有的信息，直接说「会上还没有提到」，绝不推测、绝不编造。",
  "2. 回答要短，先说结论，最多 4 行。需要点名时说清是谁、在什么时候说的。",
  "3. 引用本场原话时用时间点标注，例如「（03:12 我）」。",
  "4. 标了「识别中」的内容还没定稿，若答案只依赖这部分，要提醒用户这句可能还会变。",
  "5. 材料里没有给出往期记忆时，不要主动提起以前的会议。",
  "6. 问题如果是在问整场进度，就用最近的内容概括，不要逐句复述。",
  "7. 用中文回答，不要输出 JSON、不要加标题层级。",
].join("\n");

/**
 * 往期记忆的措辞规则单独成段（issue #28）。
 *
 * 这是最容易出问题的地方，实测踩过两个坑：
 *
 * 坑一（归属）：模型天然喜欢把"以前定过"说成"我们定了"，
 * 用户会误以为是本场会议的结论。
 *
 * 坑二（不给记忆）：实测当问题只跟往期记忆相关、本场没提过时，
 * 模型会抱着系统提示里「材料里都没有就说会上还没有提到」这条不放，
 * 回答「会上还没有提到灰度发布」，把明明给它的记忆白白浪费掉。
 * 所以这里必须显式说明「本场没提到 ≠ 不能回答」。
 */
export const MEMORY_RULES = [
  "关于「往期会议记忆」的使用规则：",
  "1. 先判断问题问的是哪一类：",
  "   · 问本场会议讲了什么（「刚才说了什么」「这场定了什么」）→ 只从本场转写回答；",
  "   · 问某个话题的结论、安排、责任、风险（不论本场是否提过）→ 本场转写和往期记忆都要看。",
  "2. 只要往期记忆里有答案，就必须回答，并在前面写清「之前的会议」或「上次」这些字眼。",
  "   「本场会议还没提到 X」不等于「不知道 X」——这种情况下应当先给出往期记忆里的答案。",
  "3. 凡引用往期记忆，必须用「之前」「上次」这类词明确归属，并说明是哪场会议。",
  "4. 如果往期记忆和本场转写冲突（例如之前定 A，本场改了 B），必须指出这个变化，并以本场为准，明确说「本场已改为…」。",
  "5. 如果往期记忆与本场问题无关，一律不要提。",
].join("\n");

/**
 * 概括类问法的专用指令（issue #31）。
 *
 * 不加这段，模型会把"总结一下会议"当成"在转写里找『总结』这两个字"，
 * 于是回答「会上没有提到总结相关内容」——而材料里明明就有全场转写。
 */
export const SUMMARY_RULES = [
  "这次用户要的是「概括整场会议」，不是在找某个关键词。请这样回答：",
  "1. 用 3~5 句话概括这场会议讲了什么（主题 → 讨论/结论 → 待定或风险）。",
  "2. 如果会议内容零散（例如只是试音、寒暄），要如实说明「这场会主要是试音/寒暄，没有实质议题」，不要硬凑出结论。",
  "3. 不要因为转写里没有出现「总结」二字就说找不到；材料就是你想概括的对象本身。",
  "4. 不要逐句复述，也不要引用具体某一句，除非那句话是唯一的结论。",
].join("\n");

export function buildQaPrompt(
  query: string,
  context: string,
  meta: {
    live: boolean;
    count: number;
    memoryCount?: number;
    summarize?: boolean;
    speaker?: { label: string; name: string } | null;
  },
) {
  const parts = [
    SYSTEM_PROMPT,
    "",
    `会议状态：${meta.live ? "正在进行中" : "已结束"}，已转写 ${meta.count} 段。`,
  ];
  if (meta.memoryCount && meta.memoryCount > 0) {
    parts.push("", MEMORY_RULES);
  }
  if (meta.summarize) {
    parts.push("", SUMMARY_RULES);
  }
  if (meta.speaker) {
    // 说话人限制必须写进提示词：模型看到整份材料时不会自己过滤，
    // 听到"对方说了什么"会把材料里的每一句都当答案
    parts.push(
      "",
      `注意：用户问的是「${meta.speaker.name}」说过的话。下面只提供了这个人的发言，`,
      "请只总结/引用这些内容，不要说成是别人的话；如果他没说过相关内容，就直说没有。",
    );
  }
  parts.push(
    "",
    "===== 材料（[分:秒] #序号 说话人：内容） =====",
    context || "（暂无材料）",
    "===== 材料结束 =====",
    "",
    `用户的问题：${query}`,
  );
  return parts.join("\n");
}

/**
 * 把模型输出清洗成可直接展示的答案。
 * 真实模型偶尔会自己加「以下是我的回答：」「希望有帮助」这类客套话，去掉多余空行。
 */
export function tidyAnswer(raw: string): string {
  return raw
    .replace(/^\s*(好的|当然|以下是[^\n]*)[，,：:]\s*/u, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- 输入校验

export const MAX_QUESTION_CHARS = 500;

export function validateQuestion(input: unknown): { ok: true; question: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "问题必须是字符串" };
  const q = input.trim();
  if (!q) return { ok: false, error: "问题不能为空" };
  if (q.length > MAX_QUESTION_CHARS) {
    return { ok: false, error: `问题太长了（${q.length} 字），请控制在 ${MAX_QUESTION_CHARS} 字以内` };
  }
  return { ok: true, question: q };
}