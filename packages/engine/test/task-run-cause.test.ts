// 每一笔会话为什么起、属于第几个回合（#3140，patched('run-cause-fields')）：工作流给 runSegment、coldVerify 的入参带上
// cause / causeSummary / roundSeq，一轮收场记 started_at 和返工摘要。只记账：这些字段不改任何走向。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { RUN_CAUSES } from '@fleet-dao/shared';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import type { RouteChoice } from '../src/ports.ts';
import type { RunSegmentResult, TaskRun, TaskWorkflowInput } from '../src/task-contract.ts';
import { reworkCauseOf } from '../src/workflows/task-support.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
import { OK_SEGMENT, scripted } from './task-script.ts';

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

const R1: RouteChoice = {
  routeId: 'r1',
  poolId: 'p1',
  modelId: 'm1',
  family: 'claude',
  hostId: 'claude-code',
};
const R2: RouteChoice = { routeId: 'r2', poolId: 'p2', modelId: 'm2', family: 'kimi', hostId: 'api-shell' };

const failed = (message: string, code: string): RunSegmentResult => ({
  ok: false,
  runId: null,
  outcome: 'failed',
  evidence: { code, message, quotaExhausted: false },
});

describe('reworkCauseOf：这一轮第一笔为什么起', () => {
  it('上一轮没留下问题是主写；留下了按问题分类，摘要取返工意见', () => {
    expect(reworkCauseOf(null, [])).toEqual({ cause: 'main' });
    expect(reworkCauseOf('CI 红了', ['检查红了：test'])).toEqual({
      cause: 'rework_ci',
      summary: '检查红了：test',
    });
    expect(reworkCauseOf('验收没过', ['验收没过：第 2 条没做到'])).toMatchObject({ cause: 'rework_verify' });
    expect(reworkCauseOf('和主线有冲突', [])).toEqual({ cause: 'rework_conflict', summary: '和主线有冲突' });
    expect(reworkCauseOf('会话跑完没有提交', ['没提交'])).toMatchObject({ cause: 'rework_no_commit' });
    expect(reworkCauseOf('正式评审要求改', ['评审：改命名'])).toMatchObject({ cause: 'rework_review' });
    expect(reworkCauseOf('卫生检查拦下了新增内容', [])).toMatchObject({ cause: 'rework_other' });
  });
  it('认出的每一种都在 shared 的 RUN_CAUSES 名单里（库里的约束同一份）', () => {
    for (const p of ['CI 红了', '验收没过', '和主线有冲突', '会话跑完没有提交', '正式评审要求改', '别的']) {
      expect(RUN_CAUSES).toContain(reworkCauseOf(p, []).cause);
    }
  });
});

describe('工作流给每一笔带起因和回合（#3140）', { timeout: 90_000 }, () => {
  it('CI 红返工一轮：第 1 笔主写、第 2 笔 CI 红了返工；验收两笔各带回合号；两轮收场记开始时刻和返工摘要', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['test'], digest: 'FAIL x' } : undefined),
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment.map((s) => [s.cause, s.roundSeq])).toEqual([
      ['main', 1],
      ['rework_ci', 2],
    ]);
    expect(calls.segment[0]).not.toHaveProperty('causeSummary');
    expect(calls.segment[1]?.causeSummary).toContain('test');
    expect(calls.verify.length).toBeGreaterThan(0);
    for (const v of calls.verify) expect(v.roundSeq).toBeGreaterThanOrEqual(1);
    const rounds = world.callsOf('recordRound').map((c) => c.input);
    expect(rounds.map((r) => [r.seq, r.outcome])).toEqual([
      [1, 'ci_red'],
      [2, 'merged'],
    ]);
    // 返工的一轮写了为什么返工；做成的那轮没有
    expect(rounds[0]?.reworkSummary).toContain('test');
    expect(rounds[1]).not.toHaveProperty('reworkSummary');
    for (const r of rounds) expect(Date.parse(r.startedAt ?? '')).toBeGreaterThan(0);
  });

  it('会话没跑成换一条路由重派：下一笔起因是「换路由重派」，摘要是分流给的原因；同一回合', async () => {
    const world = createFakeWorld({ routes: [R1, R2] });
    const { tasks, calls } = scripted({
      segment: async (_seg, n) => (n === 1 ? failed('账号被封了', 'account_banned') : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.map((s) => [s.cause, s.roundSeq])).toEqual([
      ['main', 1],
      ['reroute', 1],
    ]);
    expect(calls.segment[1]?.causeSummary).toBeTruthy();
  });

  it('没提交返工：第 2 轮这一笔起因是「没提交返工」', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      delivery: (n) => ({ head: fakeHead(100 + n), commits: n === 1 ? 0 : 1, changedFiles: ['a.ts'] }),
    });
    await withWorker(env, world, async (q) => (await start(q, input())).result() as Promise<TaskRun>, {
      tasks,
    });
    expect(calls.segment.map((s) => s.cause)).toEqual(['main', 'rework_no_commit']);
  });

  it('续会话判定为新会话时，原因直接走 resumeReason 字段，不再借 route.why', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      delivery: (n) => ({ head: fakeHead(100 + n), commits: n === 1 ? 0 : 1, changedFiles: ['a.ts'] }),
      resume: () => ({ kind: 'new', reason: '上一段没记下会话号' }),
    });
    await withWorker(env, world, async (q) => (await start(q, input())).result() as Promise<TaskRun>, {
      tasks,
    });
    const second = calls.segment[1];
    expect(second?.resumeReason).toBe('上一段没记下会话号');
    expect(second?.route.why ?? '').not.toContain('fleet-resume-new:');
  });
});
