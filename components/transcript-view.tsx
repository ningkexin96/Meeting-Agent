// 转写视图 —— 对应 issue #10（人员分离气泡 + 原话锚点跳转）
"use client";

import { useState } from "react";

type Turn = {
  id: string;
  idx: number;
  text: string;
  startMs: number;
  needsReview: boolean;
  participant: { id: string; displayName: string; speakerLabel: string; confidence: number };
};

const COLORS = [
  "bg-blue-50 border-blue-200",
  "bg-emerald-50 border-emerald-200",
  "bg-amber-50 border-amber-200",
  "bg-violet-50 border-violet-200",
];

export function TranscriptView({
  turns,
  participants,
  canEdit,
}: {
  turns: Turn[];
  participants: { id: string; displayName: string; speakerLabel: string }[];
  canEdit: boolean;
}) {
  const colorOf = new Map(
    participants.map((p, i) => [p.id, COLORS[i % COLORS.length]]),
  );

  if (turns.length === 0) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">原始转写</h2>
        <p className="mt-2 text-xs text-slate-500">
          还没有转写。点击「生成纪要」后会自动跑转写（对应 issue #7）。
        </p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">原始转写（只读）</h2>
        <span className="pill bg-slate-100 text-slate-600">{turns.length} 话轮</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        两层消息模型的第一层：完整保留，可点击引用回到这里（issue #12）。
      </p>
      <div className="mt-3 max-h-[520px] space-y-2 overflow-auto pr-1">
        {turns.map((t) => (
          <div
            key={t.id}
            id={`turn-${t.id}`}
            className={`rounded-lg border px-3 py-2 ${colorOf.get(t.participant.id) ?? "bg-slate-50 border-slate-200"} scroll-mt-4`}
          >
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span className="font-medium text-slate-700">{t.participant.displayName}</span>
              <span className="mono">
                #{t.idx} · {ms(t.startMs)}
                {t.needsReview && (
                  <span className="ml-1 pill bg-rose-100 text-rose-700">待复核</span>
                )}
              </span>
            </div>
            <div className="mt-1 text-sm leading-relaxed">{t.text}</div>
          </div>
        ))}
      </div>
      {!canEdit && (
        <p className="mt-2 text-[11px] text-slate-400">viewer 只读（issue #4 第 2 层）</p>
      )}
    </div>
  );
}

function ms(v: number) {
  const s = Math.floor(v / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}