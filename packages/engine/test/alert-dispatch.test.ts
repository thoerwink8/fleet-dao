// 提醒派单（design 15.3「谁在处理」，jobs/alert-dispatch.ts）：真库（PGlite 跑真迁移）上的装配（real/alert-dispatch.ts），
// GitHub 换成记下调用的假机器人。没人认领过门槛再推、没挂单的开跟进单（挂当前版本、贴本机做）、有人接手了撤、停着没动再推、
// 人处理过的同一段不再打开；读不到、挑不出仓、读不到里程碑一律记没跑成、不装作推过。
// 每小时对账的 24 小时再推不给有人在处理、静默了的、提醒派单再推出来的推（alert-sweep.ts），也在这里钉住。
import { randomUUID } from 'node:crypto';
import {
  type AlertRow,
  alertByKey,
  createSilence,
  repos,
  resolveAlertWithReason,
  settings,
  takeClaimRow,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { GitHub } from '@fleet-dao/github';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALERT_DISPATCH_ACTOR,
  type AlertDispatchDeps,
  AlertDispatchFailedError,
  runAlertDispatchJob,
} from '../src/jobs/alert-dispatch.ts';
import { type AlertSweepDeps, sweepAlerts } from '../src/jobs/alert-sweep.ts';
import { alertDispatchJob } from '../src/real/alert-dispatch.ts';
import { registerEngineJobs } from '../src/real/jobs.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

interface Opened {
  repo: string;
  key: string;
  title: string;
  body: string;
  labels: readonly string[];
  milestone: number | null;
}

let opened: Opened[];
let milestones: () => Promise<{ number: number; title: string }[]>;
let fleetRepoId: string;

/** 假「引擎」机器人：同一个 key 只开一张（和真的 openIssue 一样幂等），开了什么都记下。 */
const gh = {
  async openIssue(input: {
    repo: { owner: string; name: string };
    key: string;
    title: string;
    body: string;
    labels: readonly string[];
    milestone: number | null;
  }) {
    const slug = `${input.repo.owner}/${input.repo.name}`;
    const before = opened.findIndex((o) => o.repo === slug && o.key === input.key);
    if (before >= 0) return { number: 500 + before, url: `https://example.test/${before}`, created: false };
    opened.push({ ...input, repo: slug });
    return {
      number: 500 + opened.length - 1,
      url: `https://example.test/${opened.length - 1}`,
      created: true,
    };
  },
  readOpenMilestones: async () => milestones(),
} as unknown as Pick<GitHub, 'openIssue' | 'readOpenMilestones'>;

const logs: string[] = [];
const job = (over: Partial<Parameters<typeof alertDispatchJob>[0]> = {}) =>
  alertDispatchJob({
    db: t.db,
    gh,
    canaryRepo: 'acme/canary',
    deploy: () => null,
    log: (_level, text) => logs.push(text),
    ...over,
  });

beforeEach(async () => {
  await resetTestDb(t);
  await registerEngineJobs(t.db);
  opened = [];
  logs.length = 0;
  milestones = async () => [
    { number: 2, title: 'v2 以后' },
    { number: 1, title: 'v1 Fusion 接活' },
  ];
  const [fleet] = await t.db
    .insert(repos)
    .values({ owner: 'acme', name: 'fleet-dao', testCommand: 'pnpm check' })
    .returning();
  await t.db.insert(repos).values({ owner: 'acme', name: 'canary', testCommand: 'pnpm test' });
  if (!fleet) throw new Error('仓没写进去');
  fleetRepoId = fleet.id;
});

/** 直接跑一句 SQL（挪时刻、按前缀找）：库的 now 不归测试管，只能挪数据。 */
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await t.client.query<T>(text, params)).rows;

const openByPrefix = (prefix: string) =>
  q<{ title: string }>('select title from notifications where starts_with(dedupe_key, $1)', [prefix]);

