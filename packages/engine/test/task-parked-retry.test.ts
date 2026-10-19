// 停下等人的单按规则续一次（#3294）在任务工作流这一侧：停下时记停法（patched('park-kind')），查询里看得到；
// 引擎续停（jobs/parked-retry.ts）发的「继续」只认正停着的这一次、可续的停法、同一原文没续过的。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动；续停那一轮直接拿工作流句柄当真装配（查询、发信号）。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { type ParkedRetryDeps, type ParkedRetryResult, retryParkedTasks } from '../src/jobs/parked-retry.ts';
import { PortError } from '../src/ports.ts';
import {
  type ArmAutoMergeResult,
  PARKED_RETRY_ACTOR,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskContinueSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 3208,
    title: '停在 unstable 的单',
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });
}

const statusUntil = (h: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  pollQuery(() => h.query(taskStatusQuery), check, what);

/** 2026-10-19 #3208 停下时 GitHub 回的那一句（PR 是 unstable）。 */
const UNSTABLE = 'GitHub 拒绝挂自动合并：PR 状态 unstable（Pull request is in unstable status）';
const UNARMED: ArmAutoMergeResult = { armed: false, merged: false, why: UNSTABLE };
const ARMED: ArmAutoMergeResult = { armed: true, merged: false };

/** 续停这一轮：只看这一张，现问的是真工作流；法国在 release 那一刻发了新版（null＝没发）。 */
function jobOn(
  h: WorkflowHandle,
  i: TaskWorkflowInput,
  release: (park: NonNullable<TaskStatus['park']>) => Date | null,
): { deps: ParkedRetryDeps; audits: string[]; prReads: number } {
  const out = { audits: [] as string[], prReads: 0 };
  const deps: ParkedRetryDeps = {
    tasks: async () => [
      {
        taskId: i.taskId,
        owner: i.repo.owner,
        name: i.repo.name,
        issueNumber: i.issueNumber,
        workflowId: h.workflowId,
      },
    ],
    status: async () => {
      const s = await h.query(taskStatusQuery);
      return { phase: s.phase, prNumber: s.prNumber, park: s.park };
    },
    release: async () => {
      const s = await h.query(taskStatusQuery);
      const at = s.park ? release(s.park) : null;
      return at ? { sha: 'd'.repeat(40), at } : null;
    },
    mergeReady: async () => {
      out.prReads += 1;
      return { ready: false, why: '必过检查还没全绿' };
    },
    continueTask: async (workflowId, command) => {
      await env.client.workflow.getHandle(workflowId).signal(taskContinueSignal, command);
      return 'sent';
    },
    audit: async ({ why }) => {
      out.audits.push(why);
    },
    resolveAlert: async () => {},
    runs: { start: async () => 1, finish: async () => {} },
    now: () => new Date(),
    log: () => {},
  };
  return {
    deps,
    get audits() {
      return out.audits;
    },
    get prReads() {
      return out.prReads;
    },
  };
}

const anHourAfter = (park: { at: string }) => new Date(Date.parse(park.at) + 60 * 60_000);
const parkedAt = (seq: number) => (s: TaskStatus) => s.phase === 'parked' && s.park?.seq === seq;

describe('停下等人按规则续一次（#3294）', { timeout: 120_000 }, () => {
  it('#3208 的样子：自动合并没挂上（unstable）停下，之后法国发了新版 → 引擎续一次，接着挂上合并', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ arm: (n) => (n === 1 ? UNARMED : ARMED) });
    let result: ParkedRetryResult | undefined;
    let audits: string[] = [];
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const i = input();
        const h = await start(q, i);
        const s = await statusUntil(h, (st) => st.phase === 'parked', '自动合并没挂上，停下');
        expect(s.park).toMatchObject({
          kind: 'unarmed',
          title: '自动合并没挂上',
          head: expect.any(String),
          retriedBefore: false,
        });
        const job = jobOn(h, i, anHourAfter);
        result = await retryParkedTasks(job.deps);
        audits = job.audits;
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(result?.continued).toHaveLength(1);
    expect(audits).toEqual([
      expect.stringMatching(/^引擎续的（停法「自动合并没挂上」.*法国发了新版 dddddddddddd/),
    ]);
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.arm).toBe(2);
    // 只报了停下那一次
    expect(world.alerts.map((a) => a.title)).toEqual(['自动合并没挂上']);
  });

  it('同一次停下不续两次：同一原文再停下标 retriedBefore，续停不再续；编号对不上的、重发的引擎「继续」都不理，人点「继续」照样走', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ arm: (n) => (n <= 2 ? UNARMED : ARMED) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const i = input();
        const h = await start(q, i);
        const first = await statusUntil(h, (st) => st.phase === 'parked', '第一次停下');
        const seq = first.park?.seq as number;
        // 编号对不上的引擎「继续」不认
        await h.signal(taskContinueSignal, { by: PARKED_RETRY_ACTOR, parkSeq: seq + 7 });
        expect((await h.query(taskStatusQuery)).park?.seq).toBe(seq);
        const job = jobOn(h, i, anHourAfter);
        expect((await retryParkedTasks(job.deps)).continued).toHaveLength(1);
        // 同一原文又停下：标了引擎续过，这一轮不续，也不去读 PR
        const second = await statusUntil(h, parkedAt(seq + 1), '同一原文第二次停下');
        expect(second.park).toMatchObject({ kind: 'unarmed', retriedBefore: true });
        const again = await retryParkedTasks(job.deps);
        expect(again.continued).toEqual([]);
        expect(job.prReads).toBe(0);
        // 直接发引擎「继续」：上一次的编号（晚到的重发）、这一次的编号都不认
        await h.signal(taskContinueSignal, { by: PARKED_RETRY_ACTOR, parkSeq: seq });
        await h.signal(taskContinueSignal, { by: PARKED_RETRY_ACTOR, parkSeq: seq + 1 });
        const still = await h.query(taskStatusQuery);
        expect(still.phase).toBe('parked');
        expect(still.park?.seq).toBe(seq + 1);
        expect(calls.arm).toBe(2);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(3);
  });

  it('引擎续了之后、工作流还没离开 parked（报警还在发）：查询里已标 retriedBefore，下一轮续停不再发「继续」、不再记操作记录', async () => {
    const world = createFakeWorld({ holdPorts: ['raiseAlert'] });
    const { tasks, calls } = scripted({ arm: (n) => (n === 1 ? UNARMED : ARMED) });
    let signals = 0;
    let audits: string[] = [];
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const i = input();
        const h = await start(q, i);
        const first = await statusUntil(h, (st) => st.phase === 'parked', '停下，报警还挂着');
        expect(first.park?.retriedBefore).toBe(false);
        const job = jobOn(h, i, anHourAfter);
        const send = job.deps.continueTask;
        job.deps.continueTask = async (workflowId, command) => {
          signals += 1;
          return send(workflowId, command);
        };
        expect((await retryParkedTasks(job.deps)).continued).toHaveLength(1);
        // 报警还没发完，工作流仍停着；查询已经标上这一次引擎续过了
        const mid = await h.query(taskStatusQuery);
        expect(mid.phase).toBe('parked');
        expect(mid.park).toMatchObject({ seq: first.park?.seq, retriedBefore: true });
        expect((await retryParkedTasks(job.deps)).continued).toEqual([]);
        audits = job.audits;
        world.releasePort('raiseAlert');
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(signals).toBe(1);
    expect(audits).toHaveLength(1);
    expect(calls.arm).toBe(2);
  });

  it('改标准等人闸：停法记 standard，发了新版也不续；直接发引擎「继续」也不认，要人点', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      guarded: (n) => (n === 1 ? { standards: ['AGENTS.md'] } : { standards: [] }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const i = input();
        const h = await start(q, i);
        const s = await statusUntil(h, (st) => st.phase === 'parked', '改标准，停下等创始人');
        expect(s.park?.kind).toBe('standard');
        const job = jobOn(h, i, anHourAfter);
        expect((await retryParkedTasks(job.deps)).continued).toEqual([]);
        await h.signal(taskContinueSignal, { by: PARKED_RETRY_ACTOR, parkSeq: s.park?.seq as number });
        const still = await h.query(taskStatusQuery);
        expect(still.phase).toBe('parked');
        expect(calls.arm).toBe(0);
        await h.signal(taskContinueSignal, { by: 'frank', note: '同意' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(1);
  });

  it('PR 关了、还是草稿、等检查时挂合并认证失败：停法记 other，发了新版也不续，不算「自动合并没挂上」', async () => {
    const cases: { name: string; arm: (n: number, input: { expectedHead: string }) => ArmAutoMergeResult }[] =
      [
        {
          name: '关了',
          arm: (n) => (n === 1 ? { ...UNARMED, why: 'PR 已经关了', refused: 'closed' } : ARMED),
        },
        {
          name: '草稿',
          arm: (n) => (n === 1 ? { ...UNARMED, why: 'PR 还是草稿', refused: 'draft' } : ARMED),
        },
        {
          name: '认证失败',
          arm: (n, input) => {
            if (n === 1)
              return {
                armed: false,
                merged: false,
                why: '检查还在跑',
                checksPending: { names: ['merge-gate'], head: input.expectedHead, detail: '检查还在跑' },
              };
            if (n === 2) throw new PortError('AUTH_REQUIRED', 'GitHub 令牌失效', { retryable: false });
            return ARMED;
          },
        },
      ];
    for (const c of cases) {
      const world = createFakeWorld();
      const { tasks, calls } = scripted({ arm: c.arm });
      await withWorker(
        env,
        world,
        async (q) => {
          const i = input();
          const h = await start(q, i);
          // 等检查那一觉要时钟往前走才醒来再挂一次
          if (c.name === '认证失败') await env.sleep('1 minute');
          const s = await statusUntil(h, (st) => st.phase === 'parked', `${c.name}，停下`);
          expect(s.park?.kind, c.name).toBe('other');
          const job = jobOn(h, i, anHourAfter);
          expect((await retryParkedTasks(job.deps)).continued, c.name).toEqual([]);
          expect(job.audits, c.name).toEqual([]);
          expect((await h.query(taskStatusQuery)).phase, c.name).toBe('parked');
          expect(calls.arm, c.name).toBeLessThanOrEqual(2);
          await h.terminate('测试收场');
        },
        { tasks },
      );
    }
  });

  it('停下之后没发新版、PR 也还不能合：不续，原地等人', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({ arm: (n) => (n === 1 ? UNARMED : ARMED) });
    await withWorker(
      env,
      world,
      async (q) => {
        const i = input();
        const h = await start(q, i);
        await statusUntil(h, (st) => st.phase === 'parked', '自动合并没挂上，停下');
        const job = jobOn(h, i, () => null);
        expect((await retryParkedTasks(job.deps)).continued).toEqual([]);
        expect(job.prReads).toBe(1);
        expect((await h.query(taskStatusQuery)).phase).toBe('parked');
        await h.terminate('测试收场');
      },
      { tasks },
    );
  });
});
