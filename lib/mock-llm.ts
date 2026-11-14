// Mock LLM：不调用真实模型，按「阶段 + 输入」返回确定性但内容真实的输出
// 作用：演示兜底（MOCK_LLM=1），保证现场断网也能完整走完流程
import type { SampleTurn } from "@/lib/asr/samples";

export type MockStageResult = {
  text: string;
  /** 模型"调用"过的工具，用于前端运行视图展示 */
  calls: { tool: string; args: Record<string, unknown> }[];
};

export function mockSummarize(turns: { idx: number; speaker: string; text: string }[]): MockStageResult {
  const chunkSize = 4;
  const chunks: string[] = [];
  for (let i = 0; i < turns.length; i += chunkSize) {
    const slice = turns.slice(i, i + chunkSize);
    const refs = slice.map((t) => `#${t.idx}`).join(",");
    const condensed = slice
      .map((t) => t.text.replace(/[，。！？、]/g, " ").slice(0, 40))
      .join("；");
    chunks.push(`[${refs}] ${condensed}`);
  }
  const content = chunks.join("\n");
  return { text: content, calls: [{ tool: "summarize_chunk", args: { chunks: chunks.length } }] };
}

export function mockExtract(
  turns: { idx: number; id: string; text: string; speaker: string }[],
): {
  overview: string;
  decisions: { content: string; sourceTurnIdx: number }[];
  actionItems: { content: string; owner?: string; dueAt?: string; sourceTurnIdx: number }[];
  risks: { content: string; severity: "low" | "medium" | "high"; sourceTurnIdx: number }[];
} {
  const find = (kw: string) => turns.find((t) => t.text.includes(kw));
  const pick = (kw: string) => find(kw) ?? turns[0];

  const decisions = [
    { content: "先上录音上传 + 离线转写，实时转写能力放到后续迭代。", sourceTurnIdx: pick("离线转写").idx },
    { content: "纪要页先做字段级编辑（待办改负责人/截止时间），富文本编辑下个迭代。", sourceTurnIdx: pick("字段级编辑").idx },
    { content: "低置信度的说话人归属必须提供人工修正入口。", sourceTurnIdx: pick("低置信度").idx },
    { content: "所有纪要写入必须经过统一保存接口，不能绕过直接写库。", sourceTurnIdx: pick("统一的保存接口").idx },
  ];

  const actionItems = [
    { content: "把音频存储临时使用本地目录的情况写进文档，并规划对象存储替换。", owner: "张伟（产品）", sourceTurnIdx: pick("本地目录").idx },
    { content: "转写视图按人分色展示，并支持点击引用跳回原话。", owner: "李娜（前端）", dueAt: "本周四", sourceTurnIdx: pick("转写视图").idx },
    { content: "低置信度说话人归属做成可点击修改的交互。", owner: "王强（后端）", sourceTurnIdx: pick("可点击修改").idx },
    { content: "下周一再对一次进度。", sourceTurnIdx: pick("下周一").idx },
  ];

  const risks = [
    { content: "前端时间紧张，若周五没有可跑通版本将砍掉跨会议追问功能。", severity: "high" as const, sourceTurnIdx: pick("跨会议追问").idx },
    { content: "模型输出格式不稳定，结构化纪要必须校验后才能落库。", severity: "medium" as const, sourceTurnIdx: pick("输出格式不稳定").idx },
    { content: "缺少声纹库，外部参会者说话人识别可能不准。", severity: "medium" as const, sourceTurnIdx: pick("声纹库").idx },
  ];

  return {
    overview:
      "本次周会围绕会议纪要功能的上线节奏展开。会议确认两条主线：先交付「录音上传 + 离线转写」并冻结实时能力，纪要编辑先做字段级；同时明确两条硬约束：低置信度说话人必须可人工修正，所有纪要写入必须走统一保存接口。前端与后端分别认领了转写视图与说话人修正的改造任务，下周一将对齐进度。",
    decisions,
    actionItems,
    risks,
  };
}

export function mockTranscriptTurns(): SampleTurn[] {
  return [];
}

export function mockAnswer(question: string, hits: { title: string; text: string }[]): string {
  if (hits.length === 0) {
    return "我没有在这次会议或历史会议记录里找到与该问题相关的内容。可以换个说法，或者指定具体的会议。";
  }
  const lines = hits
    .map((h, i) => `${i + 1}. 《${h.title}》中提到：「${h.text}」`)
    .join("\n");
  return `关于「${question}」，我在既有纪要/转写里找到这些依据：\n${lines}\n\n基于以上内容可以确认：结论已经在会议上明确过，可直接执行。`;
}