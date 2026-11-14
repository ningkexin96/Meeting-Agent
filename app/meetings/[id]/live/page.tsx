import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { LivePanel } from "@/components/live/live-panel";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { LoginPanel } from "@/components/login-panel";

export const dynamic = "force-dynamic";

export default async function LivePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return <LoginPanel />;
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!meeting) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          会议不存在。
        </CardContent>
      </Card>
    );
  }

  const canRun = session.role === "owner" || session.role === "member";
  const [segCount, lastSession] = await Promise.all([
    prisma.liveSegment.count({ where: { meetingId: meeting.id } }),
    prisma.liveSession.findFirst({
      where: { meetingId: meeting.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="space-y-4">
      <Link
        href={`/meetings/${meeting.id}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        返回会议详情
      </Link>

      <PageHeader
        title={meeting.title}
        subtitle={
          segCount > 0
            ? `实时录制中 · 已记录 ${segCount} 条转写`
            : "会议进行中边说边出转写与增量纪要"
        }
      />

      <LivePanel
        meetingId={meeting.id}
        canRun={canRun}
        lastSessionId={lastSession?.id ?? null}
      />

      <Card size="sm">
        <CardContent className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">原理：</span>
          浏览器每 4 秒切一个完整分片（不是 timeslice，避免后续分片缺 WebM 头无法解码）。
          服务端逐片调 ASR，按时间偏移累加话轮，跨片时把未结束的句子拼接。
          增量纪要按窗口抽取并按相似度去重，会议结束才合并写入权威纪要表。
        </CardContent>
      </Card>
    </div>
  );
}