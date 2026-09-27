// fleet-api seat …、fleet-api claim …（#299 帅位只一个，specs/299-帅位只一个/方案.md 第三节）：本机经 ssh 调的那几条命令。
// 参数不对不连库（退出码 2）；不是帅位、别人拿着、认领号对不上退出码 3；连不上库退出码 1；带 --json 只打一行 JSON 给脚本读。
// 判法、存取的边界表在 core 的 seat.test.ts、db 的 seat.test.ts 和 Store 契约（store-contract-seat.ts）；这里管命令这一层。
import { fileURLToPath } from 'node:url';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';
import { devFixtures } from '../src/dev-fixtures.ts';
import { createMemoryStore } from '../src/memory-store.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { Store } from '../src/ports.ts';
import { runChild } from './child.ts';
import { seedPg } from './pg-fixtures.ts';

const T0 = new Date('2026-09-27T08:00:00.000Z');
const REPO = 'example/canary';

function setup(base?: Store) {
  const clock = { now: new Date(T0) };
  const memory = createMemoryStore(devFixtures(T0), { now: () => clock.now });
  const store = base ?? memory;
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  let stdin = '';
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet' },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    openStore: async () => {
      opened += 1;
      return { store, close: async () => {} };
    },
    openIssuePlans: async () => {
      throw new Error('seat、claim 不该读 GitHub');
    },
    openTemporal: async () => {
      throw new Error('seat、claim 不该连 Temporal');
    },
    now: () => clock.now,
    readStdin: async () => stdin,
  };
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(args, deps);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const json = async (...args: string[]) => {
    const r = await run(...args, '--json');
    return { code: r.code, body: JSON.parse(r.out) as Record<string, unknown> };
  };
  return {
    memory,
    clock,
    run,
    json,
    opened: () => opened,
    setStdin: (text: string) => {
      stdin = text;
    },
    tick: (minutes: number) => {
      clock.now = new Date(clock.now.getTime() + minutes * 60_000);
    },
  };
}

const A = ['--machine', '本机', '--session', 'a1'];
const B = ['--machine', '笔记本', '--session', 'b1'];

