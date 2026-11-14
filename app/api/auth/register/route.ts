// 注册 —— 无需邀请码
//
// 规则（对齐 Miniclaw）：
// - 邮箱格式校验、密码 8-128 位
// - 第一个注册的人成为该租户的 owner，其余为 member
// - 默认加入「演示团队」这个租户，保证新用户能看到数据

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/client";
import {
  createSession,
  hashPassword,
  sessionCookieOptions,
  SESSION_COOKIE,
  validateEmail,
  validatePassword,
} from "@/lib/auth/credentials";

const AVATAR_COLORS = ["#0d9488", "#0891b2", "#7c3aed", "#db2777", "#ea580c", "#4f46e5"];

export async function POST(req: Request) {
  let body: { email?: string; password?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim() || email.split("@")[0];

  const emailErr = validateEmail(email);
  if (emailErr) return NextResponse.json({ error: emailErr }, { status: 400 });

  const pwdErr = validatePassword(password);
  if (pwdErr) return NextResponse.json({ error: pwdErr }, { status: 400 });

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    return NextResponse.json({ error: "该邮箱已注册，请直接登录" }, { status: 409 });
  }

  // 默认落到演示团队；租户不存在则创建
  let tenant = await prisma.tenant.findFirst({ where: { name: "演示团队" } });
  if (!tenant) {
    tenant = await prisma.tenant.create({ data: { name: "演示团队" } });
  }

  // 该租户没有 owner 时，第一个注册的人是 owner
  const ownerCount = await prisma.user.count({
    where: { tenantId: tenant.id, role: "owner" },
  });
  const role = ownerCount === 0 ? "owner" : "member";

  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email,
      name,
      role,
      passwordHash: await hashPassword(password),
      avatarEmoji: "👤",
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      lastLoginAt: new Date(),
    },
  });

  const { token } = await createSession(user.id);
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