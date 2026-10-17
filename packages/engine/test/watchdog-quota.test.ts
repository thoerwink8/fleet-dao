// 看门狗的「在用的账号池额度读数不超过 30 分钟」（#76；决定 0093 从每小时对账搬来，jobs/watchdog-quota.ts）。
// 用例跟着从 reconcile-checks.test.ts 搬过来，加上看门狗这边的两条：每 5 分钟一轮、正文不带每轮会变的数，没变不改卡；
// 看门狗一轮把它算进去（扫过的池算 scanned，读不到额度表这一轮记没跑成、开着的不撤）。
import type { QuotaTablePool } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { runWatchdogJob, type WatchdogDeps } from '../src/jobs/watchdog.ts';
import {
  QUOTA_ALERT_LINK,
  QUOTA_ALERT_PREFIX,
  type QuotaWatchDeps,
  quotaAlertKey,
  watchQuotaFreshness,
} from '../src/jobs/watchdog-quota.ts';

/** 北京时间 09-26 17:41。 */
const NOW = new Date('2026-09-26T09:41:00.000Z');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function quotaPool(over: Partial<QuotaTablePool> = {}): QuotaTablePool {
  return {
    poolId: 'p1',
    channelName: '渠道一',
    channelEnabled: true,
    routeCount: 2,
    expiresAt: null,
    lastReadOkAt: minAgo(5),
    dataAt: minAgo(5),
    readOverdue: false,
    ...over,
  } as QuotaTablePool;
}

interface Card {
  dedupeKey: string;
  title: string;
  body: string;
  link?: string;
}

/** 假的提醒表：开着的卡、报过的、撤过的。 */
function world(
  over: Partial<Omit<QuotaWatchDeps, 'alerts' | 'log'>> & { open?: Card[]; listFails?: boolean } = {},
) {
  const open = new Map((over.open ?? []).map((c) => [c.dedupeKey, c] as const));
  const raised: Card[] = [];
  const resolved: { dedupeKey: string; why: string }[] = [];
  const deps: QuotaWatchDeps = {
    quotaPools: over.quotaPools ?? (async () => []),
    ...(over.quotaNotRead ? { quotaNotRead: over.quotaNotRead } : {}),
    alerts: {
      async openByPrefix(prefix) {
        if (over.listFails) throw new Error('提醒表读不了');
        return [...open.values()].filter((c) => c.dedupeKey.startsWith(prefix));
      },
      async raise(c) {
        raised.push(c);
        open.set(c.dedupeKey, c);
      },
      async resolve(x) {
        if (!open.has(x.dedupeKey)) return 'not_found';
        open.delete(x.dedupeKey);
        resolved.push(x);
        return 'ok';
      },
    },
    log: () => {},
  };
  return { deps, raised, resolved, open };
}

