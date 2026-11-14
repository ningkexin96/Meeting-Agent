"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Session = { name: string; role: string; email: string } | null;

const USERS = [
  { email: "owner@demo.dev", label: "张伟（owner）" },
  { email: "member@demo.dev", label: "李娜（member）" },
  { email: "viewer@demo.dev", label: "王强（viewer）" },
];

export function LoginBar({ session }: { session: Session }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function login(email: string) {
    setBusy(true);
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    router.refresh();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
  }

  if (session) {
    return (
      <div className="flex items-center gap-2">
        <span className="pill bg-emerald-50 text-emerald-700">
          {session.name} · {session.role}
        </span>
        <button className="btn-ghost" onClick={logout}>
          退出
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500">演示登录：</span>
      {USERS.map((u) => (
        <button
          key={u.email}
          className="btn-ghost text-xs"
          disabled={busy}
          onClick={() => login(u.email)}
        >
          {u.label}
        </button>
      ))}
    </div>
  );
}