describe('参数', () => {
  it('【故意造出的失败】参数不对：退出码 2、打用法，不连库；--json 时打一行 JSON', async () => {
    const t = setup();
    for (const args of [
      ['seat'],
      ['seat', 'grab'],
      ['seat', 'take'],
      ['seat', 'take', '--machine', '本机'],
      ['seat', 'take', ...A, '--scope', 'prod'],
      ['seat', 'check', ...A, '--term', 'x'],
      ['seat', 'take', ...A, '--machine', '又一个'],
      ['seat', 'take', '--machine', 'a b', '--session', 's'],
      ['claim', 'take', 'canary', '1', ...A, '--term', '1', '--label', 'w'],
      ['claim', 'take', REPO, '1', ...A, '--term', '1'],
      ['claim', 'take', REPO, '1', ...A, '--term', '1', '--label', 'w', '--owner', 'engine'],
      ['claim', 'step', REPO, '1', '--claim', 'abc'],
      ['claim', 'done', REPO, '1', '--claim', '00000000-0000-4000-8000-000000000000'],
      ['claim', 'step', REPO, '1', '--claim', '00000000-0000-4000-8000-000000000000', '--pr', '0'],
      ['claim', 'show'],
      ['claim', 'nuke'],
    ]) {
      const r = await t.run(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toContain('用法：fleet-api');
    }
    expect(t.opened()).toBe(0);
    const j = await t.json('seat', 'take');
    expect(j).toMatchObject({ code: 2, body: { ok: false, reason: 'usage' } });
  });

  it('--help 只打用法、不连库', async () => {
    const t = setup();
    expect((await t.run('seat', '--help')).out).toContain('seat take --machine');
    expect((await t.run('claim', '--help')).out).toContain('claim take <owner/仓名> <单号>');
    expect((await t.run('--help')).out).toContain('fleet-api seat <take|renew|check|show|handoff>');
    expect(t.opened()).toBe(0);
  });
});

describe('帅位', () => {
  it('接班、续约、现查：打新任期和上一任；--json 带任期、持有人、租约到几点（库的时钟）', async () => {
    const t = setup();
    const took = await t.run('seat', 'take', ...A);
    expect(took.code).toBe(0);
    expect(took.out).toContain('接班了：main 第 1 任是 本机/a1；座位原来没人');
    const second = await t.json('seat', 'take', ...B);
    expect(second).toMatchObject({
      code: 0,
      body: {
        ok: true,
        seat: {
          term: 2,
          holder: { machine: '笔记本', session: 'b1' },
          previous: { machine: '本机', session: 'a1' },
        },
        leaseMinutes: 45,
      },
    });
    expect(await t.json('seat', 'renew', ...B, '--term', '2')).toMatchObject({ code: 0, body: { ok: true } });
    expect(await t.json('seat', 'check', ...B, '--term', '2')).toMatchObject({
      code: 0,
      body: { ok: true, term: 2, expiresAt: new Date(T0.getTime() + 45 * 60_000).toISOString() },
    });
  });

  it('【故意造出的失败】旧帅位：续约、现查都说「不是帅位」、写明现在是谁，退出码 3', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    await t.run('seat', 'take', ...B);
    const renew = await t.run('seat', 'renew', ...A, '--term', '1');
    expect(renew.code).toBe(3);
    expect(renew.out).toContain('帅位已经是 笔记本/b1（第 2 任）');
    expect(renew.out).toContain('只回「我已退役，帅位在 笔记本/b1」');
    const check = await t.json('seat', 'check', ...A, '--term', '1');
    expect(check).toMatchObject({ code: 3, body: { ok: false, reason: 'replaced' } });
  });

  it('【故意造出的失败】过了租期没续上：现查说不是帅位（fail closed）；续上以后又是', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    t.tick(46);
    expect(await t.json('seat', 'check', ...A, '--term', '1')).toMatchObject({
      code: 3,
      body: { ok: false, reason: 'expired' },
    });
    expect((await t.run('seat', 'renew', ...A, '--term', '1')).code).toBe(0);
    expect((await t.run('seat', 'check', ...A, '--term', '1')).code).toBe(0);
  });

  it('看现状：帅位、在做的认领、引擎在跑的单、没答的提问、交接说明；座位上没人也照打', async () => {
    const t = setup();
    expect((await t.run('seat', 'show')).out).toContain('帅位（main）：座位上没人');
    await t.run('seat', 'take', ...A);
    await t.run('claim', 'take', REPO, '40', ...A, '--term', '1', '--label', '工人甲', '--note', '开工');
    t.setStdin('在做 #299\n等创始人拍 App 权限');
    expect((await t.run('seat', 'handoff', ...A, '--term', '1')).code).toBe(0);
    const show = await t.run('seat', 'show');
    expect(show.out).toContain('帅位（main）：第 1 任 本机/a1');
    expect(show.out).toContain('在做的认领（1）：');
    expect(show.out).toContain('example/canary#40 本机/工人甲 认领了：开工');
    expect(show.out).toContain('引擎在跑的单（1）：');
    expect(show.out).toContain('example/canary#12 running');
    expect(show.out).toContain('最新一份交接说明');
    expect(show.out).toContain('等创始人拍 App 权限');
    const j = await t.json('seat', 'show');
    expect(j.body).toMatchObject({
      seat: { term: 1 },
      claims: [{ repo: REPO, issue: 40, owner: { kind: 'worker', label: '工人甲' }, state: 'claimed' }],
    });
  });

  it('【故意造出的失败】交接说明：空的拒（退出码 2）；不是现任、也不是刚被换下的上一任写不进（退出码 3）', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    t.setStdin('   ');
    expect((await t.run('seat', 'handoff', ...A, '--term', '1')).code).toBe(2);
    t.setStdin('冒名');
    expect((await t.run('seat', 'handoff', ...B, '--term', '1')).code).toBe(3);
  });
});

