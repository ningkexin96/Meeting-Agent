// 真实模型健壮性测试 —— 覆盖模型输出的各种"不老实"形态
// 用法：pnpm test:llm
import { extractJson, LlmError } from "../lib/agent/llm-call";

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

function throws(name, fn) {
  try {
    fn();
    ok(name, false, "没有抛错");
  } catch (e) {
    ok(name, e instanceof LlmError, (e as Error).message.slice(0, 40));
  }
}

console.log("== 正常 JSON ==");
ok("纯 JSON", extractJson<{ a: number }>('{"a":1}').a === 1);

console.log("== markdown 包裹 ==");
ok(
  "```json 代码块",
  extractJson<{ a: number }>('```json\n{"a":2}\n```').a === 2,
);
ok(
  "``` 无语言标识",
  extractJson<{ a: number }>('```\n{"a":3}\n```').a === 3,
);

console.log("== 带前后废话 ==");
ok(
  "前面有解释文字",
  extractJson<{ a: number }>('好的，结果如下：\n{"a":4}').a === 4,
);
ok(
  "后面有补充说明",
  extractJson<{ a: number }>('{"a":5}\n希望有帮助！').a === 5,
);
ok(
  "前后都有废话",
  extractJson<{ a: number }>('分析完成。\n{"a":6}\n以上。').a === 6,
);

console.log("== 嵌套与数组 ==");
const complex = extractJson<{ items: { k: string }[] }>(
  '结果：{"items":[{"k":"x"},{"k":"y"}]} 完毕',
);
ok("嵌套对象和数组", complex.items.length === 2 && complex.items[1].k === "y");

console.log("== 常见脏数据 ==");
ok(
  "尾随逗号",
  extractJson<{ a: number; b: number }>('{"a":1,"b":2,}').b === 2,
);
ok(
  "数组尾随逗号",
  extractJson<{ list: number[] }>('{"list":[1,2,3,]}').list.length === 3,
);

console.log("== 应失败的情况 ==");
throws("完全不是 JSON", () => extractJson("今天天气不错"));
throws("JSON 被截断", () => extractJson('{"a":1,"b":'));
throws("空字符串", () => extractJson(""));

console.log("== 真实场景模拟 ==");
// 模拟 DeepSeek 常见返回：带思考过程 + 代码块
const realLike = `我来分析这段会议记录。

\`\`\`json
{
  "overview": "本次会议确认了上线节奏",
  "decisions": [{"content": "先上线离线转写", "sourceTurnIdx": 1}],
  "actionItems": [{"content": "补充文档", "owner": "张伟", "sourceTurnIdx": 2}],
  "risks": [{"content": "前端时间紧张", "severity": "high", "sourceTurnIdx": 4}]
}
\`\`\`

以上是从记录中提取的要点。`;
const parsed = extractJson<{
  overview: string;
  decisions: unknown[];
  actionItems: { owner: string }[];
  risks: unknown[];
}>(realLike);
ok("能解析真实风格的返回", parsed.overview.includes("上线节奏"));
ok("字段完整", parsed.decisions.length === 1 && parsed.risks.length === 1);
ok("嵌套字段正确", parsed.actionItems[0].owner === "张伟");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);