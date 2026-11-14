import { VoiceprintPanel } from "@/components/voiceprint-panel";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function VoiceprintsPage() {
  const session = await getSession();
  if (!session) return <div className="card p-8 text-sm">请先登录。</div>;
  const canEdit = session.role === "owner" || session.role === "member";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">说话人识别</h1>
        <p className="mt-1 text-sm text-slate-600">
          注册声纹后，会议里的说话人会被自动认领。认不出的保留为「未知参会者」并标记待复核，
          这是刻意的设计：宁可让人改，也不要模型硬猜。
        </p>
      </div>
      <VoiceprintPanel canEdit={canEdit} />
    </div>
  );
}