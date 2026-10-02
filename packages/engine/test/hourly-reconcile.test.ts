// 每小时对账的一轮外壳（jobs/hourly-reconcile.ts）和工作流：几部分的结局怎么并、记开始和记结局没成、这一轮整个没跑成、
// 真 Temporal 测试服务端上跑一轮。工作树和提醒各自怎么判在 test/real/hourly-reconcile.test.ts（真库、真 git）。
// 每条失败路径都故意造一次：都不许记成 ok。
import { randomUUID } from 'node:crypto';
import type { ScheduleResult } from '@fleet-dao/db';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { type HourlyReconcileRun, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  combineParts,
  HOURLY_RECONCILE_JOB,
  type HourlyReconcileJobDeps,
  runHourlyReconcileJob,
  WHY_MAX,
} from '../src/jobs/hourly-reconcile.ts';
import type { SweepPart } from '../src/jobs/reconcile-common.ts';
import { describeLeftovers } from '../src/jobs/worktree-sweep.ts';
import { useEnv, withWorker } from './helpers.ts';

const NOW = new Date('2026-09-26T09:41:00.000Z');
const ROOT = '/var/lib/fleet-work';

interface Harness {
  deps: HourlyReconcileJobDeps;
  finished: { id: number; result: ScheduleResult }[];
  listed: string[];
  logs: string[];
}

/** 一台什么残留都没有的机器：根下只有路由探针的目录（一个会话用户），没有没处理的提醒。 */
function harness(over: Partial<HourlyReconcileJobDeps> = {}): Harness {
  const finished: Harness['finished'] = [];
  const listed: string[] = [];
  const logs: string[] = [];
  const deps: HourlyReconcileJobDeps = {
    root: ROOT,
    probeDir: '_route-probe',
    sessionTmpDir: '_tmp',
    machine: '法国',
    async listDir(dir) {
      listed.push(dir);
      if (dir === ROOT) return [{ name: '_route-probe', isDir: true }];
      if (dir === `${ROOT}/_route-probe`) return [{ name: 'fleet-agent-carpool', isDir: true }];
      throw new Error(`用例没给 ${dir}`);
    },
    treeFor: (repo, branch) => `${ROOT}/${repo.owner}_${repo.name}/${branch.replace(/^fleet\//, '')}`,
    ownerOf: async () => null,
    leftovers: async () => ({ kind: 'empty' }),
    remove: async () => ({ gone: true }),
    issue: async () => null,
    prHeads: async () => [],
    subtaskTrees: async () => [],
    openSessions: async () => [],
    workflows: {
      state: async () => ({ state: 'missing' }),
      view: async () => {
        throw new Error('不该问');
      },
    },
    taskState: async () => null,
    approval: async () => null,
    stageRoutable: async () => ({ kind: 'none', detail: '没有在线的路由' }),
    alerts: {
      listOpen: async () => ({ alerts: [], truncated: false }),
      byKey: async () => null,
      latestByPrefix: async () => null,
      resolve: async () => 'not_found',
      raise: async () => {},
      insertOnce: async () => ({ created: true }),
      updateOpen: async () => 'not_open',
    },
    activeTasks: async () => [],
    repos: async () => [],
    auditMergedPrs: async () => ({
      outcome: 'ok',
      scanned: 0,
      found: 0,
      fixed: 0,
      problems: [],
      findings: [],
    }),
    latestDelivery: async () => null,
    repull: async () => {
      throw new Error('不该补拉');
    },
    ledgers: async () => [],
    apps: { repos: async () => [], selfCheck: async () => [] },
    gh: {
      listPrs: async () => [],
      pullFiles: async () => [],
      checksEvaluate: async () => 'none',
      requiredChecks: async () => ['check'],
      readStandardPathsFile: async () => '{"paths":[]}',
      enableAutoMerge: async () => {},
    },
    autoMergeAlerts: {
      raise: async () => {},
      resolve: async () => 'not_found',
      listOpenByPrefix: async () => [],
    },
    runs: {
      async start() {
        return 7;
      },
      async finish(id, result) {
        finished.push({ id, result });
      },
    },
    now: () => NOW,
    log: (level, text) => logs.push(`${level}:${text}`),
    ...over,
  };
  return { deps, finished, listed, logs };
}

