// fleet-api alert …（design 15.3「谁在处理」）：帅位经 ssh 看开着的提醒、跟进单、PR（不显示谁在处理、认领——#445 起只给
// 驾驶舱看，`alert claim` 也在这一版删掉了）、静默（不必带帅位任期，#445）。
// 参数不对不连库（退出码 2）；带了任期或创始人原话却核验没过退出码 3；连不上库退出码 1；--json 只打一行 JSON。
// 判法的边界表在 core 的 alert-work.test.ts，读写在 db 的 alert-work.test.ts；这里管命令这一层（真 Postgres：PGlite）。
import { upsertAlert } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AlertWorkPort, pgAlertWork } from '../src/alert-work.ts';
import { type CliDeps, main } from '../src/cli.ts';
import { devFixtures } from '../src/dev-fixtures.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { Store } from '../src/ports.ts';
import { seedPg } from './pg-fixtures.ts';

const T0 = new Date('2026-09-27T08:00:00.000Z');
const A = ['--machine', '本机', '--session', 'a1'];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => db.close());
beforeEach(async () => {
  await resetTestDb(db);
  await seedPg(db.db, devFixtures(T0));
});

function setup(over: { alerts?: AlertWorkPort; store?: Store } = {}) {
  const store = over.store ?? createPgStore(db.db);
  const alerts = over.alerts ?? pgAlertWork(db.db, () => null);
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet' },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    openStore: async () => {
      opened += 1;
      return { store, close: async () => {} };
    },
    openAlertWork: async () => {
      opened += 1;
      return { alerts, close: async () => {} };
    },
    openIssuePlans: async () => {
      throw new Error('alert 不该读 GitHub');
    },
    openTemporal: async () => {
      throw new Error('alert 不该连 Temporal');
    },
    openClaimsGitHub: async () => {
      throw new Error('alert 不该关引擎的 PR');
    },
    now: () => new Date(),
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
  return { run, json, opened: () => opened };
}

const taskless = () =>
  upsertAlert(db.db, {
    dedupeKey: 'watchdog:job:backup:after-12',
    level: 'alert',
    taskId: null,
    title: '定时任务「备份」没跑成',
    body: '最近一次没跑成：磁盘满了',
  });

describe('参数', () => {
  it('【故意造出的失败】参数不对：退出码 2、打用法，不连库；--json 时打一行 JSON', async () => {
    const t = setup();
    for (const args of [
      ['alert'],
      ['alert', 'nuke'],
      ['alert', 'unsilence', 'not-an-id', '--note', 'x', ...A],
      ['alert', 'unsilence', '00000000-0000-4000-8000-000000000000', ...A],
      ['alert', 'silences', 'extra'],
    ]) {
      const r = await t.run(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toContain('用法：fleet-api alert');
    }
    expect(t.opened()).toBe(0);
    expect(await t.json('alert', 'nuke')).toMatchObject({ code: 2, body: { ok: false, reason: 'usage' } });
  });

  it('【故意造出的失败】alert claim 已经删掉（#445）：认不出这条命令，退出码 2、不连库', async () => {
    const t = setup();
    const r = await t.run('alert', 'claim', 'k:1', ...A, '--term', '1', '--label', '工人A');
    expect(r.code).toBe(2);
    expect(r.err).toContain('没有 alert claim 这条命令');
    expect(t.opened()).toBe(0);
  });

  it('--help 只打用法、不连库', async () => {
    const t = setup();
    expect((await t.run('alert', '--help')).out).toContain('alert silence <键|编号>');
    expect((await t.run('alert', '--help')).out).not.toContain('alert claim');
    expect((await t.run('--help')).out).toContain('fleet-api alert <show|silence|unsilence|silences>');
    expect(t.opened()).toBe(0);
  });
});

describe('alert show：跟进单、PR，不显示谁在处理、认领（#445，只给驾驶舱看）', () => {
  it('开着的一条一行：级别、标题、键；不带谁在处理那一行，--json 也不带 handling', async () => {
    const t = setup();
    const a = await taskless();
    const r = await t.run('alert', 'show');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[卡住报警] 定时任务「备份」没跑成（watchdog:job:backup:after-12）');
    expect(r.out).not.toMatch(/没人在修|没人认领/);
    const j = await t.json('alert', 'show');
    expect(j.body.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: a.id, key: 'watchdog:job:backup:after-12' })]),
    );
    const row = (j.body.alerts as Record<string, unknown>[]).find((x) => x.id === a.id);
    expect(row).not.toHaveProperty('handling');
  });

  it('给了键只看那一条：跟进单、PR；不显示谁在处理、认领，也不再提「alert claim」', async () => {
    const t = setup();
    await taskless();
    const r = await t.run('alert', 'show', 'watchdog:job:backup:after-12');
    expect(r.code).toBe(0);
    expect(r.out).toContain('跟进单：没有');
    expect(r.out).not.toContain('处理：');
    expect(r.out).not.toContain('认领：');
    expect(r.out).not.toContain('alert claim');
    const j = await t.json('alert', 'show', 'watchdog:job:backup:after-12');
    expect(j.body).not.toHaveProperty('handling');
    expect(j.body).not.toHaveProperty('claim');
  });

  it('【故意造出的失败】认不出的键：退出码 2，写明没有这个键', async () => {
    const t = setup();
    const r = await t.run('alert', 'show', 'nope:1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('认不出提醒「nope:1」');
  });

  it('【故意造出的失败】读不到库：退出码 1、写明没做成，不当成「没有开着的提醒」', async () => {
    const broken: AlertWorkPort = {
      ...pgAlertWork(db.db, () => null),
      read: async () => {
        throw new Error('connection refused');
      },
    };
    const t = setup({ alerts: broken });
    await taskless();
    const r = await t.run('alert', 'show');
    expect(r.code).toBe(1);
    expect(r.err).toContain('没做成');
    expect(r.out).not.toContain('没有开着的提醒');
  });
});

