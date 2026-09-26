// fleet-api dispatch：「让 AI 接活」开关的运维命令。开、关、只看，每次改记一条操作记录、改完读回再打印；
// 没做成的每条路（参数不对、库里没这个仓、连不上库、写库出错、读回来对不上）都故意造一遍：退出码非 0，说清原因。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditLog, repos } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTO_DISPATCH_DISABLE,
  AUTO_DISPATCH_ENABLE,
  type CliDeps,
  CliError,
  describeDbError,
  main,
  operatorName,
  parseDispatchArgs,
} from '../src/cli.ts';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { createMemoryStore } from '../src/memory-store.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { Store } from '../src/ports.ts';
import { seedPg } from './pg-fixtures.ts';

const T0 = new Date('2026-09-26T07:00:00.000Z');
const LATER = new Date('2026-09-26T08:30:00.000Z');

/** 库连不上时 drizzle 给的错：外面一层「Failed query」带整句 SQL，驱动的错在 cause 里。 */
function refusedQuery(): Error {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  return new Error('Failed query: select "id", "owner" from "repos" where lower("owner") = lower($1)', {
    cause: refused,
  });
}

/** 每个方法都抛同一种错的 Store。 */
function failingStore(base: Store, err: () => unknown): Store {
  return new Proxy(base, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function'
        ? async () => {
            throw err();
          }
        : value;
    },
  });
}

