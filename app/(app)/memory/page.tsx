import { getSession } from "@/lib/auth/session";
import { MemoryPanel } from "@/components/memory/memory-panel";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const session = await getSession();
  if (!session) return null; // 登录页由 (app)/layout.tsx 统一渲染

  const canEdit = session.role === "owner" || session.role === "member";

  return <MemoryPanel canEdit={canEdit} />;
}