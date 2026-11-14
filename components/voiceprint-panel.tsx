"use client";

import { useEffect, useState } from "react";

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
  const [target, setTarget] = useState("");

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
    if (!file) {
      setMsg("请选择一段音频");
      return;
    }
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("audio", file);
    if (target) fd.append("userId", target);
    const res = await fetch("/api/voiceprints", { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(data.error ?? "注册失败");
      return;
    }
    setMsg(`已注册：${data.name}（维度 ${data.dim}，样本 ${data.samples}）`);
    setFile(null);
    void load();
  }

  async function remove(userId: string) {
    await fetch(`/api/voiceprints?userId=${userId}`, { method: "DELETE" });
    void load();
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">声纹库</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            注册后用声纹识别说话人，认不出的标「待复核」而不是硬猜（issue #23）
          </p>
        </div>
        <span className="pill bg-slate-100 text-slate-600">engine: {engine || "-"}</span>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
          还没有声纹。未注册时会议里的说话人会显示为「未知参会者」并标记待复核。
        </p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {items.map((it) => (
            <div key={it.userId} className="flex items-center justify-between rounded-lg border border-slate-200 p-2">
              <div className="text-sm">
                <span className="font-medium">{it.name}</span>
                <span className="ml-2 text-xs text-slate-500">{it.email}</span>
                <span className="ml-2 pill bg-slate-100 text-slate-600">
                  {it.dim} 维 · {it.samples} 样本
                </span>
              </div>
              {canEdit && (
                <button className="text-xs text-rose-600" onClick={() => remove(it.userId)}>
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <form onSubmit={register} className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              type="file"
              accept="audio/*"
              className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button className="btn-primary text-xs" disabled={busy}>
              {busy ? "提取中…" : "注册声纹"}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            默认给当前登录用户注册。想给别人注册，需要先在该用户下有可用音频。
          </p>
          {msg && <p className="text-xs text-blue-600">{msg}</p>}
        </form>
      )}
    </div>
  );
}