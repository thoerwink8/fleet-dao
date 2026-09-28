// 驾驶舱提醒列表的「谁在处理 · 链接 · 多久了」（design 15.3）：读的时候从认领、PR 镜像、发布记录现算（core 的 alertHandling），
// 没接上、读不到照实写 handlingProblem，不拿「没人在修」顶。拼事实（toAlertWorkFacts）和发布记录（deployFacts）也在这里验。
import { issueClaims, linkAlertWork, pullRequests, upsertAlert } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { NotificationsResponse } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type AlertWorkPort, deployFacts, pgAlertWork } from '../src/alert-work.ts';
import type { DeployLagInput } from '../src/deploy-lag.ts';
import { type Harness, harness, IDS, pgHarness } from './harness.ts';

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

const SHA = (c: string) => c.repeat(40);

async function notifications(h: Pick<Harness, 'cockpit'>, cookie: string) {
  return NotificationsResponse.parse(
    await (await h.cockpit.request('/api/notifications?status=open', { headers: { cookie } })).json(),
  );
}

describe('驾驶舱提醒列表：谁在处理', () => {
  it('接上了：每条带现算的处理状态——没人在修；本机认领了跟进单；PR 正文「修提醒」栏写了它、合了、法国已发布', async () => {
    const deploy: DeployLagInput = {
      current: { sha: SHA('b') },
      currentOnMain: null,
      state: {
        schema: 1,
        ranAt: new Date().toISOString(),
        main: {
          checkedAt: new Date().toISOString(),
          head: SHA('b'),
          headAt: new Date().toISOString(),
          commits: [
            [SHA('b'), new Date().toISOString()],
            [SHA('a'), new Date(Date.now() - 3_600_000).toISOString()],
          ],
        },
        mainError: null,
        ci: null,
        hold: null,
        waitingSince: null,
        attempt: null,
        rules: null,
        system: null,
        last: null,
      },
    };
    current = await pgHarness(t, { alertWork: pgAlertWork(t.db, () => deployFacts(deploy)) });
    const h = current;
    const { cookie } = await h.login();
    const repoId = IDS.repo;
    const unclaimed = await upsertAlert(t.db, {
      dedupeKey: 'deploy-lag:behind',
      level: 'alert',
      taskId: null,
      title: '法国跟不上主线',
      body: '',
    });
    const claimed = await upsertAlert(t.db, {
      dedupeKey: 'watchdog:job:backup:after-12',
      level: 'alert',
      taskId: null,
      title: '备份没跑成',
      body: '',
    });
    await linkAlertWork(t.db, {
      notificationId: claimed.id,
      repoId,
      issueNumber: 360,
      source: 'claim',
      linkedBy: '本机/a1',
      mode: 'replace',
      audit: { actorKind: 'ai', actorId: '本机/a1', via: 'engine' },
    });
    await t.db.insert(issueClaims).values({
      repoId,
      issueNumber: 360,
      claimId: '11111111-2222-4333-8444-555555555555',
      ownerKind: 'worker',
      ownerMachine: '本机',
      ownerLabel: '工人A',
      seatScope: 'main',
      seatTerm: 1,
      state: 'doing',
      graceMinutes: 120,
      claimedAt: new Date(Date.now() - 5 * 60_000),
      heartbeatAt: new Date(),
      updatedAt: new Date(),
      note: '查备份盘',
    });
    const fixed = await upsertAlert(t.db, {
      dedupeKey: 'routing:all-open:execute',
      level: 'alert',
      taskId: null,
      title: '执行阶段全熔断',
      body: '',
    });
    await t.db.insert(pullRequests).values({
      repoId,
      number: 370,
      state: 'merged',
      headRef: 'fix/370',
      headSha: SHA('c'),
      updatedAt: new Date(),
      mergedAt: new Date(Date.now() - 3_600_000),
      mergeSha: SHA('a'),
      alertRefs: ['routing:all-open:execute'],
    });

    const list = await notifications(h, cookie);
    expect(list.handlingProblem).toBeUndefined();
    const by = new Map(list.items.map((n) => [n.id, n.handling]));
    expect(by.get(unclaimed.id)).toMatchObject({ stage: 'unclaimed', stageText: '没人在修' });
    expect(by.get(claimed.id)).toMatchObject({
      stage: 'claimed',
      who: '本机/工人A',
      work: { repo: { owner: 'example', name: 'canary' }, issueNumber: 360 },
    });
    expect(by.get(claimed.id)?.line).toMatch(
      /^本机\/工人A 在处理 · example\/canary#360 · 查备份盘 · \d+ 分钟$/,
    );
    expect(by.get(fixed.id)).toMatchObject({
      stage: 'deployed',
      who: 'PR #370',
      pr: { repo: { owner: 'example', name: 'canary' }, number: 370, state: 'merged' },
      deploy: { state: 'deployed' },
    });
  });

  it('【故意造出的失败】没接上（开发环境、内存版）：列表照出，另写 handlingProblem，不给每条编一个「没人在修」', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const list = await notifications(h, cookie);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((n) => n.handling === undefined)).toBe(true);
    expect(list.handlingProblem).toMatch(/^谁在处理没接上/);
  });

  it('【故意造出的失败】读不到库：列表照出，handlingProblem 写没查成和原因', async () => {
    const broken: AlertWorkPort = {
      ...pgAlertWork(t.db, () => null),
      read: async () => {
        throw new Error('statement timeout');
      },
    };
    current = await pgHarness(t, { alertWork: broken });
    const h = current;
    const { cookie } = await h.login();
    const list = await notifications(h, cookie);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((n) => n.handling === undefined)).toBe(true);
    expect(list.handlingProblem).toBe('谁在处理没查成：statement timeout');
  });
});

