"use client";

import { useState } from "react";
import {
  CornerDownLeft,
  Loader2,
  Quote,
  Search,
  ShieldQuestion,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Ref = { meetingId: string; title: string; text: string; importance: number };

const SUGGESTIONS = [
  "上次关于排期定了什么？",
  "发布节奏是怎么定的？",
  "有哪些风险被提到过？",
];

export function AskForm() {
  const [q, setQ] = useState("上次关于排期定了什么？");
  const [answer, setAnswer] = useState<string | null>(null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(text?: string) {
    const question = (text ?? q).trim();
    if (!question) return;
    setQ(question);
    setBusy(true);
    setAnswer(null);
    setRefs([]);
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setAnswer(data.error ?? "请求失败");
    setAnswer(data.answer);
    setRefs(data.references ?? []);
  }

  const noHit = answer && refs.length === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
            className="flex gap-1.5"
          >
            <Input
              className="h-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="问一个关于历史会议的问题…"
            />
            <Button className="h-9" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              提问
            </Button>
          </form>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => void ask(s)}
                disabled={busy}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {answer && (
        <Card>
          <CardContent className="space-y-3">
            {noHit ? (
              <div className="flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2.5">
                <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <div className="text-xs font-medium text-warning">没有找到相关依据</div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-warning/90">{answer}</p>
                </div>
              </div>
            ) : (
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{answer}</div>
            )}

            {refs.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Quote className="size-3" />
                  引用来源
                  <Badge variant="neutral" className="h-4 px-1 text-[10px]">{refs.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {refs.map((r, i) => (
                    <div key={i} className="rounded-lg border border-border p-2.5">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="info" className="h-[18px] px-1.5 text-[10px]">
                          {r.title}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          相关度 {(r.importance * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                        {r.text}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
        <CornerDownLeft className="size-3" />
        没有相关资料时会明确回答「没找到」，不会编造内容
      </p>
    </div>
  );
}