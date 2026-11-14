// 注册
//
// 安全规则：
// - 默认每个新账号创建独立租户，注册者就是该租户的 owner
// - 只有 DEMO_SHARED_TENANT=1 时才加入共享「演示团队」（仅用于本地演示）
// - 生产环境默认关闭公开注册，必须显式设置 ALLOW_PUBLIC_REGISTER=1

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
  // 生产部署必须显式打开公开注册；本地开发/本地 start 保持演示可用。
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PUBLIC_REGISTER !== "1") {
    return NextResponse.json({ error: "当前环境未开放公开注册，请联系管理员创建账号" }, { status: 403 });
  }

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

  // 默认租户隔离：每个注册账号只看到自己的数据。
  // DEMO_SHARED_TENANT=1 仅用于本地演示模式，绝不能作为生产默认值。
  const useSharedDemoTenant = process.env.DEMO_SHARED_TENANT === "1";
  let tenant: { id: string };
  let role: "owner" | "member" = "owner";

  if (useSharedDemoTenant) {
    const found = await prisma.tenant.findFirst({ where: { name: "演示团队" } });
    tenant = found ?? (await prisma.tenant.create({ data: { name: "演示团队" } }));
    const ownerCount = await prisma.user.count({
      where: { tenantId: tenant.id, role: "owner" },
    });
    role = ownerCount === 0 ? "owner" : "member";
  } else {
    tenant = await prisma.tenant.create({ data: { name: `${name} 的团队` } });
  }

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