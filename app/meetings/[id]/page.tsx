import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { AgentRunner } from "@/components/agent-runner";
import { TranscriptView } from "@/components/transcript-view";
import { MinutesView } from "@/components/minutes-view";

export const dynamic = "force-dynamic";

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return <div className="card p-8 text-sm">请先登录。</div>;
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({
    where: { id, tenantId: session.tenantId },
    include: {
      participants: true,
      turns: { include: { participant: true }, orderBy: { idx: "asc" } },
      summaries: { orderBy: { idx: "asc" } },
      minutes: {
        include: {
          actionItems: true,
          decisions: true,
          risks: true,
        },
      },
    },
  });
  if (!meeting) notFound();

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/" className="text-xs text-slate-500 hover:text-blue-600">
            ← 返回会议列表
          </Link>
          <h1 className="mt-1 text-lg font-semibold">{meeting.title}</h1>
          <p className="mt-1 text-xs text-slate-500">
            状态：{meeting.status} · 阶段：{meeting.stage} · 话轮：{meeting.turns.length}
            {meeting.error ? ` · 错误：${meeting.error}` : ""}
          </p>
        </div>
        <Link
          href={`/meetings/${meeting.id}/live`}
          className="btn-ghost text-xs"
          title="会议进行中边说边出纪要"
        >
          ● 实时模式
        </Link>
      </div>

      <AgentRunner meetingId={meeting.id} role={session.role} initialStage={meeting.stage} />

      <div className="grid gap-5 lg:grid-cols-2">
        <TranscriptView
          turns={meeting.turns}
          participants={meeting.participants}
          canEdit={session.role === "owner" || session.role === "member"}
        />
        <MinutesView
          meetingId={meeting.id}
          minutes={meeting.minutes}
          turns={meeting.turns}
          canEdit={session.role === "owner" || session.role === "member"}
        />
      </div>
    </div>
  );
}