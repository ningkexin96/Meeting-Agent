// 已登录区域的外壳：侧边栏 + 顶栏 + 内容区
// 未登录时直接渲染登录页，不套外壳
import { getSession } from "@/lib/auth/session";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { AuthPanel } from "@/components/login-panel";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  // 未登录：整屏登录页，不带侧边栏
  if (!session) {
    // 注册入口的可见性必须和服务端规则一致，否则用户点了才收到 403
    const registerEnabled =
      process.env.NODE_ENV !== "production" || process.env.ALLOW_PUBLIC_REGISTER === "1";
    return <AuthPanel registerEnabled={registerEnabled} />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar session={session} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar session={session} />
        <main className="flex-1 overflow-y-auto overscroll-y-none">
          <div className="mx-auto w-full max-w-6xl p-4 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}