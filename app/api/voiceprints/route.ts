// 声纹管理 API —— 对应 issue #23
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { listVoiceprints, registerVoiceprint, deleteVoiceprint } from "@/lib/voice/store";
import { getEmbedder } from "@/lib/voice/embedder";
import { prisma } from "@/lib/db/client";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { audit } from "@/lib/db/scoped";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("meeting:read");
  if (!g.ok) return g.response;
  try {
    const items = await listVoiceprints(g.session.tenantId);
    return NextResponse.json({ items, engine: getEmbedder().name });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * 注册声纹：上传一段本人说话的音频。
 * 支持给「当前登录用户」注册，也支持 owner 给指定用户注册（userId 参数）。
 */
export async function POST(req: Request) {
  const g = await guard("minutes:edit");
  if (!g.ok) return g.response;
  const { session } = g;

  const form = await req.formData();
  const audio = form.get("audio");
  const targetUserId = String(form.get("userId") ?? "") || session.userId;

  if (!audio || typeof audio === "string" || audio.size === 0) {
    return NextResponse.json({ error: "请上传一段说话音频" }, { status: 400 });
  }
  if (audio.size < 1024) {
    return NextResponse.json(
      { error: `音频太短（${audio.size} 字节），请上传至少 3 秒的清晰人声` },
      { status: 400 },
    );
  }
  if (audio.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "声纹音频不能超过 20MB" }, { status: 400 });
  }

  // 校验目标用户属于本租户（第 3 层隔离）
  const target = await prisma.user.findFirst({
    where: { id: targetUserId, tenantId: session.tenantId },
  });
  if (!target) return NextResponse.json({ error: "用户不存在或不属于当前租户" }, { status: 404 });

  const dir = path.join(process.cwd(), process.env.STORAGE_DIR ?? "./storage", "voiceprints");
  await mkdir(dir, { recursive: true });
  const safe = `${target.id}-${Date.now()}.wav`;
  const abs = path.join(dir, safe);
  await writeFile(abs, Buffer.from(await audio.arrayBuffer()));

  try {
    const embedding = await getEmbedder().embed(abs, 0, 0);
    const res = await registerVoiceprint(session.tenantId, target.id, embedding);
    await audit(session, "voiceprint.registered", { userId: target.id, ...res });
    return NextResponse.json({ ok: true, userId: target.id, name: target.name, ...res });
  } catch (e) {
    return NextResponse.json({ error: `声纹提取失败：${(e as Error).message}` }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const g = await guard("minutes:edit");
  if (!g.ok) return g.response;
  const { session } = g;
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });

  const target = await prisma.user.findFirst({
    where: { id: userId, tenantId: session.tenantId },
  });
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  await deleteVoiceprint(session.tenantId, userId);
  await audit(session, "voiceprint.deleted", { userId });
  return NextResponse.json({ ok: true });
}