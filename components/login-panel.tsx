"use client";

/** 登录面板 —— 未登录时的入口，视觉对齐 Miniclaw 卡片风格 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AudioLines,
  Mic,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Eye,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const USERS = [
  {
    email: "owner@demo.dev",
    name: "张伟",
    role: "owner",
    desc: "可创建会议、触发 Agent、编辑纪要",
    icon: UserCheck,
    variant: "success" as const,
    badge: "所有者",
  },
  {
    email: "member@demo.dev",
    name: "李娜",
    role: "member",
    desc: "可创建会议、触发 Agent、编辑纪要",
    icon: UserCheck,
    variant: "info" as const,
    badge: "成员",
  },
  {
    email: "viewer@demo.dev",
    name: "王强",
    role: "viewer",
    desc: "只能查看，不能触发 Agent 或修改",
    icon: Eye,
    variant: "neutral" as const,
    badge: "只读",
  },
];

export function LoginPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function login(email: string) {
    setBusy(email);
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-3xl py-6 lg:py-12">
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <AudioLines className="size-6" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">智能会议纪要 Agent</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          上传音频或会中直接录音，自动生成可回溯到原话的结构化纪要。
        </p>
        <div className="mt-3 flex justify-center gap-1.5">
          <Badge variant="info">
            <Mic className="size-3" /> 实时转写
          </Badge>
          <Badge variant="info">
            <Sparkles className="size-3" /> 增量纪要
          </Badge>
          <Badge variant="info">
            <ShieldCheck className="size-3" /> 三层权限
          </Badge>
        </div>
      </div>

      <div className="mt-8">
        <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          选择一个演示账号
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {USERS.map((u) => {
            const Icon = u.icon;
            return (
              <button
                key={u.email}
                onClick={() => login(u.email)}
                disabled={busy !== null}
                className="group text-left disabled:opacity-60"
              >
                <Card
                  size="sm"
                  className="h-full transition-all hover:ring-primary/40 group-hover:-translate-y-0.5"
                >
                  <CardContent className="flex h-full flex-col">
                    <div className="flex items-center justify-between">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-4" />
                      </div>
                      <Badge variant={u.variant} className="text-[10px]">
                        {u.badge}
                      </Badge>
                    </div>
                    <div className="mt-2 text-sm font-medium">{u.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{u.email}</div>
                    <p className="mt-1.5 flex-1 text-[11px] leading-relaxed text-muted-foreground">
                      {u.desc}
                    </p>
                    <Button size="sm" className="mt-2 w-full" disabled={busy !== null}>
                      {busy === u.email ? "登录中…" : "以此身份登录"}
                    </Button>
                  </CardContent>
                </Card>
              </button>
            );
          })}
        </div>
      </div>

      <p className="mt-6 text-center text-[11px] text-muted-foreground">
        演示环境免密登录 · 数据均为样例，不含真实会议内容
      </p>
    </div>
  );
}