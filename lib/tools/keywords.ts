// 关键词抽取 —— 对应 issue #16
// 中文没有空格，直接按标点切词会切出整句；这里退化成字符 bigram（2 字滑动窗口）做粗检索。
// 小规模会议库完全够用；语义检索见 backlog #25（向量检索与混合召回）。
const STOPWORDS = new Set([
  "什么", "上次", "关于", "这个", "那个", "怎么", "如何", "我们", "他们", "现在", "还有",
  "是不", "不是", "可以", "一下", "定了", "的是", "有没", "没有", "一个", "么样", "时候",
]);

export function extractKeywords(query: string): string[] {
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
  return [...grams].filter((g) => g.length >= 2 && !STOPWORDS.has(g));
}