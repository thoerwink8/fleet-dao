// 本机的判断题接没接、接了用哪个后端、调不调得通（wiring.ts）：引擎每次提问和 /healthz 的 judge 项都走这一份。
// 「未接」只有默认位置上没有配置文件一种；别的读不成都要报坏（不许当成没配悄悄不问），每条都故意造一次。
// 库照发布时的做法装：先装仓里的目录样例（deploy/examples/catalog.example.json），再把路由两层的默认骨架
// （packages/db/routing.default.json）只补缺装进去——判断用途只排 Jev 1.13，它下面一条 TypeSafe 的路由、开着。
import type { Stats } from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRoutingDefault,
  type Db,
  jevAnswers,
  loadCatalog,
  loadRoutingConfig,
  parseCatalog,
  routes,
  routingCatalog,
  routingPurposeModels,
  seed,
  settings,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendResult, JevBackend } from '../src/backend.ts';
import { ERROR_NEXT } from '../src/bank.ts';
import {
  backendForRoute,
  CLAUDE_ROUTE_CLOSED,
  type JevConfigLocation,
  type JudgeRoute,
} from '../src/config.ts';
import { createJev } from '../src/jev.ts';
import { lastSentCall } from '../src/store.ts';
import { jevConfigPresence, judgeHealth, resolveJevBackend } from '../src/wiring.ts';
import { fakeBackend, MODEL, ok } from './helpers.ts';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE = 'deploy/examples/catalog.example.json';
const JEV_ROUTE = 'jev:jev-1.13:api-shell';
const KEY_VALUE = 'k-wiring-test-value-7f3a';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await seed(t.db);
  await loadCatalog(t.db, parseCatalog(repoFile(EXAMPLE), EXAMPLE));
  await applyRoutingDefault(t.db, await loadRoutingConfig());
});

/** 判断用途的模型顺序整串换掉（路由两层的上层）。 */
async function setJudgeModels(modelIds: string[]) {
  await t.db.delete(routingPurposeModels).where(eq(routingPurposeModels.purpose, 'judge'));
  if (modelIds.length > 0) {
    await t.db
      .insert(routingPurposeModels)
      .values(modelIds.map((modelId, position) => ({ purpose: 'judge' as const, modelId, position })));
  }
}

/** 只让查判断记录（jev_answers）的那一次出错，查路由两层的照常放行：不按第几次 select 数，两层读法多查几张表也不跟着改。 */
function failingOnAnswers(real: Db, error: Error): Db {
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'select' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const builder = value.apply(target, args);
        return new Proxy(builder, {
          get(b, p, r) {
            const v = Reflect.get(b, p, r);
            if (p !== 'from' || typeof v !== 'function') return v;
            return (table: unknown, ...rest: unknown[]) => {
              if (table === jevAnswers) throw error;
              return v.apply(b, [table, ...rest]);
            };
          },
        });
      };
    },
  }) as Db;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一台机器的 /etc/fleet-dao：配置文件指向同目录下的钥匙文件；key 为 null 就不放钥匙文件。 */
