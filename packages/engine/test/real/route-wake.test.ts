// 叫醒等路由的活的发信一侧（real/route-wake.ts，#194 方案 4.3）：收信人不在是正常的不报；收信失败、列不出在跑的工作流要报警、
// 全部成功再撤；报警自己写不进去不静默；叫醒绝不抛错（挡不了切号）；当场切号和探针那一轮切号两条路各接一次、探失败不叫醒。
// 和 Temporal 测试服务端一起的重选、不空转在 test/task-route-wake.test.ts。

import { WorkflowNotFoundError } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import type { OrgSwitchRound, ProbedRoute } from '../../src/jobs/org-switch.ts';
import {
  isWorkflowGone,
  ROUTE_WAKE_ALERT_KEY,
  type RouteWakeClient,
  type RouteWaker,
  routeWaker,
  temporalWakeClient,
  wakeAfterProbeNow,
  wakeAfterProbeRound,
} from '../../src/real/route-wake.ts';

function rig(
  over: { ids?: string[] | Error; signal?: RouteWakeClient['signal']; raiseFails?: boolean } = {},
) {
  const signals: { id: string; by: string }[] = [];
  const raised: { key: string; title: string; body: string }[] = [];
  const resolved: string[] = [];
  const logs: { level: string; message: string }[] = [];
  const client: RouteWakeClient = {
    async runningTaskWorkflowIds() {
      if (over.ids instanceof Error) throw over.ids;
      return over.ids ?? ['w1', 'w2', 'w3'];
    },
    signal:
      over.signal ??
      (async (id, cmd) => {
        signals.push({ id, by: cmd.by });
        return 'sent';
      }),
  };
  const waker = routeWaker({
    client,
    raise: async (a) => {
      if (over.raiseFails) throw new Error('库连不上');
      raised.push(a);
    },
    resolve: async (key) => {
      if (over.raiseFails) throw new Error('库连不上');
      resolved.push(key);
    },
    log: (level, message) => logs.push({ level, message }),
  });
  return { waker, signals, raised, resolved, logs };
}

describe('routeWaker · 叫醒', () => {
  it('同时叫醒多个：每个都收到一次，全部成功就撤警、不报', async () => {
    const r = rig();
    const result = await r.waker.wake('切号完成');
    expect(result).toEqual({ total: 3, sent: 3, gone: 0, failed: [] });
    expect(r.signals.map((s) => s.id)).toEqual(['w1', 'w2', 'w3']);
    expect(r.raised).toEqual([]);
    expect(r.resolved).toEqual([ROUTE_WAKE_ALERT_KEY]);
  });

  it('收信人不在：当成功路径略过，不报警（撤警）', async () => {
    const r = rig({ signal: async (id) => (id === 'w2' ? 'gone' : 'sent') });
    const result = await r.waker.wake('切号完成');
    expect(result).toEqual({ total: 3, sent: 2, gone: 1, failed: [] });
    expect(r.raised).toEqual([]);
    expect(r.resolved).toEqual([ROUTE_WAKE_ALERT_KEY]);
  });

  it('没有在跑的工作流：什么都不发，也不是错', async () => {
    const r = rig({ ids: [] });
    expect(await r.waker.wake('切号完成')).toEqual({ total: 0, sent: 0, gone: 0, failed: [] });
    expect(r.raised).toEqual([]);
  });

  it('收信失败（连不上、超时）：报警、结果里写明是谁，别的照发；不抛', async () => {
    const r = rig({
      signal: async (id) => {
        if (id === 'w2') throw new Error('DEADLINE_EXCEEDED');
        return 'sent';
      },
    });
    const result = await r.waker.wake('切号完成');
    expect(result.sent).toBe(2);
    expect(result.failed).toEqual([{ workflowId: 'w2', error: 'DEADLINE_EXCEEDED' }]);
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]?.key).toBe(ROUTE_WAKE_ALERT_KEY);
    expect(r.raised[0]?.body).toContain('w2');
    expect(r.raised[0]?.body).toContain('DEADLINE_EXCEEDED');
    expect(r.resolved).toEqual([]);
    expect(r.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('列不出在跑的工作流：整次没叫醒，报警，不抛', async () => {
    const r = rig({ ids: new Error('连不上 Temporal') });
    const result = await r.waker.wake('切号完成');
    expect(result).toMatchObject({ total: 0, sent: 0, listError: '连不上 Temporal' });
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]?.body).toContain('连不上 Temporal');
    expect(r.resolved).toEqual([]);
  });

  it('报警自己写不进库：不静默，结果里带 alertError、日志记 error，仍不抛', async () => {
    const r = rig({ ids: new Error('连不上 Temporal'), raiseFails: true });
    const result = await r.waker.wake('切号完成');
    expect(result.alertError).toBe('库连不上');
    expect(r.logs.filter((l) => l.level === 'error').length).toBeGreaterThanOrEqual(2);
  });
});

