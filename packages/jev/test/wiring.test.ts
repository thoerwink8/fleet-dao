// 本机的判断题接没接、接了用哪个后端、调不调得通（wiring.ts）：引擎每次提问和 /healthz 的 judge 项都走这一份。
// 「未接」只有默认位置上没有配置文件一种；别的读不成都要报坏（不许当成没配悄悄不问），每条都故意造一次。
// 库里的目录照仓里的样例装（deploy/examples/catalog.example.json）：判断阶段排第一的是 TypeSafe 那条，两条 Claude 关着。
import type { Stats } from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Db,
  jevAnswers,
  loadCatalog,
  parseCatalog,
  seed,
  settings,
  stagePolicyRoutes,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendResult, JevBackend } from '../src/backend.ts';
import { ERROR_NEXT, STALL_STATE } from '../src/bank.ts';
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
});

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

describe('按配置和调度台现找后端', () => {
  it('配好了：用判断阶段排第一、开着的那条路由（插头发给上游的型号）起后端', async () => {
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

  it('判断阶段一条开着的路由都没有：坏了，不当成判断通过', async () => {
    await t.db.update(stagePolicyRoutes).set({ enabled: false }).where(eq(stagePolicyRoutes.stage, 'judge'));
    expect(await resolveJevBackend(t.db, { ...machine().at, makeBackend: fakeMake() })).toEqual({
      state: 'broken',
      problem: '调度台的判断阶段没有开着的路由',
    });
  });

  it('驾驶舱改了顺序、开关，下一次就按新的走：Claude 那条排到第一、打开，接不了就明说', async () => {
    const claude = 'claude-solo:opus-5.5:claude-code';
    const at = machine().at;
    expect(await resolveJevBackend(t.db, { ...at, makeBackend: fakeMake() })).toMatchObject({
      state: 'ready',
      routeId: JEV_ROUTE,
    });
    // 同一阶段里位置不许重（唯一约束逐条查）：先把 TypeSafe 那条挪开，再把 Claude 那条放到第一。
    const move = (routeId: string, set: { position: number; enabled?: boolean }) =>
      t.db
        .update(stagePolicyRoutes)
        .set(set)
        .where(and(eq(stagePolicyRoutes.stage, 'judge'), eq(stagePolicyRoutes.routeId, routeId)));
    await move(JEV_ROUTE, { position: 9 });
    await move(claude, { position: 0, enabled: true });
    await move(JEV_ROUTE, { position: 1 });
    const setup = await resolveJevBackend(t.db, at);
    expect(setup.state).toBe('broken');
    expect(setup.state === 'broken' && setup.problem).toContain(`判断路由 ${claude} 起不了后端`);
    expect(setup.state === 'broken' && setup.problem).toContain(CLAUDE_ROUTE_CLOSED);
  });

  it('读不到判断阶段的路由（库出错）：坏了，原因里是库报的错', async () => {
    const failing = {
      select() {
        throw new Error('Failed query', { cause: new Error('relation "routes" does not exist') });
      },
    } as unknown as Db;
    expect(await resolveJevBackend(failing, machine().at)).toEqual({
      state: 'broken',
      problem: '读不到判断阶段的路由：relation "routes" does not exist',
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

  it('考试也是真调用：巡检考题答上了一样算调通', async () => {
    await ask(
      fakeBackend(() => failed('network', 'ECONNRESET')),
      '2026-10-10T01:00:00Z',
    );
    await createJev({ db: t.db, backend: fakeBackend(), now: () => new Date('2026-10-10T03:00:00Z') }).exam(
      [STALL_STATE],
      { task: '写码', recent: '反复跑同一条测试' },
      { runId: 'exam-1', sampleId: 's1', expect: { 'stall-state': 'looping' } },
    );
    expect(await judgeHealth(t.db, { ...machine().at, makeBackend: fakeMake() })).toMatchObject({
      state: 'ok',
    });
  });

  it('配置起不来：照样报坏（不去看调用记录）', async () => {
    const h = await judgeHealth(t.db, { ...machine({ config: '[]' }).at, makeBackend: fakeMake() });
    expect(h).toEqual({ state: 'broken', problem: '配置要是一个 JSON 对象' });
  });

  it('查调用记录出错：抛出去（健康检查报「连不上」），不当成还没调过', async () => {
    const real = t.db;
    let calls = 0;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        // 第一次 select 是查判断路由，放行；第二次是查调用记录，让它出错。
        if (prop === 'select') {
          calls += 1;
          if (calls === 2) throw new Error('Failed query', { cause: new Error('canceling statement') });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
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