describe('额度读数新不新鲜（看门狗，watchQuotaFreshness）', () => {
  it('都读新了：不报，扫了几个池照实记', async () => {
    const w = world({ quotaPools: async () => [quotaPool(), quotaPool({ poolId: 'p2' })] });
    expect(await watchQuotaFreshness(w.deps, NOW)).toEqual({ scanned: 2, found: 0, problems: [] });
    expect(w.raised).toEqual([]);
  });

  it('【故意造出的失败】过期的池：报警写明哪个池、上次读成的时刻（不写「几分钟前」），点进去是额度页；从没读成过也报', async () => {
    const w = world({
      quotaPools: async () => [
        quotaPool({ readOverdue: true, lastReadOkAt: minAgo(50) }),
        quotaPool({ poolId: 'p2', readOverdue: true, lastReadOkAt: null, dataAt: null }),
      ],
    });
    const r = await watchQuotaFreshness(w.deps, NOW);
    expect(r).toMatchObject({ scanned: 2, found: 2, problems: [] });
    expect(w.raised.map((c) => [c.dedupeKey, c.title, c.link])).toEqual([
      [quotaAlertKey('p1'), '账号池额度读数过期：p1', QUOTA_ALERT_LINK],
      [quotaAlertKey('p2'), '账号池额度读数过期：p2', QUOTA_ALERT_LINK],
    ]);
    expect(w.raised[0]?.body).toContain('p1（渠道 渠道一）最近一次读成是 09-26 16:51');
    expect(w.raised[0]?.body).not.toContain('分钟前');
    expect(w.raised[1]?.body).toContain('从没读成过');
  });

  it('看门狗 5 分钟一轮：读数还旧、正文没变不改卡（飞书调用量）；上游数冻住写明停在哪', async () => {
    const pools = async () => [
      quotaPool({ readOverdue: true, lastReadOkAt: minAgo(50), dataAt: minAgo(120) }),
    ];
    const w = world({ quotaPools: pools });
    await watchQuotaFreshness(w.deps, NOW);
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]?.body).toContain('上游数据本身停在 09-26 15:41');
    // 5 分钟后又一轮：同一个池、同一个上次读成时刻，正文一字不差，不再写卡
    const again = await watchQuotaFreshness(w.deps, new Date(NOW.getTime() + 5 * 60_000));
    expect(again).toMatchObject({ found: 1, problems: [] });
    expect(w.raised).toHaveLength(1);
  });

  it('渠道关了、没有路由在用、池过期了的不查也不报', async () => {
    const w = world({
      quotaPools: async () => [
        quotaPool({ channelEnabled: false, readOverdue: true }),
        quotaPool({ poolId: 'p3', routeCount: 0, readOverdue: true }),
        quotaPool({ poolId: 'p2', expiresAt: new Date(NOW.getTime() - 1000), readOverdue: true }),
      ],
    });
    expect(await watchQuotaFreshness(w.deps, NOW)).toMatchObject({ scanned: 0, found: 0 });
    expect(w.raised).toEqual([]);
  });

  it('读新了：撤掉旧提醒（包括搬家前对账开的那条）；别的前缀的提醒不碰', async () => {
    const w = world({
      open: [
        {
          dedupeKey: quotaAlertKey('p1'),
          title: '账号池额度读数过期：p1',
          body: '搬家前对账写的正文（带「50 分钟前」）',
        },
        { dedupeKey: 'reconcile:ledger:a/b#1', title: 'x', body: 'x' },
      ],
      quotaPools: async () => [quotaPool()],
    });
    await watchQuotaFreshness(w.deps, NOW);
    expect(w.resolved).toEqual([{ dedupeKey: quotaAlertKey('p1'), why: '读新了，或这个池不再在用' }]);
    expect(w.open.has('reconcile:ledger:a/b#1')).toBe(true);
    expect(QUOTA_ALERT_PREFIX).toBe('reconcile:quota:');
  });

  it('额度配置写明不读的池：不报读数过期，开着的旧提醒撤掉', async () => {
    const w = world({
      open: [{ dedupeKey: quotaAlertKey('jev'), title: 'x', body: 'x' }],
      quotaPools: async () => [
        quotaPool({ poolId: 'jev', readOverdue: true, lastReadOkAt: null, dataAt: null }),
        quotaPool({ poolId: 'p1', readOverdue: true, lastReadOkAt: minAgo(50) }),
      ],
      quotaNotRead: async () => ['jev'],
    });
    const r = await watchQuotaFreshness(w.deps, NOW);
    expect(r.scanned).toBe(1);
    expect(w.raised.map((c) => c.dedupeKey)).toEqual([quotaAlertKey('p1')]);
    expect(w.resolved).toEqual([
      { dedupeKey: quotaAlertKey('jev'), why: '额度配置写明不读这个池（没有这种数据），不再报读数过期' },
    ]);
  });

  it('退役标记产生的有效 notRead：不把旧 Mirasim 读数当过期池，旧提醒照样撤', async () => {
    const w = world({
      open: [{ dedupeKey: quotaAlertKey('mirasim-relay'), title: 'x', body: 'x' }],
      quotaPools: async () => [
        quotaPool({ poolId: 'mirasim-relay', readOverdue: true, lastReadOkAt: null, dataAt: null }),
      ],
      quotaNotRead: async () => ['mirasim-relay'],
    });

    const r = await watchQuotaFreshness(w.deps, NOW);

    expect(r).toEqual({ scanned: 0, found: 0, problems: [] });
    expect(w.raised).toEqual([]);
    expect(w.resolved).toEqual([
      {
        dedupeKey: quotaAlertKey('mirasim-relay'),
        why: '额度配置写明不读这个池（没有这种数据），不再报读数过期',
      },
    ]);
  });

  it('【故意造出的失败】不读名单读不出来：这一轮不查也不撤，旧提醒留着', async () => {
    const w = world({
      open: [{ dedupeKey: quotaAlertKey('jev'), title: 'x', body: 'x' }],
      quotaPools: async () => [quotaPool({ poolId: 'jev', readOverdue: true, lastReadOkAt: null })],
      quotaNotRead: async () => {
        throw new Error('额度配置读不到');
      },
    });
    const r = await watchQuotaFreshness(w.deps, NOW);
    expect(r.problems).toEqual(['读额度配置里不读的池没成，额度读数这一轮不查也不撤：额度配置读不到']);
    expect(w.raised).toEqual([]);
    expect(w.resolved).toEqual([]);
  });

  it('【故意造出的失败】读额度表抛错：记没查成，不当成都新鲜，旧提醒不撤', async () => {
    const w = world({
      open: [{ dedupeKey: quotaAlertKey('p1'), title: 'x', body: 'x' }],
      quotaPools: async () => {
        throw new Error('库连不上');
      },
    });
    const r = await watchQuotaFreshness(w.deps, NOW);
    expect(r.problems).toEqual(['读额度表没成，额度读数新不新鲜这一轮没查：库连不上']);
    expect(w.resolved).toEqual([]);
  });

  it('【故意造出的失败】列提醒抛错：照样查、照样报，记没查成，旧提醒不撤', async () => {
    const w = world({ quotaPools: async () => [quotaPool({ readOverdue: true })], listFails: true });
    const r = await watchQuotaFreshness(w.deps, NOW);
    expect(r.problems).toEqual(['列不了额度读数开着的提醒（读新了的这一轮撤不了）：提醒表读不了']);
    expect(r.found).toBe(1);
    expect(w.raised).toHaveLength(1);
    expect(w.resolved).toEqual([]);
  });
});

