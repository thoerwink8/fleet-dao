// 渠道状态的探针历史（#1139）：真库上按每次探测收成近 60 格；没接上、读不到都写没查成，不回空列表。
import { saveRouteProbe } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { RouteProbeHistoryResponse } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgProbeHistory } from '../src/probe-history.ts';
import { type Harness, harness, pgHarness, T0 } from './harness.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

async function history(h: Pick<Harness, 'cockpit'>, cookie: string) {
  const res = await h.cockpit.request('/api/routing/probe-history', { headers: { cookie } });
  expect(res.status).toBe(200);
  return RouteProbeHistoryResponse.parse(await res.json());
}

describe('探针历史接口', () => {
  it('没接上：写没查成，不回空的 channels 冒充没有历史', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = await history(h, cookie);
    expect(body).toEqual({ state: 'unreadable', why: '没查成：探针历史没接上（这台没有库）' });
  });

  it('【故意造出的失败】读库抛错：写没查成和原因，不当成没有探测', async () => {
    current = await pgHarness(t, {
      probeHistory: {
        read: () => Promise.reject(new Error('连不上库')),
      },
    });
    const { cookie } = await current.login();
    const body = await history(current, cookie);
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') return;
    expect(body.why).toContain('没查成');
    expect(body.why).toContain('连不上库');
  });

  it('接上了：老结论回填进条带；同一条路由超过 60 次只留最近的', async () => {
    current = await pgHarness(t, { probeHistory: pgProbeHistory(t.db) });
    const { cookie } = await current.login();
    const seeded = await history(current, cookie);
    expect(seeded.state).toBe('ok');
    if (seeded.state !== 'ok') return;
    const claude = seeded.channels.find((c) => c.channelId === 'ch-claude');
    // 样例里这条路由的老结论是「用时 9 秒」，回填成一格通过。
    expect(claude).toMatchObject({
      passed: 1,
      attempted: 1,
      avgDurationMs: 9000,
    });
    expect(claude?.cells).toHaveLength(1);
    expect(claude?.cells[0]).toMatchObject({
      routeId: 'rt-claude-opus',
      result: 'passed',
      durationMs: 9000,
      failureReason: null,
    });

    for (let i = 1; i <= 61; i++) {
      await saveRouteProbe(t.db, {
        routeId: 'rt-claude-opus',
        state: 'ok',
        at: new Date(T0.getTime() + i * 1000),
        detail: '答上了：OK',
        durationMs: i * 1000,
        requestText: '只回 OK',
        responseText: 'OK',
      });
    }
    const body = await history(current, cookie);
    expect(body.state).toBe('ok');
    if (body.state !== 'ok') return;
    const strip = body.channels.find((c) => c.channelId === 'ch-claude');
    expect(strip?.cells).toHaveLength(60);
    // 回填的那条和第一次新写的被裁掉，留下第 2 到第 61 次。
    expect(strip?.cells[0]?.durationMs).toBe(2_000);
    expect(strip?.cells.at(-1)).toMatchObject({
      durationMs: 61_000,
      requestText: '只回 OK',
      responseText: 'OK',
      result: 'passed',
    });
    expect(strip).toMatchObject({ passed: 60, attempted: 60 });
    const latest = body.latestByRoute.find((row) => row.routeId === 'rt-claude-opus');
    expect(latest?.durationMs).toBe(61_000);
    // 别的渠道的回填还在，不被这条路由的 60 次裁掉。
    const mirasim = body.channels.find((c) => c.channelId === 'ch-mirasim');
    expect(mirasim?.cells.length).toBeGreaterThan(0);
    expect(mirasim?.cells.every((cell) => cell.routeId !== 'rt-claude-opus')).toBe(true);
  });
});
