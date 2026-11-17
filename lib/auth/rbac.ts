// 三层权限第 1 层：RBAC 角色与能力矩阵（硬编码，不允许配置化绕过）
// 对应 issue #4
export type Role = "owner" | "member" | "viewer";

export type Capability =
  | "meeting:create"
  | "meeting:read"
  /** 删除会议：不可逆，比编辑更严格，只给 owner（issue #30） */
  | "meeting:delete"
  | "agent:run"
  | "minutes:edit"
  | "memory:read";

const MATRIX: Record<Role, Capability[]> = {
  owner: ["meeting:create", "meeting:read", "meeting:delete", "agent:run", "minutes:edit", "memory:read"],
  // member 可以建会、改纪要，但不能删会：删除会连带清掉转写、纪要和沉淀的记忆，
  // 一旦误删无法恢复。这是个一次性判断，交给对数据负责的 owner 更合适。
  member: ["meeting:create", "meeting:read", "agent:run", "minutes:edit", "memory:read"],
  viewer: ["meeting:read"],
};

/** 谁能删会议（前端用它决定是否显示删除入口，与服务端同一份规则） */
export function canDeleteMeeting(role: string): boolean {
  return can(role, "meeting:delete");
}

export function can(role: string, cap: Capability): boolean {
  const caps = MATRIX[(role as Role) ?? "viewer"];
  return Boolean(caps?.includes(cap));
}

// 工具级白名单：第 2 层权限闸门（beforeToolCall）直接读这里
export const TOOL_ROLES: Record<string, Role[]> = {
  run_transcription: ["owner", "member"],
  search_transcript: ["owner", "member", "viewer"],
  save_minutes: ["owner", "member"],
  recall_meeting_memory: ["owner", "member"],
};

export function canUseTool(role: string, toolName: string): boolean {
  const allowed = TOOL_ROLES[toolName];
  if (!allowed) return false; // 未登记的工具默认拒绝（fail-closed）
  return allowed.includes(role as Role);
}