import { VoiceprintPanel } from "@/components/voiceprint-panel";
import { getSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function VoiceprintsPage() {
  const session = await getSession();
  if (!session) return null; // 登录页由 (app)/layout.tsx 统一渲染
  const canEdit = session.role === "owner" || session.role === "member";

  return (
    <div className="space-y-4">
      <PageHeader
        title="说话人识别"
        subtitle="区分「有几个人」已支持；识别「这是谁」需外部声纹服务，或在会议中手动标注"
      />

      <VoiceprintPanel
        canEdit={canEdit}
        currentUserId={session.userId}
        canManageOthers={session.role === "owner"}
      />
    </div>
  );
}