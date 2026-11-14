// 认证核心 —— 对齐 Miniclaw 的实现方式
//
// 三个设计点：
// 1. bcrypt（12 轮）存哈希，永不存明文；比对用 timing-safe 的 compare
// 2. 会话 cookie 存的是「随机 token」而不是邮箱——原实现直接存邮箱，
//    等于任何人改个 cookie 就能变成别人
// 3. 会话表落库，支持服务端主动失效（登出 / 禁用账号）

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";

const BCRYPT_ROUNDS = 12;
export const SESSION_COOKIE = "ma_session";
const SESSION_TTL_DAYS = 7;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** 密码强度校验，与 Miniclaw 一致：8-128 位 */
export function validatePassword(password: string): string | null {
  if (password.length < 8) return "密码长度不能少于 8 位";
  if (password.length > 128) return "密码长度不能超过 128 位";
  return null;
}

/** 邮箱格式校验 */
export function validateEmail(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "请输入有效的邮箱地址";
  if (email.length > 254) return "邮箱过长";
  return null;
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  avatarEmoji: string;
  avatarColor: string;
};

/**
 * 签发会话。
 * 返回的 token 才是 cookie 的值；数据库里只存 token 的哈希，
 * 这样即使库被读走，也无法伪造会话。
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      id: sha256(token),
      userId,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

import { createHash } from "node:crypto";
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 校验 token，返回用户；过期或不存在返回 null */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { id: sha256(token) },
    include: { user: true },
  });

  if (!session) return null;

  // 过期即删
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (session.user.status !== "active") return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    tenantId: session.user.tenantId,
    avatarEmoji: session.user.avatarEmoji ?? "👤",
    avatarColor: session.user.avatarColor ?? "#0d9488",
  };
}

/** 登出：删除会话 */
export async function destroySession(token: string | undefined) {
  if (!token) return;
  await prisma.session.delete({ where: { id: sha256(token) } }).catch(() => {});
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  // 生产 HTTPS 下避免会话 cookie 经明文 HTTP 发出；本地 http://127.0.0.1 开发不受影响。
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
};