// 每一轮收场记进库（#2762，patched('round-outcome')）：返工、合并、放弃时各记一行，带结束类、档位、首派模型、PR 新增行数。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { ROUND_OUTCOMES } from '@fleet-dao/db';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import type { RoundOutcome } from '../src/ports.ts';
import {
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { roundOutcomeOf, stoppedOutcomeOf } from '../src/workflows/task-support.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

function input(over: Partial<TaskWorkflowInput> = {}): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
    ...over,
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber, 1),
    args: [i],
  });
}

describe('一轮怎么收场的（#2762）', () => {
  it('按返工那一刻的 lastProblem 认；推分支冲突和等合并冲突分开；认不出记 other', () => {
    expect(roundOutcomeOf('deliver', 'CI 红了', [])).toBe('ci_red');
    expect(roundOutcomeOf('deliver', '检查红了：test', ['检查红了：test'])).toBe('ci_red');
    expect(roundOutcomeOf('deliver', '验收没过', [])).toBe('verify_rejected');
    expect(roundOutcomeOf('implement', '和主线有冲突', [])).toBe('push_conflict');
    expect(roundOutcomeOf('deliver', '和主线有冲突', [])).toBe('merge_conflict');
    expect(roundOutcomeOf('implement', '会话跑完没有提交', [])).toBe('no_commit');
    expect(roundOutcomeOf('implement', '推的时候没有新提交', [])).toBe('no_commit');
    expect(roundOutcomeOf('implement', '会话跑完工作树里还有没提交的改动', [])).toBe('leftover');
    expect(roundOutcomeOf('implement', '卫生检查拦下了新增内容', [])).toBe('other');
    expect(stoppedOutcomeOf('会话 60 分钟没跑完，总时长到顶')).toBe('timeout');
    expect(stoppedOutcomeOf(null)).toBe('stopped');
  });

  it('引擎的结束类名单和库里的 ROUND_OUTCOMES 一字不差', () => {
    const engine: RoundOutcome[] = [
      'merged',
      'verify_rejected',
      'ci_red',
      'leftover',
      'no_commit',
      'push_conflict',
      'merge_conflict',
      'timeout',
      'stopped',
      'other',
    ];
    expect([...ROUND_OUTCOMES].sort()).toEqual([...engine].sort());
  });
});

describe('每一轮收场记进库（#2762）', { timeout: 60_000 }, () => {
  it('CI 红返工一轮、第 2 轮合并：记两行，带档位、首派模型、PR 新增行数，seq 连着', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['test'], digest: 'FAIL x' } : undefined),
      addedLines: (_i, n) => (n === 1 ? 40 : 55),
    });
    const { tasks } = scripted();
    const i = input();
    const run = await withWorker(env, world, async (q) => (await start(q, i)).result() as Promise<TaskRun>, {
      tasks,
    });
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const rows = world.callsOf('recordRound').map((c) => c.input);
    expect(rows.map((r) => [r.seq, r.round, r.outcome, r.addedLines])).toEqual([
      [1, 1, 'ci_red', 40],
      [2, 2, 'merged', 55],
    ]);
    expect(rows[0]?.taskId).toBe(i.taskId);
    expect(rows[0]?.workflowId).toBe(taskWorkflowId(i.repo, i.issueNumber, 1));
    expect(rows[0]?.firstModel).toBe('m1');
    expect(rows[0]?.tier).toBeTruthy();
  });

  it('没提交、验收没过各记成自己的类', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({
      delivery: (n) => ({ head: fakeHead(100 + n), commits: n === 1 ? 0 : 1, changedFiles: ['a.ts'] }),
      verify: (v) =>
        v.headSha === fakeHead(102)
          ? { pass: false, problems: ['没做到验收条'], round: 1 }
          : { pass: true, problems: [], round: 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.callsOf('recordRound').map((c) => c.input.outcome)).toEqual([
      'no_commit',
      'verify_rejected',
      'merged',
    ]);
    // 一轮都没推上去时没有新增行数，不拿 0 顶
    expect(world.callsOf('recordRound')[0]?.input).not.toHaveProperty('addedLines');
  });

  it('停在一轮里被放弃：记 stopped', async () => {
    const world = createFakeWorld();
    // 改到「改标准」的路径：验收过了停下等创始人，这一轮还没收场
    const { tasks } = scripted({ guarded: () => ({ standards: ['AGENTS.md'] }) });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await pollQuery(
          () => h.query(taskStatusQuery) as Promise<TaskStatus>,
          (s) => s.waiting?.kind === 'human',
          '改标准，停下等人',
        );
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不要了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(world.callsOf('recordRound').map((c) => c.input.outcome)).toEqual(['stopped']);
  });

  it('【故意造出的失败】记库没成：不挡原流程，照旧合并', async () => {
    const world = createFakeWorld({ failFirst: { recordRound: 99 } });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('recordRound')).toBeGreaterThan(0);
  });
});
