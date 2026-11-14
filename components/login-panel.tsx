"use client";

// 登录 / 注册页 —— 对齐 Miniclaw 的 landing 布局
//
// 结构：左侧品牌叙事 + 右侧玻璃卡（登录/注册切换）
// 移动端：卡片优先，品牌文案在下方

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AudioLines,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Sparkles,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Tab = "login" | "register";

export function AuthPanel({ registerEnabled = true }: { registerEnabled?: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  function switchTab(t: Tab) {
    setTab(t);
    setError("");
  }

  // 密码强度：长度 + 字符种类
  function strengthOf(p: string): number {
    if (!p) return 0;
    let s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    return Math.min(4, s);
  }
  const strength = strengthOf(password);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const url = tab === "login" ? "/api/auth/login" : "/api/auth/register";
    const payload =
      tab === "login" ? { email, password } : { email, password, name };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? (tab === "login" ? "登录失败" : "注册失败"));
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-y-auto">
      {/* 极光背景 */}
      <div className="auth-aurora" aria-hidden>
        <div className="auth-aurora-blob auth-aurora-blob-1" />
        <div className="auth-aurora-blob auth-aurora-blob-2" />
        <div className="auth-aurora-blob auth-aurora-blob-3" />
        <div className="auth-aurora-blob auth-aurora-blob-4" />
      </div>
      <div className="auth-grain" aria-hidden />

      {/* 顶栏 */}
      <header className="relative z-10 flex items-center justify-between px-5 py-4 lg:px-12">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <AudioLines className="size-5" />
          </div>
          <span className="text-[17px] font-semibold tracking-tight">Meeting Agent</span>
        </div>
        <span className="hidden text-xs text-muted-foreground sm:block">
          智能会议纪要 · Powered by Pi Agent Runtime
        </span>
      </header>

      <main className="relative z-10 flex items-start px-5 pb-10 pt-4 sm:px-6 lg:items-center lg:px-12 lg:pb-16 lg:pt-16">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex flex-col-reverse items-center gap-10 lg:grid lg:grid-cols-2 lg:items-start lg:gap-20 lg:pt-10">
            {/* 左：品牌叙事 */}
            <div className="text-center lg:text-left">
              <div className="auth-badge">
                <Sparkles className="size-3.5" />
                <span>Powered by Pi Agent Runtime</span>
              </div>

              <h1 className="mt-5 text-3xl font-bold leading-[1.18] tracking-tight sm:text-4xl lg:text-[2.75rem]">
                让每场会议
                <br />
                <span className="auth-gradient-text whitespace-nowrap">自动变成可执行纪要</span>
              </h1>

              <p className="mx-auto mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-base lg:mx-0">
                上传音频或实时录音，Agent 自动转写、分离说话人、抽取决议与待办。
                每条结论都能点回原话，可追溯、可复核。
              </p>

              <div className="mt-8 hidden flex-col gap-3 sm:flex">
                {[
                  "真实语音识别，支持实时流式转写",
                  "三层权限：路由守卫 / 工具闸门 / 租户隔离",
                  "结构化输出强校验，宁可标未知也不硬猜",
                ].map((t) => (
                  <div key={t} className="flex items-center justify-center gap-2 text-sm text-muted-foreground lg:justify-start">
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                    {t}
                  </div>
                ))}
              </div>
            </div>

            {/* 右：认证卡片 */}
            <div className="flex w-full justify-center lg:justify-end">
              <div className="auth-glass w-full max-w-sm rounded-2xl p-6">
                <div className="mb-5 flex justify-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
                    <AudioLines className="size-6" />
                  </div>
                </div>

                <h2 className="mb-1 text-center text-lg font-semibold">
                  {tab === "login" ? "欢迎回来" : "创建账户"}
                </h2>
                <p className="mb-5 text-center text-xs text-muted-foreground">
                  {tab === "login" ? "登录以继续使用 Meeting Agent" : "注册即可开始使用"}
                </p>

                {/* 标签页 */}
                <div className="auth-tabs mb-5">
                  <button
                    type="button"
                    className="auth-tab"
                    data-active={tab === "login"}
                    onClick={() => switchTab("login")}
                  >
                    登录
                  </button>
                  {registerEnabled && (
                    <button
                      type="button"
                      className="auth-tab"
                      data-active={tab === "register"}
                      onClick={() => switchTab("register")}
                    >
                      注册
                    </button>
                  )}
                </div>

                {error && (
                  <div
                    role="alert"
                    className="mb-4 rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-xs text-error"
                  >
                    {error}
                  </div>
                )}

                <form onSubmit={submit} className="space-y-3.5">
                  {tab === "register" && (
                    <div>
                      <label htmlFor="name" className="mb-1.5 block text-xs font-medium">
                        显示名称 <span className="font-normal text-muted-foreground">(可选)</span>
                      </label>
                      <div className="relative">
                        <User className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="name"
                          className="h-9 pl-8"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="留空则使用邮箱前缀"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label htmlFor="email" className="mb-1.5 block text-xs font-medium">
                      邮箱
                    </label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="email"
                        type="email"
                        className="h-9 pl-8"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                        required
                        autoFocus
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="password" className="mb-1.5 block text-xs font-medium">
                      密码
                    </label>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="password"
                        type={showPwd ? "text" : "password"}
                        className="h-9 pl-8 pr-8"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={tab === "register" ? "至少 8 位" : "请输入密码"}
                        autoComplete={tab === "login" ? "current-password" : "new-password"}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPwd((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                        tabIndex={-1}
                        aria-label={showPwd ? "隐藏密码" : "显示密码"}
                      >
                        {showPwd ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>

                    {tab === "register" && password && (
                      <>
                        <div className="auth-strength">
                          {[1, 2, 3, 4].map((i) => (
                            <div
                              key={i}
                              className="auth-strength-bar"
                              data-level={i <= strength ? strength : 0}
                            />
                          ))}
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {strength <= 1
                            ? "强度偏弱，建议 12 位以上并混合大小写"
                            : strength === 2
                              ? "强度一般，可加入数字或符号"
                              : strength === 3
                                ? "强度良好"
                                : "强度很高"}
                        </p>
                      </>
                    )}
                  </div>

                  <Button type="submit" className="h-9 w-full" disabled={loading}>
                    {loading && <Loader2 className="size-4 animate-spin" />}
                    {loading ? "处理中…" : tab === "login" ? "登录" : "注册并登录"}
                  </Button>
                </form>

                <p className="mt-4 text-center text-xs text-muted-foreground">
                  {tab === "login" ? "还没有账户？" : "已有账户？"}
                  <button
                    type="button"
                    onClick={() => switchTab(tab === "login" ? "register" : "login")}
                    className="ml-1 font-medium text-primary transition-colors hover:text-primary/80"
                  >
                    {tab === "login" ? "去注册" : "去登录"}
                  </button>
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function LoginPanel() {
  return <AuthPanel />;
}