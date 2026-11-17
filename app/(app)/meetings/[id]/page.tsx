import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Radio } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { AgentRunner } from "@/components/agent-runner";
import { getRunHistory } from "@/lib/agent/run-history";
import { TranscriptView } from "@/components/transcript-view";
import { MinutesView } from "@/components/minutes-view";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ModeBanner } from "@/components/mode-banner";
import { DeleteMeetingButton } from "@/components/delete-meeting-button";
import { canDeleteMeeting } from "@/lib/auth/rbac";
import { getAsrModeInfo } from "@/lib/asr/mode";

export const dynamic = "force-dynamic";

const STATUS_META: Record<string, { label: string; variant: "success" | "warning" | "error" | "info" | "neutral" }> = {
  done: { label: "已完成", variant: "success" },
  failed: { label: "失败", variant: "error" },
  uploaded: { label: "待处理", variant: "neutral" },
  transcribing: { label: "转写中", variant: "warning" },
  transcribed: { label: "转写完成", variant: "info" },
  summarizing: { label: "摘要中", variant: "warning" },
  extracting: { label: "抽取中", variant: "warning" },
  reviewing: { label: "待复核", variant: "info" },
};

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return null; // 登录页由 (app)/layout.tsx 统一渲染
  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({
    where: { id, tenantId: session.tenantId },
    include: {
      participants: true,
      turns: { include: { participant: true }, orderBy: { idx: "asc" } },
      minutes: { include: { actionItems: true, decisions: true, risks: true } },
    },
  });
  if (!meeting) notFound();

  const canEdit = session.role === "owner" || session.role === "member";
  const asrMode = getAsrModeInfo();
  const meta = STATUS_META[meeting.status] ?? { label: meeting.status, variant: "neutral" as const };

  return (
    <div className="space-y-4">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        返回会议列表
      </Link>

      <PageHeader
        title={meeting.title}
        subtitle={`${new Date(meeting.createdAt).toLocaleString("zh-CN", { hour12: false })} · ${meeting.turns.length} 话轮`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={meta.variant}>{meta.label}</Badge>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/meetings/${meeting.id}/live`}>
                <Radio className="size-3.5 text-error" />
                实时模式
              </Link>
            </Button>
            {/* 详情页长期停留，删除入口放在这里比只在列表里更顺手 */}
            <DeleteMeetingButton
              meetingId={meeting.id}
              title={meeting.title}
              canDelete={canDeleteMeeting(session.role)}
              variant="menu"
              redirectTo="/"
            />
          </div>
        }
      />

      {/* 没有音频、也没录音，却可能有预置转写——必须解释清楚 */}
      {asrMode.demo && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-bg px-3 py-2 text-xs text-warning">
          <span className="mt-0.5 shrink-0">⚠️</span>
          <span>
            当前是<b>演示数据模式</b>，系统不解析音频。即使这场会议没有上传任何音频，
            「生成纪要」也会产出同一份预置的周会文本。切换为真实识别请修改 .env 后重启。
          </span>
        </div>
      )}

      {meeting.error && (
        <div className="rounded-lg bg-error-bg px-3 py-2 text-xs text-error">
          上次运行失败：{meeting.error}
        </div>
      )}

      <AgentRunner
        meetingId={meeting.id}
        role={session.role}
        initialStage={meeting.stage}
        hasMinutes={Boolean(meeting.minutes)}
        history={await getRunHistory(meeting.id)}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <TranscriptView
          turns={meeting.turns}
          participants={meeting.participants}
          canEdit={canEdit}
          meetingId={meeting.id}
        />
        <MinutesView
          meetingId={meeting.id}
          minutes={meeting.minutes}
          canEdit={canEdit}
        />
      </div>
    </div>
  );
}