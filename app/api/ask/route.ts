// 跨会议追问 —— 对应 issue #16（单轮、带引用、租户隔离）
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { recallMemory } from "@/lib/tools";
import { isMockLlm } from "@/lib/llm";
import { mockAnswer } from "@/lib/mock-llm";

export async function POST(req: Request) {
  const g = await guard("memory:read");
  if (!g.ok) return g.response;
  const { session } = g;

  const { question } = await req.json() as { question?: string };
  const q = (question ?? "").trim();
  if (!q) return NextResponse.json({ error: "问题不能为空" }, { status: 400 });

  const hits = await recallMemory(
    { tenantId: session.tenantId, userId: session.userId, role: session.role },
    q,
  );

  let answer: string;
  if (isMockLlm() || hits.length === 0) {
    answer = mockAnswer(q, hits.map((h) => ({ title: h.title, text: h.text })));
  } else {
    const { callModel } = await import("@/lib/agent/llm-call");
    const ctx = hits.map((h, i) => `${i + 1}. 《${h.title}》${h.text}`).join("\n");
    answer = await callModel(
      `只依据下面的资料回答问题，资料没有就说没找到，不要编造。\n\n资料：\n${ctx}\n\n问题：${q}`,
      "answer",
    );
  }

  return NextResponse.json({ answer, references: hits });
}