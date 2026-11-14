"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus, Upload, X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function NewMeetingForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [skillId, setSkillId] = useState<string>("");
  const [skills, setSkills] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const res = await fetch("/api/skills");
      if (!res.ok) return;
      const data = await res.json();
      setSkills(data.items ?? []);
      const def = (data.items ?? []).find((s: { isDefault: boolean }) => s.isDefault);
      if (def) setSkillId(def.id);
    })();
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("title", title || "未命名会议");
    if (skillId) fd.append("skillId", skillId);
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
      <div className="relative">
        <select
          value={skillId}
          onChange={(e) => setSkillId(e.target.value)}
          className="h-8 appearance-none rounded-lg border border-border bg-background pl-2.5 pr-7 text-xs text-foreground outline-none transition-colors hover:bg-muted focus:ring-2 focus:ring-ring/40"
          title="会议类型决定抽取重点"
        >
          {skills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
      </div>
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