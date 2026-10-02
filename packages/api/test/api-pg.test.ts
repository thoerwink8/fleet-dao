// 整条链路跑在真库上：接口 → Postgres Store → PGlite（真迁移）→ 库里的触发器发 NOTIFY → LISTEN → SSE。
// 语义细节在契约测试（store-contract.ts）和各接口的测试里按内存版测过；这里只证明「换成真库，接起来照样通」。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asks, auditLog, feishuDrafts, githubEvents, progressEvents, tasks } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  AskResponse,
  BoardResponse,
  TaskDetailResponse,
  TimelineResponse,
  UpdateStagePolicyResponse,
} from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CANARY_NOT_HERE } from '../src/canary-health.ts';
import { DEPLOY_LAG_NOT_HERE } from '../src/deploy-lag.ts';
import { devFixtures } from '../src/dev-fixtures.ts';
import { draftBacklogCheck, notWiredDraftOpener } from '../src/draft-opening.ts';
import { createGatewaySeen } from '../src/gateway-seen.ts';
import { githubAppMissing } from '../src/github.ts';
import { githubAppHealthCheck } from '../src/github-app-health.ts';
import { serviceHealthChecks } from '../src/health.ts';
import { JUDGE_NOT_WIRED, judgeHealthCheck } from '../src/judge-health.ts';
import { probeDb } from '../src/pg-store.ts';
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
    const timeline = TimelineResponse.parse(await get(`/api/tasks/${IDS.task12}/timeline`));
    expect(timeline.items.length).toBeGreaterThan(0);
    // 登录本身也落了库里的操作记录。
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'login'))).toHaveLength(1);
  });

  it('fleet 命令带同一个幂等键重试：库里只有一条进度，只叫醒一次', async () => {
    const h = await start();
    // blocked 属于 AGENT_EVENT_WAKE_KINDS（会叫醒工作流），say 不会——用它才能证明「幂等键去重连带去重叫醒」
    // 在真库（不只是内存版）上也成立。
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
    expect(h.signals).toHaveLength(1);
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

  it('SSE：驾驶舱里回答追问 → 库里的触发器发通知 → 打开的页面收到 asks 的变化', async () => {
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
    const res = await h.cockpit.request(
      `/api/asks/${asked.askId}/answer`,
      write('POST', session, { answer: '6 位' }),
    );
    expect(res.status).toBe(200);
    await readUntil(reader, `{"table":"asks","id":"${asked.askId}"}`, buf);
    await reader.cancel();
  });

  it('阶段策略：按内容比对防并发——改之前被别人改过就 409；改成了留操作记录', async () => {
    const h = await start();
    const session = await h.login();
    const put = (expected: { routeIds: string[]; pinned: boolean }) =>
      h.cockpit.request(
        '/api/routing/stages/execute',
        write('PUT', session, {
          routeIds: ['rt-claude-opus'],
          pinned: true,
          expected,
          reason: '先只用 Opus',
        }),
      );
    const before = { routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false };
    const ok = await put(before);
    expect(ok.status).toBe(200);
    expect(UpdateStagePolicyResponse.parse(await ok.json()).stage).toEqual({
      stage: 'execute',
      routeIds: ['rt-claude-opus'],
      pinned: true,
    });
    expect((await put(before)).status).toBe(409);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'stage_policy.update'));
    expect(audits.map((a) => ({ target: a.target, via: a.via, ok: a.ok }))).toEqual([
      { target: 'stage:execute', via: 'cockpit', ok: true },
    ]);
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

  it('健康检查（生产那一套）：库、实时推送是真探的；Temporal 没接上、机器人凭据没读到如实报红，飞书草稿开单没接上报「未接」；LISTEN 停了实时推送也报红', async () => {
    const pgStore = () => {
      if (!current) throw new Error('还没起');
      return current.store;
    };
    const h = await start({
      health: serviceHealthChecks({
        probeDb: () => probeDb(t.db),
        feed: {
          probe: (ms) => current?.feed.probe(ms) ?? Promise.reject(new Error('还没起')),
        },
        temporal: notConnectedTemporal(),
        githubEvents: githubAppMissing('没有 /etc/fleet-dao/github/gh-app-fleet-dao-engine.json').check,
        draftOpener: notWiredDraftOpener(),
        draftBacklog: () => draftBacklogCheck(pgStore(), () => new Date(T0))(),
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
        draft_opener: { ok: true, status: 'not_wired', message: '飞书草稿开成 issue 还没接上（#91）' },
        draft_backlog: {
          ok: true,
          status: 'not_wired',
          message: '飞书草稿开成 issue 还没接上（#91）：确认了的草稿先留在待开单',
        },
        judge: { ok: true, status: 'not_wired', message: JUDGE_NOT_WIRED },
        deploy_lag: { ok: true, status: 'not_wired', message: DEPLOY_LAG_NOT_HERE },
        feishu_gateway: {
          ok: false,
          code: 'unchecked',
          message: '没查成：后端起来才 0 秒，推送轮询还没来过（盘面快照也没来取过）',
        },
        session_org: { ok: true },
        github_app: { ok: true },
        canary: { ok: true, status: 'not_wired', message: CANARY_NOT_HERE },
        watchdog: { ok: true, status: 'not_wired', message: WATCHDOG_NOT_HERE },
      },
    });
    // 一张草稿确认了 20 分钟还没开成：积压报红（库里真查出来的）。
    await t.db.insert(feishuDrafts).values({
      id: '20000000-0000-4000-8000-000000000001',
      sourceMessageId: 'om_backlog',
      chatType: 'p2p',
      rawText: '加个导出按钮',
      understanding: '加个导出按钮',
      unsure: true,
      repoId: IDS.repo,
      proposedBy: IDS.founderA,
      status: 'confirmed',
      confirmedBy: IDS.founderA,
      confirmedAt: new Date(T0.getTime() - 20 * 60_000),
    });
    // 开单没接上时 /healthz 里这一项是「未接」；检查本身在真库上照样查得出积压（接上以后就报这个）
    await expect(draftBacklogCheck(pgStore(), () => new Date(T0))()).rejects.toMatchObject({
      code: 'backlog',
      message: '最早一张待开单已经等了 20 分钟还没开成',
    });
    await h.feed.stop();
    const after = (await (await h.cockpit.request('/healthz')).json()) as { checks: Record<string, unknown> };
    expect(after.checks.realtime).toMatchObject({ ok: false, code: 'not_listening' });
  });
});
