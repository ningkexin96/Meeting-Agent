// Skill 列表 API —— 供前端选择会议类型
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listSkills } from "@/lib/skills";
import "@/lib/skills/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  return NextResponse.json({
    items: listSkills().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      bestFor: s.bestFor,
      isDefault: Boolean(s.isDefault),
      focus: s.focus,
    })),
  });
}