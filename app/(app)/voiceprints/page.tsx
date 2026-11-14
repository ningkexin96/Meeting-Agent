import { VoiceprintPanel } from "@/components/voiceprint-panel";
import { getSession } from "@/lib/auth/session";

import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Info } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function VoiceprintsPage() {
  const session = await getSession();
  if (!session) return null; // 登录页由 (app)/layout.tsx 统一渲染
  const canEdit = session.role === "owner" || session.role === "member";

  return (
    <div className="space-y-4">
      <PageHeader
        title="说话人识别"
        subtitle="注册声纹后自动认领说话人，认不出保留为未知并标记待复核"
      />

      <VoiceprintPanel canEdit={canEdit} />

      <Card size="sm">
        <CardContent className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span>
            设计取舍：认不出说话人时宁可标记「未知参会者」，也不挑最像的硬套。
            会议纪要的价值在于可信，一条「可能是某人说的」比「未知」更有害。
          </span>
        </CardContent>
      </Card>
    </div>
  );
}