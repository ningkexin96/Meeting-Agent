import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meeting Agent · 智能会议纪要",
  description: "上传音频或会中录音 → 实时转写 → 结构化纪要，每条结论可回溯到原话",
};

// 根布局只负责 html/body，不决定外壳。
// 登录页与已登录页面的布局差异由各自的 layout 决定（见 app/(app)/layout.tsx）。
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}