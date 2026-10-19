import { runs } from '@fleet-dao/db';
import { createTestDb, resetTestDb, type TestDb } from '@fleet-dao/db/testing';
import {
  createMemoryStore,
  createPgStore,
  devFixtures,
  IDS,
  type MemoryData,
  type Store,
} from '@fleet-dao/store';
import { seedPg } from '@fleet-dao/store/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheckoutHistory } from '../src/checkout-history-cli.ts';
import { runCli } from '../src/cli.ts';

const NOW = new Date('2026-10-19T05:00:00.000Z');
const NOTIFICATION_ID = 'f0000000-0000-4000-8000-000000000099';
const RUN_ID = 'd1000000-0000-4000-8000-000000013099';
const TEMPORAL_RUN_ID = 'temporal-checkout-history-1';
const WORKFLOW_ID = 'task:example/canary#13';
const HEAD = 'b'.repeat(40);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

function fixtureData() {
  const data = devFixtures(NOW);
  const run = {
    id: RUN_ID,
    segment: 'verify',
    taskId: IDS.task13,
    issueNumber: 13,
    model: 'opus-5.5',
    startedAt: '2026-10-19T03:00:00.000Z',
    endedAt: '2026-10-19T03:10:00.000Z',
    outcome: 'failed',
    prNumber: 39,
    workflowId: WORKFLOW_ID,
    temporalRunId: TEMPORAL_RUN_ID,
    failureReason: '缺对象',
  } as unknown as MemoryData['segmentRuns'][number];
  data.segmentRuns = [...(data.segmentRuns ?? []), run];
  data.notifications = [
    ...(data.notifications ?? []),
    {
      id: NOTIFICATION_ID,
      level: 'alert',
      title: 'checkout 失败',
      body: '历史 checkout 缺对象',
      link: `https://github.com/example/canary/pull/39`,
      taskId: IDS.task13,
      createdAt: '2026-10-19T03:10:00.000Z',
      raisedAt: '2026-10-19T03:10:00.000Z',
      dedupeKey: `cold-verify:checkout:${WORKFLOW_ID}`,
      deliveries: [],
    },
  ];
  return data;
}

function fixture() {
  return createMemoryStore(fixtureData(), { now: () => NOW });
}

async function inputFor(store: Pick<Store, 'readHistoricalCheckout'>) {
  const facts = await store.readHistoricalCheckout({
    notificationId: NOTIFICATION_ID,
    dedupeKey: `cold-verify:checkout:${WORKFLOW_ID}`,
    repo: 'example/canary',
    taskId: IDS.task13,
    issueNumber: 13,
    workflowId: WORKFLOW_ID,
    runId: RUN_ID,
    temporalRunId: TEMPORAL_RUN_ID,
    pr: 39,
    head: HEAD,
  });
  const raisedAt = facts.notification.raisedAt;
  const runEndedAt = facts.run.endedAt;
  const runOutcome = facts.run.outcome;
  const runPrNumber = facts.run.prNumber;
  if (!raisedAt || !runEndedAt || !runOutcome || runPrNumber === undefined) {
    throw new Error('测试历史 run 不完整');
  }
  return {
    notificationId: NOTIFICATION_ID,
    dedupeKey: facts.notification.dedupeKey,
    raisedAt,
    notificationBody: facts.notification.body,
    notificationLink: facts.notification.link ?? null,
    repo: 'example/canary',
    repoId: IDS.repo,
    taskId: IDS.task13,
    issueNumber: 13,
    workflowId: WORKFLOW_ID,
    runId: RUN_ID,
    temporalRunId: TEMPORAL_RUN_ID,
    runSegment: facts.run.segment,
    runStartedAt: facts.run.startedAt,
    runEndedAt,
    runOutcome,
    runPrNumber,
    pr: 39,
    head: HEAD,
    operator: 'founder',
    reason: '旧卡已按完整事实归档',
    evidence: '任务已结束，原 verify run 与 merged PR head 精确对应。',
    gaps: '没有可靠证据证明当时 checkout 曾成功恢复。',
    responsibility: '保留验收责任，部署后由指挥官独立核验。',
    conclusion: 'historical_unproven' as const,
  };
}

