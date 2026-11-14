"use client";

import { useState } from "react";

type Ref = { meetingId: string; title: string; text: string; importance: number };

export function AskForm() {
  const [q, setQ] = useState("上次关于排期定了什么？");
  const [answer, setAnswer] = useState<string | null>(null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAnswer(null);
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setAnswer(data.error ?? "请求失败");
      return;
    }
    setAnswer(data.answer);
    setRefs(data.references ?? []);
  }

  return (
    <div className="card p-6">
      <h1 className="text-lg font-semibold">跨会议追问</h1>
      <p className="mt-1 text-sm text-slate-600">
        基于增量记忆与历史决议做单轮问答，答案必须带引用（issue #16）。没有相关资料时会明确说没找到。
      </p>
      <form onSubmit={ask} className="mt-4 flex gap-2">
        <input
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn-primary" disabled={busy}>
          {busy ? "检索中…" : "提问"}
        </button>
      </form>

      {answer && (
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">{answer}</div>
      )}

      {refs.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-xs font-medium text-slate-500">引用来源</div>
          {refs.map((r, i) => (
            <div key={i} className="rounded border border-slate-200 p-2 text-xs">
              <span className="pill bg-slate-100 text-slate-600">{r.title}</span>
              <div className="mt-1 text-slate-600">{r.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}