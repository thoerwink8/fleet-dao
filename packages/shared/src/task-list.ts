// 任务列表（驾驶舱 /tasks，#1639）的状态分组：tasks 表的 state 加「是否暂停」归成六组，数据库查询（SQL）和内存版 Store 按同一份规则分。
// 改这里之前必须知道：
// - 暂停的单 state 仍是 running（只停这一张、能继续），所以分组先看是否暂停；暂停算进「等人」：它在等人点「继续」，不是在跑，也不是失败。
// - 卡住（stalled）也算「等人」：引擎判它卡住、已经报警，等人看。
// - 已结束的三种（做完、失败、叫停）永远按 state 分，哪怕 phase 里还留着 paused。
// - 认不出的 state 归「在跑」是兜底：库里的枚举加了新值，列表照样列得出来，不会整行消失。

import type { Task } from './domain.ts';

export const TASK_LIST_GROUPS = ['running', 'queued', 'waiting', 'done', 'failed', 'stopped'] as const;
export type TaskListGroup = (typeof TASK_LIST_GROUPS)[number];

/** 筛选一排的字（「全部」页面自己写）。 */
export const TASK_LIST_GROUP_LABELS: Record<TaskListGroup, string> = {
  running: '在跑',
  queued: '排队',
  waiting: '等人',
  done: '做完',
  failed: '失败',
  stopped: '叫停',
};

/** 一张单属于哪一组。 */
export function taskListGroupOf(task: Pick<Task, 'state'> & { paused?: string | undefined }): TaskListGroup {
  const { state } = task;
  if (state === 'done') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'stopped') return 'stopped';
  if (task.paused !== undefined) return 'waiting';
  if (state === 'asking' || state === 'stalled') return 'waiting';
  if (state === 'queued') return 'queued';
  return 'running';
}
