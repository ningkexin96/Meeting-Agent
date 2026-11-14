"use client";

import { useEffect, useState } from "react";
import {
  Fingerprint,
  Loader2,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Item = {
  userId: string;
  name: string;
  email: string;
  dim: number;
  samples: number;
  updatedAt: string;
};

export function VoiceprintPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [engine, setEngine] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  async function load() {
    const res = await fetch("/api/voiceprints");
    const data = await res.json();
    setItems(data.items ?? []);
    setEngine(data.engine ?? "");
  }

  useEffect(() => {
    void load();
  }, []);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setMsg("请选择一段音频");
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("audio", file);
    const res = await fetch("/api/voiceprints", { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setMsg(data.error ?? "注册失败");
    setMsg(`已注册：${data.name}（${data.dim} 维，共 ${data.samples} 个样本）`);
    setFile(null);
    void load();
  }

  async function remove(userId: string) {
    await fetch(`/api/voiceprints?userId=${userId}`, { method: "DELETE" });
    void load();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="size-4 text-primary" />
            声纹库
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            注册后可自动识别说话人；认不出的标记待复核，不硬猜
          </p>
        </div>
        <Badge variant="neutral" className="font-mono">
          {engine || "-"}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <div className="rounded-lg bg-warning-bg px-3 py-2.5 text-xs text-warning">
            还没有声纹。未注册时会议里的说话人会显示为「未知参会者」并标记待复核。
          </div>
        ) : (
          <div className="space-y-1.5">
            {items.map((it) => (
              <div
                key={it.userId}
                className="flex items-center gap-2.5 rounded-lg border border-border p-2"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <UserRound className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{it.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{it.email}</div>
                </div>
                <Badge variant="neutral" className="shrink-0 font-mono text-[10px]">
                  {it.dim} 维 · {it.samples} 样本
                </Badge>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(it.userId)}
                    className="shrink-0 text-muted-foreground hover:text-error"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {canEdit && (
          <form onSubmit={register} className="space-y-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="inline-flex h-8 flex-1 min-w-40 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted">
                <Upload className="size-3.5" />
                <span className="truncate">{file ? file.name : "选择一段本人说话的音频"}</span>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <Button size="sm" disabled={busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Fingerprint className="size-3.5" />}
                注册声纹
              </Button>
            </div>
            {msg && <p className="text-xs text-primary">{msg}</p>}
          </form>
        )}
      </CardContent>
    </Card>
  );
}