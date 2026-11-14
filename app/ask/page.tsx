import { AskForm } from "@/components/ask-form";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const session = await getSession();
  if (!session) return <div className="card p-8 text-sm">请先登录。</div>;
  return <AskForm />;
}