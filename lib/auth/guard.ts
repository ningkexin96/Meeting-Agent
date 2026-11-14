// Route Handler 统一守卫 —— 对应 issue #4（第 1 层：RBAC + 统一拦截）
import { NextResponse } from "next/server";
import { getSession, type Session } from "./session";
import { can, type Capability } from "./rbac";

export type Guarded = { session: Session };

export async function guard(cap: Capability): Promise<
  { ok: true; session: Session } | { ok: false; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "未登录" }, { status: 401 }) };
  }
  if (!can(session.role, cap)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `角色 ${session.role} 无权限执行 ${cap}` },
        { status: 403 },
      ),
    };
  }
  return { ok: true, session };
}