/** 报一条卡住报警，报的时刻往前挪 minutesAgo 分钟（库的 now 不归测试管，只能挪数据）。 */
async function alertAgo(minutesAgo: number, dedupeKey = 'watchdog:job:backup:after-12') {
  const { id } = await upsertAlert(t.db, {
    dedupeKey,
    level: 'alert',
    taskId: null,
    title: '定时任务「备份」没跑成',
    body: '最近一次没跑成：磁盘满了',
    link: '/schedules',
  });
  await q('update notifications set created_at = now() - make_interval(mins => $1) where id = $2', [
    minutesAgo,
    id,
  ]);
  return id;
}

const byKey = (key: string) => alertByKey(t.db, key);

const lastRun = async () =>
  (
    await q<{ outcome: string; why: string | null }>(
      "select outcome, why from schedule_runs where job = 'alert-dispatch' order by id desc limit 1",
    )
  )[0];

async function claimIssue(issueNumber: number, minutesAgo = 0) {
  const got = await takeClaimRow(t.db, {
    repoId: fleetRepoId,
    issueNumber,
    claimId: randomUUID(),
    ownerKind: 'worker',
    ownerMachine: '本机',
    ownerLabel: '工人A',
    seatScope: 'main',
    seatTerm: 3,
    state: 'claimed',
    workflowId: null,
    graceMinutes: 120,
    note: '查备份盘',
  });
  if (!got) throw new Error('认领没抢到');
  await q('update issue_claims set claimed_at = now() - make_interval(mins => $1) where issue_number = $2', [
    minutesAgo,
    issueNumber,
  ]);
  return got.value;
}