describe('checkout-history 私有 CLI', () => {
  it('默认只读预检，显式 archive 才撤卡；同一完整请求幂等', async () => {
    const store = fixture();
    const archiveInput = await inputFor(store);
    const before = (await store.listNotifications({ status: 'all', limit: 100 })).items.find(
      (n) => n.id === NOTIFICATION_ID,
    );
    const preflight = await runCheckoutHistory({
      store,
      body: JSON.stringify(archiveInput),
      archive: false,
      operator: 'founder',
    });
    expect(preflight.mode).toBe('preflight');
    expect(
      (await store.listNotifications({ status: 'all', limit: 100 })).items.find(
        (n) => n.id === NOTIFICATION_ID,
      )?.resolvedAt,
    ).toBe(before?.resolvedAt);

    const archived = await runCheckoutHistory({
      store,
      body: JSON.stringify(archiveInput),
      archive: true,
      operator: 'founder',
    });
    expect(archived).toMatchObject({ result: 'ok', conclusion: 'historical_unproven' });
    expect(
      (await store.listNotifications({ status: 'all', limit: 100 })).items.find(
        (n) => n.id === NOTIFICATION_ID,
      )?.resolvedBy,
    ).toBe('ops:checkout-history');
    const replay = await runCheckoutHistory({
      store,
      body: JSON.stringify(archiveInput),
      archive: true,
      operator: 'founder',
    });
    expect(replay).toMatchObject({ result: 'already_archived' });
  });

  it('CLI 装配默认只读，换代或操作者不匹配不写数据', async () => {
    const store = fixture();
    const archiveInput = await inputFor(store);
    const out: string[] = [];
    const code = await runCli(['checkout-history'], {
      env: { DATABASE_URL: 'memory', FLEET_OPS_OPERATOR: 'founder' },
      out: (text) => out.push(text),
      err: () => undefined,
      readStdin: async () => JSON.stringify(archiveInput),
      openStore: async () => ({ store, close: async () => undefined }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({
      mode: 'preflight',
      conclusion: 'historical_unproven',
    });

    const changed = { ...archiveInput, raisedAt: '2026-10-19T03:11:00.000Z' };
    await expect(
      runCheckoutHistory({
        store,
        body: JSON.stringify(changed),
        archive: true,
        operator: 'other',
      }),
    ).rejects.toThrow();
    expect(
      (await store.listNotifications({ status: 'all', limit: 100 })).items.find(
        (n) => n.id === NOTIFICATION_ID,
      )?.resolvedAt,
    ).toBeUndefined();
  });

  it('同一完整快照能走真实 Postgres Store 的预检、原子归档和幂等重放', async () => {
    await resetTestDb(testDb);
    await seedPg(testDb.db, fixtureData());
    await testDb.db.update(runs).set({ temporalRunId: TEMPORAL_RUN_ID }).where(eq(runs.id, RUN_ID));
    const store = createPgStore(testDb.db, { now: () => NOW });
    const archiveInput = await inputFor(store);
    const preflight = await runCheckoutHistory({
      store,
      body: JSON.stringify(archiveInput),
      archive: false,
      operator: 'founder',
    });
    expect(preflight).toMatchObject({ mode: 'preflight', conclusion: 'historical_unproven' });
    const archived = await runCheckoutHistory({
      store,
      body: JSON.stringify(archiveInput),
      archive: true,
      operator: 'founder',
    });
    expect(archived).toMatchObject({ result: 'ok' });
    const replay = await runCheckoutHistory({
      store,
      body: JSON.stringify(archiveInput),
      archive: true,
      operator: 'founder',
    });
    expect(replay).toMatchObject({ result: 'already_archived' });
  });
});
