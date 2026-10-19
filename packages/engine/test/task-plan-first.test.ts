// 重活先出方案、体量预算（#2755）：heavyweight 第一轮先跑只读的方案段（格式不对重出一次）；推之前比新增行和预算，
// 超了第一次打回收窄、第二次停下附拆单建议。真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import { DEFAULT_LIMITS, DEFAULT_PR_LINE_BUDGET, resolveLimits } from '../src/limits.ts';
import type { TaskBrief } from '../src/runner/task-brief.ts';
import {
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskContinueSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { parsePlan, splitSuggestion } from '../src/workflows/task-support.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { goodBrief, scripted } from './task-script.ts';

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

function briefOf(tier: 'heavyweight' | 'medium'): () => { ok: true; brief: TaskBrief } {
  return () => ({
    ok: true,
    brief: { ...goodBrief(), tier: { tier, effort: 'high', reason: '测试定的档' } },
  });
}

const RESUME_ALWAYS = () => ({ kind: 'resume' as const, sessionId: 'sess-1', runId: 'run-1' });
const PLAN = '```json\n{"files": ["packages/web/src/pages/a.tsx"], "addedLines": 80, "acceptance": [1]}\n```';
const answer = (text: string) => ({ ok: true as const, runId: 'run-1', answer: text });

describe('方案 JSON（#2755）', () => {
  it('认 ```json 代码块或裸 JSON；缺项、类型不对写明哪一样', () => {
    expect(parsePlan(PLAN)).toEqual({
      ok: true,
      plan: { files: ['packages/web/src/pages/a.tsx'], addedLines: 80, acceptance: [1] },
    });
    expect(parsePlan('方案如下 {"files":["a.ts"],"addedLines":3,"acceptance":["1"]}').ok).toBe(true);
    expect(parsePlan('{"files":[],"addedLines":3,"acceptance":[1]}')).toMatchObject({
      ok: false,
      why: expect.stringContaining('files'),
    });
    expect(parsePlan('{"files":["a"],"addedLines":-1,"acceptance":[1]}')).toMatchObject({
      ok: false,
      why: expect.stringContaining('addedLines'),
    });
    expect(parsePlan('{"files":["a"],"addedLines":1}')).toMatchObject({
      ok: false,
      why: expect.stringContaining('acceptance'),
    });
    expect(parsePlan('做完了')).toMatchObject({ ok: false, why: '没找到 JSON' });
    expect(parsePlan('{坏的}')).toMatchObject({ ok: false, why: 'JSON 解析不了' });
  });

  it('拆单建议按包分组，多的在前', () => {
    expect(splitSuggestion(['packages/a/x.ts', 'packages/a/y.ts', 'packages/b/z.ts', 'docs/d.md'])).toBe(
      '按改动面拆，一处一张单、各自带验收条，能先合的先合：packages/a（2 个文件）、docs（1 个文件）、packages/b（1 个文件）。',
    );
    expect(splitSuggestion(['packages/a/x.ts'])).toContain('按验收条拆');
  });

  it('Limits 有 prLineBudget：默认 3000，设 0 就是关（保留 0，不换成默认）', () => {
    expect(DEFAULT_LIMITS.prLineBudget).toBe(DEFAULT_PR_LINE_BUDGET);
    expect(resolveLimits({ prLineBudget: 0 }).prLineBudget).toBe(0);
    expect(resolveLimits({ prLineBudget: -5 }).prLineBudget).toBe(DEFAULT_PR_LINE_BUDGET);
  });
});

describe('重活先出方案（#2755）', { timeout: 60_000 }, () => {
  it('重活第一轮：先跑只读的方案段，认下了带进意见，动手续这个会话；不算一轮', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: briefOf('heavyweight'),
      resume: RESUME_ALWAYS,
      segment: async (_i, n) => answer(n === 1 ? PLAN : '验收条 1：做到了'),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[0]?.mode).toBe('plan');
    expect(calls.segment[1]?.mode).toBeUndefined();
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    const fb = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(fb).toContain('方案认下了：改 packages/web/src/pages/a.tsx，预计新增 80 行，对应验收第 1 条');
    expect(fb).toContain(`体量预算是新增 ${DEFAULT_PR_LINE_BUDGET} 行`);
    // 方案段不读交付：动手那一段收场后才读
    expect(calls.order.slice(0, 4)).toEqual(['brief', 'segment', 'segment', 'delivery']);
  });

  it('方案格式不对：续进同一个会话重出一次，认下了再动手', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: briefOf('heavyweight'),
      resume: RESUME_ALWAYS,
      segment: async (_i, n) => answer(n === 1 ? '我看完了，打算改 a.tsx' : n === 2 ? PLAN : '做完了'),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment.map((s) => s.mode)).toEqual(['plan', 'plan', undefined]);
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    expect(calls.segment[1]?.feedback.join('\n')).toContain('不是要的方案 JSON（没找到 JSON）');
    expect(calls.segment[2]?.feedback.join('\n')).toContain('方案认下了');
  });

  it('【故意造出的失败】重出一次还不对：不停下，照常动手，意见里不带方案', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: briefOf('heavyweight'),
      resume: RESUME_ALWAYS,
      segment: async (_i, n) => answer(n <= 2 ? '没有 JSON' : '做完了'),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.map((s) => s.mode)).toEqual(['plan', 'plan', undefined]);
    expect(calls.segment[2]?.feedback.join('\n')).not.toContain('方案认下了');
    expect(world.alerts).toEqual([]);
  });

  it('不是重活：不出方案，直接动手', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ brief: briefOf('medium') });
    await withWorker(env, world, async (q) => (await start(q, input())).result() as Promise<TaskRun>, {
      tasks,
    });
    expect(calls.segment).toHaveLength(1);
    expect(calls.segment[0]?.mode).toBeUndefined();
  });
});

