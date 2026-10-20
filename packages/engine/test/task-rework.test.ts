// 返工少花 token（决定 0093）：返工续上一轮的会话、连着续两轮没过开新会话；冲突引擎先自己并；会话收场后引擎自己跑测试和 tsc，
// 红了续进会话再改一次，输出交给冷验收；单任务 token 预算超了停下等人。真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMANDER_ACTOR } from '../src/commander-contract.ts';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import { DEFAULT_TASK_TOKEN_BUDGET } from '../src/limits.ts';
import { PortError } from '../src/ports.ts';
import { buildTaskBrief } from '../src/runner/task-brief.ts';
import {
  type SelfCheckResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskContinueSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { COMMIT_NUDGE_LINE, SELF_CHECK_RED_LINE } from '../src/workflows/task-support.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { BODY, goodBrief, scripted } from './task-script.ts';

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

async function start(q: string, i: TaskWorkflowInput, generation = 1): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber, generation),
    args: [i],
  });
}

/** 上一代的会话落在这个时刻，早于任何一代测试工作流的开工。 */
const PREVIOUS_GENERATION_AT = Date.parse('2020-01-01T00:00:00.000Z');
const PREVIOUS_GENERATION_TOKENS = 83_500_000;

/**
 * 照 taskTokenSpend 的口径：给了起算时间就只算这之后的（上一代的 83.5M 在开工之前，不算）。
 * 没给起算时间就整张单都算，用来抓住「工作流忘了传 since」。
 */
function spendSince(input: { since?: string } | undefined, ownTokens: number) {
  const since = input?.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(input.since);
  const previous = PREVIOUS_GENERATION_AT >= since ? PREVIOUS_GENERATION_TOKENS : 0;
  return {
    tokens: previous + ownTokens,
    runs: previous + ownTokens > 0 ? 1 : 0,
    unmetered: 0,
    estimated: 0,
  };
}

const statusOf = (h: WorkflowHandle): Promise<TaskStatus> => h.query(taskStatusQuery);
const parked = (s: TaskStatus) => s.waiting?.kind === 'human';

const RESUME_ALWAYS = () => ({ kind: 'resume' as const, sessionId: 'sess-1', runId: 'run-1' });

