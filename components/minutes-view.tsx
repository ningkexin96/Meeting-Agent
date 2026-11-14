"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CheckCircle2,
  FileText,
  Gavel,
  ListTodo,
  Pencil,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Minutes = {
  id: string;
  overview: string;
  status: string;
  actionItems: {
    id: string;
    content: string;
    owner: string | null;
    dueAt: string | null;
    unresolved: boolean;
    sourceTurnId: string | null;
  }[];
  decisions: { id: string; content: string; sourceTurnId: string | null }[];
  risks: { id: string; content: string; severity: string; sourceTurnId: string | null }[];
} | null;

const SEVERITY: Record<string, { label: string; variant: "error" | "warning" | "neutral" }> = {
  high: { label: "高", variant: "error" },
  medium: { label: "中", variant: "warning" },
  low: { label: "低", variant: "neutral" },
};

export function MinutesView({
  meetingId,
  minutes,
  canEdit,
}: {
  meetingId: string;
  minutes: Minutes;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");

  if (!minutes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            会议纪要
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">Agent 生成后在此展示</p>
        </CardHeader>
        <CardContent>
          <div className="py-10 text-center text-xs text-muted-foreground">
            还没有纪要。触发 Agent 后会生成结构化结果。
          </div>
        </CardContent>
      </Card>
    );
  }

  function jump(turnId: string | null) {
    if (!turnId) return;
    const el = document.getElementById(`turn-${turnId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("turn-flash");
    setTimeout(() => el?.classList.remove("turn-flash"), 1700);
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            会议纪要
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">每条结论可点击引用回溯原话</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant={minutes.status === "confirmed" ? "success" : "warning"}>
            {minutes.status === "confirmed" ? "已确认" : "草稿"}
          </Badge>
          {canEdit && minutes.status !== "confirmed" && (
            <Button variant="outline" size="xs" onClick={confirm}>
              <CheckCircle2 className="size-3" />
              确认
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="rounded-lg bg-muted/50 p-3 text-[13px] leading-relaxed">{minutes.overview}</p>

        <Section icon={Gavel} title="决议" count={minutes.decisions.length}>
          {minutes.decisions.map((d) => (
            <Row key={d.id} onJump={() => jump(d.sourceTurnId)}>
              {d.content}
            </Row>
          ))}
        </Section>

        <Section icon={ListTodo} title="待办" count={minutes.actionItems.length}>
          {minutes.actionItems.map((a) => (
            <div key={a.id} className="group/item relative rounded-lg border border-border p-2 pr-2">
              <div className="pr-12 text-[13px] leading-relaxed">{a.content}</div>
              <button
                onClick={() => jump(a.sourceTurnId)}
                className="absolute right-2 top-2 rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary group-hover/item:opacity-100"
                title="查看对应的原话"
              >
                引用
              </button>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <Badge variant={a.owner ? "neutral" : "error"} className="h-[18px] px-1.5 text-[10px]">
                  {a.owner ?? "未指派"}
                </Badge>
                <Badge variant="neutral" className="h-[18px] px-1.5 text-[10px]">
                  {a.dueAt ?? "无截止"}
                </Badge>
                {a.unresolved && (
                  <Badge variant="warning" className="h-[18px] px-1.5 text-[10px]">
                    待补全
                  </Badge>
                )}
                {canEdit && editing !== a.id && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-auto h-[18px] px-1.5 text-[10px]"
                    onClick={() => {
                      setEditing(a.id);
                      setOwner(a.owner ?? "");
                      setDue(a.dueAt ?? "");
                    }}
                  >
                    <Pencil className="size-2.5" />
                    编辑
                  </Button>
                )}
              </div>
              {editing === a.id && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Input
                    className="h-7 w-24 text-xs"
                    placeholder="负责人"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                  />
                  <Input
                    className="h-7 w-24 text-xs"
                    placeholder="截止时间"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                  <Button size="xs" onClick={() => save(a.id)}>
                    保存
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setEditing(null)}>
                    取消
                  </Button>
                </div>
              )}
            </div>
          ))}
        </Section>

        <Section icon={ShieldAlert} title="风险" count={minutes.risks.length}>
          {minutes.risks.map((r) => {
            const sev = SEVERITY[r.severity] ?? SEVERITY.medium;
            return (
              <Row key={r.id} onJump={() => jump(r.sourceTurnId)}>
                <Badge variant={sev.variant} className="mr-1.5 h-[18px] px-1.5 text-[10px]">
                  {sev.label}
                </Badge>
                {r.content}
              </Row>
            );
          })}
        </Section>
      </CardContent>
    </Card>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof Gavel;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{title}</span>
        <Badge variant="neutral" className="h-4 px-1 text-[10px]">
          {count}
        </Badge>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ children, onJump }: { children: React.ReactNode; onJump: () => void }) {
  return (
    <div className="group/row relative rounded-lg border border-border p-2 pr-12 transition-colors hover:border-primary/30">
      <div className="text-[13px] leading-relaxed">{children}</div>
      <button
        onClick={onJump}
        className="absolute right-2 top-2 rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary group-hover/row:opacity-100"
        title="查看对应的原话"
      >
        引用
      </button>
    </div>
  );
}