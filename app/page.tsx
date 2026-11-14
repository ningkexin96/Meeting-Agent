import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Clock3,
  FileText,
  Plus,
  Waves,
} from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { NewMeetingForm } from "@/components/new-meeting-form";
import { LoginPanel } from "@/components/login-panel";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ModeBanner } from "@/components/mode-banner";
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

export default async function HomePage() {
  const session = await getSession();
  if (!session) return <LoginPanel />;

  const meetings = await prisma.meeting.findMany({
    where: { tenantId: session.tenantId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { turns: true } } },
  });

  const canCreate = session.role === "owner" || session.role === "member";
  const asrMode = getAsrModeInfo();
  const doneCount = meetings.filter((m) => m.status === "done").length;

  return (
    <div className="space-y-6">
      <ModeBanner asr={asrMode} />

      <PageHeader
        title="会议列表"
        subtitle="上传音频或会中录音，Agent 自动生成可溯源纪要"
        actions={canCreate ? <NewMeetingForm /> : undefined}
      />

      {/* 概览 */}
      <div className="grid gap-2 sm:grid-cols-3">
        <StatCard icon={CalendarDays} label="会议总数" value={String(meetings.length)} />
        <StatCard icon={FileText} label="已生成纪要" value={String(doneCount)} />
        <StatCard
          icon={Clock3}
          label="累计话轮"
          value={String(meetings.reduce((s, m) => s + m._count.turns, 0))}
        />
      </div>

      {/* 列表 */}
      <div className="space-y-2">
        {meetings.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              还没有会议。运行 <code className="rounded bg-muted px-1 py-0.5 text-xs">pnpm db:seed</code> 生成样例数据，或点右上角新建。
            </CardContent>
          </Card>
        )}

        {meetings.map((m) => {
          const meta = STATUS_META[m.status] ?? { label: m.status, variant: "neutral" as const };
          return (
            <Link key={m.id} href={`/meetings/${m.id}`} className="block group">
              <Card
                size="sm"
                className="transition-all group-hover:ring-primary/30 group-hover:shadow-card"
              >
                <CardContent className="flex items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Waves className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{new Date(m.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                      <span className="text-border">·</span>
                      <span>{m._count.turns} 话轮</span>
                    </div>
                  </div>
                  <Badge variant={meta.variant} className="shrink-0">
                    {meta.label}
                  </Badge>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold leading-tight">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}