describe('认领', () => {
  const take = (
    t: ReturnType<typeof setup>,
    issue: string,
    who = A,
    term = '1',
    label = '工人甲',
    ...more: string[]
  ) => t.json('claim', 'take', REPO, issue, ...who, '--term', term, '--label', label, ...more);

  it('帅位认领、工人报一步、登记 PR、做完：每步都读回打出来；--json 带认领号', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    const got = await take(t, '40', A, '1', '工人甲', '--note', '开工');
    expect(got).toMatchObject({
      code: 0,
      body: { ok: true, claim: { repo: REPO, issue: 40, state: 'claimed', graceMinutes: 120 } },
    });
    const claimId = (got.body.claim as { claimId: string }).claimId;
    expect(
      (await t.run('claim', 'step', REPO, '40', '--claim', claimId, '--note', '在写测试')).out,
    ).toContain('example/canary#40：本机/工人甲 在做');
    expect((await t.run('claim', 'step', REPO, '40', '--claim', claimId, '--pr', '306')).out).toContain(
      '登记了 PR #306',
    );
    const done = await t.json('claim', 'done', REPO, '40', '--claim', claimId, '--note', 'PR #306 合了');
    expect(done).toMatchObject({ code: 0, body: { ok: true, claim: { state: 'done', prs: [306] } } });
  });

  it('【故意造出的失败】旧任期号来认领被拒（退出码 3），单子一点没动', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    await t.run('seat', 'take', ...B);
    const r = await take(t, '41');
    expect(r).toMatchObject({ code: 3, body: { ok: false, reason: 'not_seat' } });
    expect((await t.json('claim', 'show', REPO, '41', '--all')).body).toMatchObject({
      claims: [],
      missing: [41],
    });
  });

  it('【故意造出的失败】别人拿着：认领不上（退出码 3），写清谁拿着', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    await take(t, '42');
    const r = await t.run('claim', 'take', REPO, '42', ...A, '--term', '1', '--label', '工人乙');
    expect(r.code).toBe(3);
    expect(r.out).toContain('没认领上：example/canary#42 本机/工人甲 认领了');
  });

  it('【故意造出的失败】拿着作废了的认领号来报进度：没记上（退出码 3），说这张已经不归你', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    const got = await take(t, '43', A, '1', '工人甲', '--grace-minutes', '2');
    const claimId = (got.body.claim as { claimId: string }).claimId;
    t.tick(3);
    const swept = await t.run('claim', 'sweep');
    expect(swept.out).toContain('作废了 1 张');
    expect(swept.out).toContain('example/canary#43 本机/工人甲 作废了（过了宽限期（2 分钟）没心跳）');
    const back = await t.run('claim', 'step', REPO, '43', '--claim', claimId, '--note', '我回来了');
    expect(back.code).toBe(3);
    expect(back.out).toContain('这张已经不归你');
    expect((await t.run('claim', 'sweep')).out).toBe('没有过了宽限期没心跳的认领');
  });

  it('【故意造出的失败】库里没有这个仓：说清认领只管导入过的项目（退出码 1）', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    const r = await t.run('claim', 'take', 'someone/else', '1', ...A, '--term', '1', '--label', 'w');
    expect(r.code).toBe(1);
    expect(r.err).toContain('库里没有仓 someone/else');
  });

  it('演练：引擎那一边（--owner engine）只在演练座位下能抢，记在演练座位名下、待起、不起工作流；和本机抢只一边拿到', async () => {
    const t = setup();
    const engine = await t.json('claim', 'take', REPO, '60', '--owner', 'engine', '--scope', 'drill:299');
    expect(engine.code).toBe(0);
    expect(engine.body).toMatchObject({
      ok: true,
      fresh: true,
      claim: { owner: { kind: 'engine' }, seat: { scope: 'drill:299', term: 0 }, state: 'pending_start' },
    });
    await t.run('seat', 'take', ...A, '--scope', 'drill:299');
    const local = await t.run(
      'claim',
      'take',
      REPO,
      '60',
      ...A,
      '--term',
      '1',
      '--scope',
      'drill:299',
      '--label',
      'w1',
    );
    expect(local.code).toBe(3);
    expect(local.out).toContain('引擎 待起');
    // 待起补起不碰演练的
    t.tick(10);
    expect((await t.memory.listStalePendingEngineClaims({ minutes: 5, limit: 10 })).claims).toEqual([]);
    // 本机先拿到的，引擎那一边抢不到
    await t.run('claim', 'take', REPO, '61', ...A, '--term', '1', '--scope', 'drill:299', '--label', 'w1');
    expect((await t.run('claim', 'take', REPO, '61', '--owner', 'engine', '--scope', 'drill:299')).code).toBe(
      3,
    );
  });

  it('【故意造出的失败】--owner engine 不在演练座位下、带了帅位身份：参数不对（退出码 2），不连库', async () => {
    const t = setup();
    const main = await t.run('claim', 'take', REPO, '60', '--owner', 'engine');
    expect(main.code).toBe(2);
    expect(main.err).toContain('--owner engine 只在演练座位');
    expect(
      (await t.run('claim', 'take', REPO, '60', '--owner', 'engine', '--scope', 'drill:299', ...A)).code,
    ).toBe(2);
    expect(t.opened()).toBe(0);
  });
});