describe('静默（Alertmanager 式：谁、为什么、必带到期）', () => {
  it('不带 --term（这一套本来就不必须，#445）：记是谁照样建；show <键> 显示「静默：」；撤了照常', async () => {
    const t = setup();
    await upsertAlert(db.db, {
      dedupeKey: 'pool-hold:claude-solo',
      level: 'alert',
      taskId: null,
      title: '账号池 claude-solo 整池暂停',
      body: '',
    });
    const s = await t.json(
      'alert',
      'silence',
      'pool-hold:claude-solo',
      '--until',
      '+3d',
      '--note',
      '创始人 09-27 晚拍：法国暂时不用独享号',
      ...A,
    );
    expect(s).toMatchObject({ code: 0, body: { ok: true, basis: '没带帅位任期，按 --note 记的人处理' } });
    const show = await t.run('alert', 'show', 'pool-hold:claude-solo');
    expect(show.out).toContain('静默：本机/a1：创始人 09-27 晚拍：法国暂时不用独享号');
    const id = (s.body.silence as { id: string }).id;
    expect((await t.run('alert', 'silences')).out).toContain(id);
    const un = await t.run('alert', 'unsilence', id, '--note', '恢复独享号了', ...A);
    expect(un.code).toBe(0);
    expect((await t.run('alert', 'show', 'pool-hold:claude-solo')).out).not.toContain('静默：');
  });

  it('#446：--term 给了也不再核对是不是真帅位了，只当一句参考记进静默；不带 --note 照旧拒绝', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    const base = ['alert', 'silence', '--prefix', 'watchdog:job:backup:', '--until', '2h', '--note', '换盘'];
    // 不带 --term：只记 --machine/--session 是谁
    const ok = await t.json(...base, '--machine', '笔记本', '--session', 'b1');
    expect(ok).toMatchObject({ code: 0, body: { ok: true, basis: '没带帅位任期，按 --note 记的人处理' } });
    // 带了 --term，但笔记本根本没接过班、不是真帅位：#446 起不核了，照样建得上，只是记进 basis
    const wrongTerm = await t.json(...base, '--machine', '笔记本', '--session', 'b1', '--term', '1');
    expect(wrongTerm).toMatchObject({
      code: 0,
      body: { ok: true, basis: '说自己是帅位第 1 任（#446 起不核，只记这句）' },
    });
    // 真帅位带对任期：同样只是记录，不是「核过了才放行」
    const rightTerm = await t.json(...base, ...A, '--term', '1');
    expect(rightTerm).toMatchObject({
      code: 0,
      body: { ok: true, basis: '说自己是帅位第 1 任（#446 起不核，只记这句）' },
    });
    // 不带 --term、也不带 --note：--note 这条要求没变，照旧拒绝
    const noNote = await t.run(
      'alert',
      'silence',
      '--prefix',
      'watchdog:job:',
      '--until',
      '2h',
      '--machine',
      '笔记本',
      '--session',
      'b1',
    );
    expect(noNote.code).toBe(2);
    expect(noNote.err).toContain('静默要带 --note');
  });

  it('【故意造出的失败】不带到期、超过 7 天、前缀太宽、没写为什么：退出码 2，什么都不建', async () => {
    const t = setup();
    for (const args of [
      ['--prefix', 'watchdog:job:', '--note', 'x'],
      ['--prefix', 'watchdog:job:', '--until', '+8d', '--note', 'x'],
      ['--prefix', 'w:', '--until', '+1h', '--note', 'x'],
      ['--prefix', 'watchdog:job:', '--until', '+1h'],
      ['--prefix', 'watchdog:job:', '--until', '明天', '--note', 'x'],
    ]) {
      const r = await t.run('alert', 'silence', ...args, ...A);
      expect(r.code, args.join(' ')).toBe(2);
    }
    expect((await t.run('alert', 'silences', '--all')).out).toBe('没有静默');
  });
});
