// 一张单「派出过没有」：拉单（jobs/intake.ts）和点名派单（jobs/dispatch-issue.ts）用这一份，不许各判各的。
// 任务行在、Temporal 里却没有任何一代（Fusion 留下的 queued / stopped）不算派出过，派的时候接手那一行。
// 有一代在跑，或有一代已经结束（做得完、失败，都能重做），算派出过。问不清是不确定，不许当成没有工作流。
// 例外「重新派」：本机领过又退回法国（租约到期退回，或本机放手）、退回之后一直没人接的行——任务行 stopped、执行方 engine、
// 各代都已结束、操作记录里最近一条退回晚于最后一代结束的时刻。本机领单不新起一代，只算「派出过」就永远接不回来（#3033、#3258）。

import type { TaskExecutor, TaskOwner, TaskState } from '@fleet-dao/shared';
import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { errMessage } from '@fleet-dao/shared/util';

/** 操作记录里写的那句。派单接手了没有任务工作流的老任务行。 */
export const ORPHAN_TASK_ADOPT_NOTE = '接手无工作流的老任务行';

export interface IssueTaskRow {
  id: string;
  state: TaskState;
  /** 执行方。老装配不给就认不出「退回」，不会判成重新派。 */
  executor?: TaskExecutor | undefined;
  /** 归哪套系统（决定 0124）：harness 是新内核的单，旧引擎不派、不接手、不重新派。老装配不给按 v1。 */
  owner?: TaskOwner | undefined;
  /**
   * 操作记录里最近一次退回法国队列的时刻（task.local.expire 且 how=returned，或本机放手 released）；从没退回过是 null。
   * 只有 stopped + engine 的行才需要读，别的行给 null 也不影响判断。
   */
  returnedAt?: Date | null | undefined;
}

/** 顺着代数问到的每一代是在跑还是已经结束。ok:false = 问不清，不是「一代都没有」。 */
export type TaskGenerationFacts =
  | {
      ok: true;
      lives: readonly ('running' | 'terminated')[];
      /** 最后一代（最高代数）结束的时刻；还在跑、读不到是 null / 不给。判「重新派」要它，没有就不判。 */
      lastEndedAt?: Date | null | undefined;
    }
  | { ok: false; why: string };

export type DispatchStanding =
  | { kind: 'open' }
  /** returnedAt：这一行是本机退回的（有退回记录）时给，拉单据此在法国接不了时把单留给本机。 */
  | { kind: 'adopt'; taskId: string; state: 'queued' | 'stopped'; returnedAt?: Date }
  /** 退回法国队列后没人接的行：准入全过、有空位后起下一代（generation = 已有代数 + 1）。returnedAt 是那次退回的时刻。 */
  | { kind: 'redispatch'; taskId: string; generation: number; returnedAt: Date }
  | { kind: 'dispatched' }
  /** 新内核的单（tasks.owner = harness）：旧引擎一律不碰。 */
  | { kind: 'harness' }
  | { kind: 'uncertain'; why: string };

export function dispatchStanding(
  task: IssueTaskRow | null,
  generations: TaskGenerationFacts | null,
): DispatchStanding {
  if (task === null) return { kind: 'open' };
  if (task.owner === 'harness') return { kind: 'harness' };
  if (generations === null || !generations.ok) {
    const detail = generations && !generations.ok && generations.why ? generations.why : '没有回结果';
    return {
      kind: 'uncertain',
      why: `查任务工作流没查成（${detail}），不确定是不是已经派出过，没有当成没有工作流`,
    };
  }
  if (generations.lives.length > 0) {
    if (task.returnedAt && isReturnedAfterLastGeneration(task, generations)) {
      return {
        kind: 'redispatch',
        taskId: task.id,
        generation: generations.lives.length + 1,
        returnedAt: task.returnedAt,
      };
    }
    return { kind: 'dispatched' };
  }
  if (task.state === 'queued' || task.state === 'stopped') {
    return {
      kind: 'adopt',
      taskId: task.id,
      state: task.state,
      ...(task.state === 'stopped' && task.executor === 'engine' && task.returnedAt
        ? { returnedAt: task.returnedAt }
        : {}),
    };
  }
  return { kind: 'dispatched' };
}

/**
 * 「重新派」的条件，全满足才算：任务行 stopped；执行方 engine；所有代都已结束；操作记录里最近一条退回晚于最后一代结束的时刻；
 * 再往上起一代不超过代数上限。读不全（没有退回时刻、没有最后一代的结束时刻）不判。
 */
function isReturnedAfterLastGeneration(
  task: IssueTaskRow,
  generations: Extract<TaskGenerationFacts, { ok: true }>,
): boolean {
  if (task.state !== 'stopped' || task.executor !== 'engine') return false;
  if (generations.lives.some((life) => life !== 'terminated')) return false;
  if (generations.lives.length >= MAX_TASK_GENERATION) return false;
  const returned = task.returnedAt?.getTime();
  const ended = generations.lastEndedAt?.getTime();
  if (returned === undefined || ended === undefined || Number.isNaN(returned) || Number.isNaN(ended)) {
    return false;
  }
  return returned > ended;
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
  if (task.owner === 'harness') return dispatchStanding(task, null);
  let generations: TaskGenerationFacts;
  try {
    generations = await deps.taskGenerations(repo, issueNumber);
  } catch (err) {
    generations = { ok: false, why: errMessage(err) };
  }
  return dispatchStanding(task, generations);
}