describe('几部分的结局并成这一轮的（combineParts）', () => {
  const part = (over: Partial<SweepPart> = {}): SweepPart => ({
    scanned: 0,
    found: 0,
    unchecked: [],
    ...over,
  });

  it('都跑完、都查成：ok，看了几个、处理了几个照加', () => {
    expect(combineParts([part({ scanned: 3, found: 1 }), part({ scanned: 2, found: 2 })])).toEqual({
      outcome: 'ok',
      scanned: 5,
      found: 3,
    });
  });

  it('有没查成的：partial，一条一句、几处写在前面', () => {
    expect(combineParts([part({ scanned: 3, unchecked: ['a 列不了'] }), part({ scanned: 1 })])).toEqual({
      outcome: 'partial',
      why: 'a 列不了',
      scanned: 4,
      found: 0,
    });
    expect(
      combineParts([
        part({ scanned: 1, unchecked: ['a 列不了', 'b 删不掉'] }),
        part({ unchecked: ['c 没查成'] }),
      ]),
    ).toMatchObject({ outcome: 'partial', why: '3 处没查成：a 列不了；b 删不掉；c 没查成' });
  });

  it('一部分没跑成、另一部分看到了东西：partial（看到的照算），写明哪部分没跑成', () => {
    expect(combineParts([part({ failed: '工作树的根读不了' }), part({ scanned: 4, found: 1 })])).toEqual({
      outcome: 'partial',
      why: '工作树的根读不了',
      scanned: 4,
      found: 1,
    });
  });

  it('都没跑成，或者没跑成的之外一个都没看到：failed，不记成「没扫到」', () => {
    expect(combineParts([part({ failed: '根读不了' }), part({ failed: '列不了提醒' })])).toMatchObject({
      outcome: 'failed',
      why: '2 处没查成：根读不了；列不了提醒',
    });
    expect(combineParts([part({ failed: '根读不了' }), part()])).toMatchObject({ outcome: 'failed' });
  });

  it('什么都没看到、也没出错：unscanned（没扫到 ≠ 没问题），不记 ok', () => {
    expect(combineParts([part(), part()])).toEqual({
      outcome: 'unscanned',
      why: '工作树的根下什么都没有，接活开着的项目里没有没结束的单，没有要审的合并 PR，没有没处理的提醒，也没有受管的仓',
    });
  });

  it('没查成的太多：原因截断到能看的长度', () => {
    const many = Array.from({ length: 200 }, (_, i) => `acme_widgets/${i}-x 删不掉：退出码 1`);
    const r = combineParts([part({ scanned: 200, unchecked: many })]);
    expect(r.outcome).toBe('partial');
    expect('why' in r && r.why.length).toBeLessThanOrEqual(WHY_MAX);
    expect('why' in r && r.why.startsWith('200 处没查成：')).toBe(true);
  });
});

describe('树里还剩什么，写进要人拍的说法（describeLeftovers）', () => {
  const repo = {
    kind: 'repo' as const,
    dirty: [],
    dirtyCount: 0,
    stashes: 0,
    unpushed: [],
    unpushedCount: 0,
  };

  it('什么都不剩（只剩能重新生成的缓存也算）：一句都没有，照空树删', () => {
    expect(describeLeftovers({ kind: 'empty' })).toEqual([]);
    expect(describeLeftovers(repo)).toEqual([]);
  });

  it('列全了直接列；没列全写明一共几个、列的是前几个', () => {
    expect(describeLeftovers({ kind: 'not-repo', files: ['src/a.ts'], fileCount: 1 })).toEqual([
      '这一层不是 git 仓，里面有 1 个文件（能重新生成的编译和工具缓存不算）：src/a.ts',
    ]);
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    expect(describeLeftovers({ kind: 'not-repo', files: ten, fileCount: 13 })).toEqual([
      `这一层不是 git 仓，里面有 13 个文件（能重新生成的编译和工具缓存不算），前 10 个：${ten.join('；')}；…`,
    ]);
    expect(
      describeLeftovers({
        ...repo,
        dirty: [' M a.ts', '?? b.ts'],
        dirtyCount: 12,
        unpushed: ['abc1234 work'],
        unpushedCount: 1,
        stashes: 2,
      }),
    ).toEqual([
      '没推的提交 1 个：abc1234 work',
      '没提交的改动 12 处，前 2 处： M a.ts；?? b.ts；…',
      '存着 2 个 stash（git stash list）',
    ]);
  });
});

