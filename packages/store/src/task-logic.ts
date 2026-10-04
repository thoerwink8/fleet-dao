/**
 * 任务／需求（从 issue 建任务、改需求、停排队的、「让 AI 接活」开关、看板留哪些）两套 Store 共用的纯判断。
 * 改这里之前必须知道：pg 版把同样的判断写在 SQL 里（priority 的子查询、`is distinct from`、`where state = 'queued'`、行锁里比开关），
 * 只能共用常量和「判完之后」的形状；内存版直接调这里的函数。两边必须判得一样，契约测试（store-contract）管。
 */
import type { Task } from '@fleet-dao/shared';
import type { AutoDispatchChange, NewAuditEntry } from './ports.ts';

/** 到了这些状态就不再动了；看板上只留最近一段时间内结束的。 */
export const TERMINAL_TASK_STATES = ['done', 'stopped', 'failed'] as const satisfies readonly Task['state'][];

/** 结束了的任务在看板上再留多久（毫秒）。 */
export const RECENT_TERMINAL_MS = 7 * 24 * 60 * 60_000;

/** 从 issue 新建的任务一律从排队开始。 */
export const NEW_TASK_STATE = 'queued' as const satisfies Task['state'];

export const isTerminalTaskState = (state: string): boolean =>
  (TERMINAL_TASK_STATES as readonly string[]).includes(state);

/** 看板上留不留：没结束的一律留；结束了的，结束时刻（没记就用建单时刻）不早于截止时刻才留。 */
export function keepOnBoard(state: string, terminalSinceMs: number, cutoffMs: number): boolean {
  return !isTerminalTaskState(state) || terminalSinceMs >= cutoffMs;
}

/** 看板留到什么时刻为止：此刻往前 RECENT_TERMINAL_MS。 */
export const boardCutoffMs = (nowMs: number): number => nowMs - RECENT_TERMINAL_MS;

/** 新任务排在这个仓最后：这个仓现有任务里最大的优先级加一（没有任务从 1 起）。 */
export const nextTaskPriority = (priorities: readonly number[]): number => Math.max(0, ...priorities) + 1;

/** 改需求：标题和原话都没变就什么都不写（也不记操作记录）。 */
export const isRequestUnchanged = (
  task: { title: string; rawRequest: string },
  next: { title: string; rawRequest: string },
): boolean => task.title === next.title && task.rawRequest === next.rawRequest;

/** 只有排队中的才能停。 */
export const canStopTask = (state: string): boolean => state === NEW_TASK_STATE;

/** 开关要改成 on：现在已经是了（有打开时刻 = 开着）就不改、不记操作记录。 */
export const isAutoDispatchUnchanged = (before: string | null, on: boolean): boolean =>
  (before !== null) === on;

/** 本来就是要的状态：回现在的值。 */
export const autoDispatchUnchanged = (before: string | null): AutoDispatchChange => ({
  changed: false,
  autoDispatchSince: before,
});

/** 改成了：回新值和那条操作记录的编号。 */
export const autoDispatchChanged = (after: string | null, auditId: string): AutoDispatchChange => ({
  changed: true,
  autoDispatchSince: after,
  auditId,
});

/** 开关改动的操作记录：before、after 都是开关的打开时刻。 */
export const autoDispatchAudit = (
  entry: Omit<NewAuditEntry, 'before' | 'after'>,
  before: string | null,
  after: string | null,
): NewAuditEntry => ({
  ...entry,
  before: { autoDispatchSince: before },
  after: { autoDispatchSince: after },
});
