"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewMeetingForm({ role }: { role: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const allowed = role === "owner" || role === "member";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("title", title || "未命名会议");
    if (file) fd.append("audio", file);
    const res = await fetch("/api/meetings", { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(data.error ?? "创建失败");
      return;
    }
    router.push(`/meetings/${data.id}`);
  }

  if (!allowed) {
    return (
      <div className="max-w-sm text-right text-xs text-slate-500">
        当前角色 <b>{role}</b> 无创建会议权限（对应 issue #4 第 1 层 RBAC）
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full max-w-md space-y-2">
      <input
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        placeholder="会议标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          type="file"
          accept="audio/*"
          className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button className="btn-primary" disabled={busy}>
          {busy ? "上传中…" : "创建会议"}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        不选音频也可以创建（会使用预置样例转写，保证演示可跑通）。
      </p>
      {msg && <p className="text-xs text-rose-600">{msg}</p>}
    </form>
  );
}