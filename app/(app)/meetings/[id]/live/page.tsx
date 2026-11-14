import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { LivePanel } from "@/components/live/live-panel";
import { AudioDiagnostics } from "@/components/live/audio-diagnostics";
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
        realtime={["dashscope", "qwen"].includes(process.env.ASR_PROVIDER ?? "")}
      />

      <AudioDiagnostics />

      <Card size="sm">
        <CardContent className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">原理：</span>
          浏览器用 AudioWorklet 采集麦克风，以 100ms 为单位产出 16kHz 单声道 PCM，
          通过 WebSocket 持续推给服务端，服务端转发给云端语音识别，边说边回传结果。
          会议结束后合并为权威纪要。
        </CardContent>
      </Card>
    </div>
  );
}