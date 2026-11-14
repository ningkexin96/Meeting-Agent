import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { LivePanel } from "@/components/live/live-panel";

export const dynamic = "force-dynamic";

export default async function LivePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return <div className="card p-8 text-sm">请先登录。</div>;
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({
    where: { id, tenantId: session.tenantId },
  });
  if (!meeting) {
    return <div className="card p-8 text-sm">会议不存在。</div>;
  }

  const canRun = session.role === "owner" || session.role === "member";

  // 该会议是否已有实时转写内容（已结束的会话）
  const [liveSegments, liveItems, lastSession] = await Promise.all([
    prisma.liveSegment.count({ where: { meetingId: meeting.id } }),
    prisma.liveMinuteItem.count({
      where: { session: { meetingId: meeting.id } },
    }),
    prisma.liveSession.findFirst({
      where: { meetingId: meeting.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/meetings/${meeting.id}`} className="text-xs text-slate-500 hover:text-blue-600">
          ← 返回会议详情
        </Link>
        <h1 className="mt-1 text-lg font-semibold">{meeting.title}</h1>
        <p className="mt-1 text-xs text-slate-500">
          实时模式：会议进行中就出转写与增量纪要，结束后合并成正式纪要。
        </p>
        {liveSegments > 0 && (
          <p className="mt-1 text-xs text-emerald-700">
            当前会议已通过实时模式记录 {liveSegments} 条转写、{liveItems} 条纪要条目。
          </p>
        )}
      </div>

      <LivePanel
        meetingId={meeting.id}
        title={meeting.title}
        canRun={canRun}
        lastSessionId={lastSession?.id ?? null}
        lastSessionEnded={lastSession?.status === "ended"}
      />

      <div className="card p-4 text-xs text-slate-500">
        <b className="text-slate-700">原理说明</b>
        <p className="mt-1">
          浏览器用 MediaRecorder 每 4 秒切一个完整分片（不是 timeslice，避免后续分片缺少
          WebM 头无法解码）。服务端逐片调 ASR，按时间偏移累加话轮，跨片时把未结束的句子拼接。
        </p>
        <p className="mt-1">
          增量纪要按窗口抽取（每 4 条转写一次），结果按文本相似度去重后进入过程表；
          会议结束时才合并写入权威 Minutes 表，保持「模型不能直接写权威库」这条底线。
        </p>
      </div>
    </div>
  );
}