describe('在途正式合同修订（#3216）', { timeout: 60_000 }, () => {
  const revised = () => {
    const result = buildTaskBrief({
      issue: {
        number: 12,
        title: '修订需求',
        state: 'open',
        body: BODY.replace('packages/web/src/pages/', 'packages/engine/src/jobs/watchdog.ts').replace(
          '页面上能看到「验收中」这个状态',
          '引擎 PR 普通关联本单，不要求 Closes',
        ),
      },
    });
    if (!result.ok) throw new Error('测试合同不全');
    return result.brief;
  };
  it('CI期间收窄：下一续会话收到同版brief/tier、完整修订和仍有效正式CR，累计轮数保留', async () => {
    let current = goodBrief();
    const next = revised();
    let reviewsOpen = true;
    const review = {
      reviewId: 9,
      reviewer: 'reviewer',
      commitId: 'a'.repeat(40),
      submittedAt: null,
      body: '仍有效的正式CR原文',
      comments: [],
    };
    const world = createFakeWorld({
      ci: (_input, n) => {
        if (n === 1) {
          current = next;
          return { state: 'red', failedChecks: ['test'], digest: '必须返工' };
        }
        return undefined;
      },
    });
    const { tasks, calls } = scripted({
      contractBrief: () => ({ ok: true, brief: current }),
      resume: RESUME_ALWAYS,
      verify: () => ({ pass: true, problems: [], round: 1, reviewChanges: reviewsOpen ? [review] : [] }),
    });
    tasks.readCiReviews = async (i) => ({ delivered: true, head: i.expectedHead, reviews: [review] });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await pollQuery(
          () => statusOf(h),
          (s) => parked(s) && s.lastProblem === '正式评审还要求改',
          '新合同cold pass仍必须等正式CR复审',
        );
        expect(calls.arm).toBe(0);
        reviewsOpen = false;
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const second = calls.segment[1];
    expect(second?.resumeSessionId).toBe('sess-1');
    expect(second?.brief.contract).toEqual(next.contract);
    expect(second?.tier).toEqual(next.tier);
    expect(second?.tier.tier).toBe('fast');
    expect(second?.contractRevision?.reviews.join('\n')).toContain(review.body);
    expect(second?.feedback.join('\n')).toContain('正式需求已修订');
    expect(calls.spendInputs.every((i) => i.since === calls.spendInputs[0]?.since)).toBe(true);
    expect(calls.armInputs[0]?.contractGuard?.expected).toEqual(next.contract);
  });
  it('旧交代没有合同：第一次安全边界读到合同按首次接纳处理，不被当成没变（#3402）', async () => {
    const live = goodBrief();
    const { contract, ...legacy } = live;
    expect(contract).toBeDefined();
    const { tasks, calls } = scripted({
      brief: () => ({ ok: true, brief: legacy }),
      contractBrief: () => ({ ok: true, brief: live }),
    });
    const run = await withWorker(
      env,
      createFakeWorld(),
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged' });
    const first = calls.segment[0];
    // 默认参数会把显式传入的「之前没有合同」换成刚读回的合同，于是 changed 恒为假：这三样一个都不会有
    expect(first?.brief.contract).toEqual(live.contract);
    expect(first?.contractRevision).toEqual({ reviews: [] });
    expect(first?.feedback.join('\n')).toContain('正式需求已修订');
  });
  it('同head验收中改正文：旧/晚到pass作废，轮数不清零，新合同从全量重验', async () => {
    let current = goodBrief();
    const next = revised();
    const { tasks, calls } = scripted({
      contractBrief: () => ({ ok: true, brief: current }),
      verify: (_input, n) => {
        if (n === 1) current = next;
        return { pass: true, problems: [], round: n === 1 ? 1 : 2 };
      },
    });
    const run = await withWorker(
      env,
      createFakeWorld(),
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 2 });
    expect(calls.segment).toHaveLength(1);
    expect(calls.verify).toHaveLength(2);
    expect(calls.verify[1]?.headSha).toBe(calls.verify[0]?.headSha);
    expect(calls.verify[1]?.contract).toEqual(next.contract);
    expect(calls.verify[1]?.recheck).toBeUndefined();
    expect(calls.arm).toBe(1);
    expect(calls.armInputs[0]?.contractGuard?.expected).toEqual(next.contract);
  });
  it('反复修订仍耗尽原验收轮数，只用既有一次自动继续，之后受管停下', async () => {
    let current = goodBrief();
    const { tasks, calls } = scripted({
      brief: () => ({ ok: true, brief: current }),
      contractBrief: () => ({ ok: true, brief: current }),
      verify: (_input, n) => {
        const next = buildTaskBrief({
          issue: { number: 12, title: '连续修订', state: 'open', body: `${BODY}\n2. 修订 ${n}` },
        });
        if (!next.ok) throw new Error('测试合同不全');
        current = next.brief;
        return { pass: true, problems: [], round: n % 2 === 1 ? 1 : 2 };
      },
    });
    await withWorker(
      env,
      createFakeWorld(),
      async (q) => {
        const h = await start(q, input());
        const status = await pollQuery(
          () => statusOf(h),
          (s) => parked(s) && s.lastProblem === '验收 2 轮都没过',
          '连续修订后仍按既有上限停下',
        );
        expect(status.verifyRound).toBe(2);
        expect(calls.verify).toHaveLength(4);
        expect(calls.segment).toHaveLength(1);
        expect(calls.arm).toBe(0);
        expect(calls.spendInputs.every((i) => i.since === calls.spendInputs[0]?.since)).toBe(true);
      },
      { tasks },
    );
  });
});