describe('看门狗一轮算进额度读数这一步', () => {
  function watchdogDeps(quota: WatchdogDeps['quota'], w: ReturnType<typeof world>): WatchdogDeps {
    return {
      health: async () => [],
      alerts: {
        openByPrefix: w.deps.alerts.openByPrefix,
        latestByPrefix: async () => null,
        byKey: async () => null,
        raise: w.deps.alerts.raise,
        resolve: w.deps.alerts.resolve,
      },
      runs: { start: async () => 1, finish: async () => {} },
      ...(quota ? { quota } : {}),
      now: () => NOW,
      log: () => {},
    };
  }

  it('在用的池算扫过（登记表上没别的任务也不是 unscanned），过期的报一条', async () => {
    const w = world();
    const run = await runWatchdogJob(
      watchdogDeps(
        { quotaPools: async () => [quotaPool({ readOverdue: true, lastReadOkAt: minAgo(50) })] },
        w,
      ),
    );
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect(w.raised.map((c) => c.dedupeKey)).toEqual([quotaAlertKey('p1')]);
  });

  it('【故意造出的失败】读不到额度表：看门狗这一轮记没跑成、写明原因，开着的不撤', async () => {
    const w = world({ open: [{ dedupeKey: quotaAlertKey('p1'), title: 'x', body: 'x' }] });
    const err = await runWatchdogJob(
      watchdogDeps(
        {
          quotaPools: async () => {
            throw new Error('库连不上');
          },
        },
        w,
      ),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('读额度表没成，额度读数新不新鲜这一轮没查：库连不上');
    expect(w.resolved).toEqual([]);
  });
});
