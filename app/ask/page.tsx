import { AskForm } from "@/components/ask-form";
import { getSession } from "@/lib/auth/session";
import { LoginPanel } from "@/components/login-panel";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const session = await getSession();
  if (!session) return <LoginPanel />;

  return (
    <div className="space-y-4">
      <PageHeader title="跨会议追问" subtitle="检索历史纪要与增量记忆，回答必带引用" />
      <AskForm />
    </div>
  );
}