// 登录 —— 邮箱 + 密码
// 安全要点：
// 1. 用户不存在与密码错误返回同一条提示，避免枚举账号
// 2. 校验失败也跑一次 bcrypt，抹平时间差（防时序侧信道）
// 3. 成功后签发随机 token 会话（不是把邮箱写进 cookie）

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/client";
import {
  createSession,
  sessionCookieOptions,
  SESSION_COOKIE,
  verifyPassword,
} from "@/lib/auth/credentials";

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  if (!email || !password) {
    return NextResponse.json({ error: "请输入账号和密码" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // 用户不存在时也跑一次比对，避免通过响应时间探测账号是否存在
  const hash =
    user?.passwordHash ??
    "$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) {
    return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
  }

  if (user.status !== "active") {
    return NextResponse.json({ error: "账号已被禁用，请联系管理员" }, { status: 403 });
  }

  const { token } = await createSession(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions);

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarEmoji: user.avatarEmoji,
      avatarColor: user.avatarColor,
    },
  });
}