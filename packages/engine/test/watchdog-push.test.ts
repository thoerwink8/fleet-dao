// 看门狗的「提醒真的推到飞书了」：不通进「要你拍」，通了自己撤，人处理过的同一段不再打开，读不到算没查成、不撤。
import type { FeishuPushFacts } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { PUSH_ALERT_KEY, type PushWatchDeps, watchFeishuPush } from '../src/jobs/watchdog-push.ts';

const NOW = new Date('2026-10-14T10:00:00Z');
const HOUR = 60 * 60_000;

type Row = { title: string; body: string; resolvedAt: Date | null; resolvedBy: string | null };

function world(facts: FeishuPushFacts | (() => Promise<FeishuPushFacts>), row: Row | null = null) {
  const state = {
    row,
    raised: [] as {
      dedupeKey: string;
      level: string;
      title: string;
      body: string;
      link: string;
      options?: readonly { action?: { kind: string } }[] | undefined;
    }[],
    resolved: [] as string[],
  };
  const deps: PushWatchDeps = {
    facts: typeof facts === 'function' ? facts : async () => facts,
    alerts: {
      byKey: async () => state.row,
      raise: async (x) => {
        state.raised.push(x);
        state.row = { title: x.title, body: x.body, resolvedAt: null, resolvedBy: null };
      },
      resolve: async (x) => {
        state.resolved.push(x.why);
        if (state.row) state.row = { ...state.row, resolvedAt: NOW, resolvedBy: 'engine:watchdog' };
        return 'ok';
      },
    },
    log: () => {},
  };
  return { deps, state };
}

const quiet: FeishuPushFacts = { status: null, stale: null, undelivered: 0, lastDeliveredAt: null };
const notConfigured: FeishuPushFacts = {
  ...quiet,
  status: { configured: false, why: '飞书机器人在 2 个群里，认不出哪个是团队群', at: NOW },
};
const stuck: FeishuPushFacts = {
  status: { configured: true, why: null, at: NOW },
  stale: {
    id: 'n1',
    title: '主线红了',
    since: new Date(NOW.getTime() - 2 * HOUR),
    attempts: 3,
    lastError: 'code=230002',
  },
  undelivered: 4,
  lastDeliveredAt: new Date(NOW.getTime() - 9 * 24 * HOUR),
};

describe('watchFeishuPush', () => {
  it('没东西要推：通着，不报', async () => {
    const w = world(quiet);
    expect(await watchFeishuPush(w.deps, NOW)).toEqual({ scanned: 0, found: 0, problems: [] });
    expect(w.state.raised).toEqual([]);
  });

  it('后端记了没配：进「要你拍」，正文写缺什么、怎么查、怎么真发一条验', async () => {
    const w = world(notConfigured);
    const r = await watchFeishuPush(w.deps, NOW);
    expect(r.found).toBe(1);
    expect(w.state.raised).toHaveLength(1);
    expect(w.state.raised[0]).toMatchObject({ dedupeKey: PUSH_ALERT_KEY, level: 'decision' });
    expect(w.state.raised[0]?.options?.length).toBeGreaterThanOrEqual(2);
    expect(w.state.raised[0]?.options?.every((o) => o.action !== undefined)).toBe(true);
    expect(w.state.raised[0]?.body).toContain('认不出哪个是团队群');
    expect(w.state.raised[0]?.body).toContain('fleet-api feishu-push test');
  });

  it('该推的 1 小时没送到、最近没送成过：报；同样的话下一轮不重写', async () => {
    const w = world(stuck);
    await watchFeishuPush(w.deps, NOW);
    await watchFeishuPush(w.deps, NOW);
    expect(w.state.raised).toHaveLength(1);
    expect(w.state.raised[0]?.body).toContain('code=230002');
  });

  it('通了：自己撤，写明为什么', async () => {
    const w = world(quiet, { title: 't', body: 'b', resolvedAt: null, resolvedBy: null });
    await watchFeishuPush(w.deps, NOW);
    expect(w.state.resolved).toHaveLength(1);
    expect(w.state.resolved[0]).toContain('通了');
  });

  it('同一段里人点了「处理」：不再打开；看门狗自己撤过的：再不通照样打开', async () => {
    const handled = world(stuck, { title: 't', body: 'b', resolvedAt: NOW, resolvedBy: 'user-1' });
    expect((await watchFeishuPush(handled.deps, NOW)).found).toBe(1);
    expect(handled.state.raised).toEqual([]);
    const again = world(stuck, { title: 't', body: 'b', resolvedAt: NOW, resolvedBy: 'engine:watchdog' });
    await watchFeishuPush(again.deps, NOW);
    expect(again.state.raised).toHaveLength(1);
  });

  it('【故意造出的失败】读不到推送状态：记没查成，开着的不撤，不当成通着', async () => {
    const w = world(
      async () => {
        throw new Error('relation "settings" does not exist');
      },
      { title: 't', body: 'b', resolvedAt: null, resolvedBy: null },
    );
    const r = await watchFeishuPush(w.deps, NOW);
    expect(r.problems.join()).toContain('没查');
    expect(w.state.resolved).toEqual([]);
    expect(w.state.raised).toEqual([]);
  });
});
