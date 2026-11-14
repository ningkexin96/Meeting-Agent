"use client";

/** 侧边栏 —— 对齐 Miniclaw UnifiedSidebar 的视觉语言 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  AudioLines,
  CalendarDays,
  LogOut,
  MessageSquareText,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Session = { name: string; role: string; email: string } | null;

const NAV = [
  { href: "/", label: "会议列表", icon: CalendarDays, exact: true },
  { href: "/ask", label: "跨会议追问", icon: MessageSquareText },
  { href: "/voiceprints", label: "说话人识别", icon: Mic },
];

const ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  member: "成员",
  viewer: "只读",
};

export function Sidebar({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
  }

  return (
    <aside
      className={cn(
        "hidden h-screen shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 lg:flex",
        collapsed ? "w-[60px]" : "w-[236px]",
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 px-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <AudioLines className="size-[18px]" />
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-tight">Meeting Agent</div>
            <div className="truncate text-[11px] text-muted-foreground">智能会议纪要</div>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCollapsed((v) => !v)}
          className={cn("shrink-0 text-muted-foreground", collapsed && "mx-auto")}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {!collapsed && (
          <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            工作台
          </div>
        )}
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                collapsed && "justify-center px-0",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* 能力提示 */}
      {!collapsed && (
        <div className="mx-2 mb-2 rounded-lg bg-primary/5 p-2.5 ring-1 ring-primary/10">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
            <Sparkles className="size-3.5" />
            已启用能力
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Badge variant="info" className="h-[18px] px-1.5 text-[10px]">实时转写</Badge>
            <Badge variant="info" className="h-[18px] px-1.5 text-[10px]">声纹识别</Badge>
            <Badge variant="info" className="h-[18px] px-1.5 text-[10px]">语义检索</Badge>
          </div>
        </div>
      )}

      {/* User */}
      {session && (
        <div
          className={cn(
            "border-t border-border p-2",
            collapsed ? "flex justify-center" : "",
          )}
        >
          {collapsed ? (
            <Button variant="ghost" size="icon-sm" onClick={logout} title="退出登录">
              <LogOut className="size-4" />
            </Button>
          ) : (
            <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {session.name.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium leading-tight">{session.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {ROLE_LABEL[session.role] ?? session.role}
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={logout} title="退出登录">
                <LogOut className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}