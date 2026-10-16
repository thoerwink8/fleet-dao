// 整条链路跑在真库上：接口 → Postgres Store → PGlite（真迁移）→ 库里的触发器发 NOTIFY → LISTEN → SSE。
// 语义细节在契约测试（store-contract.ts）和各接口的测试里按内存版测过；这里只证明「换成真库，接起来照样通」。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditLog, githubEvents, runs, tasks } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { BoardResponse, TaskDetailResponse } from '@fleet-dao/shared';
import { DEPLOY_LAG_NOT_HERE, devFixtures } from '@fleet-dao/store';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { probeDb } from '../src/db-probe.ts';
import { githubAppMissing } from '../src/github.ts';
import { githubAppHealthCheck } from '../src/github-app-health.ts';
import { serviceHealthChecks } from '../src/health.ts';
import { JUDGE_NOT_WIRED, judgeHealthCheck } from '../src/judge-health.ts';
import { NODE_REPORT_NOT_WIRED, nodeReportPart } from '../src/node-reporter.ts';
import { sessionOrgHealthCheck } from '../src/session-org-health.ts';
import { notConnectedTemporal } from '../src/temporal.ts';
import { WATCHDOG_NOT_HERE } from '../src/watchdog-health.ts';
import { deliverGithub, type HarnessOptions, IDS, pgHarness, T0 } from './harness.ts';

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

describe('接口跑在真库上', () => {
  it('登录、看板、需求详情、时间线：从库里读出来，形状对得上 shared 的契约', async () => {
    const h = await start();
    const session = await h.login();
    const get = async (path: string) => {
      const res = await h.cockpit.request(path, { headers: { cookie: session.cookie } });
      expect(res.status, path).toBe(200);
      return res.json();
    };
    const board = BoardResponse.parse(await get(`/api/repos/${IDS.repo}/board`));
    expect(board.tasks.map((task) => task.id)).toContain(IDS.task12);
    const detail = TaskDetailResponse.parse(await get(`/api/tasks/${IDS.task12}`));
    // 老流程的会话表 09-29 起没人写、已删（#2357）：任务详情不再有老会话这个字段，用量也就没有可汇总的，三段的流水另有用例（下面 runs 表那一组）
    expect(detail).not.toHaveProperty('runs');
    expect(detail.usage.total.runs).toBe(0);
    // 登录本身也落了库里的操作记录。
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'login'))).toHaveLength(1);
  });

  it('GitHub 事件进来（真库）：PR 事件原文落库、写镜像；同一投递再来不重复；issue 的事件记成不处理、不建任务', async () => {
    const h = await start({ data: devFixtures(T0) });
    const founderA = { login: 'founder-a', id: 1001, type: 'User' };
    const repository = { full_name: 'example/canary' };
    const payload = {
      action: 'opened',
      pull_request: {
        number: 7,
        state: 'open',
        updated_at: '2026-09-25T07:30:00Z',
        user: founderA,
        head: { ref: 'fleet/7-a', sha: 'a'.repeat(40), repo: repository },
        base: { ref: 'main', repo: repository },
      },
      sender: founderA,
      repository,
    };
    const res = await deliverGithub(h, 'pull_request', payload, { delivery: 'pg-1' });
    expect(await res.json()).toMatchObject({ ok: true, verdict: 'accepted' });
    expect(
      await deliverGithub(h, 'pull_request', payload, { delivery: 'pg-1' }).then((r) => r.json()),
    ).toMatchObject({ verdict: 'duplicate' });
    const [event] = await t.db.select().from(githubEvents).where(eq(githubEvents.deliveryId, 'pg-1'));
    expect(event).toMatchObject({ status: 'accepted', attempts: 1, payload });
    expect(h.accepted.map((e) => e.deliveryId)).toEqual(['pg-1']);

    // issue 的事件门口不收（单子由引擎自己拉）：记成不处理，不建任务
    const issue = {
      action: 'opened',
      issue: {
        number: 40,
        title: '给 README 加一行',
        state: 'open',
        created_at: '2026-09-25T07:30:00Z',
        user: founderA,
      },
      sender: founderA,
      repository,
    };
    expect(await deliverGithub(h, 'issues', issue, { delivery: 'pg-2' }).then((r) => r.json())).toMatchObject(
      {
        verdict: 'ignored',
        reason: 'event_not_handled',
      },
    );
    expect(await t.db.select().from(tasks).where(eq(tasks.issueNumber, 40))).toHaveLength(0);
  });

  it('健康检查（生产那一套）：库、实时推送是真探的；Temporal 没接上、机器人凭据没读到如实报红，网关还没来过报「没查成」；LISTEN 停了实时推送也报红', async () => {
    const h = await start({
      health: serviceHealthChecks({
        probeDb: () => probeDb(t.db),
        feed: {
          probe: (ms) => current?.feed.probe(ms) ?? Promise.reject(new Error('还没起')),
        },
        temporal: notConnectedTemporal(),
        githubEvents: githubAppMissing('没有 /etc/fleet-dao/github/gh-app-fleet-dao-engine.json').check,
        judge: judgeHealthCheck({
          db: t.db,
          location: { path: join(tmpdir(), 'fleet-api-pg-nowhere', 'jev.json'), explicit: false },
        }),
        // 和 main.ts 在非正式环境的装配一样：没有发布目录、没有自动发布
        deployLag: { check: async () => {}, notWired: DEPLOY_LAG_NOT_HERE },
        // 库里真查：没有切号的提醒就是好的（session-org-health.test.ts 另测开着报红）
        sessionOrg: sessionOrgHealthCheck(t.db),
        // 库里真查：没有机器人权限的提醒就是好的（github-app-health.test.ts 另测开着报红）
        githubApp: githubAppHealthCheck(t.db),
        // 和 main.ts 在非正式环境的装配一样：看门狗只在正式环境跑
        watchdog: { check: async () => {}, notWired: WATCHDOG_NOT_HERE },
        // 和 main.ts 没配推送地址时的装配一样
        nodeReport: nodeReportPart(null),
      }),
    });
    const res = await h.cockpit.request('/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      checks: {
        database: { ok: true },
        realtime: { ok: true },
        temporal: { ok: false, code: 'not_connected', message: 'Temporal 客户端还没接上' },
        engine: { ok: false, code: 'not_connected', message: 'Temporal 客户端还没接上' },
        github_events: {
          ok: false,
          code: 'app_credentials_missing',
          message: 'GitHub 机器人的凭据没读到，PR 和 CI 事件写不进镜像',
        },
        judge: { ok: true, status: 'not_wired', message: JUDGE_NOT_WIRED },
        deploy_lag: { ok: true, status: 'not_wired', message: DEPLOY_LAG_NOT_HERE },
        session_org: { ok: true },
        github_app: { ok: true },
        watchdog: { ok: true, status: 'not_wired', message: WATCHDOG_NOT_HERE },
        node_report: { ok: true, status: 'not_wired', message: NODE_REPORT_NOT_WIRED },
      },
    });
    await h.feed.stop();
    const after = (await (await h.cockpit.request('/healthz')).json()) as { checks: Record<string, unknown> };
    expect(after.checks.realtime).toMatchObject({ ok: false, code: 'not_listening' });
  });
});

