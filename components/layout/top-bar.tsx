"use client";

/** 移动端顶栏 + 登录态切换 —— 桌面端由侧边栏承担导航 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { AudioLines, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Session = { name: string; role: string; email: string } | null;

const DEMO_USERS = [
  { email: "owner@demo.dev", label: "张伟", role: "owner" },
  { email: "member@demo.dev", label: "李娜", role: "member" },
  { email: "viewer@demo.dev", label: "王强", role: "viewer" },
];

const NAV = [
  { href: "/", label: "会议列表" },
  { href: "/ask", label: "跨会议追问" },
  { href: "/voiceprints", label: "说话人识别" },
];

export function TopBar({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function login(email: string) {
    setBusy(true);
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setOpen(false);
    router.refresh();
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4 lg:hidden">
      <Link href="/" className="flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <AudioLines className="size-4" />
        </div>
        <span className="text-sm font-semibold">Meeting Agent</span>
      </Link>

      <Button variant="ghost" size="icon-sm" onClick={() => setOpen((v) => !v)}>
        {open ? <X className="size-4" /> : <Menu className="size-4" />}
      </Button>

      {open && (
        <div className="absolute left-0 right-0 top-14 z-50 animate-fade-in border-b border-border bg-background p-3 shadow-lg">
          <div className="space-y-0.5">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "block rounded-lg px-3 py-2 text-sm",
                  pathname === n.href
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground",
                )}
              >
                {n.label}
              </Link>
            ))}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 px-1 text-[11px] font-medium text-muted-foreground">演示账号</div>
            <div className="grid grid-cols-3 gap-1.5">
              {DEMO_USERS.map((u) => (
                <Button
                  key={u.email}
                  variant={session?.email === u.email ? "default" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => login(u.email)}
                >
                  {u.label}
                </Button>
              ))}
            </div>
            {session && (
              <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={logout}>
                退出登录
              </Button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}