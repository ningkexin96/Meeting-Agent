"use client";

// 删除会议 —— 对应 issue #30
//
// 交互取舍：
// - 列表里直接放删除按钮，但**不做"点一下就删"**：删除会连带清掉转写、纪要和实时记录，
//   是不可逆操作，必须二次确认。
// - 确认框要求**输入会议标题**才能提交。不是因为想为难用户，而是列表里会议常常同名，
//   光点"确定"很容易删错行；打字这一步能把"手滑"挡在门外。
// - 用原生 <dialog>：自带焦点陷阱、Esc 关闭和背景遮罩，
//   比自己搭一层 div 更不容易出现"遮罩挡住了但 Tab 还能跑到后面"这类问题。
// - 列表里删除后只刷新（用户可能还要接着删下一场）；详情页删除后跳回列表（当前页已不存在）。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function DeleteMeetingButton({
  meetingId,
  title,
  canDelete,
  variant = "icon",
  /** 删除成功后跳转到哪里（不传则只刷新当前页，适合列表场景） */
  redirectTo,
}: {
  meetingId: string;
  title: string;
  /** 无权限时不渲染按钮（服务端还会再校验一次，这里只是不展示） */
  canDelete: boolean;
  /** icon：列表行内的图标按钮；menu：详情页里的带文字按钮 */
  variant?: "icon" | "menu";
  redirectTo?: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // portal 只能在浏览器端渲染，服务端首帧不能执行
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  /** 统一的关闭入口：先 close() 再改状态，两者顺序不能反（见 doDelete 里的说明） */
  const closeDialog = () => {
    dialogRef.current?.close();
    setOpen(false);
  };

  const confirmed = typed.trim() === title.trim();

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      setTyped("");
      setError(null);
      dlg.showModal();
      // 等 dialog 进入顶层再聚焦，否则在部分浏览器里焦点会落回页面
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open && dlg.open) dlg.close();
  }, [open]);

  async function doDelete() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `删除失败（${res.status}）`);
        return;
      }

      // 关键：先把 <dialog> 真正关掉，再动路由。
      //
      // 踩过的坑：`dialog.close()` 会触发 onClose，把 open 状态置回 false；
      // 如果此时还停在「刚删掉那场会」的路由上，React 重渲染时会把删按钮里的
      // <dialog> 重新挂载——而 <dialog> 的 default 属性是 open，
      // 于是它自己又弹出来，接着触发 onCancel，整个按钮落进自激循环，
      // 最终把 URL 推到已经被删掉的 /meetings/[id]，用户看到 404。
      // 顺序反过来（先 close，再 replace/refresh）就不会有这个窗口期。
      dialogRef.current?.close();
      setOpen(false);

      // 无论从哪个页面删的，删完都回列表：当前页可能已经不存在了
      router.replace(redirectTo ?? "/");
    } catch (e) {
      setError(`网络错误：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!canDelete) return null;

  return (
    <>
      <button
        type="button"
        title="删除会议"
        aria-label={`删除会议「${title}」`}
        className={cn(
          "shrink-0 rounded-md text-muted-foreground transition-all",
          "hover:bg-error-bg hover:text-error",
          // 默认就可见：只在 hover 才出现的删除按钮，用户根本发现不了这个功能。
          // 给正常态留一个低对比度的灰，hover 时再变成红色。
          variant === "icon"
            ? "flex size-7 items-center justify-center opacity-40 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100"
            : "inline-flex h-7 items-center gap-1 px-2 text-xs hover:text-error",
        )}
        onClick={(e) => {
          // 列表整行是链接，删按钮必须阻止跳转
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Trash2 className={variant === "icon" ? "size-3.5" : "size-3"} />
        {variant === "menu" && "删除"}
      </button>

      {/* 用 portal 挂到 body：dialog 不能留在 <a> 里——
          原生 dialog 的 default open 属性、以及外层链接的点击区域，
          都会把「关闭」误当成「打开」或「导航」的来源 */}
      {mounted &&
        createPortal(
          <dialog
        ref={dialogRef}
        className="w-[min(420px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground backdrop:bg-black/40"
        onClose={() => setOpen(false)}
        onCancel={(e: React.SyntheticEvent<HTMLDialogElement>) => {
          // Esc：正在删除时不允许关闭，避免请求发一半界面没了
          if (busy) e.preventDefault();
        }}
      >
        <div className="flex items-start gap-2 px-4 pt-4">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-error-bg text-error">
            <AlertTriangle className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">删除这场会议？</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              会同时删除这场会的转写、纪要、说话人和实时记录，<b className="text-foreground">无法恢复</b>。
              由这场会沉淀的记忆会保留，只是不再关联到这场会。
            </p>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted"
            onClick={closeDialog}
            disabled={busy}
            aria-label="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="px-4 pb-4 pt-3">
          <label className="text-[11px] text-muted-foreground">
            请输入会议标题确认：<b className="text-foreground">{title}</b>
          </label>
          <Input
            ref={inputRef}
            className="mt-1.5 h-8"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmed && !busy) void doDelete();
            }}
            placeholder={title}
            disabled={busy}
          />
          {error && <div className="mt-1.5 text-xs text-error">{error}</div>}

          <div className="mt-3 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={closeDialog} disabled={busy}>
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void doDelete()}
              disabled={!confirmed || busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {busy ? "正在删除…" : "永久删除"}
            </Button>
          </div>
        </div>
          </dialog>,
          document.body,
        )}
    </>
  );
}