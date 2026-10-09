// 一张单「派出过没有」：拉单（jobs/intake.ts）和点名派单（jobs/dispatch-issue.ts）用这一份，不许各判各的。
// 任务行在、Temporal 里却没有任何一代（Fusion 留下的 queued / stopped）不算派出过，派的时候接手那一行。
// 有一代在跑，或有一代已经结束（做得完、失败，都能重做），算派出过。问不清是不确定，不许当成没有工作流。

import type { TaskState } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

/** 操作记录里写的那句。派单接手了没有任务工作流的老任务行。 */
export const ORPHAN_TASK_ADOPT_NOTE = '接手无工作流的老任务行';

export interface IssueTaskRow {
  id: string;
  state: TaskState;
}

/** 顺着代数问到的每一代是在跑还是已经结束。ok:false = 问不清，不是「一代都没有」。 */
export type TaskGenerationFacts =
  | { ok: true; lives: readonly ('running' | 'terminated')[] }
  | { ok: false; why: string };

export type DispatchStanding =
  | { kind: 'open' }
  | { kind: 'adopt'; taskId: string; state: 'queued' | 'stopped' }
  | { kind: 'dispatched' }
  | { kind: 'uncertain'; why: string };

export function dispatchStanding(
  task: IssueTaskRow | null,
  generations: TaskGenerationFacts | null,
): DispatchStanding {
  if (task === null) return { kind: 'open' };
  if (generations === null || !generations.ok) {
    const detail = generations && !generations.ok && generations.why ? generations.why : '没有回结果';
    return {
      kind: 'uncertain',
      why: `查任务工作流没查成（${detail}），不确定是不是已经派出过，没有当成没有工作流`,
    };
  }
  if (generations.lives.length > 0) return { kind: 'dispatched' };
  if (task.state === 'queued' || task.state === 'stopped') {
    return { kind: 'adopt', taskId: task.id, state: task.state };
  }
  return { kind: 'dispatched' };
}

/** 先读任务行。没有行就不问 Temporal（新单不因为 Temporal 暂时连不上而派不出去）。有行才问各代。 */
export async function readDispatchStanding<R>(
  deps: {
    issueTask(repo: R, issueNumber: number): Promise<IssueTaskRow | null>;
    taskGenerations(repo: R, issueNumber: number): Promise<TaskGenerationFacts>;
  },
  repo: R,
  issueNumber: number,
): Promise<DispatchStanding> {
  const task = await deps.issueTask(repo, issueNumber);
  if (task === null) return dispatchStanding(null, null);
  let generations: TaskGenerationFacts;
  try {
    generations = await deps.taskGenerations(repo, issueNumber);
  } catch (err) {
    generations = { ok: false, why: errMessage(err) };
  }
  return dispatchStanding(task, generations);
}