function setup() {
  const clock = { now: new Date(T0) };
  const store = createMemoryStore(devFixtures(T0), { now: () => clock.now });
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  let closed = 0;
  const deps = (s: Store = store, env: CliDeps['env'] = {}): CliDeps => ({
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root', ...env },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    openStore: async (url) => {
      opened.push(url);
      return {
        store: s,
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  const run = (args: string[], s?: Store) => main(['dispatch', ...args], deps(s));
  const since = () => store.data.repos.find((r) => r.id === IDS.repo)?.autoDispatchSince;
  return { clock, store, out, err, opened, deps, run, since, closed: () => closed };
}

describe('参数', () => {
  it('恰好两个：owner/仓名，和 on、off、status 之一；别的写法一律拒（退出码 2），不猜', () => {
    for (const argv of [
      [],
      ['example/canary'],
      ['example/canary', 'on', 'now'],
      ['canary', 'on'],
      ['example/canary/x', 'on'],
      ['https://github.com/example/canary', 'on'],
      ['on', 'example/canary'],
      ['example/canary', 'ON'],
      ['example/canary', 'enable'],
      ['example/canary', '--force'],
      ['--repo=example/canary', 'on'],
    ]) {
      let caught: unknown;
      try {
        parseDispatchArgs(argv);
      } catch (e) {
        caught = e;
      }
      expect(caught, argv.join(' ')).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode, argv.join(' ')).toBe(2);
    }
    expect(parseDispatchArgs(['example/canary', 'on'])).toEqual({
      owner: 'example',
      name: 'canary',
      action: 'on',
    });
    expect(parseDispatchArgs(['Example-1/fleet.dao_x', 'status'])).toEqual({
      owner: 'Example-1',
      name: 'fleet.dao_x',
      action: 'status',
    });
  });

  it('参数不对：退出码 2、打印用法，不连库；没带库连接也是 2', async () => {
    const t = setup();
    expect(await t.run(['canary', 'on'])).toBe(2);
    expect(t.err.at(-1)).toContain('要写成 owner/仓名');
    expect(t.err.at(-1)).toContain('用法：fleet-api dispatch');
    expect(
      await main(['dispatch', 'example/canary', 'on'], t.deps(t.store, { DATABASE_URL: undefined })),
    ).toBe(2);
    expect(t.err.at(-1)).toContain('没有 DATABASE_URL');
    expect(t.opened).toEqual([]);
    expect(t.store.data.audit).toEqual([]);
  });
});

describe('开、关、只看', () => {
  it('status：关着就说关着，不改、不记，连接用完关掉', async () => {
    const t = setup();
    expect(await t.run(['example/canary', 'status'])).toBe(0);
    expect(t.out.join('\n')).toBe(
      'example/canary：让 AI 接活 关着（auto_dispatch_since 为空：只收单、显示，不派）\n操作记录里还没有开关它的记录',
    );
    expect(t.err).toEqual([]);
    expect(t.since()).toBeUndefined();
    expect(t.store.data.audit).toEqual([]);
    expect(t.closed()).toBe(1);
  });

  it('on：设成此刻，记一条操作记录（谁、什么时候、打开），从库里读回来打印；再 on 不重设时刻、不记', async () => {
    const t = setup();
    expect(await t.run(['example/canary', 'on'])).toBe(0);
    const since = T0.toISOString();
    expect(t.since()).toBe(since);
    expect(t.store.data.audit).toHaveLength(1);
    const entry = t.store.data.audit[0];
    expect(entry).toMatchObject({
      at: since,
      actor: { kind: 'engine', id: 'ops:dispatch' },
      action: AUTO_DISPATCH_ENABLE,
      target: `repo:${IDS.repo}`,
      via: 'engine',
      ok: true,
      before: { autoDispatchSince: null },
      after: { autoDispatchSince: since },
      reason: '服务器上 root 跑的 fleet-api dispatch example/canary on',
    });
    expect(t.out.at(-1)).toBe(
      `已打开：example/canary：让 AI 接活 开着，自 ${since} 起（这之后新开的 issue 自动派；这之前就开着的不自动派，要人点「交给 fleet」）\n` +
        `最近一次开关：${since} 打开，服务器上 root 跑的 fleet-api dispatch example/canary on（操作记录 ${entry?.id}）`,
    );

    t.clock.now = LATER;
    expect(await t.run(['example/canary', 'on'])).toBe(0);
    expect(t.out.at(-1)).toBe(`没改：example/canary 本来就开着，自 ${since} 起（再开不重设时刻）`);
    expect(t.since()).toBe(since);
    expect(t.store.data.audit).toHaveLength(1);

    // 仓名不分大小写，打印用库里的写法；看得到是谁、什么时候打开的
    expect(await t.run(['EXAMPLE/Canary', 'status'])).toBe(0);
    expect(t.out.at(-1)).toContain(`example/canary：让 AI 接活 开着，自 ${since} 起`);
    expect(t.out.at(-1)).toContain(`最近一次开关：${since} 打开，服务器上 root 跑的`);
  });

  it('off：设为空，操作记录记下原来的时刻；再 off 不记', async () => {
    const t = setup();
    await t.run(['example/canary', 'on']);
    const since = T0.toISOString();
    t.clock.now = LATER;
    expect(await t.run(['example/canary', 'off'])).toBe(0);
    expect(t.since()).toBeUndefined();
    const entry = t.store.data.audit.at(-1);
    expect(entry).toMatchObject({
      at: LATER.toISOString(),
      action: AUTO_DISPATCH_DISABLE,
      before: { autoDispatchSince: since },
      after: { autoDispatchSince: null },
      reason: '服务器上 root 跑的 fleet-api dispatch example/canary off',
    });
    expect(t.out.at(-1)).toContain('已关上：example/canary：让 AI 接活 关着');
    expect(t.out.at(-1)).toContain(`最近一次开关：${LATER.toISOString()} 关上`);
    expect(await t.run(['example/canary', 'off'])).toBe(0);
    expect(t.out.at(-1)).toBe('没改：example/canary 本来就关着');
    expect(t.store.data.audit).toHaveLength(2);
  });

  it('status：最近那一页里没有开关记录、后面还有没翻的，照实说没翻，不说成「从没开关过」', async () => {
    const t = setup();
    for (let i = 0; i < 51; i++)
      await t.store.appendAudit({
        actor: { kind: 'user', id: IDS.founderA },
        action: 'repo.rename',
        target: `repo:${IDS.repo}`,
        via: 'cockpit',
        ok: true,
      });
    expect(await t.run(['example/canary', 'status'])).toBe(0);
    expect(t.out.at(-1)).toContain('最近 50 条和它有关的操作记录里没有开关它的（更早的没翻）');
  });

  it('读和改之间被别处改成了要的样子：不再改、不记，照实说', async () => {
    const t = setup();
    // 读的时候还关着，写的时候别处已经打开了
    const racing: Store = {
      ...t.store,
      findRepoByName: async (owner, name) => {
        const repo = await t.store.findRepoByName(owner, name);
        return repo && { ...repo, autoDispatchSince: null };
      },
    };
    await t.run(['example/canary', 'on']);
    t.clock.now = LATER;
    expect(await t.run(['example/canary', 'on'], racing)).toBe(0);
    expect(t.out.at(-1)).toBe(`没改：example/canary 刚被别处改成了开着，自 ${T0.toISOString()} 起`);
    expect(t.store.data.audit).toHaveLength(1);
  });
});

describe('接在真库上（PGlite 跑真迁移）', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => db.close());

  it('status → on → off：开关写进接活读的那一列，操作记录进 audit_log，都从库里读回来打印', async () => {
    await resetTestDb(db);
    await seedPg(db.db, devFixtures(T0));
    let now = T0;
    const store = createPgStore(db.db, { now: () => now });
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      openStore: async () => ({ store, close: async () => {} }),
    };
    const since = async () => (await db.db.select({ since: repos.autoDispatchSince }).from(repos))[0]?.since;
    const audits = () =>
      db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.target, `repo:${IDS.repo}`));

    expect(await main(['dispatch', 'example/canary', 'status'], deps)).toBe(0);
    expect(out.at(-1)).toContain('example/canary：让 AI 接活 关着');

    expect(await main(['dispatch', 'example/canary', 'on'], deps)).toBe(0);
    expect((await since())?.toISOString()).toBe(T0.toISOString());
    const [opened] = await audits();
    expect(opened).toMatchObject({
      actorKind: 'engine',
      actorId: 'ops:dispatch',
      action: AUTO_DISPATCH_ENABLE,
      via: 'engine',
      ok: true,
      reason: '服务器上 root 跑的 fleet-api dispatch example/canary on',
    });
    expect(out.at(-1)).toContain(`已打开：example/canary：让 AI 接活 开着，自 ${T0.toISOString()} 起`);
    expect(out.at(-1)).toContain(`（操作记录 ${opened?.id}）`);

    now = LATER;
    expect(await main(['dispatch', 'example/canary', 'off'], deps)).toBe(0);
    expect(await since()).toBeNull();
    expect((await audits()).map((a) => a.action).sort()).toEqual([
      AUTO_DISPATCH_DISABLE,
      AUTO_DISPATCH_ENABLE,
    ]);
    expect(out.at(-1)).toContain(`已关上：example/canary：让 AI 接活 关着`);
    expect(out.at(-1)).toContain(`最近一次开关：${LATER.toISOString()} 关上`);
    expect(err).toEqual([]);
  });
});