describe('体量预算（#2755）', { timeout: 60_000 }, () => {
  it('可信单份生成快照单独计量，raw字段不改；旧history无新字段仍按原预算返工', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: briefOf('medium'),
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: 1,
        changedFiles: ['packages/db/migrations/meta/0095_snapshot.json'],
        addedLines: 9550,
        ...(n === 1
          ? {}
          : {
              lineBudgetMeasurement: {
                version: 1 as const,
                base: fakeHead(1),
                head: fakeHead(100 + n),
                rawAddedLines: 9550,
                rawDiffBytes: 330000,
                verifiedGeneratedLines: 8037,
                chargeableAddedLines: 1513,
                verified: true,
                reason: '已核单份快照',
              },
            }),
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('pushBranch')).toBe(1);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('9550');
  });

  it('失败或串head的折扣不适用，保持raw判并带明确原因', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: briefOf('medium'),
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: 1,
        changedFiles: ['packages/db/migrations/meta/0095_snapshot.json'],
        addedLines: n < 3 ? 9550 : 100,
        lineBudgetMeasurement: {
          version: 1,
          base: fakeHead(1),
          head: fakeHead(999),
          rawAddedLines: 9550,
          verifiedGeneratedLines: 8037,
          chargeableAddedLines: 1513,
          verified: n === 2,
          reason: '未核实当前head',
        },
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await pollQuery(
          () => h.query(taskStatusQuery) as Promise<TaskStatus>,
          (x) => x.waiting?.kind === 'human',
          'raw预算等待',
        );
        expect(world.count('pushBranch')).toBe(0);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.segment[1]?.feedback.join('\n')).toContain('未核实当前head');
  });
  it('超了预算第一次：不推，打回收窄（意见写明新增几行、预算几行）；收窄到预算内再推', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: briefOf('medium'),
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: 1,
        changedFiles: ['packages/web/src/pages/a.tsx', 'packages/api/src/b.ts'],
        addedLines: n === 1 ? 5000 : 900,
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('pushBranch')).toBe(1);
    expect(calls.segment[1]?.feedback.join('\n')).toContain(
      `这一轮相对主线新增 5000 行，超过体量预算 ${DEFAULT_PR_LINE_BUDGET} 行`,
    );
  });

  it('收窄过还超：停下等人，写明拆单建议；人点「继续」照这一版推', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({
      brief: briefOf('medium'),
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: 1,
        changedFiles: ['packages/web/src/pages/a.tsx', 'packages/api/src/b.ts', 'packages/api/src/c.ts'],
        addedLines: 6000,
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(
          () => h.query(taskStatusQuery) as Promise<TaskStatus>,
          (x) => x.waiting?.kind === 'human',
          '超预算停下',
        );
        expect(s.lastProblem).toContain('改动超出体量预算：新增 6000 行');
        expect(world.alerts.at(-1)?.detail).toContain('按改动面拆');
        expect(world.alerts.at(-1)?.detail).toContain('packages/api（2 个文件）');
        expect(world.count('pushBranch')).toBe(0);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('pushBranch')).toBe(1);
  });

  it('没量到新增行（老版读交付）：不判预算', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({ brief: briefOf('medium') });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
  });
});
