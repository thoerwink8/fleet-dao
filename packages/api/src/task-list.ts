// 任务列表（GET /api/tasks，#1639）：把 Store 翻出来的一页单子，配上三段流水、会话流水，拼成每行要给页面的样子。
// 改这里之前必须知道：
// - 现在在哪一段、用的模型沿用主页「在跑的」的算法（shared 的 taskFlow），不另算一份。已结束的单（做完、失败、叫停）segment 一律给 null：
//   「现在在哪」对结束了的单没有意思，页面看状态就行。
// - 累计花费 = 三段流水加老流程会话里结束了的各笔报的花费（shared 的 summarizeUsage，和任务详情同一份算法）。
//   一笔都没有 → null 加原因；有的没读到 → 给读到的合计，note 写明偏低。永远不拿 0 顶。
// - PR 号取起跑最晚的、带 PR 号的那一笔三段流水。

import {
  type Channel,
  type Model,
  type Repo,
  type Route,
  type SegmentRunView,
  type SessionRun,
  type TaskListResponse,
  taskFlow,
  taskListGroupOf,
} from '@fleet-dao/shared';
import type { SegmentRunRecord, TaskListPage } from '@fleet-dao/store';
import type { z } from 'zod';
import { isTaskFinished, routeLookup, segmentRunViews, usageView } from './views.ts';

type Response = z.input<typeof TaskListResponse>;
type Row = Response['items'][number];

export interface TaskListInput {
  page: TaskListPage;
  repos: readonly Repo[];
  /** 这一页所有单的三段流水（store.listSegmentRunsForTasks）。 */
  segmentRuns: readonly SegmentRunRecord[];
  /** 这一页所有单的老流程会话（store.listRuns）。 */
  runs: readonly SessionRun[];
  routes: readonly Route[];
  models: readonly Model[];
  channels: readonly Channel[];
}

const lastStarted = (views: readonly SegmentRunView[]): SegmentRunView | undefined =>
  views.reduce<SegmentRunView | undefined>(
    (latest, v) =>
      v.startedAt !== undefined && (!latest || (latest.startedAt ?? '') <= v.startedAt) ? v : latest,
    undefined,
  );

function costOf(usage: ReturnType<typeof usageView>['total']): Row['cost'] {
  const read = usage.runs - usage.missingCost;
  if (usage.runs === 0) return { usd: null, note: '还没有结束的会话记录，花费没得算' };
  if (read <= 0) return { usd: null, note: `${usage.runs} 笔会话都没报花费` };
  const usd = Math.round(usage.costUsd * 1_000_000) / 1_000_000;
  return usage.missingCost > 0
    ? { usd, note: `另有 ${usage.missingCost} 笔会话没报花费，这个数偏低` }
    : { usd };
}

export function taskListView(input: TaskListInput): Response {
  const repoById = new Map(input.repos.map((r) => [r.id, r]));
  const route = routeLookup([...input.routes], [...input.models], [...input.channels]);
  const tasks = input.page.items.map((i) => i.task);
  const finished = new Set(tasks.filter(isTaskFinished).map((t) => t.id));
  // 单子结束与否决定「开着的那一笔」算在跑还是没收尾（readSegmentRun 的 taskFinished），所以按这个分两批读
  const viewsByTask = new Map<string, SegmentRunView[]>();
  for (const taskFinished of [true, false]) {
    const records = input.segmentRuns.filter(
      (r) => (r.taskId !== undefined && finished.has(r.taskId)) === taskFinished,
    );
    const batch = segmentRunViews(records, {
      models: [...input.models],
      channels: [...input.channels],
      taskFinished,
    });
    batch.forEach((view, i) => {
      const taskId = records[i]?.taskId;
      if (taskId !== undefined) viewsByTask.set(taskId, [...(viewsByTask.get(taskId) ?? []), view]);
    });
  }
  const runsOf = (taskId: string): SessionRun[] => input.runs.filter((r) => r.taskId === taskId);

  const items = input.page.items.map(({ task, updatedAt }): Row => {
    const views = viewsByTask.get(task.id) ?? [];
    const repo = repoById.get(task.repoId);
    const flow = taskFlow(task, views);
    const group = taskListGroupOf(task);
    const sessions = runsOf(task.id);
    const latestSession = sessions.at(-1);
    const model =
      flow.worker ??
      lastStarted(views)?.modelName ??
      (latestSession ? route(latestSession.routeId).modelName : null);
    const prNumber = lastStarted(views.filter((v) => v.prNumber !== undefined))?.prNumber ?? null;
    return {
      taskId: task.id,
      repoId: task.repoId,
      repo: repo ? `${repo.owner}/${repo.name}` : '（仓不在库里）',
      issueNumber: task.issueNumber,
      title: task.title,
      state: task.state,
      ...(task.paused === undefined ? {} : { paused: task.paused }),
      group,
      segment: isTaskFinished(task) ? null : flow.segment,
      model,
      createdAt: task.createdAt,
      updatedAt,
      cost: costOf(usageView(sessions, route, views).total),
      prNumber,
    };
  });

  const { counts } = input.page;
  return {
    items,
    counts: { all: Object.values(counts).reduce((a, b) => a + b, 0), ...counts },
    ...(input.page.nextCursor === undefined ? {} : { nextCursor: input.page.nextCursor }),
  };
}