describe('返工续会话（决定 0093）', { timeout: 60_000 }, () => {
  it('CI 红了：下一轮续上一轮跑成的会话，判续会话指名上一段的执行编号，提示词只补返工意见', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL task.test.ts' } : undefined,
    });
    const { tasks, calls } = scripted({ resume: RESUME_ALWAYS });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[0]?.resumeSessionId).toBeUndefined();
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    expect(calls.segment[1]?.worktreePath).toBe(calls.segment[0]?.worktreePath);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('FAIL task.test.ts');
    expect(calls.resume).toHaveLength(1);
    expect(calls.resume[0]?.previous).toEqual({ runId: 'run-1' });
    expect(world.states.some((s) => s.doing.includes('续上一段的会话'))).toBe(true);
  });

  it('CI 红了：返工意见里有红的 job 名、摘要和日志尾巴，不只一句「check 红」（#2795）', async () => {
    const detail =
      '红的 job：lint、check\n\n【lint】failure\n「biome（退出码 1，12 秒）」的输出结尾：\nFound 6 errors.';
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1
          ? {
              state: 'red',
              failedChecks: ['check', 'lint'],
              digest: 'check：failure：红的 job：lint',
              detail,
            }
          : undefined,
    });
    const { tasks, calls } = scripted({ resume: RESUME_ALWAYS });
    await withWorker(env, world, async (q) => (await start(q, input())).result() as Promise<TaskRun>, {
      tasks,
    });
    const feedback = calls.segment[1]?.feedback ?? [];
    expect(feedback).toEqual(['CI 红了：check、lint', 'check：failure：红的 job：lint', detail]);
  });

  it('续不上（换了执行方式）：照旧开新会话带全份交代，进度写明为什么', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
    });
    const { tasks, calls } = scripted({
      resume: () => ({ kind: 'new', reason: '换了执行方式（claude-code → cursor-agent）' }),
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
    expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
    expect(world.states.some((s) => s.doing.includes('没续上会话（换了执行方式'))).toBe(true);
  });

  it('连着续了两轮还没过：下一轮开新会话，返工意见第一行写明为什么清空重来', async () => {
    // 第 1、2 轮 CI 红；第 3 轮 CI 绿、验收没过（验收返工另给一轮，#1967）；第 4 轮前已经连着续了两轮
    const world = createFakeWorld({
      ci: (_i, n) =>
        n <= 2 ? { state: 'red', failedChecks: ['test (engine)'], digest: `FAIL 第 ${n} 次` } : undefined,
    });
    const { tasks, calls } = scripted({
      resume: RESUME_ALWAYS,
      // 按头判：CI 红的两轮里和 CI 同时起的验收会被丢掉，不能按第几次调用排答案
      verify: (i) =>
        i.headSha === fakeHead(103)
          ? { pass: false, problems: ['没做到验收条：页面上看不到「验收中」'], round: 1 }
          : { pass: true, problems: [], round: 2 },
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
    expect(calls.segment.map((s) => s.resumeSessionId)).toEqual([undefined, 'sess-1', 'sess-1', undefined]);
    // 只判了两次：第 4 轮没问续不续
    expect(calls.resume).toHaveLength(2);
    const fresh = calls.segment[3]?.feedback ?? [];
    expect(fresh[0]).toContain('开新会话');
    expect(fresh.join('\n')).toContain('没做到验收条');
  });
});

