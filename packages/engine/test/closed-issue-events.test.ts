// 单一关就撤停着等人的任务（jobs/closed-issue-events.ts，#2103）：
// 投递账上的 issues.closed → 那张单停着等人的任务收到放弃、挂起提醒撤掉；在跑的不动；别的单不碰；
// 同一事件重复来（同一条再被捞到、另一个投递编号又报一次）不重复发信号；列不出在跑的工作流不记、下一眼再来。
// 撤法和每小时对账是同一个函数（abandonClosedIssueTasks），对账那一支见 closed-issue-tasks.test.ts。
import type { ClosedIssueDelivery } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  CLOSED_ISSUE_EVENT_BY,
  CLOSED_ISSUE_EVENT_WINDOW_MS,
  type ClosedIssueEventDeps,
  runClosedIssueEvents,
} from '../src/jobs/closed-issue-events.ts';
import {
  abandonClosedIssueTasks,
  CLOSED_ISSUE_ABANDON_BY,
  CLOSED_ISSUE_ABANDON_REASON,
  type ClosedIssueHold,
  type ClosedIssueTaskDeps,
} from '../src/jobs/closed-issue-tasks.ts';

const NOW = new Date('2026-10-13T08:00:00.000Z');

const closed = (deliveryId: string, issueNumber: number, repo = 'acme/demo'): ClosedIssueDelivery => ({
  deliveryId,
  repo,
  payload: {
    action: 'closed',
    issue: { number: issueNumber, state: 'closed' },
    repository: { full_name: repo },
  },
  receivedAt: NOW,
});

interface World {
  deps: ClosedIssueEventDeps;
  /** 投递账：note 为空的就是还没处理的。 */
  ledger: Map<string, { row: ClosedIssueDelivery; note: string | null }>;
  signals: { workflowId: string; by: string; reason: string }[];
  resolved: { workflowId: string; why: string; by: string | undefined }[];
  sinceAsked: Date[];
  logs: string[];
}

function world(opts: {
  running: string[];
  parked: Record<string, boolean>;
  states: Record<string, 'open' | 'closed'>;
  deliveries: ClosedIssueDelivery[];
  runningIds?: () => Promise<string[]>;
  /** 给了就走关单收尾的停法，不再问 isParked。放弃之后改成 busy，模拟工作流已经离开检查点。 */
  hold?: Record<string, ClosedIssueHold>;
}): World {
  const signals: World['signals'] = [];
  const resolved: World['resolved'] = [];
  const sinceAsked: Date[] = [];
  const logs: string[] = [];
  const parked = { ...opts.parked };
  const holds = opts.hold ? { ...opts.hold } : null;
  const ledger: World['ledger'] = new Map(
    opts.deliveries.map((row) => [row.deliveryId, { row, note: null }]),
  );
  const tasks: ClosedIssueTaskDeps = {
    closedIssueTasks: {
      runningTaskWorkflowIds: opts.runningIds ?? (async () => [...opts.running]),
      async isParked(workflowId) {
        return parked[workflowId] ?? false;
      },
      ...(holds
        ? {
            async holdForClose(workflowId: string) {
              return holds[workflowId] ?? { kind: 'busy' as const };
            },
          }
        : {}),
      async resolveParkAlerts(workflowId, why, by) {
        resolved.push({ workflowId, why, by });
        return 1;
      },
      async issueState(repo, n) {
        const s = opts.states[`${repo.owner}/${repo.name}#${n}`];
        if (!s) throw new Error(`用例没给 ${repo.owner}/${repo.name}#${n} 的状态`);
        return s;
      },
      async abandon(workflowId, c) {
        signals.push({ workflowId, ...c });
        // 工作流收到放弃就不再停着等人（真引擎里它收尾结束）
        parked[workflowId] = false;
        if (holds) holds[workflowId] = { kind: 'busy' };
        return 'sent';
      },
    },
    now: () => NOW,
    log: (_level, text) => logs.push(text),
  };
  const deps: ClosedIssueEventDeps = {
    async pending(since) {
      sinceAsked.push(since);
      return [...ledger.values()].filter((e) => e.note === null).map((e) => e.row);
    },
    async markHandled(deliveryId, note) {
      const e = ledger.get(deliveryId);
      if (!e || e.note !== null) return false;
      e.note = note;
      return true;
    },
    tasks: () => tasks,
    now: () => NOW,
    log: (_level, text) => logs.push(text),
  };
  return { deps, ledger, signals, resolved, sinceAsked, logs };
}

