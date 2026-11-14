"use client";

// 声纹库 —— 用于「将来接入真实声纹服务」的预留配置
//
// 定位说明（重要）：
// 当前离线环境下的声纹特征区分度不足（不同人相似度可达 0.97），
// 无法可靠识别「这是谁」。所以这个页面现在的作用是：
//   1. 说明当前引擎的能力边界，避免用户误以为能自动认人
//   2. 预留外部声纹服务的接入位置（VOICEPRINT_BASE_URL）
// 「谁说了什么」的标注走会议详情页的手动命名，不依赖这里。

import { useEffect, useState } from "react";
import {
  Fingerprint,
  Info,
  Loader2,
  ShieldAlert,
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

export function VoiceprintPanel({
  canEdit,
  currentUserId,
  canManageOthers,
}: {
  canEdit: boolean;
  currentUserId: string;
  canManageOthers: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [engine, setEngine] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  // 离线引擎无法区分不同人，页面必须说清楚
  const engineUsable = engine === "http";

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
    setMsg(null);
    const res = await fetch(`/api/voiceprints?userId=${userId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(data.error ?? "删除失败");
      return;
    }
    void load();
  }

  return (
    <div className="space-y-4">
      {/* 当前能力说明 —— 这是本页最重要的部分 */}
      {!engineUsable ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning-bg px-3 py-2.5 text-xs text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1 leading-relaxed">
            <p>
              <b>当前引擎（{engine || "未配置"}）无法可靠识别说话人身份。</b>
              离线特征提取对不同人的区分度不足，实测相似度约 0.97，
              系统会统一标记为「未知」而不是随意认领。
            </p>
            <p>
              <b>要标注「谁说了什么」，请在会议详情页点击说话人姓名手动命名。</b>
              这里注册的声纹暂时不会生效。
            </p>
            <p>
              如需自动识别身份，需配置外部声纹服务（
              <code className="rounded bg-warning/15 px-1 font-mono">VOICEPRINT_BASE_URL</code>
              ），推荐 ECAPA-TDNN 等模型。
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-success/20 bg-success-bg px-3 py-2 text-xs text-success">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            已接入外部声纹服务（{engine}）。注册后可自动识别说话人身份，
            认不出的会标记为未知而不是硬猜。
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Fingerprint className="size-4 text-primary" />
              声纹库
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {engineUsable
                ? "注册后可自动认领说话人"
                : "预留配置：接入外部声纹服务后才会生效"}
            </p>
          </div>
          <Badge variant={engineUsable ? "success" : "neutral"} className="font-mono">
            {engine || "-"}
          </Badge>
        </CardHeader>

        <CardContent className="space-y-3">
          {items.length === 0 ? (
            <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
              还没有声纹样本。
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
                  {!engineUsable && (
                    <Badge variant="warning" className="shrink-0 text-[10px]">
                      暂不生效
                    </Badge>
                  )}
                  {canEdit && (canManageOthers || it.userId === currentUserId) && (
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
                <label className="inline-flex h-8 min-w-40 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted">
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
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Fingerprint className="size-3.5" />
                  )}
                  注册声纹
                </Button>
              </div>
              {msg && <p className="text-xs text-primary">{msg}</p>}
            </form>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardContent className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span>
            设计取舍：说话人分离和声纹识别是两件事——前者回答「有几个人」（已支持，
            自动区分并标注为说话人 A/B/C），后者回答「这是谁」（需要声纹服务）。
            认不出身份时宁可留空让人工标注，也不按相似度硬套一个名字。
          </span>
        </CardContent>
      </Card>
    </div>
  );
}