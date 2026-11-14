// 会话（MVP：cookie 存 email，seed 用户免密登录）
// 对应 issue #4 —— 第 0 层：身份
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/client";

export const SESSION_COOKIE = "ma_user";

export type Session = {
  userId: string;
  tenantId: string;
  role: string;
  name: string;
  email: string;
};

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const email = store.get(SESSION_COOKIE)?.value;
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;
  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    name: user.name,
    email: user.email,
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