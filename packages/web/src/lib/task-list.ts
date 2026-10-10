// 任务列表页（/tasks，#1639）的纯逻辑：筛选条件和地址栏查询串互转、详情页「返回」落到哪、一行里各样东西怎么说。
// 筛选全写在地址栏（?status=&repo=&q=）：刷新、返回、复制链接都保得住。不认的值当没给，不报错。
import { TASK_LIST_GROUP_LABELS, TASK_LIST_GROUPS, type TaskListGroup } from '@fleet-dao/shared';
import type { TaskListFilter, TaskListRow } from '../api/types';
import type { Tone } from './status';
import { taskStateLabel, taskTone } from './status';

export const TASKS_PATH = '/tasks';

/** 详情页链接里记着「从哪个列表进来」的参数名。 */
export const FROM_PARAM = 'from';

export interface TaskListView {
  status: TaskListGroup | undefined;
  repoId: string | undefined;
  q: string;
}

const isGroup = (s: string | null): s is TaskListGroup =>
  (TASK_LIST_GROUPS as readonly string[]).includes(s ?? '');

export function viewOfParams(params: URLSearchParams): TaskListView {
  const status = params.get('status');
  const repo = params.get('repo');
  return {
    status: isGroup(status) ? status : undefined,
    repoId: repo ? repo : undefined,
    q: params.get('q') ?? '',
  };
}

/** 接口的筛选条件：搜索词两头的空白去掉，空的不发。 */
export function filterOf(view: TaskListView): TaskListFilter {
  const q = view.q.trim();
  return {
    ...(view.status === undefined ? {} : { status: view.status }),
    ...(view.repoId === undefined ? {} : { repoId: view.repoId }),
    ...(q === '' ? {} : { q }),
  };
}

/** 回写地址栏：没筛的键不写，别的参数（例如 ?node=）原样留着。 */
export function paramsWithView(prev: URLSearchParams, view: TaskListView): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const k of ['status', 'repo', 'q']) next.delete(k);
  if (view.status !== undefined) next.set('status', view.status);
  if (view.repoId !== undefined) next.set('repo', view.repoId);
  if (view.q.trim() !== '') next.set('q', view.q);
  return next;
}

export const isFiltered = (view: TaskListView): boolean =>
  view.status !== undefined || view.repoId !== undefined || view.q.trim() !== '';

/** 列表当前的地址（路径加查询串），点进详情时带着，返回时用它。 */
export function listLocation(search: string): string {
  return `${TASKS_PATH}${search}`;
}

/** 从列表点进详情的链接。 */
export function detailLink(taskId: string, from: string): string {
  return `/tasks/${encodeURIComponent(taskId)}?${FROM_PARAM}=${encodeURIComponent(from)}`;
}

/**
 * 详情页返回列表的地址：只认站内的 /tasks 或 /tasks?…（地址栏里的值谁都能改，不能让它把人带去别处）。
 * 没带、不合规矩的是 null，详情页照旧回主页。
 */
export function backToList(from: string | null): string | null {
  if (from === null) return null;
  return from === TASKS_PATH || from.startsWith(`${TASKS_PATH}?`) ? from : null;
}

export const GROUP_TABS: { id: TaskListGroup | 'all'; label: string }[] = [
  { id: 'all', label: '全部' },
  ...TASK_LIST_GROUPS.map((g) => ({ id: g, label: TASK_LIST_GROUP_LABELS[g] })),
];

export const segmentText: Record<NonNullable<TaskListRow['segment']>, string> = {
  scoping: '对题',
  doing: '动手',
  verifying: '验收',
  verify_pending: '等验收',
  merge: '合并',
};

/** 一行状态芯片的颜色和字：暂停的单 state 仍是在干活，但人让它停了，画成等待色，不画成失败。 */
export function rowStatus(row: Pick<TaskListRow, 'state' | 'paused'>): { tone: Tone; label: string } {
  if (row.paused !== undefined) return { tone: 'stall', label: '已暂停' };
  return { tone: taskTone(row), label: taskStateLabel[row.state] };
}