describe('没做成的路：退出码非 0，说清原因', () => {
  it('库里没这个仓：退出码 1，开、关、看都一样，什么都不改', async () => {
    const t = setup();
    for (const action of ['on', 'off', 'status'])
      expect(await t.run(['example/nope', action]), action).toBe(1);
    expect(t.err).toEqual([
      '没改成（什么都没改）：库里没有仓 example/nope（受管的仓就是 repos 表的行，见 docs/ops.md 第九节）',
      '没改成（什么都没改）：库里没有仓 example/nope（受管的仓就是 repos 表的行，见 docs/ops.md 第九节）',
      '没查成：库里没有仓 example/nope（受管的仓就是 repos 表的行，见 docs/ops.md 第九节）',
    ]);
    expect(t.out).toEqual([]);
    expect(t.store.data.audit).toEqual([]);
    expect(t.closed()).toBe(3);
  });

  it('连不上库：退出码 1，说「连不上库」和驱动给的原因，不把 SQL 打出来', async () => {
    const t = setup();
    const down = failingStore(t.store, refusedQuery);
    expect(await t.run(['example/canary', 'status'], down)).toBe(1);
    expect(await t.run(['example/canary', 'on'], down)).toBe(1);
    expect(t.err).toEqual([
      '没查成：连不上库（connect ECONNREFUSED 127.0.0.1:5432）',
      '没改成（什么都没改）：连不上库（connect ECONNREFUSED 127.0.0.1:5432）',
    ]);
    expect(t.out).toEqual([]);
    expect(t.closed()).toBe(2);
  });

  it('写库出错：退出码 1，说清开关和操作记录一起没改、怎么核对', async () => {
    const t = setup();
    const broken: Store = {
      ...t.store,
      setAutoDispatch: async () => {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      },
    };
    expect(await t.run(['example/canary', 'on'], broken)).toBe(1);
    expect(t.err.at(-1)).toBe(
      '没改成：写库时库出错（57014：canceling statement due to statement timeout）。开关和操作记录在同一个事务里，要么都改了、要么都没改：跑 status 看现在是哪样',
    );
    expect(t.since()).toBeUndefined();
  });

  it('写的时候仓没了：退出码 1', async () => {
    const t = setup();
    const gone: Store = { ...t.store, setAutoDispatch: async () => 'not_found' };
    expect(await t.run(['example/canary', 'on'], gone)).toBe(1);
    expect(t.err.at(-1)).toBe('没改成：仓 example/canary 刚刚不在库里了，什么都没改');
  });

  it('读回来的开关和刚写的对不上：退出码 1，说清改了什么、读回来是什么', async () => {
    const t = setup();
    let reads = 0;
    const stale: Store = {
      ...t.store,
      findRepoByName: async (owner, name) => {
        reads += 1;
        const repo = await t.store.findRepoByName(owner, name);
        return reads === 1 ? repo : repo && { ...repo, autoDispatchSince: null };
      },
    };
    expect(await t.run(['example/canary', 'on'], stale)).toBe(1);
    const id = t.store.data.audit.at(-1)?.id;
    expect(t.err.at(-1)).toBe(
      `已经改成「开着，自 ${T0.toISOString()} 起」（操作记录 ${id}），但读回来是「关着」，对不上：多半刚被别处改过，跑 status 核对`,
    );
    expect(t.out).toEqual([]);
  });

  it('读回时找不到刚记的操作记录、读回时连不上库：退出码 1', async () => {
    const t = setup();
    const noAudit: Store = { ...t.store, listAudit: async () => ({ items: [] }) };
    expect(await t.run(['example/canary', 'on'], noAudit)).toBe(1);
    expect(t.err.at(-1)).toMatch(
      /^已经改成「开着，自 .+ 起」（操作记录 \d+），但读回时库里找不到这条操作记录：跑 status 核对$/,
    );

    await t.run(['example/canary', 'off']);
    let reads = 0;
    const dropped: Store = {
      ...t.store,
      findRepoByName: async (owner, name) => {
        reads += 1;
        if (reads > 1) throw refusedQuery();
        return t.store.findRepoByName(owner, name);
      },
    };
    expect(await t.run(['example/canary', 'on'], dropped)).toBe(1);
    expect(t.err.at(-1)).toMatch(
      /^已经改成「开着，自 .+ 起」（操作记录 \d+），但读回开关时连不上库（connect ECONNREFUSED 127\.0\.0\.1:5432）：跑 status 核对$/,
    );
  });
});

