// 整条链路跑在真库上：接口 → Postgres Store → PGlite（真迁移）→ 库里的触发器发 NOTIFY → LISTEN → SSE / 叫醒等回答的命令。
// 语义细节在契约测试（store-contract.ts）和各接口的测试里按内存版测过；这里只证明「换成真库，接起来照样通」。
import { asks, auditLog, feishuDrafts, progressEvents } from '@fleet-dao/db';
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
import { draftBacklogCheck, notWiredDraftOpener } from '../src/draft-opening.ts';
import { notWiredGitHub } from '../src/github.ts';
import { serviceHealthChecks } from '../src/health.ts';
import { probeDb } from '../src/pg-store.ts';
import { notConnectedTemporal } from '../src/temporal.ts';
import {
  agentRequest,
  DEV_RUN_ID,
  type HarnessOptions,
  IDS,
  openEvents,
  pgHarness,
  readUntil,
  settle,
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
    const timeline = TimelineResponse.parse(await get(`/api/tasks/${IDS.task12}/timeline`));
    expect(timeline.items.length).toBeGreaterThan(0);
    // 登录本身也落了库里的操作记录。
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'login'))).toHaveLength(1);
  });

  it('fleet 命令带同一个幂等键重试：库里只有一条进度，只叫醒一次', async () => {
    const h = await start();
    const say = () =>
      h.agent.request(
        '/agent/v1/say',
        agentRequest(h.agentToken(), 'POST', { text: '真库上的一句' }, { 'idempotency-key': 'pg-key-1' }),
      );
    expect((await say()).status).toBe(200);
    expect((await say()).status).toBe(200);
    const rows = await t.db
      .select()
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, DEV_RUN_ID), eq(progressEvents.kind, 'say')));
    expect(rows.filter((r) => (r.payload as { text?: string }).text === '真库上的一句')).toHaveLength(1);
    expect(h.signals).toHaveLength(1);
  });

  it('别处（飞书、issue）直接写进库的回答：库里的触发器发通知，当场叫醒等着的 fleet ask', async () => {
    const h = await start({ config: { askWaitMs: 5_000 } });
    const pending = h.agent.request(
      '/agent/v1/ask',
      agentRequest(h.agentToken(), 'POST', { question: '用哪家短信？' }),
    );
    let row: typeof asks.$inferSelect | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      [row] = await t.db.select().from(asks).where(eq(asks.question, '用哪家短信？'));
      if (!row) await settle(5);
    }
    if (!row) throw new Error('追问没落库');
    const answeredAt = Date.now();
    await t.db
      .update(asks)
      .set({ answer: '先用阿里云', answeredBy: IDS.founderB, answeredAt: new Date() })
      .where(eq(asks.id, row.id));
    const body = AskResponse.parse(await (await pending).json());
    expect(body).toEqual({ askId: row.id, status: 'answered', answer: '先用阿里云' });
    // 远早于兜底的回库轮询（5 秒）：是通知叫醒的。
    expect(Date.now() - answeredAt).toBeLessThan(2_000);
  });

  it('SSE：驾驶舱里回答追问 → 库里的触发器发通知 → 打开的页面收到 asks 的变化', async () => {
    const h = await start();
    const session = await h.login();
    const asked = AskResponse.parse(
      await (
        await h.agent.request(
          '/agent/v1/ask',
          agentRequest(h.agentToken(), 'POST', { question: '验证码几位？', blocking: false }),
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

  it('健康检查（生产那一套）：库、实时推送是真探的；Temporal、GitHub 事件、飞书草稿开单没接上如实报红；LISTEN 停了实时推送也报红', async () => {
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
        githubEvents: notWiredGitHub().check,
        draftOpener: notWiredDraftOpener(),
        draftBacklog: () => draftBacklogCheck(pgStore(), () => new Date(T0))(),
      }),
    });
    const res = await h.cockpit.request('/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      checks: {
        database: { ok: true },
        realtime: { ok: true },
        temporal: { ok: false, code: 'not_connected', message: 'Temporal 客户端还没接上（等引擎的 PR）' },
        github_events: { ok: false, code: 'not_wired', message: 'GitHub 事件还没接到引擎（等引擎的 PR）' },
        draft_opener: {
          ok: false,
          code: 'not_wired',
          message: '飞书草稿开单还没接上（开 issue、拉起需求工作流那一步，等 #43）',
        },
        draft_backlog: { ok: true },
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
    const backlog = (await (await h.cockpit.request('/healthz')).json()) as {
      checks: Record<string, unknown>;
    };
    expect(backlog.checks.draft_backlog).toEqual({
      ok: false,
      code: 'backlog',
      message: '最早一张待开单已经等了 20 分钟还没开成',
    });
    await h.feed.stop();
    const after = (await (await h.cockpit.request('/healthz')).json()) as { checks: Record<string, unknown> };
    expect(after.checks.realtime).toMatchObject({ ok: false, code: 'not_listening' });
  });
});