function machine(options: { config?: string; key?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-jev-wiring-'));
  dirs.push(dir);
  const keyFile = join(dir, 'typesafe.key');
  if (options.key !== null) writeFileSync(keyFile, options.key ?? `${KEY_VALUE}\n`);
  const path = join(dir, 'jev.json');
  writeFileSync(
    path,
    options.config ??
      JSON.stringify({ typesafe: { endpoint: 'https://jev.example.invalid/v1/systemone', keyFile } }),
  );
  return { dir, path, keyFile, at: { path, explicit: false } satisfies JevConfigLocation };
}

/** 测试里不出网：路由对了就交一个假后端。 */
const fakeMake = (seen: JudgeRoute[] = []) => {
  const make = async (route: JudgeRoute): Promise<JevBackend> => {
    seen.push(route);
    return fakeBackend();
  };
  return make;
};

describe('配置文件在不在', () => {
  it('默认位置上没有：未接（这是唯一的「没配」）', () => {
    const missing = join(tmpdir(), 'fleet-jev-nowhere', 'jev.json');
    expect(jevConfigPresence({ path: missing, explicit: false })).toEqual({ state: 'absent', path: missing });
  });

  it('FLEET_JEV_CONFIG 明写的文件不在：坏了，不是未接', () => {
    const missing = join(tmpdir(), 'fleet-jev-nowhere', 'jev.json');
    const p = jevConfigPresence({ path: missing, explicit: true });
    expect(p.state).toBe('broken');
    expect(p.state === 'broken' && p.problem).toContain('FLEET_JEV_CONFIG');
  });

  it('查不了（权限不够这类）：坏了，不当成没配——existsSync 会把它说成「不存在」', () => {
    const denied = (path: string): Stats => {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), { code: 'EACCES' });
    };
    const p = jevConfigPresence({ path: '/etc/fleet-dao/jev.json', explicit: false }, denied);
    expect(p).toEqual({ state: 'broken', problem: '查不了 /etc/fleet-dao/jev.json：EACCES' });
  });

  it('是个目录：坏了', () => {
    const { dir } = machine();
    const inside = join(dir, 'jev-dir');
    mkdirSync(inside);
    expect(jevConfigPresence({ path: inside, explicit: false })).toEqual({
      state: 'broken',
      problem: `${inside} 不是文件`,
    });
  });

  it('在：present', () => {
    const { at } = machine();
    expect(jevConfigPresence(at, statSync)).toEqual({ state: 'present', path: at.path });
  });
});