describe('接在真库上（PGlite 跑真迁移）', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => db.close());

  it('接班、认领、换班后工人照旧报进度、旧帅位认领被拒：和内存版一样', async () => {
    await resetTestDb(db);
    await seedPg(db.db, devFixtures(T0));
    const t = setup(createPgStore(db.db));
    expect((await t.run('seat', 'take', ...A)).code).toBe(0);
    const got = await take2(t);
    const claimId = (got.body.claim as { claimId: string }).claimId;
    expect((await t.run('seat', 'take', ...B)).code).toBe(0);
    expect(
      (await t.run('claim', 'step', REPO, '44', '--claim', claimId, '--note', '换班后接着做')).code,
    ).toBe(0);
    expect((await t.run('claim', 'take', REPO, '45', ...A, '--term', '1', '--label', '工人乙')).code).toBe(3);
    expect((await t.json('seat', 'check', ...B, '--term', '2')).code).toBe(0);
  });

  const take2 = (t: ReturnType<typeof setup>) =>
    t.json('claim', 'take', REPO, '44', ...A, '--term', '1', '--label', '工人甲');
});

// 同步起 node：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 child.ts 开头）。
describe('命令行入口（真起一个 node 进程）', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/fleet-api.ts', import.meta.url));
  const exec = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env };
    delete base.DATABASE_URL;
    return runChild(process.execPath, [bin, ...args], { env: { ...base, ...env } });
  };
  const REFUSED_DB = 'postgres://fleet@127.0.0.1:1/fleet';

  it('【故意造出的失败】连不上库（法国的库停了）：退出码 1，--json 打一行没查成，本机脚本按「不是帅位」算', () => {
    const r = exec(['seat', 'check', ...A, '--term', '1', '--json'], { DATABASE_URL: REFUSED_DB });
    expect(r.status).toBe(1);
    const body = JSON.parse(r.stdout) as { ok: boolean; reason: string; why: string };
    expect(body).toMatchObject({ ok: false, reason: 'error' });
    expect(body.why).toContain('连不上库');
    const human = exec(['claim', 'show', REPO], { DATABASE_URL: REFUSED_DB });
    expect(human.status).toBe(1);
    expect(human.stderr).toContain('连不上库');
  });

  it('参数不对：退出码 2，不连库', () => {
    const r = exec(['seat', 'take'], { DATABASE_URL: REFUSED_DB });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('要带 --machine');
  });
});
