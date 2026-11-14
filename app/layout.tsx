import type { Metadata } from "next";
import "./globals.css";
import { getSession } from "@/lib/auth/session";
import Link from "next/link";
import { LoginBar } from "@/components/login-bar";

export const metadata: Metadata = {
  title: "Meeting Agent · 智能会议纪要",
  description: "48 小时 MVP：上传音频 → 转写 → Agent 编排 → 结构化纪要",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return (
    <html lang="zh-CN">
      <body>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-3">
              <Link href="/" className="text-base font-semibold">
                Meeting Agent
              </Link>
              <span className="pill bg-slate-100 text-slate-600">48h MVP</span>
            </div>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              <Link href="/" className="hover:text-blue-600">
                会议列表
              </Link>
              <Link href="/ask" className="hover:text-blue-600">
                跨会议追问
              </Link>
              <Link href="/voiceprints" className="hover:text-blue-600">
                说话人识别
              </Link>
              <LoginBar session={session} />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}