describe('按配置和路由两层现找后端', () => {
  it('配好了：用路由两层里判断用途排第一、不是死的那条路由（插头发给上游的型号）起后端', async () => {
    const seen: JudgeRoute[] = [];
    const setup = await resolveJevBackend(t.db, { ...machine().at, makeBackend: fakeMake(seen) });
    expect(setup).toMatchObject({ state: 'ready', routeId: JEV_ROUTE, backend: { model: MODEL } });
    expect(seen).toEqual([{ hostId: 'api-shell', model: 'jev-1.13.0' }]);
  });

  it('没配：未接，连库都不碰', async () => {
    const missing = join(tmpdir(), 'fleet-jev-nowhere', 'jev.json');
    const noDb = {} as Db;
    expect(await resolveJevBackend(noDb, { path: missing, explicit: false })).toEqual({
      state: 'absent',
      path: missing,
    });
  });

  it('配置不是 JSON、有不认识的键：坏了，原因写明', async () => {
    const notJson = await resolveJevBackend(t.db, { ...machine({ config: '{ typesafe: ' }).at });
    expect(notJson.state === 'broken' && notJson.problem).toContain('不是合法的 JSON');
    const unknown = await resolveJevBackend(t.db, { ...machine({ config: '{"typesafe":{},"extra":1}' }).at });
    expect(unknown.state === 'broken' && unknown.problem).toContain('有不认识的键 extra');
  });

  it('判断用途下唯一那条路由关着：坏了，写明是哪条、死在哪，不当成判断通过', async () => {
    await t.db.update(routingCatalog).set({ enabled: false }).where(eq(routingCatalog.modelId, 'jev-1.13'));
    expect(await resolveJevBackend(t.db, { ...machine().at, makeBackend: fakeMake() })).toEqual({
      state: 'broken',
      problem: `路由两层里判断用途没有派得出去的路由：${JEV_ROUTE} 死了：开关关着（这条路由在它的模型下关着）`,
    });
  });

  it('探针真探了、没通（不是按量计费不探）：那条算死，原因照探针写的', async () => {
    await t.db
      .update(routes)
      .set({ probeState: 'failed', probedAt: new Date(), probeDetail: '连不上 TypeSafe：ECONNREFUSED' })
      .where(eq(routes.id, JEV_ROUTE));
    const setup = await resolveJevBackend(t.db, { ...machine().at, makeBackend: fakeMake() });
    expect(setup).toEqual({
      state: 'broken',
      problem: `路由两层里判断用途没有派得出去的路由：${JEV_ROUTE} 死了：探针判不在线：连不上 TypeSafe：ECONNREFUSED`,
    });
  });

  it('判断用途没配模型顺序：坏了，写明没配，不回空当成没事', async () => {
    await setJudgeModels([]);
    expect(await resolveJevBackend(t.db, { ...machine().at, makeBackend: fakeMake() })).toEqual({
      state: 'broken',
      problem: '路由两层里判断用途没有派得出去的路由：用途 judge 没配模型顺序',
    });
  });

  it('判断用途排的模型下一条路由都没有：坏了，写明是哪个模型', async () => {
    await t.db.delete(routingCatalog).where(eq(routingCatalog.modelId, 'jev-1.13'));
    expect(await resolveJevBackend(t.db, { ...machine().at, makeBackend: fakeMake() })).toEqual({
      state: 'broken',
      problem: '路由两层里判断用途没有派得出去的路由：模型 jev-1.13 没有路由（routing_catalog 里一条都没有）',
    });
  });

  it('两层的顺序、开关改了，下一次就按新的走：Opus 排到第一、它的 Claude 路由开着就用它、接不了明说；关掉就跳过、回到 Jev', async () => {
    const claude = 'claude-solo:opus-5.5:claude-code';
    const at = machine().at;
    expect(await resolveJevBackend(t.db, { ...at, makeBackend: fakeMake() })).toMatchObject({
      state: 'ready',
      routeId: JEV_ROUTE,
    });
    // Claude 那条还没探过：接得上是「不知道」，不算死，照样排在 Jev 前面被取到
    await setJudgeModels(['opus-5.5', 'jev-1.13']);
    const setup = await resolveJevBackend(t.db, at);
    expect(setup.state).toBe('broken');
    expect(setup.state === 'broken' && setup.problem).toContain(`判断路由 ${claude} 起不了后端`);
    expect(setup.state === 'broken' && setup.problem).toContain(CLAUDE_ROUTE_CLOSED);
    // Opus 下的路由都关了：都是死的，跳过，取后面 Jev 那条
    await t.db.update(routingCatalog).set({ enabled: false }).where(eq(routingCatalog.modelId, 'opus-5.5'));
    const seen: JudgeRoute[] = [];
    expect(await resolveJevBackend(t.db, { ...at, makeBackend: fakeMake(seen) })).toMatchObject({
      state: 'ready',
      routeId: JEV_ROUTE,
    });
    expect(seen).toEqual([{ hostId: 'api-shell', model: 'jev-1.13.0' }]);
  });

  it('读不到路由两层（库出错）：坏了，原因里是库报的错', async () => {
    const failing = {
      select() {
        throw new Error('Failed query', {
          cause: new Error('relation "routing_purpose_models" does not exist'),
        });
      },
    } as unknown as Db;
    expect(await resolveJevBackend(failing, machine().at)).toEqual({
      state: 'broken',
      problem: '读不到路由两层里判断用途的路由：relation "routing_purpose_models" does not exist',
    });
  });

  it('钥匙文件不在、是空的：坏了，写明是哪条路由、哪个文件', async () => {
    const noKey = machine({ key: null });
    const missing = await resolveJevBackend(t.db, noKey.at);
    expect(missing.state).toBe('broken');
    expect(missing.state === 'broken' && missing.problem).toContain(`判断路由 ${JEV_ROUTE} 起不了后端`);
    expect(missing.state === 'broken' && missing.problem).toContain('读不到 TypeSafe 密钥文件');
    expect(missing.state === 'broken' && missing.problem).toContain(noKey.keyFile);
    const empty = await resolveJevBackend(t.db, machine({ key: '\n' }).at);
    expect(empty.state === 'broken' && empty.problem).toContain('TypeSafe 密钥文件是空的');
  });

  it('钥匙读到了、后端起不来：原因里没有钥匙的值（引擎日志、健康检查的日志都照抄这句）', async () => {
    // 真的 backendForRoute：读到钥匙以后在「测试里不许真调 TypeSafe」这一步拒，走的就是生产那条路。
    const setup = await resolveJevBackend(t.db, {
      ...machine().at,
      makeBackend: (r, c) => backendForRoute(r, c),
    });
    expect(setup.state).toBe('broken');
    expect(setup.state === 'broken' && setup.problem).toContain('测试里不许真调 TypeSafe');
    expect(JSON.stringify(setup)).not.toContain(KEY_VALUE);
  });
});

