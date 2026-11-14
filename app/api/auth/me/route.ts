// 当前用户信息 —— 供前端判断登录态
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null }, { status: 401 });

  return NextResponse.json({
    user: {
      id: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      avatarEmoji: session.avatarEmoji,
      avatarColor: session.avatarColor,
    },
  });
}