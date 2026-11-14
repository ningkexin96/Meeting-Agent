import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(req: Request) {
  const { email } = await req.json();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  const store = await cookies();
  store.set(SESSION_COOKIE, user.email, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.json({ ok: true, role: user.role });
}