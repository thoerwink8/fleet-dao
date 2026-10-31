// 会话列表的工人状态：从该会话最近的几条事件推出来。纯函数，规则在这一个文件里。
// 优先级：卡住或失败 > 在跑 > 空闲或等待 > 做完（herdr 的 blocked / working / idle / done）。

export type WorkerState = 'stuck' | 'running' | 'waiting' | 'done';

export const STATE_ORDER: readonly WorkerState[] = ['stuck', 'running', 'waiting', 'done'];

export const STATE_LABEL: Record<WorkerState, string> = {
  stuck: '卡住或失败',
  running: '在跑',
  waiting: '空闲或等待',
  done: '做完',
};

/** 接口给的一条近期事件（最旧在前）：只带判状态用得上的字段。 */
export interface TailEvent {
  type: string;
  outcome?: string | null;
  final?: boolean | null;
  status?: string | null;
  exitCode?: number | null;
  killed?: unknown;
  spawnError?: unknown;
  deadline?: string | null;
}

/** 工人超过截止时间这么久还没交，就算卡住（毫秒）。 */
export const DEADLINE_GRACE_MS = 5 * 60_000;

const present = (v: unknown): boolean => v !== null && v !== undefined && v !== '' && v !== false;

/** 从第 i 条往回找这一次启动的截止时间；碰到上一次的结束或交回就不再往前。 */
function deadlineBefore(tail: readonly TailEvent[], i: number): number | undefined {
  for (let j = i; j >= 0; j--) {
    const e = tail[j];
    if (!e) continue;
    if (e.type === 'worker.spawned') {
      const d = e.deadline ? Date.parse(e.deadline) : Number.NaN;
      return Number.isNaN(d) ? undefined : d;
    }
    if (e.type === 'worker.settled' || e.type === 'handback.recorded') return undefined;
  }
  return undefined;
}

/**
 * 从最新一条往回找第一条能说明状态的事件：
 * - handback.recorded：final 且 outcome=delivered → 做完；final 但没交付 → 卡住；不是 final → 还会重试，算等待
 * - worker.settled：退出码非 0、被杀、起不来 → 卡住；正常退出 → 等交回（等待）
 * - worker.result.submitted：failed 或 blocked → 卡住；其他 → 等核验（等待）
 * - worker.spawned / progress.reported / stop.requested：在跑；过了截止时间又超出宽限 → 卡住
 * - worker.spawn.requested：已请求还没起 → 等待
 * - session.turn.started：在跑
 * 轮次结束、收尾、不认识的类型不说明状态，跳过；一条都没有就是等待。
 */
export function deriveWorkerState(tail: readonly TailEvent[], now: number = Date.now()): WorkerState {
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (!e) continue;
    switch (e.type) {
      case 'handback.recorded':
        if (e.final !== true) return 'waiting';
        return e.outcome === 'delivered' ? 'done' : 'stuck';
      case 'worker.settled': {
        const bad =
          (typeof e.exitCode === 'number' && e.exitCode !== 0) || present(e.killed) || present(e.spawnError);
        return bad ? 'stuck' : 'waiting';
      }
      case 'worker.result.submitted':
        return e.status === 'failed' || e.status === 'blocked' ? 'stuck' : 'waiting';
      case 'worker.spawn.requested':
        return 'waiting';
      case 'worker.spawned':
      case 'worker.progress.reported':
      case 'worker.stop.requested': {
        const deadline = deadlineBefore(tail, i);
        return deadline !== undefined && now > deadline + DEADLINE_GRACE_MS ? 'stuck' : 'running';
      }
      case 'session.turn.started':
        return 'running';
      default:
    }
  }
  return 'waiting';
}

/** 按状态组排序（卡住 > 在跑 > 等待 > 做完），组内最后事件号倒序；空组不出。 */
export function groupByState<T extends { lastEventId: number }>(
  items: readonly T[],
  stateOf: (item: T) => WorkerState,
): { state: WorkerState; items: T[] }[] {
  const groups = new Map<WorkerState, T[]>();
  for (const it of items) {
    const s = stateOf(it);
    const g = groups.get(s);
    if (g) g.push(it);
    else groups.set(s, [it]);
  }
  return STATE_ORDER.filter((s) => groups.has(s)).map((state) => ({
    state,
    items: (groups.get(state) ?? []).sort((a, b) => b.lastEventId - a.lastEventId),
  }));
}
