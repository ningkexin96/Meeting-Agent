// 会话 —— 第 0 层：身份
//
// 改造说明：原实现把 email 直接放在 cookie 里，等于任何人手改 cookie
// 就能变成别的用户。现在 cookie 存随机 token，库里存 sha256(token)，
// 校验要走数据库，登出/禁用能真正失效。

import { cookies } from "next/headers";
import { resolveSession, SESSION_COOKIE } from "./credentials";

export { SESSION_COOKIE };

export type Session = {
  userId: string;
  tenantId: string;
  role: string;
  name: string;
  email: string;
  avatarEmoji: string;
  avatarColor: string;
};

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token);
  if (!user) return null;

  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    name: user.name,
    email: user.email,
    avatarEmoji: user.avatarEmoji,
    avatarColor: user.avatarColor,
  };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("未登录");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "无权限") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function scopeOf(s: Session) {
  return { tenantId: s.tenantId, userId: s.userId, role: s.role };
}