describe('提醒派单一轮（真库）', () => {
  it('没人认领过了 20 分钟：开一张跟进单（本仓、挂当前版本、贴缺陷和本机做）挂上，推一条「没人认领」；再跑一轮不重开、不改卡', async () => {
    const id = await alertAgo(30);
    const run = await runAlertDispatchJob(job()());
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      repo: 'acme/fleet-dao',
      key: `alert:${id}`,
      labels: ['缺陷', '本机做'],
      milestone: 1,
      title: '跟进提醒：定时任务「备份」没跑成',
    });
    expect(opened[0]?.body).toContain('挂当前版本「v1 Fusion 接活」');
    const esc = await byKey(`unclaimed:${id}:first`);
    expect(esc).toMatchObject({
      level: 'alert',
      title: '没人认领：定时任务「备份」没跑成',
      resolvedAt: null,
    });
    expect(esc?.body).toContain('跟进单是 acme/fleet-dao#500');
    expect(esc?.body).not.toContain('没挂单');
    const link = await q<{ actor_id: string; target: string }>(
      "select actor_id, target from audit_log where action = 'alert.link'",
    );
    expect(link).toHaveLength(1);
    expect(link[0]).toMatchObject({ actor_id: ALERT_DISPATCH_ACTOR, target: `notification:${id}` });

    const again = await runAlertDispatchJob(job()());
    expect(again.outcome).toBe('ok');
    expect(opened).toHaveLength(1);
    expect((await byKey(`unclaimed:${id}:first`))?.updatedAt).toEqual(esc?.updatedAt);
  });

  it('不到 20 分钟不推不开单；日报、要人拍的不开单（要拍的推「还没拍」）', async () => {
    await alertAgo(5);
    const { id: decision } = await upsertAlert(t.db, {
      dedupeKey: 'approval:x',
      level: 'decision',
      taskId: null,
      title: '等你点头：发布',
      body: '',
    });
    await q("update notifications set created_at = now() - interval '40 minutes' where id = $1", [decision]);
    const run = await runAlertDispatchJob(job()());
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(opened).toHaveLength(0);
    expect(await byKey(`unclaimed:${decision}:first`)).toMatchObject({
      level: 'decision',
      title: '还没拍：等你点头：发布',
    });
  });

  it('有人认领了跟进单：再推的那条撤掉、写明谁在处理；认领 60 分钟还没开 PR：推一条「停着没动」', async () => {
    const id = await alertAgo(30);
    await runAlertDispatchJob(job()());
    await claimIssue(500);
    await runAlertDispatchJob(job()());
    const esc = await byKey(`unclaimed:${id}:first`);
    expect(esc?.resolvedBy).toBe(ALERT_DISPATCH_ACTOR);
    expect(esc?.body).toMatch(/^已撤：有人在处理了：本机\/工人A 在处理 · acme\/fleet-dao#500/);

    await q("update issue_claims set claimed_at = now() - interval '70 minutes'");
    const run = await runAlertDispatchJob(job()());
    expect(run.found).toBe(1);
    const [stuck] = await openByPrefix(`stuck:${id}:claimed-`);
    expect(stuck?.title).toBe('停着没动（认领了）：定时任务「备份」没跑成');
  });

  it('人在再推的那条上点了处理：同一段里不再打开；原来那条静默了：再推的撤掉写明谁拍的', async () => {
    const id = await alertAgo(30);
    await runAlertDispatchJob(job()());
    await resolveAlertWithReason(t.db, { dedupeKey: `unclaimed:${id}:first`, by: 'user-1', why: '知道了' });
    await runAlertDispatchJob(job()());
    expect((await byKey(`unclaimed:${id}:first`))?.resolvedBy).toBe('user-1');

    const other = await alertAgo(30, 'pool-hold:claude-solo');
    await runAlertDispatchJob(job()());
    expect((await byKey(`unclaimed:${other}:first`))?.resolvedAt).toBeNull();
    await createSilence(t.db, {
      matchKind: 'key',
      match: 'pool-hold:claude-solo',
      comment: '创始人 09-27 晚拍：法国暂时不用独享号',
      createdBy: '本机/s1',
      minutes: 60,
      audit: { actorKind: 'ai', actorId: '本机/s1', via: 'engine' },
    });
    await runAlertDispatchJob(job()());
    expect((await byKey(`unclaimed:${other}:first`))?.body).toMatch(
      /^已撤：原来那条静默了（本机\/s1：创始人 09-27 晚拍：法国暂时不用独享号/,
    );
  });

  it('【故意造出的失败】设置认不出：这一轮记没跑成（写明哪一项），不开单、不推', async () => {
    await alertAgo(30);
    await t.db.insert(settings).values({ key: 'alerts.claimAfterMinutes', value: 'abc' });
    const err = await runAlertDispatchJob(job()()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlertDispatchFailedError);
    expect((await lastRun())?.outcome).toBe('failed');
    expect((await lastRun())?.why).toContain('alerts.claimAfterMinutes');
    expect(opened).toHaveLength(0);
    expect(await openByPrefix('unclaimed:')).toHaveLength(0);
  });

  it('【故意造出的失败】挑不出开在哪个仓（受管的不止一个、没设）：不开单，照样推「没人认领」并写明没开成，这一轮记没跑成', async () => {
    const id = await alertAgo(30);
    await t.db.insert(repos).values({ owner: 'acme', name: 'website', testCommand: 'pnpm test' });
    await expect(runAlertDispatchJob(job()())).rejects.toBeInstanceOf(AlertDispatchFailedError);
    expect(opened).toHaveLength(0);
    const esc = await byKey(`unclaimed:${id}:first`);
    expect(esc?.body).toContain('跟进单没开成：受管的项目有 2 个');
    expect((await lastRun())?.why).toContain('alerts.issueRepo');
    // 设了开在哪就开
    await t.db.insert(settings).values({ key: 'alerts.issueRepo', value: 'acme/fleet-dao' });
    expect((await runAlertDispatchJob(job()())).outcome).toBe('ok');
    expect(opened).toHaveLength(1);
  });

  it('【故意造出的失败】读不到里程碑：不开单（不拿「未排期」顶），这一轮记没跑成；仓里真没有开着的 v<N>：未排期照开', async () => {
    await alertAgo(30);
    milestones = async () => {
      throw new Error('GitHub 502');
    };
    await expect(runAlertDispatchJob(job()())).rejects.toBeInstanceOf(AlertDispatchFailedError);
    expect(opened).toHaveLength(0);
    expect((await lastRun())?.why).toContain('GitHub 502');
    milestones = async () => [{ number: 7, title: 'P6 旧阶段' }];
    await runAlertDispatchJob(job()());
    expect(opened[0]).toMatchObject({ milestone: null });
    expect(opened[0]?.body).toContain('先未排期');
  });

  it('【故意造出的失败】读不到认领和 PR（库出错）：这一轮记没跑成，一条都不推、不开单（不当成都没人认领）', async () => {
    await alertAgo(30);
    const deps: AlertDispatchDeps = {
      ...job()(),
      read: async () => {
        throw new Error('statement timeout');
      },
    };
    await expect(runAlertDispatchJob(deps)).rejects.toBeInstanceOf(AlertDispatchFailedError);
    expect((await lastRun())?.why).toContain('statement timeout');
    expect(opened).toHaveLength(0);
    expect(await openByPrefix('unclaimed:')).toHaveLength(0);
  });

  it('开着的提醒一条都没有：记 ok（看过了、没东西要推），不记成「没扫到」让看门狗误报', async () => {
    const run = await runAlertDispatchJob(job()());
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
  });
});

