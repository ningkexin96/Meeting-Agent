"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Mic, TriangleAlert } from "lucide-react";
import { cn, formatMs } from "@/lib/utils";

type Turn = {
  id: string;
  idx: number;
  text: string;
  startMs: number;
  needsReview: boolean;
  participant: { id: string; displayName: string; speakerLabel: string; confidence: number };
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
}: {
  turns: Turn[];
  participants: { id: string; displayName: string; speakerLabel: string }[];
  canEdit: boolean;
}) {
  const toneOf = new Map(participants.map((p, i) => [p.id, SPEAKER_TONES[i % SPEAKER_TONES.length]]));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Mic className="size-4 text-primary" />
            原始转写
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">完整保留 · 点击纪要引用可跳回此处</p>
        </div>
        <Badge variant="neutral">{turns.length} 话轮</Badge>
      </CardHeader>

      <CardContent>
        {turns.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            还没有转写。点击上方「生成纪要」后自动转写。
          </div>
        ) : (
          <div className="max-h-[520px] space-y-1.5 overflow-auto pr-1">
            {turns.map((t) => {
              const tone = toneOf.get(t.participant.id) ?? SPEAKER_TONES[0];
              return (
                <div
                  key={t.id}
                  id={`turn-${t.id}`}
                  className={cn("scroll-mt-4 rounded-lg px-3 py-2 ring-1", tone.bubble)}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className={cn("font-medium", tone.name)}>{t.participant.displayName}</span>
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