// 上下文治理 —— 对应架构第 ④ 层 / issue #12
// transformContext：裁剪窗口、注入摘要；convertToLlm：过滤 UI-only 消息
// 说明：Mock 模式下不触发真实模型调用，这里仍保留完整实现以证明设计成立

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_TURNS_IN_CONTEXT = 24;

/** 只把与当前阶段相关的摘要块 + 最近窗口送进模型 */
export function transformContext(
  history: ChatMessage[],
  summaryBlocks: string[],
): ChatMessage[] {
  const system = `你是会议纪要 Agent。你只能依据提供的摘要在阶段内自主安排步骤，不得编造未被记录的内容。
阶段边界由系统控制，你不需要跳阶段。所有结论必须能对应到 #话轮编号。`;

  const contextBlock = summaryBlocks.length
    ? `【会议摘要索引】\n${summaryBlocks.join("\n")}`
    : "【会议摘要索引】暂无";

  const recent = history.slice(-MAX_TURNS_IN_CONTEXT);
  return [{ role: "system", content: system }, { role: "system", content: contextBlock }, ...recent];
}

/** 过滤掉仅用于 UI 展示的消息，避免污染模型上下文 */
export function convertToLlm(messages: (ChatMessage & { uiOnly?: boolean })[]): ChatMessage[] {
  return messages
    .filter((m) => !m.uiOnly)
    .map(({ role, content }) => ({ role, content }));
}

/** 粗略 token 估算，用于成本与溢出预警（issue #20 的落点） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.6);
}