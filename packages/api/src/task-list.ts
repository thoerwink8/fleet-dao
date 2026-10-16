// 任务列表（GET /api/tasks，#1639）：把 Store 翻出来的一页单子，配上三段流水、会话流水，拼成每行要给页面的样子。
// 改这里之前必须知道：
// - 现在在哪一段、用的模型沿用主页「在跑的」的算法（shared 的 taskFlow），不另算一份。已结束的单（做完、失败、叫停）segment 一律给 null：
//   「现在在哪」对结束了的单没有意思，页面看状态就行。
// - 累计花费 = 三段流水加老流程会话（shared 的 summarizeUsage，和任务详情同一份算法），再拆成实付和按 API 价折算
//   （taskListCost）。一段都没报实付、token 和单价都齐的给估计，不当成 0；没有单价的标出来。永远不拿 0 顶。
//   流水要带上 task_id 没记、按单号对上的各代（调用方开 includeIssueMatch），按 matchedTaskId 归到那张单。
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
  taskListCost,
  taskListGroupOf,
} from '@fleet-dao/shared';
import type { SegmentRunRecord, TaskListPage } from '@fleet-dao/store';
import type { z } from 'zod';
import { issueKey } from './request-issue.ts';
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
  /**
   * 「来自需求 N」（#2060）：这一页的单子里是驾驶舱哪条需求开出来的，键是 `owner/name#单号`（小写，request-issue.ts 的 issueKey）。
   * 没给（这台后端没接需求表）= 一个都不带；查不成给 requestSeqUnavailable 写原因，不能当成「都不是提需求开的」。
   */
  requestSeqs?: ReadonlyMap<string, number> | undefined;
  requestSeqUnavailable?: string | undefined;
}

const lastStarted = (views: readonly SegmentRunView[]): SegmentRunView | undefined =>
  views.reduce<SegmentRunView | undefined>(
    (latest, v) =>
      v.startedAt !== undefined && (!latest || (latest.startedAt ?? '') <= v.startedAt) ? v : latest,
    undefined,
  );

/** 归到哪张单：按单号兜底的用 matchedTaskId（task_id 是空的），其余用 task_id。 */
const taskKeyOf = (r: {
  matchedTaskId?: string | undefined;
  taskId?: string | undefined;
}): string | undefined => r.matchedTaskId ?? r.taskId;

export function taskListView(input: TaskListInput): Response {
  const repoById = new Map(input.repos.map((r) => [r.id, r]));
  const route = routeLookup([...input.routes], [...input.models], [...input.channels]);
  const tasks = input.page.items.map((i) => i.task);
  const finished = new Set(tasks.filter(isTaskFinished).map((t) => t.id));
  // 单子结束与否决定「开着的那一笔」算在跑还是没收尾（readSegmentRun 的 taskFinished），所以按这个分两批读。
  // 重做各代里 task_id 没记的行靠 matchedTaskId 归单，不然做完的单的验收会被当成还没结束的单。
  const viewsByTask = new Map<string, SegmentRunView[]>();
  for (const taskFinished of [true, false]) {
    const records = input.segmentRuns.filter((r) => {
      const key = taskKeyOf(r);
      return (key !== undefined && finished.has(key)) === taskFinished;
    });
    const batch = segmentRunViews(records, {
      models: [...input.models],
      channels: [...input.channels],
      taskFinished,
    });
    batch.forEach((view, i) => {
      const taskId = records[i] ? taskKeyOf(records[i]) : undefined;
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
    const usage = usageView(sessions, route, views);
    const model =
      flow.worker ??
      lastStarted(views)?.modelName ??
      (latestSession ? route(latestSession.routeId).modelName : null);
    const prNumber = lastStarted(views.filter((v) => v.prNumber !== undefined))?.prNumber ?? null;
    const requestSeq = repo
      ? input.requestSeqs?.get(issueKey(`${repo.owner}/${repo.name}`, task.issueNumber))
      : undefined;
    return {
      taskId: task.id,
      repoId: task.repoId,
      repo: repo ? `${repo.owner}/${repo.name}` : '（仓不在库里）',
      issueNumber: task.issueNumber,
      title: task.title,
      state: task.state,
      ...(task.paused === undefined ? {} : { paused: task.paused }),
      ...(task.executor === undefined ? {} : { executor: task.executor }),
      ...(task.claimedBy === undefined ? {} : { claimedBy: task.claimedBy }),
      ...(task.leaseUntil === undefined ? {} : { leaseUntil: task.leaseUntil }),
      group,
      segment: isTaskFinished(task) ? null : flow.segment,
      model,
      createdAt: task.createdAt,
      updatedAt,
      cost: taskListCost(usage.total, views.filter((v) => !v.running).length),
      prNumber,
      ...(requestSeq === undefined ? {} : { requestSeq }),
    };
  });

  const { counts } = input.page;
  return {
    items,
    counts: { all: Object.values(counts).reduce((a, b) => a + b, 0), ...counts },
    ...(input.page.nextCursor === undefined ? {} : { nextCursor: input.page.nextCursor }),
    ...(input.requestSeqUnavailable === undefined
      ? {}
      : { requestSeqUnavailable: input.requestSeqUnavailable }),
  };
}
