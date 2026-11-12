// 会话的工人状态：从该会话最近的几条事件推出来。纯函数，规则只在这一个文件里（#3781 收尾）：
// 驾驶舱前端按它给列表分组；投影按同一份规则记下当前态，接口层数「卡住」时读投影，不现扫事件。
// 优先级：卡住或失败 > 在跑 > 空闲或等待 > 做完（herdr 的 blocked / working / idle / done）。
// 不依赖 zod 等运行时库，前端打包不会因此变大，所以单独放子路径 `@fleet-dao/harness-contract/worker-state`。

export type WorkerState = 'stuck' | 'running' | 'waiting' | 'done';

/** 接口给的一条近期事件（最旧在前）：只带判状态用得上的字段。 */
export interface TailEvent {
  type: string;
  outcome?: string | null;
  verdict?: string | null;
  final?: boolean | null;
  status?: string | null;
  exitCode?: number | null;
  killed?: unknown;
  spawnError?: unknown;
  deadline?: string | null;
}

/** 工人超过截止时间这么久还没交，就算卡住（毫秒）。 */
export const DEADLINE_GRACE_MS = 5 * 60_000;

/** 判状态只看最近这么多条。列表的 tail 和投影的窗口用同一个数。 */
export const TAIL_EVENTS = 24;

/** 从载荷里摘进 tail 的字段。大文本不进。投影和列表的瘦身版都按这份。 */
export const TAIL_FIELDS = [
  'outcome',
  'verdict',
  'final',
  'status',
  'exitCode',
  'killed',
  'spawnError',
  'deadline',
] as const;

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
 * - handback.recorded：final 且 outcome=completed（派工器的 OutcomeKind）、核验没判 failed → 做完；
 *   其他 final（被杀、起不来、核验判失败、结果不确定）→ 卡住；不是 final → 还会重试，算等待
 * - worker.settled：退出码非 0、被杀、起不来 → 卡住；正常退出 → 等交回（等待）
 * - worker.result.submitted：failed 或 blocked → 卡住；其他 → 等核验（等待）
 * - worker.spawned / progress.reported / stop.requested：在跑；过了截止时间又超出宽限 → 卡住
 * - worker.spawn.requested：已请求还没起 → 等待
 * - session.turn.started：在跑
 * - session.turn.settled 带了 outcome（ADE 会话，#3914）：lost 算卡住，其余算空闲。
 *   没有 outcome 的旧轮次结束不说明状态，跳过（法国会话的「做完」不被它盖掉）。
 * 收尾、不认识的类型不说明状态，跳过；一条都没有就是等待。
 */
export function deriveWorkerState(tail: readonly TailEvent[], now: number = Date.now()): WorkerState {
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (!e) continue;
    switch (e.type) {
      case 'handback.recorded':
        if (e.final !== true) return 'waiting';
        return e.outcome === 'completed' && e.verdict !== 'failed' ? 'done' : 'stuck';
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
      case 'session.turn.settled':
        if (e.outcome === 'lost') return 'stuck';
        if (typeof e.outcome === 'string' && e.outcome !== '') return 'waiting';
        break;
      default:
    }
  }
  return 'waiting';
}

/** 数这批会话里有几个是卡住的（和投影用同一条规则；全库个数改读投影，不靠它扫）。 */
export function countStuck(tails: Iterable<readonly TailEvent[]>, now: number = Date.now()): number {
  let n = 0;
  for (const t of tails) if (deriveWorkerState(t, now) === 'stuck') n++;
  return n;
}

/** 一条事件收成判状态用的瘦身版：只留 TAIL_FIELDS，空值丢掉。 */
export function tailEventFrom(type: string, payload: unknown): TailEvent {
  const ev: Record<string, unknown> = { type };
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const src = payload as Record<string, unknown>;
    for (const k of TAIL_FIELDS) {
      const v = src[k];
      if (v !== undefined && v !== null) ev[k] = v;
    }
  }
  return ev as unknown as TailEvent;
}

/** 把一条新事件折进窗口，超过 limit 丢掉最旧的。一条条折，结果等于只留最后 limit 条。 */
export function pushTail(tail: readonly TailEvent[], event: TailEvent, limit = TAIL_EVENTS): TailEvent[] {
  if (limit < 1) return [];
  const start = tail.length >= limit ? tail.length - (limit - 1) : 0;
  const next = tail.slice(start);
  next.push(event);
  return next;
}

/**
 * 状态还是在跑、并且这次启动写了截止时间时，返回那个截止时间（毫秒）。
 * 过了它再加宽限，deriveWorkerState 会改判卡住；投影记下这个时刻，到点再改，不用把会话重读一遍。
 */
export function trackedDeadlineMs(tail: readonly TailEvent[], now: number): number | null {
  if (deriveWorkerState(tail, now) !== 'running') return null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (!e) continue;
    switch (e.type) {
      case 'worker.spawned':
      case 'worker.progress.reported':
      case 'worker.stop.requested':
        return deadlineBefore(tail, i) ?? null;
      case 'session.turn.started':
      case 'handback.recorded':
      case 'worker.settled':
      case 'worker.result.submitted':
      case 'worker.spawn.requested':
        return null;
      default:
    }
  }
  return null;
}