describe('冲突引擎先自己并（决定 0093）', { timeout: 60_000 }, () => {
  it('等合并冲突、交回动手；动手前并最新主线并干净了：不派模型，直接对新头重跑 CI 和验收，不算一轮', async () => {
    const world = createFakeWorld({
      // 第 1 次（等合并时）并出冲突；第 2 次（动手前）主线动过、git 自动合并干净
      sync: (_i, n) =>
        n === 1
          ? { state: 'conflict', conflictFiles: ['a.ts'] }
          : n === 2
            ? { head: fakeHead(800) }
            : undefined,
    });
    const { tasks, calls } = scripted({
      merged: (n) => (n === 1 ? { state: 'conflict', detail: 'PR #1 和主线冲突' } : { state: 'merged' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, head: fakeHead(800) });
    expect(calls.segment).toHaveLength(1);
    expect(calls.verify.map((v) => v.headSha)).toEqual([fakeHead(101), fakeHead(800)]);
    expect(world.states.some((s) => s.doing.includes('引擎自己并掉了'))).toBe(true);
    expect(world.alerts).toEqual([]);
  });

  it('不强制 CI 的仓直接合并撞上冲突：引擎先并主线，并干净就再合，不派模型', async () => {
    const world = createFakeWorld({ sync: (_i, n) => (n === 1 ? { head: fakeHead(810) } : undefined) });
    const { tasks, calls } = scripted({
      ciPolicy: () => ({ mode: 'off' }),
      mergeNow: (n) =>
        n === 1
          ? { merged: false, reason: 'conflict', detail: 'PR #100 和主线冲突' }
          : { merged: true, mergeCommit: 'abc1234567890' },
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
    expect(calls.segment).toHaveLength(1);
    expect(calls.merge).toBe(2);
  });

  it('并不干净：照旧交给会话解（冲突文件名进返工意见）', async () => {
    const world = createFakeWorld({
      sync: (_i, n) => (n <= 2 ? { state: 'conflict', conflictFiles: ['a.ts'] } : undefined),
    });
    const { tasks, calls } = scripted({
      merged: (n) => (n === 1 ? { state: 'conflict', detail: 'PR #1 和主线冲突' } : { state: 'merged' }),
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
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('和最新主线有冲突，要解决：a.ts');
  });
});

const RED: SelfCheckResult = {
  state: 'red',
  steps: [
    { command: 'pnpm test:changed', outcome: 'fail', exitCode: 1, digest: 'FAIL test/a.test.ts > 少了一行' },
    { command: 'node_modules/.bin/tsc -b --pretty false', outcome: 'pass', exitCode: 0, digest: '' },
  ],
};
const GREEN: SelfCheckResult = {
  state: 'green',
  steps: [{ command: 'pnpm test:changed', outcome: 'pass', exitCode: 0, digest: 'Tests  3 passed (3)' }],
};

describe('会话收场后引擎自测（决定 0093）', { timeout: 60_000 }, () => {
  it('已有PR同成果返工才携带固定头和PR身份；首次无PR维持原输入', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['test'], digest: '返工' } : undefined),
    });
    const { tasks, calls } = scripted({
      delivery: () => ({ head: fakeHead(101), commits: 1, changedFiles: ['packages/core/src/a.ts'] }),
      selfCheck: () => GREEN,
    });
    const result = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(result).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.selfCheck).toHaveLength(2);
    expect(calls.selfCheck[0]).not.toHaveProperty('expectedHead');
    expect(calls.selfCheck[0]).not.toHaveProperty('prNumber');
    expect(calls.selfCheck[1]).toMatchObject({ expectedHead: fakeHead(101), prNumber: 100 });
  });

  it('红了：精炼输出续进同一个会话再改一次，再测一次就推；最后一次的输出交给冷验收', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      resume: RESUME_ALWAYS,
      selfCheck: (_i, n) => (n === 1 ? RED : GREEN),
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
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    const fb = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(fb).toContain(SELF_CHECK_RED_LINE);
    expect(fb).toContain('FAIL test/a.test.ts > 少了一行');
    expect(calls.selfCheck).toHaveLength(2);
    expect(calls.selfCheck[0]).toMatchObject({ worktreePath: calls.segment[0]?.worktreePath });
    expect(world.count('pushBranch')).toBe(1); // 改完才推，只推一次
    expect(calls.verify[0]?.testOutput).toContain('Tests  3 passed');
    // 推之前测，不是推之后
    expect(calls.order.slice(0, 4)).toEqual(['brief', 'segment', 'delivery', 'segment']);
  });

  it('改了还红：不再续，照旧推交给 CI；验收拿到的是红的那份输出', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ resume: RESUME_ALWAYS, selfCheck: () => RED });
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
    expect(calls.selfCheck).toHaveLength(2);
    expect(calls.verify[0]?.testOutput).toContain('没过（退出码 1）');
  });

  it('活动限时到了：记 skipped，只调一次，照旧推', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      selfCheck: () => {
        throw new Error('activity StartToClose timeout');
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.selfCheck).toHaveLength(1);
    expect(calls.verify[0]?.testOutput).toBeUndefined();
    expect(world.count('pushBranch')).toBe(1);
  });

  it('【故意造出的失败】自测活动没装（抛错）：不挡原流程，照旧推，验收不带测试输出', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    delete (tasks as { selfCheck?: unknown }).selfCheck;
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(1);
    expect(calls.verify[0]?.testOutput).toBeUndefined();
    expect(world.alerts).toEqual([]);
  });

  it('绿了：不续会话，输出交给验收；头换了（等合并时并了主线）的验收不带旧输出', async () => {
    const world = createFakeWorld({
      sync: (_i, n) => (n === 1 ? { state: 'clean', head: fakeHead(555) } : undefined),
    });
    const { tasks, calls } = scripted({
      selfCheck: () => GREEN,
      merged: (n) => (n === 1 ? { state: 'conflict', detail: 'PR #1 和主线冲突' } : { state: 'merged' }),
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
    expect(calls.segment).toHaveLength(1);
    expect(calls.verify.map((v) => v.headSha)).toEqual([fakeHead(101), fakeHead(555)]);
    expect(calls.verify[0]?.testOutput).toContain('过了');
    expect(calls.verify[1]?.testOutput).toBeUndefined();
  });
});

