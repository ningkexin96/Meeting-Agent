// 事件总线：状态机 / 实时流 → SSE → 前端（对应 issue #11 #26）
export type AgentStage =
  | "PREPARING"
  | "SUMMARIZING"
  | "EXTRACTING"
  | "REVIEWING"
  | "DONE"
  | "FAILED";

/** 实时转写片段（issue #26） */
export type LiveSegmentPayload = {
  seq: number;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  needsReview: boolean;
};

/** 增量纪要条目（issue #26） */
export type LiveMinutePayload = {
  id: string;
  kind: "decision" | "action_item" | "risk";
  content: string;
  owner?: string | null;
  dueAt?: string | null;
  severity?: string;
};

export type RunEvent =
  | { type: "stage"; stage: AgentStage; note?: string; at: number }
  | { type: "tool"; tool: string; args: Record<string, unknown>; ok: boolean; at: number }
  | { type: "text"; text: string; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "done"; meetingId: string; at: number }
  // ---- 实时流（issue #26）----
  | { type: "live:segment"; segment: LiveSegmentPayload; at: number }
  | { type: "live:minutes"; items: LiveMinutePayload[]; at: number }
  | { type: "live:chunk"; seq: number; status: "pending" | "transcribed" | "failed"; error?: string; at: number }
  | { type: "live:ended"; sessionId: string; at: number };

type Listener = (e: RunEvent) => void;

class RunBus {
  private listeners = new Map<string, Set<Listener>>();
  private history = new Map<string, RunEvent[]>();

  subscribe(meetingId: string, fn: Listener) {
    if (!this.listeners.has(meetingId)) this.listeners.set(meetingId, new Set());
    this.listeners.get(meetingId)!.add(fn);
    // 重连补齐历史事件（issue #11 验收：断线重连后补齐当前状态）
    for (const e of this.history.get(meetingId) ?? []) fn(e);
    return () => {
      this.listeners.get(meetingId)?.delete(fn);
    };
  }

  publish(meetingId: string, e: RunEvent) {
    const arr = this.history.get(meetingId) ?? [];
    arr.push(e);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    this.history.set(meetingId, arr);
    for (const fn of this.listeners.get(meetingId) ?? []) {
      try {
        fn(e);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  reset(meetingId: string) {
    this.history.set(meetingId, []);
  }

  /**
   * 丢弃某场会议的全部订阅者与历史（issue #30）。
   *
   * 用在「删除会议」之前：会议删掉后，页面上还挂着的 SSE 连接会继续请求这个频道，
   * 服务端再也找不到这个会议 → 控制台里出现一串 404。
   * 这些 404 本身无害，但会让人误以为删除出错了，所以显式清掉。
   */
  drop(meetingId: string) {
    this.listeners.delete(meetingId);
    this.history.delete(meetingId);
  }

  snapshot(meetingId: string) {
    return this.history.get(meetingId) ?? [];
  }
}

const globalForBus = globalThis as unknown as { __runBus?: RunBus };
export const runBus = globalForBus.__runBus ?? new RunBus();
globalForBus.__runBus = runBus;