// 会议创建 —— 对应 issue #5（上传）与 #4（RBAC）
import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/client";
import { guard } from "@/lib/auth/guard";
import { audit } from "@/lib/db/scoped";

export async function POST(req: Request) {
  const g = await guard("meeting:create");
  if (!g.ok) return g.response;
  const { session } = g;

  const form = await req.formData();
  const title = String(form.get("title") ?? "").trim() || "未命名会议";
  const audio = form.get("audio");

  let audioPath: string | null = null;
  if (audio && typeof audio !== "string" && audio.size > 0) {
    if (audio.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: "音频超过 50MB 限制" }, { status: 400 });
    }
    const dir = path.join(process.cwd(), process.env.STORAGE_DIR ?? "./storage");
    await mkdir(dir, { recursive: true });
    const safe = `${Date.now()}-${audio.name.replace(/[^\w.\-]/g, "_")}`;
    await writeFile(path.join(dir, safe), Buffer.from(await audio.arrayBuffer()));
    audioPath = safe;
  }

  const meeting = await prisma.meeting.create({
    data: {
      tenantId: session.tenantId,
      title,
      status: "uploaded",
      stage: "PREPARING",
      audioPath,
      createdBy: session.userId,
    },
  });

  await audit(session, "meeting.created", { title, hasAudio: Boolean(audioPath) }, meeting.id);
  return NextResponse.json({ id: meeting.id });
}