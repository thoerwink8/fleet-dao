// 会话列表的分组：判状态的规则在 harness-contract 的 worker-state（前端和接口层共用一份，#3781 收尾），
// 这里只管组的顺序、中文名和分组排序。
import type { WorkerState } from '@fleet-dao/harness-contract/worker-state';

export {
  DEADLINE_GRACE_MS,
  deriveWorkerState,
  type TailEvent,
  type WorkerState,
} from '@fleet-dao/harness-contract/worker-state';

export const STATE_ORDER: readonly WorkerState[] = ['stuck', 'running', 'waiting', 'done'];

export const STATE_LABEL: Record<WorkerState, string> = {
  stuck: '卡住或失败',
  running: '在跑',
  waiting: '空闲或等待',
  done: '做完',
};

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