describe('temporalWakeClient · 收信人不在和真失败分开', () => {
  const fakeClient = (signal: () => Promise<void>) =>
    ({
      connection: { withDeadline: <R>(_d: number | Date, fn: () => Promise<R>) => fn() },
      workflow: { getHandle: () => ({ signal }), list: () => (async function* () {})() },
    }) as never;

  it('WorkflowNotFoundError、「already completed」都是 gone', async () => {
    const a = temporalWakeClient(
      fakeClient(async () => {
        throw new WorkflowNotFoundError('not found', 'w', undefined);
      }),
    );
    expect(await a.signal('w', { by: 'x', reason: 'y' })).toBe('gone');
    const b = temporalWakeClient(
      fakeClient(async () => {
        throw new Error('workflow execution already completed');
      }),
    );
    expect(await b.signal('w', { by: 'x', reason: 'y' })).toBe('gone');
  });

  it('别的错照抛（不当成 gone，不吞）', async () => {
    const c = temporalWakeClient(
      fakeClient(async () => {
        throw new Error('14 UNAVAILABLE');
      }),
    );
    await expect(c.signal('w', { by: 'x', reason: 'y' })).rejects.toThrow('UNAVAILABLE');
    expect(isWorkflowGone(new Error('别的'))).toBe(false);
  });

  it('发成功是 sent', async () => {
    const c = temporalWakeClient(fakeClient(async () => {}));
    expect(await c.signal('w', { by: 'x', reason: 'y' })).toBe('sent');
  });
});

describe('接到切号上', () => {
  const probed: ProbedRoute[] = [];
  const spyWaker = (): RouteWaker & { reasons: string[] } => {
    const reasons: string[] = [];
    return {
      reasons,
      async wake(reason) {
        reasons.push(reason);
        return { total: 0, sent: 0, gone: 0, failed: [] };
      },
    };
  };

  it('当场切号：探完叫醒一次，结果原样交回；探失败（抛）不叫醒、错照抛', async () => {
    const w = spyWaker();
    const ok = wakeAfterProbeNow(async () => probed, w);
    expect(await ok('solo')).toBe(probed);
    expect(w.reasons).toEqual(['切到独享并探过']);
    const bad = wakeAfterProbeNow(async () => {
      throw new Error('探不了');
    }, w);
    await expect(bad('carpool')).rejects.toThrow('探不了');
    expect(w.reasons).toHaveLength(1);
  });

  it('探针那一轮：切了号才叫醒；没切不叫；核对抛了不叫、错照抛', async () => {
    const w = spyWaker();
    let afterError: Error | null = null;
    const inner: OrgSwitchRound = {
      now: async () => null,
      before: async () => 'solo',
      after: async () => {
        if (afterError) throw afterError;
      },
    };
    const round = wakeAfterProbeRound(inner, w);
    expect(await round.before()).toBe('solo');
    await round.after(null, probed);
    expect(w.reasons).toEqual([]);
    await round.after('carpool', probed);
    expect(w.reasons).toEqual(['探针那一轮切到拼车并探过']);
    afterError = new Error('核对出错');
    await expect(round.after('solo', probed)).rejects.toThrow('核对出错');
    expect(w.reasons).toHaveLength(1);
  });
});