describe('发布记录 → core 的 DeployFacts', () => {
  const state = (over: Record<string, unknown> = {}) =>
    ({
      schema: 1,
      ranAt: '2026-09-27T12:00:00.000Z',
      main: {
        checkedAt: '2026-09-27T12:00:00.000Z',
        head: SHA('b'),
        headAt: '2026-09-27T11:00:00.000Z',
        commits: [[SHA('b'), '2026-09-27T11:00:00.000Z']],
      },
      mainError: null,
      ci: null,
      hold: null,
      waitingSince: null,
      attempt: {
        sha: SHA('b'),
        startedAt: '2026-09-27T11:10:00.000Z',
        endedAt: '2026-09-27T11:20:00.000Z',
        result: 'ok',
      },
      rules: null,
      system: null,
      last: null,
      ...over,
    }) as Extract<DeployLagInput['state'], { schema: 1 }>;

  it('在用的版本、主线列表、这一轮的时刻；最近一次发布就是它而且成了：切上去的时刻', () => {
    expect(deployFacts({ current: { sha: SHA('b') }, currentOnMain: null, state: state() })).toEqual({
      ok: true,
      currentSha: SHA('b'),
      commits: [[SHA('b'), '2026-09-27T11:00:00.000Z']],
      checkedAt: '2026-09-27T12:00:00.000Z',
      deployedAt: '2026-09-27T11:20:00.000Z',
    });
    const other = deployFacts({
      current: { sha: SHA('b') },
      currentOnMain: null,
      state: state({ attempt: { sha: SHA('c'), startedAt: 'x', endedAt: null, result: 'running' } }),
    });
    expect(other).toMatchObject({ ok: true, deployedAt: null });
  });

  it('【故意造出的失败】读不到链接、状态文件、主线：ok=false 带原因，不当成「没发布」', () => {
    expect(
      deployFacts({ current: { error: '读不了 current：EACCES' }, currentOnMain: null, state: state() }),
    ).toEqual({ ok: false, why: '读不了 current：EACCES' });
    expect(deployFacts({ current: { sha: null }, currentOnMain: null, state: state() })).toMatchObject({
      ok: false,
    });
    expect(
      deployFacts({ current: { sha: SHA('b') }, currentOnMain: null, state: { error: '状态文件认不出' } }),
    ).toEqual({ ok: false, why: '状态文件认不出' });
    expect(
      deployFacts({
        current: { sha: SHA('b') },
        currentOnMain: null,
        state: state({ main: null, mainError: '取不到 GitHub' }),
      }),
    ).toEqual({ ok: false, why: '自动发布这一轮没读到主线：取不到 GitHub' });
  });
});
