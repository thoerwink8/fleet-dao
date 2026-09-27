// 两处核对（jobs/reconcile-checks.ts）：对上了不报、对不上报并写明哪张单缺什么、条件没了撤、读不到不记 ok 且旧提醒不撤。
// 接活关着的项目不查；排队的单投递上记着为什么不派的不报，没记的先补拉；10 分钟内更新过的不查。
// 人开的 PR 不报合并人这一条在 github 包的测试里（这里只认对账结果里 findings 的种类）。
import { randomUUID } from 'node:crypto';
import type { ActiveTaskRef, AlertRow, IssueDeliveryRef, MergedPrLedger } from '@fleet-dao/db';
import type { MergedPrAuditReport, MergedPrFinding } from '@fleet-dao/github';
import type { TaskState } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  checkLedgers,
  checkMergedPrs,
  checkWorkflows,
  INTAKE_HOLDS,
  LEDGER_GRACE_MS,
  ledgerAlertKey,
  MERGED_PR_LOOKBACK_MS,
  prAlertKey,
  type ReconcileCheckDeps,
  type RepullResult,
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
    autoDispatch: true,
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
  inserted: { dedupeKey: string; title: string; body: string; link: string | null; created: boolean }[];
  asked: string[];
  repulled: string[];
  ledgerCalls: { since: Date; prs: { owner: string; name: string; number: number }[] }[];
}

type Delivery = Pick<IssueDeliveryRef, 'status' | 'reason' | 'note'> &
  Partial<Pick<IssueDeliveryRef, 'issueState'>>;

/** 对账结果：findings 照种类给，problems 跟着 text 排，found、fixed 照 github 包的算法数。 */
function audit(findings: MergedPrFinding[], over: Partial<MergedPrAuditReport> = {}): MergedPrAuditReport {
  return {
    outcome: findings.some((f) => f.kind === 'unchecked') ? 'partial' : 'ok',
    scanned: new Set(findings.map((f) => f.number)).size,
    found: findings.filter((f) => f.kind !== 'unchecked').length,
    fixed: findings.filter((f) => f.kind === 'mirror_fixed').length,
    problems: findings.map((f) => f.text),
    findings,
    ...over,
  };
}

