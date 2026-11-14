// 纪要视图 —— 对应 issue #14（引用跳转 + 字段级编辑 + unresolved 提示）
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Minutes = {
  id: string;
  overview: string;
  status: string;
  actionItems: { id: string; content: string; owner: string | null; dueAt: string | null; unresolved: boolean; sourceTurnId: string | null }[];
  decisions: { id: string; content: string; sourceTurnId: string | null }[];
  risks: { id: string; content: string; severity: string; sourceTurnId: string | null }[];
} | null;

type Turn = { id: string; idx: number; text: string; participant: { displayName: string } };

export function MinutesView({
  meetingId,
  minutes,
  turns,
  canEdit,
}: {
  meetingId: string;
  minutes: Minutes;
  turns: Turn[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");

  if (!minutes) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">会议纪要</h2>
        <p className="mt-2 text-xs text-slate-500">
          还没有纪要。触发 Agent 后会在这里生成（对应 issue #13）。
        </p>
      </div>
    );
  }

  function jump(turnId: string | null) {
    if (!turnId) return;
    const el = document.getElementById(`turn-${turnId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("ring-2", "ring-blue-500");
    setTimeout(() => el?.classList.remove("ring-2", "ring-blue-500"), 1600);
  }

  async function save(itemId: string) {
    await fetch(`/api/meetings/${meetingId}/minutes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionItemId: itemId, owner, dueAt: due }),
    });
    setEditing(null);
    router.refresh();
  }

  async function confirm() {
    await fetch(`/api/meetings/${meetingId}/minutes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minutesStatus: "confirmed" }),
    });
    router.refresh();
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">会议纪要</h2>
        <div className="flex items-center gap-2">
          <span className={`pill ${minutes.status === "confirmed" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {minutes.status}
          </span>
          {canEdit && minutes.status !== "confirmed" && (
            <button className="btn-ghost text-xs" onClick={confirm}>
              确认纪要
            </button>
          )}
        </div>
      </div>

      <p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm leading-relaxed">{minutes.overview}</p>

      <Section title="决议">
        {minutes.decisions.map((d) => (
          <Item key={d.id} onJump={() => jump(d.sourceTurnId)}>
            {d.content}
          </Item>
        ))}
      </Section>

      <Section title="待办">
        {minutes.actionItems.map((a) => (
          <div key={a.id} className="rounded-lg border border-slate-200 p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm">{a.content}</div>
              <button className="mono shrink-0 text-[11px] text-blue-600" onClick={() => jump(a.sourceTurnId)}>
                #引用
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <span className={`pill ${a.owner ? "bg-slate-100 text-slate-700" : "bg-rose-100 text-rose-700"}`}>
                {a.owner ?? "未指派"}
              </span>
              <span className="pill bg-slate-100 text-slate-600">{a.dueAt ?? "无截止"}</span>
              {a.unresolved && <span className="pill bg-amber-100 text-amber-700">unresolved</span>}
              {canEdit && editing !== a.id && (
                <button
                  className="ml-auto text-blue-600"
                  onClick={() => {
                    setEditing(a.id);
                    setOwner(a.owner ?? "");
                    setDue(a.dueAt ?? "");
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            {editing === a.id && (
              <div className="mt-2 flex flex-wrap gap-1">
                <input
                  className="w-28 rounded border border-slate-200 px-2 py-1 text-xs"
                  placeholder="负责人"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                />
                <input
                  className="w-28 rounded border border-slate-200 px-2 py-1 text-xs"
                  placeholder="截止时间"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
                <button className="btn-primary px-2 py-1 text-xs" onClick={() => save(a.id)}>
                  保存
                </button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            )}
          </div>
        ))}
      </Section>

      <Section title="风险">
        {minutes.risks.map((r) => (
          <Item key={r.id} onJump={() => jump(r.sourceTurnId)}>
            <span
              className={`pill mr-1 ${
                r.severity === "high"
                  ? "bg-rose-100 text-rose-700"
                  : r.severity === "low"
                    ? "bg-slate-100 text-slate-600"
                    : "bg-amber-100 text-amber-700"
              }`}
            >
              {r.severity}
            </span>
            {r.content}
          </Item>
        ))}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-xs font-medium text-slate-500">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Item({ children, onJump }: { children: React.ReactNode; onJump: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 p-2">
      <div className="text-sm">{children}</div>
      <button className="mono shrink-0 text-[11px] text-blue-600" onClick={onJump}>
        #引用
      </button>
    </div>
  );
}