describe('库的错误说成白话', () => {
  it('取最里面那层原因；连不上的说连不上，别的说库出错；原因是空的也不拿空冒充', () => {
    expect(describeDbError(refusedQuery())).toBe('连不上库（connect ECONNREFUSED 127.0.0.1:5432）');
    // 本机 socket 不在：postgres.js 报 ENOENT
    expect(
      describeDbError(
        Object.assign(new Error('connect ENOENT /var/run/postgresql/.s.PGSQL.5432'), { code: 'ENOENT' }),
      ),
    ).toBe('连不上库（connect ENOENT /var/run/postgresql/.s.PGSQL.5432）');
    // IPv4、IPv6 都连不上：AggregateError 的 message 是空的
    const both = Object.assign(
      new AggregateError(
        [new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );
    expect(describeDbError(new Error('Failed query: select 1', { cause: both }))).toBe(
      '连不上库（connect ECONNREFUSED ::1:5432；connect ECONNREFUSED 127.0.0.1:5432）',
    );
    expect(describeDbError(Object.assign(new Error('role "fleet" does not exist'), { code: '28000' }))).toBe(
      '连不上库（28000：role "fleet" does not exist）',
    );
    expect(
      describeDbError(Object.assign(new Error('relation "repos" does not exist'), { code: '42P01' })),
    ).toBe('库出错（42P01：relation "repos" does not exist）');
    expect(describeDbError(new Error(''))).toBe('库出错（没说原因）');
    expect(describeDbError('断了')).toBe('库出错（断了）');
  });

  it('谁跑的：bin/fleet-api 传来的名字；没传就记本进程的用户并写明', () => {
    expect(operatorName({ FLEET_OPS_OPERATOR: 'alice' })).toBe('alice');
    expect(operatorName({ FLEET_OPS_OPERATOR: '  ' })).toContain('没经 bin/fleet-api');
    expect(operatorName({})).toContain('没经 bin/fleet-api');
  });
});

describe('命令行入口（真起一个 node 进程）', () => {
  const bin = fileURLToPath(new URL('../src/bin/fleet-api.ts', import.meta.url));
  const exec = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env };
    delete base.DATABASE_URL;
    return spawnSync(process.execPath, [bin, ...args], {
      env: { ...base, ...env },
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
    });
  };
  // 本机 1 号端口没人听：连接当场被拒，和法国上 Postgres 停了、socket 不在一样是「连不上库」
  const REFUSED_DB = 'postgres://fleet@127.0.0.1:1/fleet';

  it('参数不对、没带库连接：退出码 2，不连库', () => {
    const bad = exec(['dispatch', 'canary', 'on'], { DATABASE_URL: REFUSED_DB });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('要写成 owner/仓名');
    const noDb = exec(['dispatch', 'example/canary', 'status']);
    expect(noDb.status).toBe(2);
    expect(noDb.stderr).toContain('DATABASE_URL');
    const unknown = exec(['dispatch-everything']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('fleet-api dispatch <owner/仓名> on|off|status');
  });

  it('库连不上：退出码 1，说「连不上库」和原因，不把 SQL 打出来', () => {
    for (const [action, lead] of [
      ['status', '没查成：'],
      ['on', '没改成（什么都没改）：'],
    ] as const) {
      const r = exec(['dispatch', 'example/canary', action], { DATABASE_URL: REFUSED_DB });
      expect(r.status, action).toBe(1);
      expect(r.stderr, action).toContain(`${lead}连不上库（`);
      expect(r.stderr, action).toContain('ECONNREFUSED');
      expect(r.stderr, action).not.toContain('Failed query');
      expect(r.stdout, action).toBe('');
    }
  });
});