function world(
  over: {
    tasks?: ActiveTaskRef[];
    states?: Record<string, WorkflowState | 'throw'>;
    taskStates?: Record<string, TaskState | null>;
    repos?: { owner: string; name: string }[];
    audit?: ReconcileCheckDeps['auditMergedPrs'];
    open?: AlertRow[];
    listOpen?: ReconcileCheckDeps['alerts']['listOpen'];
    activeTasks?: ReconcileCheckDeps['activeTasks'];
    reposFn?: ReconcileCheckDeps['repos'];
    /** issue 号 → 最近一次接活处理过的投递（投递编号是 d-<号>）；'throw' 读不成；不给是没有。 */
    deliveries?: Record<number, Delivery | 'throw'>;
    /** 投递编号 → 补拉的结果；补拉之后工作流怎样由 afterRepull 定。 */
    repull?: (deliveryId: string) => Promise<RepullResult>;
    afterRepull?: Record<string, WorkflowState>;
    ledgers?: ReconcileCheckDeps['ledgers'];
  } = {},
): World {
  const raised: Raised[] = [];
  const resolved: World['resolved'] = [];
  const inserted: World['inserted'] = [];
  const asked: string[] = [];
  const repulled: string[] = [];
  const ledgerCalls: World['ledgerCalls'] = [];
  const rows = [...(over.open ?? [])];
  const deps: ReconcileCheckDeps = {
    activeTasks: over.activeTasks ?? (async () => over.tasks ?? []),
    repos: over.reposFn ?? (async () => over.repos ?? []),
    auditMergedPrs: over.audit ?? (async () => audit([])),
    async latestDelivery(ref) {
      const d = over.deliveries?.[ref.issueNumber];
      if (d === 'throw') throw new Error('投递表读不了');
      return d ? { deliveryId: `d-${ref.issueNumber}`, issueState: 'open', ...d } : null;
    },
    async repull(deliveryId) {
      repulled.push(deliveryId);
      if (!over.repull) throw new Error(`用例没给 ${deliveryId} 的补拉结果`);
      return over.repull(deliveryId);
    },
    async ledgers(input) {
      ledgerCalls.push(input);
      return over.ledgers ? over.ledgers(input) : [];
    },
    workflows: {
      async state(id) {
        asked.push(id);
        // 补拉之后的样子只对补拉过的那张单算（投递编号是 d-<号>）
        const issue = /#(\d+)$/.exec(id)?.[1];
        const after = repulled.includes(`d-${issue}`) ? over.afterRepull?.[id] : undefined;
        const st = after ?? over.states?.[id] ?? { state: 'missing' };
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
        inserted.push({
          dedupeKey: input.dedupeKey,
          title: input.title,
          body: input.body,
          link: input.link,
          created: true,
        });
        return { created: true };
      },
      async updateOpen() {
        return 'not_open';
      },
    },
    now: () => NOW,
    log() {},
  };
  return { deps, raised, resolved, inserted, asked, repulled, ledgerCalls };
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

describe('开着的单都有着落', () => {
  it('工作流在跑：不报，found 是 0', async () => {
    const w = world({
      tasks: [task()],
      states: { 'req:acme/widgets#160': { state: 'running' } },
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('【故意造出的失败】在做的单（在干、写方案中），工作流结束了或不在、10 分钟前就没再更新：报卡住，写明哪张单、卡在哪；不补拉', async () => {
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
    expect(w.repulled).toEqual([]);
    expect(w.raised.map((r) => r.dedupeKey)).toEqual([
      `${WORKFLOW_ALERT_PREFIX}${TASK}`,
      `${WORKFLOW_ALERT_PREFIX}${OTHER}`,
    ]);
    expect(w.raised[0]).toMatchObject({
      level: 'alert',
      taskId: TASK,
      title: '开着的单没有着落：acme/widgets#160',
      link: 'https://github.com/acme/widgets/issues/160',
    });
    expect(w.raised[0]?.body).toContain('在干');
    expect(w.raised[0]?.body).toContain('已经不在了');
    expect(w.raised[0]?.body).toContain('不自动重起');
    expect(w.raised[1]?.body).toContain('写方案中');
    expect(w.raised[1]?.body).toContain('被强行终止了');
  });

  it('从没写过快照（updatedAt 空）也算过了窗口，照样报', async () => {
    const w = world({ tasks: [task({ updatedAt: null })] });
    const part = await checkWorkflows(w.deps);
    expect(part.found).toBe(1);
    expect(w.raised).toHaveLength(1);
  });

  it('项目「让 AI 接活」关着：不查、不计数，也不去问 Temporal', async () => {
    const w = world({
      tasks: [task({ autoDispatch: false }), task({ state: 'queued', autoDispatch: false })],
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect(w.asked).toEqual([]);
    expect(w.raised).toEqual([]);
  });

  it('排队的单，投递上记着为什么不派（未排期、不是当前版本、母单、子单、开关打开前开的、本机做、等着）：不报、不补拉', async () => {
    const notes: Delivery[] = [
      { status: 'accepted', reason: null, note: 'task=exists, workflow=unscheduled' },
      { status: 'accepted', reason: null, note: 'task=exists, workflow=not_current_version' },
      { status: 'accepted', reason: null, note: 'task=exists, workflow=mother_ticket' },
      { status: 'accepted', reason: null, note: 'task=created, workflow=sub_issue' },
      { status: 'accepted', reason: null, note: 'task=created, workflow=opened_before_switch' },
      { status: 'accepted', reason: null, note: 'task=exists, workflow=reserved_local' },
      { status: 'waiting', reason: '这个项目停派：流程配置认不出', note: null },
    ];
    const w = world({
      tasks: notes.map((_, i) =>
        task({ taskId: randomUUID(), issueNumber: 200 + i, state: 'queued', updatedAt: null }),
      ),
      deliveries: Object.fromEntries(notes.map((d, i) => [200 + i, d])),
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: notes.length, found: 0, unchecked: [] });
    expect(w.repulled).toEqual([]);
    expect(w.raised).toEqual([]);
  });

  it('排队的单那一版 issue 已经关了（机器人关的，接活不叫停、库里还排着）：不是开着的单，不补拉、不报，旧提醒撤掉', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const w = world({
      tasks: [task({ state: 'queued', updatedAt: null })],
      deliveries: { 160: { status: 'accepted', reason: null, note: 'stop=skip_bot', issueState: 'closed' } },
      open: [old],
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(w.repulled).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(w.resolved.map((r) => r.why)).toEqual([
      'GitHub 上这张单关着，不要求有工作流（接活记的是「stop=skip_bot」）',
    ]);
  });

  it('接活每一种「不派」都定了算不算有着落：算的是开关打开前开的、未排期、别的版本、母单、子单、本机做', () => {
    const held = Object.entries(INTAKE_HOLDS)
      .filter(([, why]) => why !== null)
      .map(([k]) => k)
      .sort();
    expect(held).toEqual(
      [
        'mother_ticket',
        'not_current_version',
        'opened_before_switch',
        'reserved_local',
        'sub_issue',
        'unscheduled',
      ].sort(),
    );
  });

  it('【故意造出的失败】排队的单两样都没有（没判成、开关关着时记的旧结论）：补拉一次，工作流起来了就算补上，不报', async () => {
    const w = world({
      tasks: [
        task({ state: 'queued', updatedAt: null }),
        task({ taskId: OTHER, issueNumber: 161, state: 'queued', updatedAt: null }),
      ],
      deliveries: {
        160: { status: 'accepted', reason: null, note: 'task=created, workflow=version_unreadable' },
        161: { status: 'accepted', reason: null, note: 'task=created, workflow=dispatch_off' },
      },
      repull: async () => ({ kind: 'processed', note: 'task=exists, workflow=started' }),
      afterRepull: {
        'req:acme/widgets#160': { state: 'running' },
        'req:acme/widgets#161': { state: 'running' },
      },
    });
    const part = await checkWorkflows(w.deps);
    expect(w.repulled).toEqual(['d-160', 'd-161']);
    expect(part).toEqual({ scanned: 2, found: 2, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('补拉后接活判了不派（本机做也算）、或记成等着：有着落了，不报', async () => {
    const w = world({
      tasks: [
        task({ state: 'queued', updatedAt: null }),
        task({ taskId: OTHER, issueNumber: 161, state: 'queued', updatedAt: null }),
      ],
      deliveries: {
        160: { status: 'failed', reason: 'GitHub 读不了里程碑', note: null },
        161: { status: 'failed', reason: '引擎重启', note: null },
      },
      repull: async (id) =>
        id === 'd-160'
          ? { kind: 'processed', note: 'task=exists, workflow=reserved_local' }
          : { kind: 'waiting', why: '上一轮还没结束' },
    });
    const part = await checkWorkflows(w.deps);
    expect(w.repulled).toEqual(['d-160', 'd-161']);
    expect(part).toEqual({ scanned: 2, found: 2, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('【故意造出的失败】补拉也没成（还是没起来、没有投递、门没收、重放抛错）：报卡住，写明卡在哪', async () => {
    const ids = [TASK, OTHER, randomUUID(), randomUUID()];
    const w = world({
      tasks: ids.map((taskId, i) => task({ taskId, issueNumber: 160 + i, state: 'queued', updatedAt: null })),
      deliveries: {
        160: { status: 'accepted', reason: null, note: 'task=exists, workflow=started' },
        162: { status: 'failed', reason: '上次没处理成', note: null },
        163: { status: 'failed', reason: '上次没处理成', note: null },
      },
      async repull(id) {
        if (id === 'd-160') return { kind: 'processed', note: 'task=exists, workflow=already_running' };
        if (id === 'd-162') return { kind: 'not_taken', why: '门口没收（author_not_whitelisted）' };
        throw new Error('GitHub 读不了里程碑');
      },
    });
    const part = await checkWorkflows(w.deps);
    expect(w.repulled).toEqual(['d-160', 'd-162', 'd-163']);
    expect(part).toMatchObject({ scanned: 4, found: 4, unchecked: [] });
    expect(w.raised.map((r) => r.body)).toEqual([
      expect.stringContaining('补拉了一次还是没起来：接活记的是「task=exists, workflow=already_running」'),
      expect.stringContaining('库里没有这张 issue 的投递，补拉不了'),
      expect.stringContaining('补拉时接活没收：门口没收（author_not_whitelisted）'),
      expect.stringContaining('补拉了一次没成：GitHub 读不了里程碑'),
    ]);
    expect(w.raised[0]?.body).toContain('排队中');
  });

  it('补拉时那条投递正在处理：这一轮不报、旧提醒不撤', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const w = world({
      tasks: [task({ state: 'queued', updatedAt: null })],
      deliveries: { 160: { status: 'processing', reason: null, note: null } },
      repull: async () => ({ kind: 'busy' }),
      open: [old],
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });

  it('补拉之后问工作流没问成：这一轮不报、旧提醒不撤', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    let asks = 0;
    const w = world({
      tasks: [task({ state: 'queued', updatedAt: null })],
      deliveries: { 160: { status: 'failed', reason: '上次没处理成', note: null } },
      repull: async () => ({ kind: 'processed', note: 'task=exists, workflow=started' }),
      open: [old],
    });
    const state = w.deps.workflows.state;
    w.deps.workflows.state = async (id) => {
      asks += 1;
      if (asks > 1) throw new Error('Temporal 连不上');
      return state(id);
    };
    const part = await checkWorkflows(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });

  it('【故意造出的失败】读投递抛错：记没查成，不补拉、不报，旧提醒不撤', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const w = world({
      tasks: [task({ state: 'queued', updatedAt: null })],
      deliveries: { 160: 'throw' },
      open: [old],
    });
    const part = await checkWorkflows(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets#160 的投递没读成：投递表读不了']);
    expect(w.repulled).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });

  it('10 分钟内更新过：不查', async () => {
    const w = world({
      tasks: [task({ updatedAt: new Date(NOW.getTime() - WORKFLOW_QUIET_MS + 1) })],
    });
    const part = await checkWorkflows(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('工作流又在跑、单结束了、有了不派理由、项目接活关了、库里没了：撤掉', async () => {
    const third = '33333333-3333-4333-8333-333333333333';
    const fourth = '44444444-4444-4444-8444-444444444444';
    const fifth = '55555555-5555-4555-8555-555555555555';
    const running = openAlert(`${WORKFLOW_ALERT_PREFIX}${TASK}`, { taskId: TASK });
    const done = openAlert(`${WORKFLOW_ALERT_PREFIX}${OTHER}`);
    const held = openAlert(`${WORKFLOW_ALERT_PREFIX}${third}`);
    const off = openAlert(`${WORKFLOW_ALERT_PREFIX}${fourth}`);
    const gone = openAlert(`${WORKFLOW_ALERT_PREFIX}${fifth}`);
    const w = world({
      tasks: [
        task(),
        task({ taskId: third, issueNumber: 162, state: 'queued' }),
        task({ taskId: fourth, issueNumber: 163, autoDispatch: false }),
      ],
      states: { 'req:acme/widgets#160': { state: 'running' } },
      deliveries: { 162: { status: 'accepted', reason: null, note: 'workflow=not_current_version' } },
      taskStates: { [OTHER]: 'done', [fifth]: null },
      open: [running, done, held, off, gone],
    });
    const part = await checkWorkflows(w.deps);
    expect(part.found).toBe(5);
    expect(w.resolved.map((r) => r.why)).toEqual([
      '需求工作流在跑',
      '这张单已经结束了（做完了）',
      '投递上记着不派：不是当前版本',
      '这个项目「让 AI 接活」关着，不要求有工作流',
      '库里没有这张单了',
    ]);
    expect(running.body.startsWith('已撤：')).toBe(true);
    expect(done.resolvedAt).toEqual(NOW);
  });

  it('【故意造出的失败】问 Temporal 抛错：这一部分没查全，旧提醒不撤', async () => {
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

  it('【故意造出的失败】列不出单：这一部分 failed，旧提醒不撤', async () => {
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

  it('提醒对上的单读不了：不撤，记没查成', async () => {
    const old = openAlert(`${WORKFLOW_ALERT_PREFIX}${OTHER}`);
    const w = world({ open: [old] });
    w.deps.taskState = async () => {
      throw new Error('库连不上');
    };
    const part = await checkWorkflows(w.deps);
    expect(part.unchecked).toEqual([`提醒 ${WORKFLOW_ALERT_PREFIX}${OTHER} 对上的单读不了，不撤：库连不上`]);
    expect(old.resolvedAt).toBeNull();
  });

  it('报提醒写不进去：记没查成，不当成报了', async () => {
    const w = world({ tasks: [task()] });
    w.deps.alerts.raise = async () => {
      throw new Error('提醒表写不了');
    };
    const part = await checkWorkflows(w.deps);
    expect(part.found).toBe(0);
    expect(part.unchecked).toEqual(['acme/widgets#160 没有着落，报提醒没报成：提醒表写不了']);
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

describe('合了的 PR：镜像、合并人、合并记录', () => {
  const sinceOf = (now: Date) => new Date(now.getTime() - MERGED_PR_LOOKBACK_MS);

  it('镜像没记成 merged：算发现，不报警', async () => {
    const seen: Date[] = [];
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async (_repo, since) => {
        seen.push(since);
        return audit([{ number: 7, kind: 'mirror_fixed', text: '#7 合并了但镜像里没有（已补）' }]);
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(seen).toEqual([sinceOf(NOW)]);
    expect(w.inserted).toEqual([]);
  });

  it('【故意造出的失败】机器人开的 PR 合并人不是引擎、没有合并记录：报 reconcile:pr，一条里写全；已经报过的不再报', async () => {
    const report = audit([
      { number: 7, kind: 'not_merged_by_engine', text: '#7 不是「引擎」机器人合的（合并人 founder）' },
      { number: 7, kind: 'no_merge_record', text: '#7 合并了，但账上没有合并队列的合并记录' },
    ]);
    const w = world({ repos: [{ owner: 'acme', name: 'widgets' }], audit: async () => report });
    const part = await checkMergedPrs(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 2, unchecked: [] });
    expect(w.inserted).toHaveLength(1);
    expect(w.inserted[0]).toMatchObject({
      dedupeKey: prAlertKey('acme', 'widgets', 7),
      title: '机器人开的 PR 没经合并队列合：acme/widgets#7',
      link: 'https://github.com/acme/widgets/pull/7',
      created: true,
    });
    expect(w.inserted[0]?.body).toContain(
      '#7 不是「引擎」机器人合的（合并人 founder）\n#7 合并了，但账上没有合并队列的合并记录',
    );

    await checkMergedPrs(w.deps);
    expect(w.inserted.map((x) => x.created)).toEqual([true, false]);
  });

  it('只有镜像补上的（人开的 PR 对账结果就是这样）：不报合并人那两项', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => audit([{ number: 9, kind: 'mirror_fixed', text: '#9 合并了但镜像里没有（已补）' }]),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.found).toBe(1);
    expect(w.inserted).toEqual([]);
  });

  it('【故意造出的失败】列 PR 失败（读不到 GitHub）：这个仓写进 unchecked，不记成查完了', async () => {
    const w = world({
      repos: [
        { owner: 'acme', name: 'widgets' },
        { owner: 'acme', name: 'other' },
      ],
      audit: async (repo) =>
        repo === 'acme/widgets'
          ? audit([], { outcome: 'unscanned', scanned: 0, why: '列合并的 PR 失败：403' })
          : audit([], { scanned: 1 }),
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

  it('单张没查成：partial，写进 unchecked，不报警', async () => {
    const w = world({
      repos: [{ owner: 'acme', name: 'widgets' }],
      audit: async () => audit([{ number: 7, kind: 'unchecked', text: '#7 没查成：502' }]),
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets 合并的 PR 没查全：#7 没查成：502']);
    expect(w.inserted).toEqual([]);
  });

  it('列不出受管的仓：这一部分 failed', async () => {
    const w = world({
      reposFn: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await checkMergedPrs(w.deps);
    expect(part.failed).toBe('列受管的仓没成：库连不上');
  });
});

describe('合了的 PR 对上的单记了账', () => {
  function ledger(over: Partial<MergedPrLedger> = {}): MergedPrLedger {
    return {
      owner: 'acme',
      name: 'widgets',
      prNumber: 88,
      prUpdatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      headRef: 'fleet/160-abc',
      taskId: TASK,
      issueNumber: 160,
      taskState: 'done',
      sessions: [
        {
          runId: randomUUID(),
          stage: 'execute',
          startedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
          endedAt: new Date(NOW.getTime() - 4 * 60 * 60_000),
          outcome: 'ok',
          inputTokens: 1200,
          outputTokens: 300,
        },
        {
          runId: randomUUID(),
          stage: 'verify',
          startedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
          endedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
          outcome: 'ok',
          // 没读到：留空，关单评论写「没读到」，不算缺
          inputTokens: null,
          outputTokens: null,
        },
        {
          runId: randomUUID(),
          stage: 'execute',
          startedAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
          endedAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
          // 刚起就被限流：一个 token 都没花，照实记的 0 不算缺
          outcome: 'failed',
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
      ...over,
    };
  }
  type Session = MergedPrLedger['sessions'][number];

  it('会话都有结局、用量记了或留空（没跑成的 0 照实记）、单做完了：不报，按 26 小时回看', async () => {
    const w = world({ ledgers: async () => [ledger()] });
    const part = await checkLedgers(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
    expect(w.ledgerCalls[0]?.since).toEqual(new Date(NOW.getTime() - MERGED_PR_LOOKBACK_MS));
  });

  it('【故意造出的失败】缺什么报什么：会话没结局、跑成了的会话用量记成 0、单没记成做完，一条 PR 一条提醒，写明哪张单', async () => {
    const base = ledger();
    const w = world({
      ledgers: async () => [
        ledger({
          taskState: 'merging',
          sessions: [
            { ...(base.sessions[0] as Session), endedAt: null, outcome: null },
            { ...(base.sessions[1] as Session), inputTokens: 0, outputTokens: 0 },
            { ...(base.sessions[1] as Session), runId: randomUUID(), inputTokens: 0, outputTokens: null },
          ],
        }),
      ],
    });
    const part = await checkLedgers(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]).toMatchObject({
      dedupeKey: ledgerAlertKey('acme', 'widgets', 88),
      taskId: TASK,
      title: '合了的 PR 记账不全：acme/widgets#88',
      link: 'https://github.com/acme/widgets/pull/88',
    });
    const body = w.raised[0]?.body ?? '';
    expect(body).toContain('单 #160：1 次会话没有结局（execute）');
    expect(body).toContain('单 #160：2 次跑成了的会话用量记成了 0');
    expect(body).toContain('单 #160：合并关单那一步没写完：库里这张单是「在合并」');
  });

  it('合并不满 30 分钟（关单那一步可能还在走）：不报', async () => {
    const w = world({
      ledgers: async () => [
        ledger({ taskState: 'merging', prUpdatedAt: new Date(NOW.getTime() - LEDGER_GRACE_MS + 1) }),
      ],
    });
    const part = await checkLedgers(w.deps);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.raised).toEqual([]);
  });

  it('补齐了撤；出了回看窗口的旧提醒点名复查；镜像里不再对得上的也撤；认不出的键不撤', async () => {
    const fixed = openAlert(ledgerAlertKey('acme', 'widgets', 88));
    const gone = openAlert(ledgerAlertKey('acme', 'gadgets', 7));
    const odd = openAlert('reconcile:ledger:认不出');
    const w = world({ open: [fixed, gone, odd], ledgers: async () => [ledger()] });
    const part = await checkLedgers(w.deps);
    expect(w.ledgerCalls[0]?.prs).toEqual([
      { owner: 'acme', name: 'widgets', number: 88 },
      { owner: 'acme', name: 'gadgets', number: 7 },
    ]);
    expect(part.found).toBe(2);
    expect(w.resolved.map((r) => r.why)).toEqual([
      '会话结局、用量、关单都记齐了',
      '镜像里这条 PR 不再是已合并、或对不上单了',
    ]);
    expect(part.unchecked).toEqual(['提醒 reconcile:ledger:认不出 认不出是哪条 PR，不撤']);
    expect(odd.resolvedAt).toBeNull();
  });

  it('【故意造出的失败】读库抛错：这一部分 failed，旧提醒不撤', async () => {
    const old = openAlert(ledgerAlertKey('acme', 'widgets', 88));
    const w = world({
      open: [old],
      ledgers: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await checkLedgers(w.deps);
    expect(part.failed).toBe('读合了的 PR 和会话记账没成：库连不上');
    expect(w.resolved).toEqual([]);
    expect(old.resolvedAt).toBeNull();
  });

  it('列提醒抛错：照样查、照样报，记没查成，旧提醒不撤', async () => {
    const w = world({
      ledgers: async () => [ledger({ taskState: 'running' })],
      listOpen: async () => {
        throw new Error('提醒表读不了');
      },
    });
    const part = await checkLedgers(w.deps);
    expect(part.unchecked).toEqual(['列没处理的提醒没成，记账核对的旧提醒这一轮不复查、不撤：提醒表读不了']);
    expect(part.found).toBe(1);
    expect(w.resolved).toEqual([]);
  });
});
