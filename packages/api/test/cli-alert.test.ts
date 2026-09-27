// fleet-api alert …（design 15.3「谁在处理」）：帅位经 ssh 看提醒谁在处理、认领提醒（认领它的跟进单，就是 #299 的认领）、静默。
// 参数不对不连库（退出码 2）；不是帅位、跟进单在别人手里、提醒撤了退出码 3；连不上库退出码 1；--json 只打一行 JSON。
// 判法的边界表在 core 的 alert-work.test.ts，读写在 db 的 alert-work.test.ts；这里管命令这一层（真 Postgres：PGlite）。
import { resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AlertWorkPort, pgAlertWork } from '../src/alert-work.ts';
import { type CliDeps, main } from '../src/cli.ts';
import { devFixtures } from '../src/dev-fixtures.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { Store } from '../src/ports.ts';
import { seedPg } from './pg-fixtures.ts';

const T0 = new Date('2026-09-27T08:00:00.000Z');
const REPO = 'example/canary';
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
      ['alert', 'claim'],
      ['alert', 'claim', 'k:1', '--machine', '本机'],
      ['alert', 'claim', 'k:1', ...A, '--term', 'x', '--label', 'w'],
      ['alert', 'claim', 'k:1', ...A, '--term', '1'],
      ['alert', 'claim', 'k:1', ...A, '--term', '1', '--label', 'w', '--owner', 'engine'],
      ['alert', 'claim', 'k:1', ...A, '--term', '1', '--label', 'w', '--bogus', 'x'],
      ['alert', 'unsilence', 'not-an-id', '--note', 'x', ...A],
      ['alert', 'unsilence', '00000000-0000-4000-8000-000000000000', ...A],
      ['alert', 'silences', 'extra'],
    ]) {
      const r = await t.run(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toContain('用法：fleet-api alert');
    }
    expect(t.opened()).toBe(0);
    expect(await t.json('alert', 'claim')).toMatchObject({ code: 2, body: { ok: false, reason: 'usage' } });
  });

  it('--help 只打用法、不连库', async () => {
    const t = setup();
    expect((await t.run('alert', '--help')).out).toContain('alert claim <键|编号>');
    expect((await t.run('--help')).out).toContain('fleet-api alert <show|claim|silence|unsilence|silences>');
    expect(t.opened()).toBe(0);
  });
});

