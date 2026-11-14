"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function NewMeetingForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        新建会议
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5">
      <Input
        className="h-8 w-40"
        placeholder="会议标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted">
        <Upload className="size-3.5" />
        {file ? file.name.slice(0, 12) : "音频"}
        <input
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <Button size="sm" disabled={busy}>
        {busy ? "创建中…" : "创建"}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOpen(false)}>
        <X className="size-3.5" />
      </Button>
      {msg && <span className="text-xs text-error">{msg}</span>}
    </form>
  );
}