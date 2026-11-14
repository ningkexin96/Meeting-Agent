// 运行模式提示条 —— 明确告诉用户当前是「真实识别」还是「预置样例」
// 对应问题：mock 模式下无音频也能生成纪要，但界面不解释，用户会困惑"我什么都没说怎么有记录"
import { AlertTriangle, CheckCircle2, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

export type AsrModeInfo = {
  provider: string;
  mode: string;
  demo: boolean;
};

export function ModeBanner({ asr }: { asr: AsrModeInfo }) {
  if (!asr.demo) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-success/20 bg-success-bg px-3 py-2 text-xs text-success">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
        <span>
          <b>真实语音识别</b>：{asr.mode}。上传音频或进入实时模式后，会识别你实际说的内容。
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-bg px-3 py-2 text-xs text-warning">
      <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <b>演示数据模式</b>（ASR_PROVIDER={asr.provider}）—— 系统不解析音频，
        任何会议都会拿到同一份预置的周会文本。这就是你「没说话也有记录」的原因。
        想用真实识别，把 <code className="rounded bg-warning/15 px-1 font-mono">.env</code> 里的
        <code className="rounded bg-warning/15 px-1 font-mono">ASR_PROVIDER</code> 改成
        <code className="rounded bg-warning/15 px-1 font-mono">dashscope</code> 后重启。
      </span>
    </div>
  );
}

/** 紧凑版，放在卡片标题旁 */
export function ModeBadge({ asr }: { asr: AsrModeInfo }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        asr.demo ? "bg-warning-bg text-warning" : "bg-success-bg text-success",
      )}
      title={asr.demo ? "当前使用预置样例数据，不解析真实音频" : asr.mode}
    >
      {asr.demo ? (
        <>
          <AlertTriangle className="size-2.5" />
          演示数据
        </>
      ) : (
        <>
          <CheckCircle2 className="size-2.5" />
          真实识别
        </>
      )}
    </span>
  );
}