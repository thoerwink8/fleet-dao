// 环境页（#820 片 1）：GET /api/env —— 这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」。
// 语义（怎么分项、读不到怎么写、一项坏不连累别的）在这里按内存版测；契约对账在 web-routes-contract.test.ts。
// 做完的标准（方案 §5 片 1）：法国和 WSL 两种环境各项分别返回；故意让一项读失败，只那一项写「没查成 + 原因」；
// 法国引擎关着显示「关着（临时调整）」不是红。
import { EnvResponseSchema, MeResponse, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import { DEPLOY_LAG_NOT_HERE } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type EnvFact, envFacts, fact } from '../src/env-view.ts';
import { ENGINE_OFF_DETAIL } from '../src/home-engine.ts';
import type { HealthCheck } from '../src/ports.ts';
import { type Harness, harness } from './harness.ts';

const ENV_PATH = WEB_API_PREFIX + WebRoutes.env.path;

async function getEnv(h: Pick<Harness, 'cockpit' | 'login'>) {
  const { cookie } = await h.login();
  return h.cockpit.request(ENV_PATH, { headers: { cookie } });
}

/** 一个健康的引擎探针：名字 engine，回 ok（和 /healthz 里的那一项同名，home-engine.ts 按名字找它）。 */
const engineUp: HealthCheck = { name: 'engine', async check() {} };

/** 一个探不通的引擎探针：回 engine_offline（真没连上，主页那格会标红）。 */
const engineDown: HealthCheck = {
  name: 'engine',
  async check() {
    const err = new Error('no engine workers') as Error & { code: string };
    err.code = 'engine_offline';
    throw err;
  },
};

/** 一个跑起来就抛的探针：跑不成，算红（runHealthChecks 每一项自己接住，别的探针不受影响）。 */
const exploding: HealthCheck = {
  name: 'database',
  async check() {
    throw new Error('连接池爆了');
  },
};

