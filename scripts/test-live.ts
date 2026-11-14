// 实时流式单元测试 —— 对应 issue #26
// 用法：pnpm test:live
import { stitchTurns } from "../lib/live/transcribe";
import { textSimilarity, dedupe, extractByRules } from "../lib/live/extract";
import type { AsrTurn } from "../lib/asr";

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

function turn(text, startMs, endMs, speaker = "speaker_0"): AsrTurn {
  return { speakerLabel: speaker, startMs, endMs, text, confidence: 0.9 };
}

console.log("== 跨片拼接 ==");

// 片 1 结尾未结束，片 2 开头接着说话
const p1 = [turn("今天主要对一下", 0, 3000)];
const n1 = [turn("纪要功能的上线节奏。", 0, 2000)];
const stitched = stitchTurns(p1, n1, 4000);
ok("未结束的句子跨片合并", stitched.length === 1, `${stitched.length} 条`);
ok("文本拼接正确", stitched[0]?.text === "今天主要对一下纪要功能的上线节奏。", stitched[0]?.text);
ok("时间范围覆盖两片", stitched[0]?.startMs === 0 && stitched[0]?.endMs === 6000);

// 片 1 已经结束（有句号），片 2 是新句子
const p2 = [turn("这是我的结论。", 0, 3000)];
const n2 = [turn("另外说下一件事。", 0, 2000)];
const noMerge = stitchTurns(p2, n2, 4000);
ok("完整句不合并", noMerge.length === 2, `${noMerge.length} 条`);
ok("第二句时间偏移正确", noMerge[1]?.startMs === 4000, `startMs=${noMerge[1]?.startMs}`);

// 不同说话人不合并
const p3 = [turn("我先说", 0, 3000, "speaker_0")];
const n3 = [turn("我补充", 0, 2000, "speaker_1")];
ok("不同说话人不合并", stitchTurns(p3, n3, 4000).length === 2);

// 间隔太远不合并
const p4 = [turn("没说完", 0, 1000)];
const n4 = [turn("很久以后说", 8000, 9000)];
ok("间隔过大不合并", stitchTurns(p4, n4, 4000).length === 2);

// 边界
ok("空 prev 直接返回新片", stitchTurns([], n1, 0).length === 1);
ok("空 next 保持原样", stitchTurns(p1, [], 0).length === 1);

console.log("== 文本相似度与去重 ==");
ok("相同文本相似度为 1", Math.abs(textSimilarity("先上线离线转写", "先上线离线转写") - 1) < 1e-9);
ok("完全不同文本相似度为 0", textSimilarity("天气不错", "后端压力不大") === 0);
const partial = textSimilarity("先上线离线转写，实时能力往后放", "先上线离线转写，实时能力以后再说");
ok("部分相似有中间值", partial > 0.3 && partial < 1, partial.toFixed(2));

const existing = [
  { kind: "decision" as const, content: "先上线离线转写，实时能力往后放。" },
];
const incoming = [
  { kind: "decision" as const, content: "先上线离线转写，实时能力往后放。" }, // 重复
  { kind: "decision" as const, content: "纪要页先做字段级编辑。" }, // 新
  { kind: "action_item" as const, content: "先上线离线转写，实时能力往后放。" }, // 跨类型不算重复
];
const kept = dedupe(incoming, existing);
ok("重复条目被丢弃", kept.length === 2, `${kept.length} 条`);
ok("保留了新决议", kept.some((k) => k.content.includes("字段级")));
ok("不同类型视为不同条目", kept.some((k) => k.kind === "action_item"));

const batchDup = dedupe(
  [
    { kind: "risk" as const, content: "缺少声纹库识别不准。" },
    { kind: "risk" as const, content: "缺少声纹库识别不准。" },
  ],
  [],
);
ok("同批次内去重", batchDup.length === 1, `${batchDup.length} 条`);

console.log("== 规则抽取 ==");
const rules = extractByRules([
  { seq: 0, text: "这个事今天就定下来。", speaker: "speaker_0" },
  { seq: 1, text: "张伟你负责把这部分做成可点击修改的。", speaker: "speaker_0" },
  { seq: 2, text: "还有一个风险，没有声纹库可能不准。", speaker: "speaker_1" },
]);
ok("识别出决议", rules.some((r) => r.kind === "decision"));
ok("识别出待办", rules.some((r) => r.kind === "action_item"));
ok("识别出风险", rules.some((r) => r.kind === "risk"));
// 「可能不准」属于普通风险 → medium；只有「来不及 / 砍掉 / 硬要求」才是 high
const riskItem = rules.find((r) => r.kind === "risk");
ok("普通风险判为 medium", riskItem?.severity === "medium", riskItem?.severity);
const highRules = extractByRules([
  { seq: 0, text: "如果周五还不行，我们就要砍掉这个功能。", speaker: "speaker_0" },
]);
ok("含「砍掉」判为 high", highRules[0]?.severity === "high", highRules[0]?.severity);
ok("每条带来源标注", rules.every((r) => r.sourceText?.startsWith("#")));

const empty = extractByRules([{ seq: 0, text: "嗯。", speaker: "x" }]);
ok("太短的句子不抽取", empty.length === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);