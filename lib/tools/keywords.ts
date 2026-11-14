// 关键词抽取 —— 对应 issue #16 / #25
//
// 中文没有空格，按标点切词会切出整句，所以退化成字符 bigram（2 字滑动窗口）。
// 但 bigram 有个副作用：领域高频词（上线、功能、时间）会把无关问题也匹配上。
// 例如「量子计算什么时候上线」会命中「先上线录音上传」——字面重合，语义无关。
//
// 所以这里给每个 bigram 一个权重：
//   通用词（GENERIC）权重 0.2  —— 单独命中不算数，只能作为辅助
//   领域高频词（DOMAIN_FREQ）权重 0.5 —— 需要配合其他词
//   常规词权重 1.0

export type WeightedKeyword = { term: string; weight: number };

const STOPWORDS = new Set([
  "什么", "上次", "关于", "这个", "那个", "怎么", "如何", "我们", "他们", "现在", "还有",
  "是不", "不是", "可以", "一下", "定了", "的是", "有没", "没有", "一个", "么样", "时候",
]);

// 跨领域通用词：几乎任何会议都会出现，单靠它匹配没有区分度
const GENERIC = new Set([
  "上线", "功能", "时间", "问题", "内容", "需求", "方案", "情况", "处理", "进行",
  "需要", "觉得", "认为", "如果", "因为", "所以", "但是", "然后", "已经", "目前",
  "今天", "明天", "昨天", "本周", "下周",
]);

// 会议场景高频但仍有区分度的词
const DOMAIN_FREQ = new Set([
  "转写", "纪要", "会议", "模型", "识别", "音频", "存储", "文档", "进度", "版本",
]);

function weightOf(term: string): number {
  if (GENERIC.has(term)) return 0.2;
  if (DOMAIN_FREQ.has(term)) return 0.5;
  return 1;
}

/** 抽取带权重的关键词 */
export function extractWeightedKeywords(query: string): WeightedKeyword[] {
  const grams = new Set<string>();
  for (const seg of query.split(/[\s，。？！、,?.!：:；;]+/)) {
    const s = seg.trim();
    if (!s) continue;
    if (s.length <= 2) {
      grams.add(s);
      continue;
    }
    for (let i = 0; i + 2 <= s.length; i++) grams.add(s.slice(i, i + 2));
  }

  return [...grams]
    .filter((g) => g.length >= 2 && !STOPWORDS.has(g))
    .map((term) => ({ term, weight: weightOf(term) }));
}

/** 兼容旧接口：只要词表 */
export function extractKeywords(query: string): string[] {
  return extractWeightedKeywords(query).map((k) => k.term);
}