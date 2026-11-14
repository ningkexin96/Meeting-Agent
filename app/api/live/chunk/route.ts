// 分片上传 —— 对应 issue #26
// POST /api/live/chunk  multipart: sessionId, seq, startMs, endMs, audio
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getSession } from "@/lib/live/session";
import { processChunk } from "@/lib/live/transcribe";
import { extractIncrement } from "@/lib/live/extract";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const g = await guard("agent:run");
  if (!g.ok) return g.response;
  const { session: auth } = g;

  const form = await req.formData();
  const sessionId = String(form.get("sessionId") ?? "");
  const seq = Number(form.get("seq") ?? -1);
  const startMs = Number(form.get("startMs") ?? 0);
  const endMs = Number(form.get("endMs") ?? 0);
  const audio = form.get("audio");

  if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
  if (!Number.isFinite(seq) || seq < 0) {
    return NextResponse.json({ error: "seq 非法" }, { status: 400 });
  }
  if (!audio || typeof audio === "string") {
    return NextResponse.json({ error: "缺少音频分片" }, { status: 400 });
  }
  if (audio.size === 0) {
    return NextResponse.json({ error: "音频分片为空" }, { status: 400 });
  }
  if (audio.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "单个分片不能超过 10MB" }, { status: 400 });
  }

  // 第 3 层隔离：会话必须属于当前租户
  const live = await getSession(sessionId, auth.tenantId);
  if (!live) return NextResponse.json({ error: "会话不存在或不属于当前租户" }, { status: 404 });
  if (live.status !== "live") {
    return NextResponse.json({ error: `会话已${live.status === "ended" ? "结束" : "失效"}` }, { status: 409 });
  }

  const name = (audio as File).name || "chunk.webm";
  const ext = (name.split(".").pop() || "webm").toLowerCase();
  const buffer = Buffer.from(await audio.arrayBuffer());

  const result = await processChunk({
    sessionId,
    seq,
    startMs,
    endMs,
    audio: buffer,
    ext,
  });

  // 每片处理完尝试抽一次增量（内部会判断窗口是否够）
  let newItems: unknown[] = [];
  if (result.ok) {
    try {
      newItems = await extractIncrement(sessionId);
    } catch (e) {
      console.warn(`[live] 增量抽取失败：${(e as Error).message}`);
    }
  }

  return NextResponse.json({
    ok: result.ok,
    added: result.added,
    error: result.error,
    newItems,
  });
}