describe('一轮（runHourlyReconcileJob，不起 Temporal）', () => {
  it('没有残留、没有提醒：探针目录算看过，记 ok（不记成一个都没扫到）', async () => {
    const h = harness();
    const run = await runHourlyReconcileJob(h.deps);
    expect(run).toEqual({ runId: 7, outcome: 'ok', scanned: 1, found: 0 });
    expect(h.finished).toEqual([{ id: 7, result: { outcome: 'ok', scanned: 1, found: 0 } }]);
    expect(h.logs).toContain('info:每小时对账跑完了');
  });

  it('根下什么都没有：记 unscanned、写明为什么', async () => {
    const h = harness({ listDir: async () => [] });
    expect(await runHourlyReconcileJob(h.deps)).toMatchObject({ outcome: 'unscanned', scanned: 0, found: 0 });
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'unscanned',
      why: expect.stringContaining('什么都没有'),
    });
  });

  it('读不了根、也列不了提醒：记 failed、抛 HourlyReconcileFailedError（带这一轮的编号）', async () => {
    const h = harness({
      listDir: async () => {
        throw new Error('EACCES: 故意造的');
      },
      alerts: {
        ...harness().deps.alerts,
        listOpen: async () => {
          throw new Error('库连不上');
        },
      },
    });
    await expect(runHourlyReconcileJob(h.deps)).rejects.toMatchObject({
      name: 'HourlyReconcileFailedError',
      runId: 7,
      message: expect.stringContaining('EACCES'),
    });
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'failed',
      why: expect.stringContaining('库连不上'),
    });
    expect(h.logs).toContain('error:每小时对账这一轮没跑成');
  });

  it('列提醒没成、树照看：记 partial（看到的树照算），写明提醒那部分没跑成', async () => {
    const h = harness({
      alerts: {
        ...harness().deps.alerts,
        listOpen: async () => {
          throw new Error('库连不上');
        },
      },
    });
    const run = await runHourlyReconcileJob(h.deps);
    expect(run).toMatchObject({
      outcome: 'partial',
      scanned: 1,
      why:
        '3 处没查成：列没处理的提醒没成：库连不上；列没处理的提醒没成，工作流核对的旧提醒这一轮不撤：库连不上；' +
        '列没处理的提醒没成，记账核对的旧提醒这一轮不复查、不撤：库连不上',
    });
    expect(h.logs.some((l) => l.startsWith('warn:每小时对账：列没处理的提醒没成'))).toBe(true);
  });

  it('【故意造出的失败】列没结束的单没成：这一轮不记 ok，写明是列单没成', async () => {
    const h = harness({
      activeTasks: async () => {
        throw new Error('库连不上');
      },
    });
    const run = await runHourlyReconcileJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('列没结束的单没成：库连不上');
  });

  it('【故意造出的失败】列合并的 PR 失败（GitHub 读不到）：这个仓写进原因，这一轮不记 ok', async () => {
    const h = harness({
      repos: async () => [{ owner: 'acme', name: 'widgets' }],
      auditMergedPrs: async () => ({
        outcome: 'unscanned',
        scanned: 0,
        found: 0,
        fixed: 0,
        problems: [],
        findings: [],
        why: '列合并的 PR 失败：403',
      }),
    });
    const run = await runHourlyReconcileJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('acme/widgets：列合并的 PR 失败：403');
  });

  it('【故意造出的失败】读合了的 PR 的记账没成：这一轮不记 ok，写明是记账那部分', async () => {
    const h = harness({
      ledgers: async () => {
        throw new Error('关系 session_runs 不存在');
      },
    });
    const run = await runHourlyReconcileJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('读合了的 PR 和会话记账没成：关系 session_runs 不存在');
  });

  it('GitHub 机器人权限自检是这一轮的最后一项：缺权限的报提醒、算发现一个；自检没跑成记 partial，不记 ok', async () => {
    const raised: string[] = [];
    const widgets = { owner: 'acme', name: 'widgets' };
    const h = harness({
      alerts: {
        ...harness().deps.alerts,
        raise: async (input) => {
          raised.push(input.dedupeKey);
        },
      },
      apps: {
        repos: async () => [widgets],
        selfCheck: async () => [
          { role: 'agent', repo: 'acme/widgets', ok: true, missing: [], extra: [] },
          { role: 'engine', repo: 'acme/widgets', ok: false, missing: ['statuses:write'], extra: [] },
        ],
      },
    });
    // 探针目录 1 个 + 两个机器人 2 个
    expect(await runHourlyReconcileJob(h.deps)).toEqual({ runId: 7, outcome: 'ok', scanned: 3, found: 1 });
    expect(raised).toEqual(['github-app:engine:acme/widgets']);

    const broken = harness({
      apps: {
        repos: async () => [widgets],
        selfCheck: async () => {
          throw new Error('引擎的 App 私钥读不到');
        },
      },
    });
    expect(await runHourlyReconcileJob(broken.deps)).toMatchObject({
      outcome: 'partial',
      why: 'GitHub 机器人权限自检没跑成：引擎的 App 私钥读不到',
    });
  });

  it('一轮当中出了没料到的错（列出来的不是列表）：记 failed 写明原因再抛，不记成 ok', async () => {
    const h = harness({ listDir: async () => null as never });
    await expect(runHourlyReconcileJob(h.deps)).rejects.toThrow('每小时对账没跑成');
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'failed',
      why: expect.stringContaining('每小时对账没跑成'),
    });
  });

  it('记不上开始：原样抛出，不去看树、不碰提醒（登记表上它会过期，看门狗看得见）', async () => {
    const h = harness({
      runs: {
        async start() {
          throw new Error('scheduled_jobs 里没登记 hourly-reconcile');
        },
        async finish() {},
      },
    });
    await expect(runHourlyReconcileJob(h.deps)).rejects.toThrow('没登记');
    expect(h.listed).toEqual([]);
  });

  it('记结局失败：原样抛出，不当成跑完了', async () => {
    const h = harness({
      runs: {
        async start() {
          return 1;
        },
        async finish() {
          throw new Error('库连不上');
        },
      },
    });
    await expect(runHourlyReconcileJob(h.deps)).rejects.toThrow('库连不上');
  });
});