describe('alert show：谁在处理、修到哪', () => {
  it('开着的一条一行：没人认领、多久了；--json 带现算的处理状态', async () => {
    const t = setup();
    const a = await taskless();
    const r = await t.run('alert', 'show');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[卡住报警] 定时任务「备份」没跑成（watchdog:job:backup:after-12）');
    expect(r.out).toMatch(/没人认领 · \d+/);
    const j = await t.json('alert', 'show');
    expect(j.body.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.id,
          key: 'watchdog:job:backup:after-12',
          handling: expect.objectContaining({ stage: 'unclaimed', stageText: '没人认领' }),
        }),
      ]),
    );
  });

  it('给了键只看那一条：跟进单、认领、PR、怎么认领', async () => {
    const t = setup();
    await taskless();
    const r = await t.run('alert', 'show', 'watchdog:job:backup:after-12');
    expect(r.code).toBe(0);
    expect(r.out).toContain('跟进单：没有');
    expect(r.out).toContain('认领：帅位经 ssh 调 fleet-api alert claim watchdog:job:backup:after-12');
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

describe('alert claim：认领提醒的跟进单', () => {
  it('没挂单的：退出码 2，写明先开单带 --issue 或等提醒派单开', async () => {
    const t = setup();
    await taskless();
    await t.run('seat', 'take', ...A);
    const r = await t.run(
      'alert',
      'claim',
      'watchdog:job:backup:after-12',
      ...A,
      '--term',
      '1',
      '--label',
      '工人A',
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('还没挂单');
    expect(r.err).toContain('--issue <owner/仓#号>');
  });

  it('带 --issue：认领那张单、挂上跟进单，show 显示谁在处理；再来一次认得出是自己拿着', async () => {
    const t = setup();
    await taskless();
    await t.run('seat', 'take', ...A);
    const claim = ['alert', 'claim', 'watchdog:job:backup:after-12', ...A, '--term', '1', '--label', '工人A'];
    const got = await t.json(...claim, '--issue', `${REPO}#360`, '--note', '查备份盘');
    expect(got).toMatchObject({
      code: 0,
      body: {
        ok: true,
        work: { repo: REPO, issueNumber: 360 },
        claim: { owner: { kind: 'worker', machine: '本机', label: '工人A' }, state: 'claimed' },
        linked: 'linked',
        already: false,
      },
    });
    const show = await t.run('alert', 'show');
    expect(show.out).toMatch(/本机\/工人A 在处理 · example\/canary#360 · 查备份盘 · \d+ 分钟/);
    // 再来一次（比如挂单那步上次没成）：认领那步认得出是自己拿着，跟进单已经一样
    expect(await t.json(...claim, '--issue', '360')).toMatchObject({
      code: 0,
      body: { ok: true, already: true, linked: 'same' },
    });
  });

  it('【故意造出的失败】不是帅位（没接班、任期不对）：退出码 3，单子一点没动', async () => {
    const t = setup();
    await taskless();
    const r = await t.run(
      'alert',
      'claim',
      'watchdog:job:backup:after-12',
      ...A,
      '--term',
      '1',
      '--label',
      '工人A',
      '--issue',
      `${REPO}#360`,
    );
    expect(r.code).toBe(3);
    expect(r.out).toContain('没认领上');
    const show = await t.run('alert', 'show');
    expect(show.out).toMatch(/没人认领 · \d+/);
  });

  it('【故意造出的失败】跟进单在引擎手里（它自己卡住才报的）：退出码 3，写明转人工的两条路', async () => {
    const t = setup();
    const store = createPgStore(db.db);
    const repo = await store.findRepoByName('example', 'canary');
    if (!repo) throw new Error('夹具里没有 example/canary');
    const got = await store.claimForEngine({
      repoId: repo.id,
      issueNumber: 293,
      workflowId: `req:${REPO}#293`,
      actor: { kind: 'engine', id: 'fusion' },
    });
    expect(got.ok).toBe(true);
    await taskless();
    await t.run('seat', 'take', ...A);
    const r = await t.run(
      'alert',
      'claim',
      'watchdog:job:backup:after-12',
      ...A,
      '--term',
      '1',
      '--label',
      '工人A',
      '--issue',
      `${REPO}#293`,
    );
    expect(r.code).toBe(3);
    expect(r.out).toContain('在引擎手里');
    expect(r.out).toContain('创始人说改派');
  });

  it('【故意造出的失败】已经撤了的提醒：退出码 3，不认领', async () => {
    const t = setup();
    const a = await taskless();
    expect(
      await resolveAlertWithReason(db.db, {
        dedupeKey: 'watchdog:job:backup:after-12',
        by: 'engine:watchdog',
        why: '按期跑成了',
      }),
    ).toBe('ok');
    await t.run('seat', 'take', ...A);
    const r = await t.json(
      'alert',
      'claim',
      a.id,
      ...A,
      '--term',
      '1',
      '--label',
      '工人A',
      '--issue',
      `${REPO}#360`,
    );
    expect(r).toMatchObject({ code: 3, body: { ok: false, reason: 'resolved' } });
  });
});

describe('静默（Alertmanager 式：谁、为什么、必带到期）', () => {
  it('帅位还没人接过（上线过渡）：记是谁照样建；show 显示「已静默」；撤了照常', async () => {
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
    expect(s).toMatchObject({ code: 0, body: { ok: true, basis: '帅位还没人接过（上线过渡）' } });
    const show = await t.run('alert', 'show');
    expect(show.out).toContain('已静默（本机/a1：创始人 09-27 晚拍：法国暂时不用独享号）');
    const id = (s.body.silence as { id: string }).id;
    expect((await t.run('alert', 'silences')).out).toContain(id);
    const un = await t.run('alert', 'unsilence', id, '--note', '恢复独享号了', ...A);
    expect(un.code).toBe(0);
    expect((await t.run('alert', 'show')).out).toMatch(/没人认领 · \d+/);
  });

  it('【故意造出的失败】帅位上线后不带任期、没有创始人原话：退出码 3；带创始人原话照建', async () => {
    const t = setup();
    await t.run('seat', 'take', ...A);
    const base = ['alert', 'silence', '--prefix', 'watchdog:job:backup:', '--until', '2h', '--note', '换盘'];
    const r = await t.run(...base, '--machine', '笔记本', '--session', 'b1');
    expect(r.code).toBe(3);
    expect(r.err).toContain('静默要带任期');
    expect((await t.run(...base, '--machine', '笔记本', '--session', 'b1', '--term', '1')).code).toBe(3);
    const ok = await t.json(
      ...base,
      '--machine',
      '笔记本',
      '--session',
      'b1',
      '--founder',
      '备份盘今晚换，先别吵',
    );
    expect(ok).toMatchObject({ code: 0, body: { ok: true, basis: '创始人原话：备份盘今晚换，先别吵' } });
    expect((await t.run(...base, ...A, '--term', '1')).code).toBe(0);
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