describe('交活时没提交：同一轮续一次会话补提交（#2722）', { timeout: 60_000 }, () => {
  it('没提交、树里有剩：续同一个会话一次让它提交，提交了就推；轮数不加', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      resume: RESUME_ALWAYS,
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: n === 1 ? 0 : 1,
        changedFiles: n === 1 ? [] : ['a.ts'],
        leftover: n === 1 ? ['?? a.ts'] : [],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    expect(calls.segment[1]?.worktreePath).toBe(calls.segment[0]?.worktreePath);
    const fb = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(fb).toContain(COMMIT_NUDGE_LINE);
    expect(fb).toContain('?? a.ts');
    expect(calls.order.slice(0, 4)).toEqual(['brief', 'segment', 'delivery', 'segment']);
    expect(world.count('pushBranch')).toBe(1);
    expect(world.states.some((s) => s.doing.includes('续进会话补提交'))).toBe(true);
  });

  it('续了还没提交：不再续第二次，照旧返工进下一轮', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      resume: RESUME_ALWAYS,
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: n <= 2 ? 0 : 1,
        changedFiles: n <= 2 ? [] : ['a.ts'],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    // 第 1 轮：动手 + 续一次补提交；第 2 轮：返工（续会话）一次就提交了
    expect(calls.segment).toHaveLength(3);
    expect(calls.segment[1]?.feedback.join('\n')).toContain(COMMIT_NUDGE_LINE);
    expect(calls.segment[2]?.feedback.join('\n')).toContain('没有产生新的提交');
    expect(world.count('pushBranch')).toBe(1);
  });

  it('续不上会话（换了执行方式）：不在这一轮另开会话，照旧返工', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      resume: () => ({ kind: 'new', reason: '换了执行方式' }),
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: n === 1 ? 0 : 1,
        changedFiles: n === 1 ? [] : ['a.ts'],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[1]?.feedback.join('\n')).not.toContain(COMMIT_NUDGE_LINE);
  });
});