// 起工人、跑一轮在整包一起跑时可能超过默认的 5 秒（和路由探针的用例同一个上限）。
describe('每小时对账的工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  const env = useEnv();

  async function runOnce(jobs: EngineJobs | undefined): Promise<HourlyReconcileRun> {
    return withWorker(
      env(),
      createFakeWorld(),
      (taskQueue) =>
        env().client.workflow.execute(WORKFLOW_TYPES.hourlyReconcile, {
          taskQueue,
          workflowId: `hourly-reconcile-${randomUUID()}`,
          args: [{ schemaVersion: 1 }],
        }),
      jobs ? { jobs } : {},
    );
  }

  async function failureOf(jobs: EngineJobs | undefined): Promise<ApplicationFailure> {
    const err = await runOnce(jobs).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkflowFailedError);
    let cause = (err as WorkflowFailedError).cause;
    while (cause && !(cause instanceof ApplicationFailure)) cause = (cause as { cause?: Error }).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    return cause as ApplicationFailure;
  }

  it('一轮跑完：工作流交回这一轮的结局（和记进 schedule_runs 的同一份）', async () => {
    const h = harness();
    const run = await runOnce({ hourlyReconcile: () => h.deps });
    expect(run).toEqual({ runId: 7, outcome: 'ok', scanned: 1, found: 0 });
    expect(h.finished).toHaveLength(1);
  });

  it('这一轮没跑成：活动报 HOURLY_RECONCILE_FAILED（不重试，下一轮一小时后照来）', async () => {
    const h = harness({
      listDir: async () => {
        throw new Error('EACCES: 故意造的');
      },
      alerts: {
        ...harness().deps.alerts,
        listOpen: async () => {
          throw new Error('库连不上');
        },
      },
    });
    const failure = await failureOf({ hourlyReconcile: () => h.deps });
    expect(failure.type).toBe('HOURLY_RECONCILE_FAILED');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain('EACCES');
  });

  it('假端口的工人（没装每小时对账）接到这一轮：明确报 JOB_NOT_CONFIGURED，不回一个空的 ok', async () => {
    const failure = await failureOf(undefined);
    expect(failure.type).toBe('JOB_NOT_CONFIGURED');
    expect(failure.nonRetryable).toBe(true);
  });

  it('登记的名字、频率：每小时对账、连着两轮没跑成才算过期', () => {
    expect(HOURLY_RECONCILE_JOB).toMatchObject({
      id: 'hourly-reconcile',
      name: '每小时对账（工作树、工作流、PR 记账、提醒、GitHub 机器人权限）',
      expectEveryMinutes: 150,
    });
  });
});