describe('/healthz 的 judge 项看什么', () => {
  const failed = (reason: 'network' | 'auth', detail: string): BackendResult => ({
    ok: false,
    reason,
    detail,
    latencyMs: 8,
  });
  const ask = (backend: JevBackend, iso: string) =>
    createJev({ db: t.db, backend, route: JEV_ROUTE, now: () => new Date(iso) }).ask(
      ERROR_NEXT,
      { step: '任务 t1 的 execute 阶段（会话失败）', message: 'socket hang up' },
      { subject: 'run:r1' },
    );

  it('配好了、还没调过：好', async () => {
    expect(await judgeHealth(t.db, { ...machine().at, makeBackend: fakeMake() })).toEqual({
      state: 'ok',
      routeId: JEV_ROUTE,
    });
  });

  it('最近一次真调用没成：报坏，带着原因和原文；下一次调成了自动好', async () => {
    const options = { ...machine().at, makeBackend: fakeMake() };
    await ask(
      fakeBackend(() => failed('network', 'ECONNRESET')),
      '2026-10-10T01:00:00Z',
    );
    const bad = await judgeHealth(t.db, options);
    expect(bad).toMatchObject({
      state: 'failing',
      call: { questionId: 'error-next', ok: false, reason: 'network', detail: 'ECONNRESET' },
    });
    await ask(
      fakeBackend(() => ok({ 'error-next': ['retry', 0.9] })),
      '2026-10-10T02:00:00Z',
    );
    expect(await judgeHealth(t.db, options)).toMatchObject({
      state: 'ok',
      routeId: JEV_ROUTE,
      call: { ok: true, reason: null },
    });
  });

  it('把握不够也算调通了（答了，只是不作数）', async () => {
    await ask(
      fakeBackend(() => ok({ 'error-next': ['retry', 0.2] })),
      '2026-10-10T01:00:00Z',
    );
    expect(await judgeHealth(t.db, { ...machine().at, makeBackend: fakeMake() })).toMatchObject({
      state: 'ok',
    });
  });

  it('本地就拦下、没发出去的（到了每日上限）不算调用：盖不住前面那次没成的', async () => {
    await ask(
      fakeBackend(() => failed('auth', 'HTTP 401')),
      '2026-10-10T01:00:00Z',
    );
    await t.db.insert(settings).values({ key: 'judge.dailyCallLimit', value: 0 });
    const capped = await ask(fakeBackend(), '2026-10-10T02:00:00Z');
    expect(capped).toMatchObject({ judged: false, reason: 'daily_cap' });
    const health = await judgeHealth(t.db, { ...machine().at, makeBackend: fakeMake() });
    expect(health).toMatchObject({ state: 'failing', call: { reason: 'auth' } });
  });

  it('配置起不来：照样报坏（不去看调用记录）', async () => {
    const h = await judgeHealth(t.db, { ...machine({ config: '[]' }).at, makeBackend: fakeMake() });
    expect(h).toEqual({ state: 'broken', problem: '配置要是一个 JSON 对象' });
  });

  it('查调用记录出错：抛出去（健康检查报「连不上」），不当成还没调过', async () => {
    const flaky = failingOnAnswers(
      t.db,
      new Error('Failed query', { cause: new Error('canceling statement') }),
    );
    await expect(judgeHealth(flaky, { ...machine().at, makeBackend: fakeMake() })).rejects.toThrow(
      'Failed query',
    );
    await expect(lastSentCall(t.db)).resolves.toBeUndefined();
  });
});

describe('判断记录里记下用的是哪条路由', () => {
  it('样本里带 route；没说就没有', async () => {
    const backend = fakeBackend();
    const withRoute = await createJev({ db: t.db, backend, route: JEV_ROUTE }).ask(
      ERROR_NEXT,
      { step: 's', message: 'm' },
      { subject: 'run:r1' },
    );
    const without = await createJev({ db: t.db, backend }).ask(
      ERROR_NEXT,
      { step: 's', message: 'm' },
      { subject: 'run:r2' },
    );
    const rows = await t.db.select().from(jevAnswers);
    const byId = new Map(rows.map((r) => [r.id, r.sample as { route?: string }]));
    expect(byId.get(withRoute.answerId ?? -1)?.route).toBe(JEV_ROUTE);
    expect(byId.get(without.answerId ?? -1)).not.toHaveProperty('route');
  });
});
