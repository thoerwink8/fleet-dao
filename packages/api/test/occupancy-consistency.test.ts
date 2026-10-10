// #1747：在跑的会话数、池占用，主页、法国页（/api/env）、额度页（/api/pools）、路由页（/api/routing/...）读同一份。
// 同一份假数据下各处的数必须相同；「在跑」只数已开工的，「已选定还没开跑」单列，不混进在跑、也不丢。
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  EnvResponseSchema,
  HomeResponseSchema,
  PoolsResponse,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures, IDS } from '@fleet-dao/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, type HarnessOptions, harness, pgHarness, T0 } from './harness.ts';

const path = (p: string) => WEB_API_PREFIX + p;

/** 样例库里 pool-claude-a 上已经有 1 个开工的会话（run1）；再加一个选定了还没开工的。 */
function fixtures(): Partial<MemoryData> {
  const data = devFixtures(T0);
  data.runs = [
    ...(data.runs ?? []),
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      taskId: IDS.task12,
      stage: 'execute',
      routeId: 'rt-claude-opus',
      whyRoute: '排队中',
      queuedAt: new Date(T0.getTime() - 60_000).toISOString(),
    },
  ];
  return data;
}

async function readAll(h: Pick<Harness, 'cockpit' | 'login'>) {
  const { cookie } = await h.login();
  const get = async (p: string) => {
    const res = await h.cockpit.request(path(p), { headers: { cookie } });
    expect(res.status).toBe(200);
    return res.json();
  };
  return {
    env: EnvResponseSchema.parse(await get(WebRoutes.env.path)),
    pools: PoolsResponse.parse(await get(WebRoutes.pools.path)),
    home: HomeResponseSchema.parse(await get(WebRoutes.home.path)),
  };
}

function expectSameEverywhere(r: Awaited<ReturnType<typeof readAll>>) {
  const poolRunning = r.pools.pools.reduce((n, p) => n + p.running, 0);
  const poolReserved = r.pools.pools.reduce((n, p) => n + p.reserved, 0);
  expect(poolRunning).toBe(1);
  expect(poolReserved).toBe(1);
  // 法国页「在跑的会话」「池占用」
  const sessions = r.env.facts.sessions;
  const envPools = r.env.facts.pools;
  expect(sessions.ok && sessions.value.total).toBe(poolRunning);
  expect(envPools.ok && envPools.value.running).toBe(poolRunning);
  expect(envPools.ok && envPools.value.reserved).toBe(poolReserved);
  // 主页「此刻 N 个会话在干活」
  expect(r.home.slots).toEqual({ running: poolRunning, reserved: poolReserved });
  // 额度页那一池
  const claude = r.pools.pools.find((p) => p.id === 'pool-claude-a');
  expect(claude).toMatchObject({ running: 1, reserved: 1 });
}

describe('在跑数、池占用各页同源（内存版）', () => {
  it('同一份假数据：主页、法国页、额度页的在跑数和已选定数相同', async () => {
    expectSameEverywhere(await readAll(harness({ data: fixtures() })));
  });
});

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

async function start(options: HarnessOptions = {}) {
  current = await pgHarness(t, options);
  return current;
}

describe('在跑数、池占用各页同源（PG 版）', () => {
  it('同一份假数据：主页、法国页、额度页的在跑数和已选定数相同', async () => {
    expectSameEverywhere(await readAll(await start({ data: fixtures() })));
  });
});
