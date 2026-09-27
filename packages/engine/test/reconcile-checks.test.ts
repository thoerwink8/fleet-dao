// 三处核对（jobs/reconcile-checks.ts）：没问题不报、有问题报并计 found、条件没了撤、读不到不记 ok 且旧提醒不撤。
// 排队的单、10 分钟内更新过的不报。人开的 PR 不报合并人这一条在 github 包的测试里（这里只认对账结果里有没有那两句）。
import { randomUUID } from 'node:crypto';
import type { ActiveTaskRef, AlertRow } from '@fleet-dao/db';
import type { TaskState } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  checkMergedPrs,
  checkQuotas,
  checkWorkflows,
  MERGED_PR_LOOKBACK_MS,
  prAlertKey,
  QUOTA_ALERT_KEY,
  type QuotaPoolRead,
  type ReconcileCheckDeps,
  WORKFLOW_ALERT_PREFIX,
  WORKFLOW_QUIET_MS,
} from '../src/jobs/reconcile-checks.ts';
import type { WorkflowState } from '../src/jobs/reconcile-common.ts';

const NOW = new Date('2026-09-26T09:41:00.000Z');
const TASK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function task(over: Partial<ActiveTaskRef> = {}): ActiveTaskRef {
  return {
    taskId: TASK,
    owner: 'acme',
    name: 'widgets',
    issueNumber: 160,
    state: 'running',
    updatedAt: new Date(NOW.getTime() - 20 * 60_000),
    ...over,
  };
}

interface Raised {
  dedupeKey: string;
  title: string;
  body: string;
  taskId: string | null;
  link?: string | undefined;
}

interface World {
  deps: ReconcileCheckDeps;
  raised: Raised[];
  resolved: { dedupeKey: string; why: string }[];
  inserted: { dedupeKey: string; body: string; link: string | null; created: boolean }[];
  asked: string[];
}

function world(
  over: {
    tasks?: ActiveTaskRef[];
    states?: Record<string, WorkflowState | 'throw'>;
    taskStates?: Record<string, TaskState | null>;
    repos?: { owner: string; name: string }[];
    audit?: ReconcileCheckDeps['auditMergedPrs'];
    pools?: QuotaPoolRead[];
    open?: AlertRow[];
    listOpen?: ReconcileCheckDeps['alerts']['listOpen'];
    activeTasks?: ReconcileCheckDeps['activeTasks'];
    reposFn?: ReconcileCheckDeps['repos'];
    quotaPools?: ReconcileCheckDeps['quotaPools'];
  } = {},
): World {
  const raised: Raised[] = [];
  const resolved: World['resolved'] = [];
  const inserted: World['inserted'] = [];
  const asked: string[] = [];
  const rows = [...(over.open ?? [])];
  const deps: ReconcileCheckDeps = {
    activeTasks: over.activeTasks ?? (async () => over.tasks ?? []),
    repos: over.reposFn ?? (async () => over.repos ?? []),
    auditMergedPrs:
      over.audit ?? (async () => ({ outcome: 'ok', scanned: 0, found: 0, fixed: 0, problems: [] })),
    quotaPools: over.quotaPools ?? (async () => over.pools ?? []),
    workflows: {
      async state(id) {
        asked.push(id);
        const st = over.states?.[id] ?? { state: 'missing' };
        if (st === 'throw') throw new Error('Temporal 连不上');
        return st;
      },
      async view() {
        throw new Error('不该问');
      },
    },
    async taskState(id) {
      if (over.taskStates && id in over.taskStates) return over.taskStates[id] ?? null;
      return null;
    },
    alerts: {
      async listOpen(limit) {
        if (over.listOpen) return over.listOpen(limit);
        const alerts = rows.filter((r) => r.resolvedAt === null);
        return { alerts: alerts.slice(0, limit), truncated: alerts.length > limit };
      },
      async byKey(key) {
        return rows.find((r) => r.dedupeKey === key) ?? null;
      },
      async latestByPrefix() {
        return null;
      },
      async resolve(input) {
        resolved.push({ dedupeKey: input.dedupeKey, why: input.why });
        const row = rows.find((r) => r.dedupeKey === input.dedupeKey && r.resolvedAt === null);
        if (!row) return rows.some((r) => r.dedupeKey === input.dedupeKey) ? 'already_resolved' : 'not_found';
        row.resolvedAt = NOW;
        row.resolvedBy = input.by;
        row.body = `已撤：${input.why}\n\n${row.body}`;
        return 'ok';
      },
      async raise(input) {
        raised.push(input);
        const row = rows.find((r) => r.dedupeKey === input.dedupeKey);
        if (row) {
          row.title = input.title;
          row.body = input.body;
          row.taskId = input.taskId;
          row.link = input.link ?? null;
          row.resolvedAt = null;
          row.updatedAt = NOW;
          return;
        }
        rows.push({
          id: randomUUID(),
          dedupeKey: input.dedupeKey,
          level: input.level,
          taskId: input.taskId,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          createdAt: NOW,
          updatedAt: NOW,
          resolvedAt: null,
          resolvedBy: null,
        });
      },
      async insertOnce(input) {
        const existing = rows.find((r) => r.dedupeKey === input.dedupeKey);
        if (existing) {
          inserted.push({ ...input, created: false });
          return { created: false };
        }
        rows.push({
          id: randomUUID(),
          dedupeKey: input.dedupeKey,
          level: input.level,
          taskId: input.taskId,
          title: input.title,
          body: input.body,
          link: input.link,
          createdAt: NOW,
          updatedAt: NOW,
          resolvedAt: null,
          resolvedBy: null,
        });
        inserted.push({ dedupeKey: input.dedupeKey, body: input.body, link: input.link, created: true });
        return { created: true };
      },
      async updateOpen() {
        return 'not_open';
      },
    },
    now: () => NOW,
    log() {},
  };
  return { deps, raised, resolved, inserted, asked };
}

