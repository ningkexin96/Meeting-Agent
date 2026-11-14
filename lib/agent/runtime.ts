// Agent Runtime —— 对应 issue #6
// 用 @earendil-works/pi-agent-core 的 Agent 承载「阶段内自主编排」，
// 外层状态机（lib/agent/pipeline.ts）只负责调用与校验，不关心模型怎么调工具。
//
// 真实模型模式下：Agent + 工具注册表 + beforeToolCall 权限闸门 + finishTurn 阶段收敛。
// MOCK_LLM=1 时不启动 Agent（避免误调真实网关），由 pipeline 里的确定性逻辑产出。
import { obj, str, arr, opt } from "@earendil-works/pi-schema";
import { canUseTool } from "@/lib/auth/rbac";

export type AgentRunContext = {
  tenantId: string;
  userId: string;
  role: string;
  meetingId: string;
};

// 工具参数 Schema（pi-schema builders 会同时生成 JSON Schema 与 TS 类型）
export const searchTranscriptParams = obj({
  query: str({ description: "要检索的关键词或原话片段" }),
  limit: opt(str({ description: "返回条数，默认 5" })),
});

export const saveMinutesParams = obj({
  overview: str({ description: "会议概述" }),
  decisions: arr(obj({ content: str(), sourceTurnIdx: str() })),
  actionItems: arr(
    obj({ content: str(), owner: opt(str()), dueAt: opt(str()), sourceTurnIdx: str() }),
  ),
  risks: arr(obj({ content: str(), severity: str(), sourceTurnIdx: str() })),
});

/**
 * 权限闸门（第 2 层）：在工具真正执行前拦截。
 * 对应架构里「Hook: beforeToolCall 权限闸门」。
 */
export function guardToolCall(ctx: AgentRunContext, toolName: string) {
  if (!canUseTool(ctx.role, toolName)) {
    return {
      block: true as const,
      reason: `角色 ${ctx.role} 无权调用工具 ${toolName}`,
    };
  }
  return { block: false as const };
}

/**
 * 创建真实模式下的 Agent。
 * 注意：这是 ESM-only 依赖，运行时动态 import。
 */
export async function createMeetingAgent(ctx: AgentRunContext) {
  const core = await import("@earendil-works/pi-agent-core");
  const { getModels, getModel } = await import("@/lib/llm");
  const { searchTranscript, saveMinutes } = await import("@/lib/tools");

  const models = await getModels();
  const model = await getModel();

  const tools = [
    {
      name: "search_transcript",
      label: "检索原话",
      description: "按关键词在会议转写中检索相关原话，返回带 turnId 的片段。",
      parameters: searchTranscriptParams,
      execute: async (_id: string, params: { query: string; limit?: string }) => {
        const gate = guardToolCall(ctx, "search_transcript");
        if (gate.block) throw new Error(gate.reason);
        const hits = await searchTranscript(
          { ...ctx },
          params.query,
          Number(params.limit ?? 5) || 5,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(hits) }],
          details: { count: hits.length },
        };
      },
    },
    {
      name: "save_minutes",
      label: "保存纪要",
      description: "把结构化的会议纪要写入权威数据源。这是唯一写入路径。",
      parameters: saveMinutesParams,
      execute: async (_id: string, params: Record<string, unknown>) => {
        const gate = guardToolCall(ctx, "save_minutes");
        if (gate.block) throw new Error(gate.reason);
        const res = await saveMinutes({ ...ctx }, params as never);
        return {
          content: [{ type: "text", text: JSON.stringify(res) }],
          details: res,
        };
      },
    },
  ];

  const agent = new core.Agent({
    initialState: {
      systemPrompt: [
        "你是会议纪要 Agent。",
        "你只能在当前阶段内自主决定调用哪些工具、调用几次。",
        "阶段边界由系统控制，你不能跳阶段。",
        "所有结论必须能对应到转写话轮，不得编造。",
        "保存纪要只能通过 save_minutes 工具，不能以其他方式写库。",
      ].join("\n"),
      model,
      tools: tools as never,
    },
    streamFn: models.streamSimple.bind(models) as never,
    // 第 2 层权限：工具执行前的硬闸门
    beforeToolCall: async (context: { toolCall: { name: string } }) => {
      const gate = guardToolCall(ctx, context.toolCall.name);
      if (gate.block) {
        return {
          terminate: true,
          result: {
            content: [{ type: "text" as const, text: `工具调用被拒绝：${gate.reason}` }],
            details: { blocked: true },
            isError: true,
          },
        };
      }
      return undefined;
    },
  });

  return { agent, model, models };
}