describe('单关了的事件：停着等人的任务马上撤（#2103）', () => {
  it('单关了：停着等人的任务收到放弃、挂起提醒撤掉，署名是事件这一路；投递账上记下做了什么', async () => {
    const w = world({
      running: ['task:acme/demo#7'],
      parked: { 'task:acme/demo#7': true },
      states: { 'acme/demo#7': 'closed' },
      deliveries: [closed('d-1', 7)],
    });
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toEqual([
      { workflowId: 'task:acme/demo#7', by: CLOSED_ISSUE_EVENT_BY, reason: CLOSED_ISSUE_ABANDON_REASON },
    ]);
    expect(w.resolved).toEqual([
      { workflowId: 'task:acme/demo#7', why: CLOSED_ISSUE_ABANDON_REASON, by: CLOSED_ISSUE_EVENT_BY },
    ]);
    expect(w.ledger.get('d-1')?.note).toBe('单关了：放弃了 1 条停着等人的任务');
    expect(w.sinceAsked).toEqual([new Date(NOW.getTime() - CLOSED_ISSUE_EVENT_WINDOW_MS)]);
  });

  it('同一张单的任务还在跑（不是停着等人）：不发放弃、不撤提醒；别的单停着的也不碰', async () => {
    const w = world({
      running: ['task:acme/demo#7', 'task:acme/demo#8', 'task:acme/other#7'],
      parked: { 'task:acme/demo#7': false, 'task:acme/demo#8': true, 'task:acme/other#7': true },
      states: { 'acme/demo#7': 'closed', 'acme/demo#8': 'closed', 'acme/other#7': 'closed' },
      deliveries: [closed('d-1', 7)],
    });
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toEqual([]);
    expect(w.resolved).toEqual([]);
    expect(w.ledger.get('d-1')?.note).toBe('单关了：放弃了 0 条停着等人的任务');
  });

  it('同一事件重复来：再看一眼不再处理；另一个投递编号又报同一张单，任务已经放弃了，不再发信号', async () => {
    const w = world({
      running: ['task:acme/demo#7'],
      parked: { 'task:acme/demo#7': true },
      states: { 'acme/demo#7': 'closed' },
      deliveries: [closed('d-1', 7)],
    });
    await runClosedIssueEvents(w.deps);
    expect(await runClosedIssueEvents(w.deps)).toBe(0);
    w.ledger.set('d-2', { row: closed('d-2', 7), note: null });
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toHaveLength(1);
    expect(w.resolved).toHaveLength(1);
    expect(w.ledger.get('d-2')?.note).toBe('单关了：放弃了 0 条停着等人的任务');
  });

  it('单其实又开了（事件晚到）：照 GitHub 现读的状态，不撤', async () => {
    const w = world({
      running: ['task:acme/demo#7'],
      parked: { 'task:acme/demo#7': true },
      states: { 'acme/demo#7': 'open' },
      deliveries: [closed('d-1', 7)],
    });
    await runClosedIssueEvents(w.deps);
    expect(w.signals).toEqual([]);
  });

  it('列不出在跑的任务工作流：不记进投递账，下一眼再来', async () => {
    let fail = true;
    const w = world({
      running: ['task:acme/demo#7'],
      parked: { 'task:acme/demo#7': true },
      states: { 'acme/demo#7': 'closed' },
      deliveries: [closed('d-1', 7)],
      runningIds: async () => {
        if (fail) throw new Error('Temporal 连不上');
        return ['task:acme/demo#7'];
      },
    });
    expect(await runClosedIssueEvents(w.deps)).toBe(0);
    expect(w.ledger.get('d-1')?.note).toBeNull();
    expect(w.signals).toEqual([]);
    fail = false;
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toHaveLength(1);
  });

  it('事件里认不出是哪张单：不撤，记下认不出', async () => {
    const w = world({
      running: ['task:acme/demo#7'],
      parked: { 'task:acme/demo#7': true },
      states: { 'acme/demo#7': 'closed' },
      deliveries: [{ ...closed('d-1', 7), payload: { action: 'closed' } }],
    });
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toEqual([]);
    expect(w.ledger.get('d-1')?.note).toBe('单关了：认不出是哪张单，没撤任务');
  });

  it('检查点软暂停、没有开着的会话：和停着等人走同一条放弃，署名仍是事件这一路', async () => {
    const w = world({
      running: ['task:acme/demo#7'],
      parked: {},
      hold: { 'task:acme/demo#7': { kind: 'paused', openSessions: 0 } },
      states: { 'acme/demo#7': 'closed' },
      deliveries: [closed('d-1', 7)],
    });
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toEqual([
      { workflowId: 'task:acme/demo#7', by: CLOSED_ISSUE_EVENT_BY, reason: CLOSED_ISSUE_ABANDON_REASON },
    ]);
    expect(w.ledger.get('d-1')?.note).toBe('单关了：放弃了 1 条停着等人的任务');
    w.ledger.set('d-2', { row: closed('d-2', 7), note: null });
    expect(await runClosedIssueEvents(w.deps)).toBe(1);
    expect(w.signals).toHaveLength(1);
    expect(w.ledger.get('d-2')?.note).toBe('单关了：放弃了 0 条停着等人的任务');
  });

  it('已经记下「放弃了 0 条」的旧投递不再捞；每小时对账仍按同一套判定收掉停在检查点的', async () => {
    const id = '388d1990-ca7d-11f1-88a0-ab3b1f9cde3d';
    const w = world({
      running: ['task:thoerwink8/fleet-dao#2928'],
      parked: {},
      hold: { 'task:thoerwink8/fleet-dao#2928': { kind: 'paused', openSessions: 0 } },
      states: { 'thoerwink8/fleet-dao#2928': 'closed' },
      deliveries: [],
    });
    w.ledger.set(id, {
      row: closed(id, 2928, 'thoerwink8/fleet-dao'),
      note: '单关了：放弃了 0 条停着等人的任务',
    });
    expect(await runClosedIssueEvents(w.deps)).toBe(0);
    expect(w.signals).toEqual([]);
    expect(w.ledger.get(id)?.note).toBe('单关了：放弃了 0 条停着等人的任务');
    const part = await abandonClosedIssueTasks(w.deps.tasks());
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(w.signals).toEqual([
      {
        workflowId: 'task:thoerwink8/fleet-dao#2928',
        by: CLOSED_ISSUE_ABANDON_BY,
        reason: CLOSED_ISSUE_ABANDON_REASON,
      },
    ]);
  });
});
