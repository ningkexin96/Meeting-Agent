"use client";

// 原始转写视图
//
// 说话人姓名可点击重命名：说话人分离只给出「有几个人」，
// 不知道「这是谁」，所以真实姓名需要用户手动标注。

import { useState } from "react";
import { Check, Loader2, Mic, Pencil, TriangleAlert, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatMs } from "@/lib/utils";

type Turn = {
  id: string;
  idx: number;
  text: string;
  startMs: number;
  needsReview: boolean;
  participant: { id: string; displayName: string; speakerLabel: string; confidence: number };
};

type Participant = {
  id: string;
  displayName: string;
  speakerLabel: string;
  nameSource?: string;
};

// 每位说话人一组色，均取自 Teal 系与中性色，保持整体协调
const SPEAKER_TONES = [
  { bubble: "bg-primary/5 ring-primary/15", name: "text-primary" },
  { bubble: "bg-secondary ring-border", name: "text-foreground" },
  { bubble: "bg-warning-bg/60 ring-warning/20", name: "text-warning" },
  { bubble: "bg-accent ring-primary/10", name: "text-accent-foreground" },
];

export function TranscriptView({
  turns,
  participants,
  canEdit,
  meetingId,
}: {
  turns: Turn[];
  participants: Participant[];
  canEdit: boolean;
  meetingId: string;
}) {
  const toneOf = new Map(participants.map((p, i) => [p.id, SPEAKER_TONES[i % SPEAKER_TONES.length]]));

  // 说话人列表（本视图内维护，重命名后立即反映）
  const [names, setNames] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const p of participants) m[p.speakerLabel] = p.displayName;
    return m;
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(speakerLabel: string) {
    const name = draft.trim();
    if (!name) {
      setErr("姓名不能为空");
      return;
    }
    setSaving(true);
    setErr(null);
    const res = await fetch(`/api/meetings/${meetingId}/speakers`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speakerLabel, displayName: name }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setErr(data.error ?? "保存失败");
      return;
    }
    setNames((prev) => ({ ...prev, [speakerLabel]: name }));
    setEditing(null);
  }

  const unknownCount = Object.values(names).filter((n) => /未知|说话人 [A-Z]/.test(n)).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Mic className="size-4 text-primary" />
            原始转写
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {canEdit && unknownCount > 0
              ? "点击说话人姓名可标注真实身份"
              : "完整保留 · 点击纪要引用可跳回此处"}
          </p>
        </div>
        <Badge variant="neutral">{turns.length} 话轮</Badge>
      </CardHeader>

      <CardContent>
        {err && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-error-bg px-2.5 py-1.5 text-xs text-error">
            <TriangleAlert className="size-3.5 shrink-0" />
            {err}
          </div>
        )}

        {turns.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            还没有转写。点击上方「生成纪要」后自动转写。
          </div>
        ) : (
          <div className="max-h-[520px] space-y-1.5 overflow-auto pr-1">
            {turns.map((t) => {
              const tone = toneOf.get(t.participant.id) ?? SPEAKER_TONES[0];
              const label = t.participant.speakerLabel;
              const name = names[label] ?? t.participant.displayName;
              const isEditing = editing === label;

              return (
                <div
                  key={t.id}
                  id={`turn-${t.id}`}
                  className={cn("scroll-mt-4 rounded-lg px-3 py-2 ring-1", tone.bubble)}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    {isEditing ? (
                      <span className="flex items-center gap-1">
                        <Input
                          className="h-6 w-32 px-1.5 text-[11px]"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void save(label);
                            if (e.key === "Escape") setEditing(null);
                          }}
                          autoFocus
                          placeholder="输入真实姓名"
                        />
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="size-6"
                          onClick={() => void save(label)}
                          disabled={saving}
                        >
                          {saving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Check className="size-3 text-success" />
                          )}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="size-6"
                          onClick={() => setEditing(null)}
                        >
                          <X className="size-3" />
                        </Button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <span className={cn("font-medium", tone.name)}>{name}</span>
                        {canEdit && (
                          <button
                            onClick={() => {
                              setEditing(label);
                              setDraft(name);
                              setErr(null);
                            }}
                            className="text-muted-foreground transition-colors hover:text-primary"
                            title="标注真实身份"
                          >
                            <Pencil className="size-2.5" />
                          </button>
                        )}
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      {t.needsReview && (
                        <Badge variant="warning" className="h-4 gap-0.5 px-1 text-[10px]">
                          <TriangleAlert className="size-2.5" />
                          待复核
                        </Badge>
                      )}
                      <span className="font-mono">
                        #{t.idx} · {formatMs(t.startMs)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1 text-[13px] leading-relaxed">{t.text}</div>
                </div>
              );
            })}
          </div>
        )}

        {!canEdit && (
          <p className="mt-2 text-[11px] text-muted-foreground">当前为只读角色，不可编辑</p>
        )}
      </CardContent>
    </Card>
  );
}