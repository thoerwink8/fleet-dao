// 整条链路跑在真库上：接口 → Postgres Store → PGlite（真迁移）→ 库里的触发器发 NOTIFY → LISTEN → SSE。
// 语义细节在契约测试（store-contract.ts）和各接口的测试里按内存版测过；这里只证明「换成真库，接起来照样通」。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asks, auditLog, githubEvents, progressEvents, runs, tasks } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { AskResponse, BoardResponse, TaskDetailResponse } from '@fleet-dao/shared';
import { DEPLOY_LAG_NOT_HERE, devFixtures } from '@fleet-dao/store';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CANARY_NOT_HERE } from '../src/canary-health.ts';
import { probeDb } from '../src/db-probe.ts';
import { createGatewaySeen } from '../src/gateway-seen.ts';
import { githubAppMissing } from '../src/github.ts';
import { githubAppHealthCheck } from '../src/github-app-health.ts';
import { serviceHealthChecks } from '../src/health.ts';
import { JUDGE_NOT_WIRED, judgeHealthCheck } from '../src/judge-health.ts';
import { sessionOrgHealthCheck } from '../src/session-org-health.ts';
import { notConnectedTemporal } from '../src/temporal.ts';
import { WATCHDOG_NOT_HERE } from '../src/watchdog-health.ts';
import {
  agentRequest,
  DEV_RUN_ID,
  deliverGithub,
  type HarnessOptions,
  IDS,
  openEvents,
  pgHarness,
  readUntil,
  T0,
  write,
} from './harness.ts';

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
    expect(detail.runs.map((r) => r.id)).toContain(DEV_RUN_ID);
    // 缓存读写从库里读回来、折进当量；花费没记的就是没读到
    expect(detail.usage.total).toMatchObject({
      cacheReadTokens: 1_450_000,
      cacheWriteTokens: 64_000,
      inputEquivalent: 385_000,
      missingCost: 1,
    });
    // 计费方式从库里的渠道表读：Claude 订阅是套餐内，没记的花费记在套餐内那一栏的没读到
    expect(detail.runs.find((r) => r.id === IDS.run0)?.billing).toBe('subscription');
    expect(detail.usage.total.cost.subscription).toEqual({ runs: 1, usd: 0, missing: 1 });
    // 登录本身也落了库里的操作记录。
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'login'))).toHaveLength(1);
  });

  it('fleet 命令带同一个幂等键重试：库里只有一条进度，不发信号', async () => {
    const h = await start();
    // 幂等键去重在真库（不只是内存版）上也成立；fleet 命令只写库、不发信号（#901）。
    const blocked = () =>
      h.agent.request(
        '/agent/v1/blocked',
        agentRequest(
          h.agentToken(),
          'POST',
          { reason: '真库上的一句', needs: 'access' },
          { 'idempotency-key': 'pg-key-1' },
        ),
      );
    expect((await blocked()).status).toBe(200);
    expect((await blocked()).status).toBe(200);
    const rows = await t.db
      .select()
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, DEV_RUN_ID), eq(progressEvents.kind, 'blocked')));
    expect(rows.filter((r) => (r.payload as { reason?: string }).reason === '真库上的一句')).toHaveLength(1);
    expect(h.signals).toHaveLength(0);
  });

  it('fleet ask 在真库上：不等回答、当场按推荐先做，范围和推荐落库；别处（飞书、issue）写进库的回答，再问同一句回「答过了」', async () => {
    const h = await start();
    const ask = async () =>
      AskResponse.parse(
        await (
          await h.agent.request(
            '/agent/v1/ask',
            agentRequest(h.agentToken(), 'POST', {
              question: '用哪家短信？',
              options: ['腾讯云', '阿里云'],
              recommend: '阿里云',
            }),
          )
        ).json(),
      );
    const first = await ask();
    expect(first).toMatchObject({ status: 'assumed', answer: '阿里云' });
    const [row] = await t.db.select().from(asks).where(eq(asks.id, first.askId));
    expect(row).toMatchObject({
      scope: 'task',
      recommended: '阿里云',
      options: ['阿里云', '腾讯云'],
      hold: null,
    });
    await t.db
      .update(asks)
      .set({ answer: '腾讯云', answeredBy: IDS.founderB, answeredAt: new Date() })
      .where(eq(asks.id, first.askId));
    expect(await ask()).toEqual({ askId: first.askId, status: 'answered', answer: '腾讯云' });
  });

  it('SSE：驾驶舱里关闭旧追问 → 库里的触发器发通知 → 打开的页面收到 asks 的变化', async () => {
    const h = await start();
    const session = await h.login();
    const asked = AskResponse.parse(
      await (
        await h.agent.request(
          '/agent/v1/ask',
          agentRequest(h.agentToken(), 'POST', {
            question: '验证码几位？',
            options: ['6 位', '4 位'],
            recommend: '6 位',
          }),
        )
      ).json(),
    );
    const { reader } = await openEvents(h, session.cookie);
    const buf = await readUntil(reader, 'event: ready');
    const res = await h.cockpit.request(`/api/asks/${asked.askId}/close`, write('POST', session));
    expect(res.status).toBe(200);
    await readUntil(reader, `{"table":"asks","id":"${asked.askId}"}`, buf);
    await reader.cancel();
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
        // 和 main.ts 在法国以外的装配一样：没有发布目录、没有自动发布
        deployLag: { check: async () => {}, notWired: DEPLOY_LAG_NOT_HERE },
        // 网关刚接上还没来过：没查成，照实报红（gateway-seen.test.ts 另测来过、太久没来）
        feishuGateway: createGatewaySeen(() => new Date(T0)),
        // 库里真查：没有切号的提醒就是好的（session-org-health.test.ts 另测开着报红）
        sessionOrg: sessionOrgHealthCheck(t.db),
        // 库里真查：没有机器人权限的提醒就是好的（github-app-health.test.ts 另测开着报红）
        githubApp: githubAppHealthCheck(t.db),
        // 和 main.ts 在法国以外的装配一样：全流程巡检只在法国跑
        canary: { check: async () => {}, notWired: CANARY_NOT_HERE },
        // 和 main.ts 在法国以外的装配一样：看门狗只在法国跑
        watchdog: { check: async () => {}, notWired: WATCHDOG_NOT_HERE },
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
        feishu_gateway: {
          ok: false,
          code: 'unchecked',
          message: '没查成：后端起来才 0 秒，意图卡轮询还没来过',
        },
        session_org: { ok: true },
        github_app: { ok: true },
        canary: { ok: true, status: 'not_wired', message: CANARY_NOT_HERE },
        watchdog: { ok: true, status: 'not_wired', message: WATCHDOG_NOT_HERE },
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
    expect(d.usage.total).toMatchObject({ runs: 4, noQueue: 4, missingCost: 2 });
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