describe('三段的流水（runs 表）跑在真库上：任务详情按段、按模型，读不到的逐笔写明原因', () => {
  async function detailOf(h: Awaited<ReturnType<typeof pgHarness>>, taskId: string) {
    const session = await h.login();
    const res = await h.cockpit.request(`/api/tasks/${taskId}`, { headers: { cookie: session.cookie } });
    expect(res.status).toBe(200);
    return TaskDetailResponse.parse(await res.json());
  }
  const reasons = (run: { unread: { item: string; reason: string }[] } | undefined) =>
    Object.fromEntries((run?.unread ?? []).map((n) => [n.item, n.reason]));

  it('从库里读：task_id 对上的、按单号兜底的（标明）都在；派工档、耗时、按段每段再按模型；没记的 token、花费写明没记到', async () => {
    const d = await detailOf(await start(), IDS.task13);
    expect(d.segmentRuns.map((r) => [r.id, r.segment, r.tier ?? null, r.matchedBy])).toEqual([
      [IDS.seg13scope, 'scope', null, 'task'],
      [IDS.seg13manual1, 'manual', 'fast', 'task'],
      [IDS.seg13manual2, 'manual', 'fast', 'task'],
      [IDS.seg13verify, 'verify', null, 'issueNumber'],
    ]);
    expect(reasons(d.segmentRuns[1])).toEqual({ tokens: '没记到：缓存读、缓存写', cost: '花费没记到' });
    expect(d.segmentRuns[2]).toMatchObject({
      durationMs: 25 * 60_000,
      costUsd: 1.86,
      billing: 'subscription',
    });
    expect(d.usage.bySegment.map((s) => [s.segment, s.runs, s.byModel.map((m) => m.model)])).toEqual([
      ['scope', 1, ['opus-5.5']],
      ['manual', 2, ['kimi-k3', 'opus-5.5']],
      ['verify', 1, ['gpt-5.6']],
    ]);
    expect(d.usage.total).toMatchObject({ runs: 4, missingCost: 2 });
  });

  it('【失败】起止缺一头：库里一段 ended_at、outcome 都空，单子却已经结束——不当在跑，耗时没读到并写明原因', async () => {
    const h = await start();
    await t.db.insert(runs).values({
      id: 'd1000000-0000-4000-8000-0000000130ab',
      segment: 'verify',
      taskId: IDS.task13,
      model: 'gpt-5.6',
      startedAt: new Date(T0.getTime() - 505 * 60_000),
    });
    const d = await detailOf(h, IDS.task13);
    const stale = d.segmentRuns.find((r) => r.id === 'd1000000-0000-4000-8000-0000000130ab');
    expect(stale?.running).toBe(false);
    expect(reasons(stale).time).toContain('没记结束时刻');
    expect(d.usage.bySegment.find((s) => s.segment === 'verify')).toMatchObject({ runs: 2, missingTime: 1 });
  });

  it(
    '【失败】段名认不出：库里的约束挡不到的数据（约束被放宽、整表导进来）读出来也不猜成哪一段，写明原样',
    async () => {
      // 单独一份库：要拆掉 runs_segment_known 才写得进认不出的段名，不能动别的用例共用的那份
      const loose = await createTestDb();
      try {
        await loose.client.exec('alter table runs drop constraint runs_segment_known');
        const h = await pgHarness(loose);
        try {
          await loose.db.insert(runs).values({
            id: 'd1000000-0000-4000-8000-0000000130aa',
            segment: 'fusion-execute' as 'manual',
            taskId: IDS.task13,
            model: 'opus-5.5',
            startedAt: new Date(T0.getTime() - 500 * 60_000),
            endedAt: new Date(T0.getTime() - 490 * 60_000),
            outcome: 'done',
          });
          const d = await detailOf(h, IDS.task13);
          const odd = d.segmentRuns.find((r) => r.id === 'd1000000-0000-4000-8000-0000000130aa');
          expect(odd?.segment).toBeNull();
          expect(reasons(odd).segment).toContain('fusion-execute');
          expect(d.usage.bySegment.at(-1)).toMatchObject({ segment: null, runs: 1 });
        } finally {
          await h.stop();
        }
      } finally {
        await loose.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});