function openAlert(dedupeKey: string, over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: randomUUID(),
    dedupeKey,
    level: 'alert',
    taskId: null,
    title: dedupeKey,
    body: '原来的正文',
    link: null,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

describe('开着的单都有工作流', () => {
  it('工作流在跑：不报，found 是 0', async () => {
    const w = world({
      tasks: [task()],
      states: { 'req:acme/widgets#160': { state: 'running' } },
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('running / planning，工作流结束了或不在，而且 10 分钟前就没再更新：报 reconcile:workflow 并计 found', async () => {
    const w = world({
      tasks: [
        task({ state: 'running' }),
        task({
          taskId: OTHER,
          issueNumber: 161,
          state: 'planning',
          updatedAt: new Date(NOW.getTime() - WORKFLOW_QUIET_MS),
        }),
      ],
      states: {
        'req:acme/widgets#160': { state: 'missing' },
        'req:acme/widgets#161': { state: 'closed', status: 'TERMINATED' },
      },
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toMatchObject({ scanned: 2, found: 2, unchecked: [] });
    expect(w.raised.map((r) => r.dedupeKey)).toEqual([
      `${WORKFLOW_ALERT_PREFIX}${TASK}`,
      `${WORKFLOW_ALERT_PREFIX}${OTHER}`,
    ]);
    expect(w.raised[0]).toMatchObject({
      level: 'alert',
      taskId: TASK,
      link: 'https://github.com/acme/widgets/issues/160',
    });
    expect(w.raised[0]?.body).toContain('在干');
    expect(w.raised[0]?.body).toContain('已经不在了');
    expect(w.raised[1]?.body).toContain('写方案中');
    expect(w.raised[1]?.body).toContain('被强行终止了');
  });

  it('从没写过快照（updatedAt 空）也算过了窗口，照样报', async () => {
    const w = world({ tasks: [task({ updatedAt: null })] });
    const part = await checkWorkflows(w.deps);
    expect(part.found).toBe(1);
    expect(w.raised).toHaveLength(1);
  });

  it('排队的单不报，也不去问 Temporal', async () => {
    const w = world({ tasks: [task({ state: 'queued', updatedAt: null })] });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.asked).toEqual([]);
    expect(w.raised).toEqual([]);
  });

  it('10 分钟内更新过：不报', async () => {
    const w = world({
      tasks: [task({ updatedAt: new Date(NOW.getTime() - WORKFLOW_QUIET_MS + 1) })],
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('工作流又在跑、单结束了、回到排队：撤掉', async () => {
    const running = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const done = openAlert(`${WORKFLOW_ALERT_PREFIX}${OTHER}`);
    const back = openAlert(`${WORKFLOW_ALERT_PREFIX}33333333-3333-4333-8333-333333333333`);
    const w = world({
      tasks: [
        task(),
        task({ taskId: '33333333-3333-4333-8333-333333333333', issueNumber: 162, state: 'queued' }),
      ],
      states: { 'req:acme/widgets#160': { state: 'running' } },
      taskStates: { [OTHER]: 'done' },
      open: [running, done, back],
    });
    const part = await checkWorkflows(w.deps);
    expect(part.found).toBe(3);
    expect(w.resolved.map((r) => r.why)).toEqual([
      '需求工作流又在跑了',
      '这张单已经结束了（做完了）',
      '这张单在排队，没派是有意的，不要求已经有工作流',
    ]);
    expect(running.body.startsWith('已撤：')).toBe(true);
    expect(done.resolvedAt).toEqual(NOW);
  });

  it('问 Temporal 抛错：这一部分没查全，旧提醒不撤', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const w = world({
      tasks: [task()],
      states: { 'req:acme/widgets#160': 'throw' },
      open: [old],
    });
    const part = await checkWorkflows(w.deps);
    expect(part.failed).toBeUndefined();
    expect(part.unchecked).toEqual(['acme/widgets#160 的工作流没问成：Temporal 连不上']);
    expect(part.found).toBe(0);
    expect(w.resolved).toEqual([]);
    expect(old.resolvedAt).toBeNull();
    expect(w.raised).toEqual([]);
  });

  it('列不出单：这一部分 failed，旧提醒不撤', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const w = world({
      open: [old],
      activeTasks: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await checkWorkflows(w.deps);
    expect(part.failed).toBe('列没结束的单没成：库连不上');
    expect(w.resolved).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });

  it('10 分钟窗口里的旧提醒也不撤（可能正在收尾）', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const w = world({
      tasks: [task({ updatedAt: new Date(NOW.getTime() - 60_000) })],
      open: [old],
    });
    await checkWorkflows(w.deps);
    expect(w.resolved).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });
});

describe('合了的 PR 都记了账', () => {
  const sinceOf = (now: Date) => new Date(now.getTime() - MERGED_PR_LOOKBACK_MS);

  it('镜像没记成 merged：算发现，不报警', async () => {
    const seen: Date[] = [];
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async (_repo, since) => {
        seen.push(since);
        return {
          outcome: 'ok',
          scanned: 1,
          found: 1,
          fixed: 1,
          problems: ['#7 合并了但镜像里没有（已补）'],
        };
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(seen).toEqual([sinceOf(NOW)]);
    expect(w.inserted).toEqual([]);
  });

  it('机器人开的 PR 合并人不是引擎、或没有合并记录：报 reconcile:pr，一条里写全', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => ({
        outcome: 'ok',
        scanned: 1,
        found: 2,
        fixed: 0,
        problems: ['#7 不是「引擎」机器人合的（合并人 founder）', '#7 合并了，但账上没有合并队列的合并记录'],
      }),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 2, unchecked: [] });
    expect(w.inserted).toEqual([
      {
        dedupeKey: prAlertKey('acme', 'widgets', 7),
        body: '#7 不是「引擎」机器人合的（合并人 founder）\n#7 合并了，但账上没有合并队列的合并记录',
        link: 'https://github.com/acme/widgets/pull/7',
        created: true,
      },
    ]);
  });

  it('只有「已补」的（人开的 PR 对账结果就是这样）：不报合并人那两项', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => ({
        outcome: 'ok',
        scanned: 2,
        found: 1,
        fixed: 1,
        problems: ['#9 合并了但镜像里没有（已补）'],
      }),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.found).toBe(1);
    expect(w.inserted).toEqual([]);
  });

  it('列 PR 失败：这个仓写进 unchecked，不记成查完了', async () => {
    const w = world({
      repos: [
        { owner: 'acme', name: 'widgets' },
        { owner: 'acme', name: 'other' },
      ],
      audit: async (repo) => {
        if (repo === 'acme/widgets') {
          return {
            outcome: 'unscanned',
            scanned: 0,
            found: 0,
            fixed: 0,
            problems: [],
            why: '列合并的 PR 失败：403',
          };
        }
        return { outcome: 'ok', scanned: 1, found: 0, fixed: 0, problems: [] };
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.failed).toBeUndefined();
    expect(part.unchecked).toEqual(['acme/widgets：列合并的 PR 失败：403']);
    expect(part.scanned).toBe(1);
  });

  it('审的时候抛错：这个仓写进 unchecked', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => {
        throw new Error('GitHub 连不上');
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets 审合并的 PR 没做成：GitHub 连不上']);
  });

  it('单张没查成：partial，写进 unchecked', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => ({
        outcome: 'partial',
        scanned: 1,
        found: 0,
        fixed: 0,
        problems: ['#7 没查成：502'],
      }),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets 合并的 PR 没查全：#7 没查成：502']);
    expect(w.inserted).toEqual([]);
  });
});

describe('额度读数不超过 30 分钟', () => {
  const pool = (over: Partial<QuotaPoolRead> = {}): QuotaPoolRead => ({
    poolId: 'relay-a',
    channelName: '中转',
    channelEnabled: true,
    lastReadOkAt: new Date(NOW.getTime() - 5 * 60_000),
    dataAt: new Date(NOW.getTime() - 5 * 60_000),
    neverRead: false,
    readOverdue: false,
    ...over,
  });

  it('都新的：不报；原来那条撤掉', async () => {
    const old = openAlert(QUOTA_ALERT_KEY);
    const w = world({ pools: [pool()], open: [old] });
    const part = await checkQuotas(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 1, unchecked: [] });
    expect(w.raised).toEqual([]);
    expect(w.resolved).toEqual([
      { dedupeKey: QUOTA_ALERT_KEY, why: '启用的渠道下，账号池的额度读数都在 30 分钟以内' },
    ]);
    expect(old.body.startsWith('已撤：')).toBe(true);
  });

  it('启用渠道下过期的汇成一条，写出上次读成的时刻；停用的渠道不算', async () => {
    const staleAt = new Date(NOW.getTime() - 45 * 60_000);
    const frozenAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
    const w = world({
      pools: [
        pool({ poolId: 'relay-a', lastReadOkAt: staleAt, dataAt: null, readOverdue: true }),
        pool({ poolId: 'relay-b', neverRead: true, lastReadOkAt: null, dataAt: null, readOverdue: true }),
        pool({
          poolId: 'relay-c',
          lastReadOkAt: NOW,
          dataAt: frozenAt,
          readOverdue: true,
        }),
        pool({
          poolId: 'old-a',
          channelName: '停用的',
          channelEnabled: false,
          readOverdue: true,
          neverRead: true,
          lastReadOkAt: null,
        }),
        pool({ poolId: 'relay-fresh' }),
      ],
    });
    const part = await checkQuotas(w.deps);
    expect(part).toMatchObject({ scanned: 4, found: 3, unchecked: [] });
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]).toMatchObject({ dedupeKey: QUOTA_ALERT_KEY, level: 'alert', taskId: null });
    const body = w.raised[0]?.body ?? '';
    expect(body).toContain('中转 / relay-a：上次读成在北京时间 09-26 16:56（45 分钟前）');
    expect(body).toContain('中转 / relay-b：从没读成过');
    expect(body).toContain('中转 / relay-c：上次读成在北京时间 09-26 17:41（0 分钟前）');
    expect(body).toContain('上游数据冻住了（数据时刻北京时间 09-26 15:41）');
    expect(body).not.toContain('old-a');
    expect(body).not.toContain('relay-fresh');
  });

  it('读额度表抛错：这一部分 failed，旧提醒不撤', async () => {
    const old = openAlert(QUOTA_ALERT_KEY);
    const w = world({
      open: [old],
      quotaPools: async () => {
        throw new Error('关系 quota_windows 不存在');
      },
    });
    const part = await checkQuotas(w.deps);
    expect(part.failed).toBe('读额度表没成：关系 quota_windows 不存在');
    expect(part.scanned).toBe(0);
    expect(w.resolved).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });
});
