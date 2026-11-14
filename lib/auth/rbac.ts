// 三层权限第 1 层：RBAC 角色与能力矩阵（硬编码，不允许配置化绕过）
// 对应 issue #4
export type Role = "owner" | "member" | "viewer";

export type Capability =
  | "meeting:create"
  | "meeting:read"
  | "agent:run"
  | "minutes:edit"
  | "memory:read";

const MATRIX: Record<Role, Capability[]> = {
  owner: ["meeting:create", "meeting:read", "agent:run", "minutes:edit", "memory:read"],
  member: ["meeting:create", "meeting:read", "agent:run", "minutes:edit", "memory:read"],
  viewer: ["meeting:read"],
};

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