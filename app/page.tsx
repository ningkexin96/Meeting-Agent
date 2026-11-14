import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { NewMeetingForm } from "@/components/new-meeting-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="card p-8">
        <h1 className="text-xl font-semibold">智能会议纪要 Agent</h1>
        <p className="mt-2 text-sm text-slate-600">
          请在右上角选择一个演示账号登录。owner 与 member 可以触发 Agent，viewer 只能查看。
        </p>
      </div>
    );
  }

  const meetings = await prisma.meeting.findMany({
    where: { tenantId: session.tenantId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { turns: true } } },
  });

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold">会议列表</h1>
            <p className="mt-1 text-sm text-slate-600">
              上传音频 → 触发 Agent → 生成可溯源的结构化纪要。
            </p>
          </div>
          <NewMeetingForm role={session.role} />
        </div>
      </section>

      <section className="grid gap-3">
        {meetings.length === 0 && (
          <div className="card p-6 text-sm text-slate-500">还没有会议。先运行 pnpm db:seed 生成样例数据。</div>
        )}
        {meetings.map((m) => (
          <Link
            key={m.id}
            href={`/meetings/${m.id}`}
            className="card flex items-center justify-between p-4 hover:border-blue-300"
          >
            <div>
              <div className="font-medium">{m.title}</div>
              <div className="mt-1 text-xs text-slate-500">
                {new Date(m.createdAt).toLocaleString("zh-CN")} · {m._count.turns} 话轮
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="pill bg-slate-100 text-slate-600">{m.stage}</span>
              <StatusPill status={m.status} />
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded: "bg-slate-100 text-slate-600",
    transcribing: "bg-amber-50 text-amber-700",
    transcribed: "bg-sky-50 text-sky-700",
    summarizing: "bg-amber-50 text-amber-700",
    extracting: "bg-amber-50 text-amber-700",
    reviewing: "bg-violet-50 text-violet-700",
    done: "bg-emerald-50 text-emerald-700",
    failed: "bg-rose-50 text-rose-700",
  };
  return <span className={`pill ${map[status] ?? "bg-slate-100 text-slate-600"}`}>{status}</span>;
}