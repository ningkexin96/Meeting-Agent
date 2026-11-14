import type { Metadata } from "next";
import "./globals.css";
import { getSession } from "@/lib/auth/session";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

export const metadata: Metadata = {
  title: "Meeting Agent · 智能会议纪要",
  description: "上传音频或会中录音 → 实时转写 → 结构化纪要，每条结论可回溯到原话",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <html lang="zh-CN">
      <body>
        <div className="flex h-screen overflow-hidden">
          <Sidebar session={session} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <TopBar session={session} />
            <main className="flex-1 overflow-y-auto overscroll-y-none">
              <div className="mx-auto w-full max-w-6xl p-4 lg:p-8">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}