describe('/api/env（内存版）', () => {
  it('环境名读得到时给名字（api.env 的 FLEET_MACHINE_NAME）；没配时写「认不出」并给原因，不猜成某一台', async () => {
    const named = await getEnv(harness());
    expect(named.status).toBe(200);
    const ok = EnvResponseSchema.parse(await named.json());
    expect(ok.name.name).toBe('测试机');
    expect(ok.name.problem).toBeUndefined();

    const unnamed = harness({ config: { machineName: null } });
    const res = await getEnv(unnamed);
    expect(res.status).toBe(200);
    const body = EnvResponseSchema.parse(await res.json());
    expect(body.name.name).toBe('认不出');
    expect(body.name.problem).toContain('FLEET_MACHINE_NAME');
  });

  it('顶栏徽标的名字跟着 /api/me 带回（不为一个名字去拉整份环境页）；没配时同样写「认不出」并给原因', async () => {
    const getMe = async (h: Pick<Harness, 'cockpit' | 'login'>) => {
      const { cookie } = await h.login();
      const res = await h.cockpit.request(WEB_API_PREFIX + WebRoutes.me.path, { headers: { cookie } });
      expect(res.status).toBe(200);
      return MeResponse.parse(await res.json());
    };
    expect((await getMe(harness())).env).toEqual({ name: '测试机' });
    const unnamed = await getMe(harness({ config: { machineName: null } }));
    expect(unnamed.env.name).toBe('认不出');
    expect(unnamed.env.problem).toContain('FLEET_MACHINE_NAME');
  });

  it('七项都在：引擎、总开关、在用版本、在跑的会话、池占用、健康、最近拉单；每一项各自带 ok', async () => {
    const h = harness({ health: [engineUp] });
    const res = await getEnv(h);
    expect(res.status).toBe(200);
    const body = EnvResponseSchema.parse(await res.json());
    expect(Object.keys(body.facts).sort()).toEqual([
      'engine',
      'health',
      'master',
      'pools',
      'schedule',
      'sessions',
      'version',
    ]);
    // 引擎开着（探针回 ok）：在跑，不是别的三态
    expect(body.facts.engine).toMatchObject({ ok: true, value: { state: 'on' } });
    // 在跑的会话：fixture 里 task12 在跑 → 至少一个；数字和 StageKind 都对得上
    expect(body.facts.sessions.ok).toBe(true);
    if (body.facts.sessions.ok) expect(body.facts.sessions.value.total).toBeGreaterThan(0);
    // 池占用：fixture 有池
    expect(body.facts.pools.ok).toBe(true);
    if (body.facts.pools.ok) expect(body.facts.pools.value.count).toBeGreaterThan(0);
  });

  it('引擎关着写「关着（临时调整）」，不是红、不是 down：法国 2026-09-29 起临时关着', async () => {
    const h = harness({ config: { engineOff: true } });
    const res = await getEnv(h);
    const body = EnvResponseSchema.parse(await res.json());
    expect(body.facts.engine).toEqual({ ok: true, value: { state: 'off', detail: ENGINE_OFF_DETAIL } });
  });

  it('引擎开着却探不到在线工人：写 down，是「真没连上」，和「关着」分开', async () => {
    const h = harness({ health: [engineDown] });
    const body = EnvResponseSchema.parse(await (await getEnv(h)).json());
    expect(body.facts.engine).toMatchObject({ ok: true, value: { state: 'down' } });
    if (body.facts.engine.ok) expect(body.facts.engine.value.state).not.toBe('off');
  });

  it('版本那一项没接上（非法国正式机器）：写「没查成 + 原因」，不拿空或 0 顶', async () => {
    const h = harness(); // 测试装配没有 deployLag（和生产上非法国机器一样）
    const body = EnvResponseSchema.parse(await (await getEnv(h)).json());
    expect(body.facts.version).toEqual({ ok: false, reason: DEPLOY_LAG_NOT_HERE });
  });

  it('故意造出失败：健康探针抛异常时，健康那一项算红，别的项照常', async () => {
    const h = harness({ health: [engineUp, exploding] });
    const body = EnvResponseSchema.parse(await (await getEnv(h)).json());
    // 健康那项：红了，「连接池爆了」那一项在名单里（runHealthChecks 每一项自己接住，不让整个报告抛）
    expect(body.facts.health.ok).toBe(true);
    if (body.facts.health.ok) {
      expect(body.facts.health.value.ok).toBe(false);
      expect(body.facts.health.value.failing).toContain('database');
    }
    // 别的项不受连累：引擎那一项照常按它自己的探针结果走
    expect(body.facts.engine).toMatchObject({ ok: true, value: { state: 'on' } });
  });

  it('故意造出失败：某一项读法抛异常时，只有那一项写「没查成 + 原因」，别的项照常（一项坏不连累别项）', async () => {
    // 库读法直接抛：会话那一项该写「没查成」，池、定时任务、健康照常
    const facts = await envFacts({
      engine: { ok: true, value: { state: 'on' } },
      readSessions: () => {
        throw new Error('库连不上（测试故意造的）');
      },
      readPools: async () => ({ count: 2, running: 1, unread: 0, stale: 0 }),
      readSchedule: async () => ({ status: 'never' as const }),
      readMaster: async () => ({ on: false as const, why: 'never_set' as const }),
      readVersion: null,
      versionNotWired: DEPLOY_LAG_NOT_HERE,
      readHealth: async () => ({ ok: true, total: 3, failing: [], notWired: [] }),
    });
    expect(facts.sessions.ok).toBe(false);
    if (!facts.sessions.ok) {
      expect(facts.sessions.reason).toContain('库连不上（测试故意造的）');
      expect(facts.sessions.reason).toContain('在跑的会话');
    }
    expect(facts.pools).toEqual({ ok: true, value: { count: 2, running: 1, unread: 0, stale: 0 } });
    expect(facts.schedule).toEqual({ ok: true, value: { status: 'never' } });
    expect(facts.health.ok).toBe(true);
    expect(facts.engine.ok).toBe(true);
    expect(facts.version).toEqual({ ok: false, reason: DEPLOY_LAG_NOT_HERE });
  });

  it('引擎总开关那一项（#1086）：开着/关着、谁什么时候改的都带；没设过 = 默认关；读库抛了只有这一项红', async () => {
    const base = {
      engine: { ok: true as const, value: { state: 'on' as const } },
      readSessions: async () => ({ pools: [], inFlightByStage: {} }),
      readPools: async () => ({ count: 0, running: 0, unread: 0, stale: 0 }),
      readSchedule: async () => ({ status: 'never' as const }),
      readVersion: null,
      versionNotWired: DEPLOY_LAG_NOT_HERE,
      readHealth: async () => ({ ok: true, total: 1, failing: [], notWired: [] }),
    };
    const closed = await envFacts({
      ...base,
      readMaster: async () => ({
        on: false as const,
        why: 'set' as const,
        by: 'user:frank',
        at: '2026-10-05T13:00:00.000Z',
      }),
    });
    expect(closed.master).toMatchObject({
      ok: true,
      value: { on: false, why: 'set', by: 'user:frank', at: '2026-10-05T13:00:00.000Z' },
    });
    if (closed.master.ok) expect(closed.master.value.detail).toContain('关着');

    const neverSet = await envFacts({
      ...base,
      readMaster: async () => ({ on: false as const, why: 'never_set' as const }),
    });
    expect(neverSet.master).toMatchObject({ ok: true, value: { on: false, why: 'never_set' } });
    if (neverSet.master.ok) expect(neverSet.master.value.detail).toContain('默认关');

    const broken = await envFacts({
      ...base,
      readMaster: async () => {
        throw new Error('库连不上（测试故意造的）');
      },
    });
    expect(broken.master.ok).toBe(false);
    if (!broken.master.ok) expect(broken.master.reason).toContain('引擎总开关');
    expect(broken.engine.ok).toBe(true);
  });

  it('故意造出失败：fact() 抓住抛出来的原因并写进那一项；没抛时原样给值', async () => {
    const good: EnvFact<number> = await fact('某个数', () => 7);
    expect(good).toEqual({ ok: true, value: 7 });
    const bad: EnvFact<number> = await fact('某个数', () => {
      throw new Error('读坏了');
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('读某个数没成：读坏了');
  });

  it('健康一项「未接」单列，不算红：这台机器没有这一项功能，不是坏了', async () => {
    const notWired: HealthCheck = {
      name: 'deploy_lag',
      notWired: DEPLOY_LAG_NOT_HERE,
      async check() {},
    };
    const h = harness({ health: [engineUp, notWired] });
    const body = EnvResponseSchema.parse(await (await getEnv(h)).json());
    expect(body.facts.health.ok).toBe(true);
    if (body.facts.health.ok) {
      expect(body.facts.health.value.notWired).toContain('deploy_lag');
      expect(body.facts.health.value.failing).not.toContain('deploy_lag');
    }
  });

  it('没登录读不到：401（环境页只在登录后给细节）', async () => {
    const h = harness();
    const res = await h.cockpit.request(ENV_PATH);
    expect(res.status).toBe(401);
  });
});