describe('单任务 token 预算（决定 0093）', { timeout: 60_000 }, () => {
  it('花掉的超了预算：起会话之前停下等人，写明花了多少、预算多少；点「继续」再给一份接着干', async () => {
    const world = createFakeWorld();
    const over = DEFAULT_TASK_TOKEN_BUDGET + 1_000_000;
    const { tasks, calls } = scripted({
      spend: () => ({ tokens: over, runs: 9, unmetered: 1, estimated: 0 }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(() => statusOf(h), parked, '超了预算停下');
        expect(s.lastProblem).toContain('超了预算');
        expect(calls.segment).toHaveLength(0); // 没起会话
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(1);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]?.detail).toContain(String(over));
    expect(world.alerts[0]?.detail).toContain('p95');
    expect(world.alerts[0]?.detail).toContain('1 次会话用量还没补上');
  });

  it('指挥官判不是空转、继续并放宽预算（#3294 第 2 片）：下一次超预算不再停；不放宽的继续，同样的花费会再停一次', async () => {
    const B = DEFAULT_TASK_TOKEN_BUDGET;
    // 第一次查花费超一份；第二次（返工回来）超两份多一点：只给一份的继续挡得住，放宽一档的放得过
    const scripts = () =>
      scripted({
        spend: (n) => ({
          tokens: n === 1 ? B + 1_000_000 : 2 * B + 1_000_000,
          runs: 9,
          unmetered: 0,
          estimated: 0,
        }),
        verify: (_i, n) =>
          n === 1
            ? { pass: false, problems: ['没做到验收条：缺测试'], round: 1 }
            : { pass: true, problems: [], round: 2 },
      });

    const widened = scripts();
    const run = await withWorker(
      env,
      createFakeWorld(),
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(() => statusOf(h), parked, '超了预算停下');
        expect(s.park).toMatchObject({ kind: 'quota', seq: 1 });
        // 带错编号的指挥官继续不算：还停着
        await h.signal(taskContinueSignal, { by: COMMANDER_ACTOR, parkSeq: 99, widenBudget: true });
        await env.sleep('1 minute');
        expect(parked(await statusOf(h))).toBe(true);
        await h.signal(taskContinueSignal, { by: COMMANDER_ACTOR, parkSeq: 1, widenBudget: true });
        return h.result() as Promise<TaskRun>;
      },
      { tasks: widened.tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(widened.calls.spend).toBeGreaterThanOrEqual(2);

    const plain = scripts();
    await withWorker(
      env,
      createFakeWorld(),
      async (q) => {
        const h = await start(q, input());
        await pollQuery(() => statusOf(h), parked, '超了预算停下');
        await h.signal(taskContinueSignal, { by: COMMANDER_ACTOR, parkSeq: 1 });
        const again = await pollQuery(
          () => statusOf(h),
          (s) => parked(s) && s.park?.seq === 2,
          '没放宽：返工回来又超了预算，再停下',
        );
        expect(again.park?.kind).toBe('quota');
        await h.terminate('测试收场');
      },
      { tasks: plain.tasks },
    );
  });

  it('原始合计超了、输入当量没超（缓存读占大头，#2859）：不停，照旧起会话', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      spend: () => ({
        tokens: 37_800_000,
        runs: 9,
        unmetered: 0,
        estimated: 0,
        inputTokens: 600_000,
        outputTokens: 100_000,
        cacheReadTokens: 36_800_000,
        cacheWriteTokens: 300_000,
        inputEquivalent: 6_500_000,
        inputEquivalentEstimated: 0,
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
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(1);
    expect(world.alerts).toHaveLength(0);
  });

  it('#2830 记下的老结果（只有 weighted）：照读 weighted，不退回原始合计，在途单重放判法不变', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      spend: () => ({
        tokens: 37_800_000,
        runs: 9,
        unmetered: 0,
        estimated: 0,
        weighted: 4_680_000,
        weightedEstimated: 0,
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(1);
    expect(world.alerts).toHaveLength(0);
  });

  it('输入当量超了（#2859）：停下，原因里写输入当量用了多少、上限多少，四样原始数另列', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({
      spend: () => ({
        tokens: 40_000_000,
        runs: 9,
        unmetered: 0,
        estimated: 0,
        inputTokens: 38_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        inputEquivalent: 7_500_000,
        inputEquivalentEstimated: 0,
      }),
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(() => statusOf(h), parked, '输入当量超了预算停下');
        expect(s.lastProblem).toContain('超了预算');
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    const detail = world.alerts[0]?.detail ?? '';
    expect(detail).toContain('新输入 38000000');
    expect(detail).toContain('缓存读 1000000');
    expect(detail).toContain('输入当量 7500000');
    expect(detail).toContain('上限 7000000');
    expect(detail).not.toContain('折算');
    expect(world.alerts[0]?.title).toContain('输入当量 7.5M / 7.0M');
  });

  it('量到的不多、被叫停那几行估出来的把预算顶超了：照样停下，写明哪部分是估的', async () => {
    const world = createFakeWorld();
    const measured = 1_000_000;
    // 三次被叫停的会话记不到用量：按这张单量到的行的速率估出来的下限把它顶过预算
    const estimated = DEFAULT_TASK_TOKEN_BUDGET;
    const { tasks, calls } = scripted({
      spend: () => ({ tokens: measured, runs: 9, unmetered: 3, estimated }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(() => statusOf(h), parked, '估出来超了预算停下');
        expect(s.lastProblem).toContain('超了预算');
        expect(calls.segment).toHaveLength(0);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks,
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(1);
    const alert = world.alerts[0]?.detail ?? '';
    expect(alert).toContain(String(measured + estimated)); // 判断用的是合计
    expect(alert).toContain('3 次会话用量还没补上');
    expect(alert).toContain('估出来的下限'); // 说清哪部分是估的，不当成量到的
    expect(alert).toContain(`另 ${estimated} 是`);
  });

  it('重做的第 2 代：上一代已花 83.5M，开工时累计是 0，正常起会话，不停下', async () => {
    const world = createFakeWorld();
    const seen: number[] = [];
    const { tasks, calls } = scripted({
      spend: (_n, input) => {
        const spent = spendSince(input, 0);
        seen.push(spent.tokens);
        return spent;
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input(), 2)).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(seen[0]).toBe(0);
    expect(calls.spendInputs[0]?.since).toBeTruthy();
    expect(Date.parse(calls.spendInputs[0]?.since ?? '')).toBeGreaterThan(PREVIOUS_GENERATION_AT);
    expect(calls.segment).toHaveLength(1);
    expect(world.alerts).toEqual([]);
  });

  it('第 2 代自己花超过 7M：仍然停下等人；点「继续」按这一代已花的再给一份，不是按上一代', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL task.test.ts' } : undefined,
    });
    // 第一次查是这一代的 8M（上一代 83.5M 在开工之前）。点继续之后份数按 8M 给到 2 份（14M）。
    // 下一轮动手前抬到 15M：超 2 份就再停下。若份数按上一代一起算，2 份不够、会给到 13 份，15M 就停不下。
    let own = DEFAULT_TASK_TOKEN_BUDGET + 1_000_000;
    const { tasks, calls } = scripted({
      spend: (_n, input) => {
        const spent = spendSince(input, own);
        own = 15_000_000;
        return spent;
      },
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input(), 2);
        const first = await pollQuery(() => statusOf(h), parked, '这一代超了预算停下');
        expect(first.lastProblem).toContain('8.0M / 7.0M');
        expect(first.lastProblem).not.toContain('83.5M');
        expect(calls.segment).toHaveLength(0);
        expect(calls.spendInputs[0]?.since).toBeTruthy();
        expect(world.alerts[0]?.detail).toContain(String(DEFAULT_TASK_TOKEN_BUDGET + 1_000_000));
        expect(world.alerts[0]?.detail).not.toContain(String(PREVIOUS_GENERATION_TOKENS));
        await h.signal(taskContinueSignal, { by: 'frank' });
        // lastProblem 在报警之前就写上。只看它会读到上一回的提醒；等再次停下来，报警已经记上。
        const second = await pollQuery(
          () => statusOf(h),
          (s) => parked(s) && s.lastProblem?.includes('15.0M / 14.0M') === true,
          '按这一代已给 2 份仍超了再停下',
        );
        expect(second.lastProblem).toContain('15.0M / 14.0M');
        expect(world.alerts.at(-1)?.detail).toContain('已给 2 份');
        expect(calls.segment).toHaveLength(1);
        return 'parked';
      },
      { tasks },
    );
  });

  it('没超：不停下；查花费没查成也照旧起会话', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      spend: () => {
        throw new PortError('DB_DOWN', '库一时不通', { retryable: false });
      },
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
    expect(calls.segment).toHaveLength(1);
    expect(world.alerts).toEqual([]);
  });
});

describe('耗尽后接纳正式合同修订（#3216）', { timeout: 60_000 }, () => {
  it('全程停下期间修改正文：继续同一会话仍交付新版brief和正式CR', async () => {
    let current = goodBrief();
    const next = buildTaskBrief({
      issue: {
        number: 12,
        title: '全程续行修订',
        state: 'open',
        body: BODY.replace('packages/web/src/pages/', 'packages/engine/src/jobs/watchdog.ts'),
      },
    });
    if (!next.ok) throw new Error('测试合同不全');
    const review = {
      reviewId: 3216,
      reviewer: 'reviewer',
      commitId: 'a'.repeat(40),
      submittedAt: null,
      body: 'FULL_LIMITS_REVISION_REVIEW',
      inlineComments: [],
    };
    const { tasks, calls } = scripted({
      brief: () => ({ ok: true, brief: current }),
      contractBrief: () => ({ ok: true, brief: current }),
      flow: () => ({ mode: 'full', source: 'hash', reason: null }),
      resume: RESUME_ALWAYS,
    });
    tasks.readCiReviews = async (i) => ({ delivered: true, head: i.expectedHead, reviews: [review] });
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 6 ? { state: 'red', failedChecks: ['test'], digest: 'old CI red' } : undefined),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await pollQuery(
          () => statusOf(h),
          (s) => parked(s) && s.lastProblem?.includes('推送 6 次') === true,
          '全程耗尽停下',
        );
        current = next.brief;
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    const after = calls.segment[6];
    expect(after?.resumeSessionId).toBe('sess-1');
    expect(after?.brief.contract).toEqual(next.brief.contract);
    expect(after?.tier).toEqual(next.brief.tier);
    expect(after?.contractRevision?.reviews.join('\n') ?? '').toContain(review.body);
  });
});