describe('每小时对账的 24 小时再推：有人在处理、静默了的，提醒派单再推出来的不推', () => {
  const DAY = 24 * 60 * 60_000;
  const now = new Date('2026-09-28T12:00:00.000Z');
  const row = (id: string, dedupeKey: string): AlertRow => ({
    id,
    dedupeKey,
    level: 'alert',
    taskId: null,
    title: `提醒 ${id}`,
    body: '',
    link: null,
    createdAt: new Date(now.getTime() - 2 * DAY),
    updatedAt: new Date(now.getTime() - 2 * DAY),
    resolvedAt: null,
    resolvedBy: null,
  });
  const open = [
    row('a-handled', 'watchdog:job:backup:after-1'),
    row('a-silenced', 'pool-hold:claude-solo'),
    row('a-alone', 'canary:broken'),
    row('a-esc', 'unclaimed:11111111-2222-4333-8444-555555555555:first'),
  ];
  const sweep = (handling: AlertSweepDeps['handling']) => {
    const reminded: string[] = [];
    const deps: AlertSweepDeps = {
      workflows: {
        state: async () => ({ state: 'missing' }),
        view: async () => {
          throw new Error('不该问');
        },
      },
      taskState: async () => null,
      approval: async () => null,
      stageRoutable: async () => ({ kind: 'dispatch' }),
      ...(handling ? { handling } : {}),
      alerts: {
        listOpen: async () => ({ alerts: open, truncated: false }),
        byKey: async () => null,
        latestByPrefix: async () => null,
        resolve: async () => 'ok',
        raise: async () => {},
        insertOnce: async (x) => {
          reminded.push(x.dedupeKey.split(':')[1] ?? '');
          return { id: randomUUID(), created: true };
        },
        updateOpen: async () => 'ok',
      },
      now: () => now,
      log: () => {},
    };
    return { reminded, run: () => sweepAlerts(deps, open, false) };
  };

  it('只给没人在处理的再推；再推出来的那几条归提醒派单', async () => {
    const s = sweep(
      async () =>
        new Map([
          ['a-handled', { stage: 'claimed' as const, line: '本机/工人A 在处理' }],
          ['a-silenced', { stage: 'silenced' as const, line: '已静默' }],
          ['a-alone', { stage: 'unclaimed' as const, line: '没人认领' }],
        ]),
    );
    const part = await s.run();
    expect(s.reminded).toEqual(['a-alone']);
    expect(part.unchecked).toEqual([]);
  });

  it('【故意造出的失败】谁在处理读不到：照旧再推（宁可多一张卡），记没查全', async () => {
    const s = sweep(async () => {
      throw new Error('statement timeout');
    });
    const part = await s.run();
    expect(s.reminded).toEqual(['a-handled', 'a-silenced', 'a-alone']);
    expect(part.unchecked).toEqual(['谁在处理没查成，照旧按 24 小时再推：statement timeout']);
  });
});
