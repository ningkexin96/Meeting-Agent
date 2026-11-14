// 事件总线：状态机 → SSE → 前端运行视图（对应 issue #11）
export type AgentStage =
  | "PREPARING"
  | "SUMMARIZING"
  | "EXTRACTING"
  | "REVIEWING"
  | "DONE"
  | "FAILED";

export type RunEvent =
  | { type: "stage"; stage: AgentStage; note?: string; at: number }
  | { type: "tool"; tool: string; args: Record<string, unknown>; ok: boolean; at: number }
  | { type: "text"; text: string; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "done"; meetingId: string; at: number };

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

  snapshot(meetingId: string) {
    return this.history.get(meetingId) ?? [];
  }
}

const globalForBus = globalThis as unknown as { __runBus?: RunBus };
export const runBus = globalForBus.__runBus ?? new RunBus();
globalForBus.__runBus = runBus;