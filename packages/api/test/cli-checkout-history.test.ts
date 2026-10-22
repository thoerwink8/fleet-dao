import { auditLog, notifications, runs } from '@fleet-dao/db';
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
import { temporal } from '@temporalio/proto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CheckoutExecutionReader, checkoutExecutionReader } from '../src/checkout-execution-reader.ts';
import { runCheckoutHistory } from '../src/checkout-history-cli.ts';
import { runCli } from '../src/cli.ts';
import { CHECKOUT_EXECUTION_ID, checkoutFixture } from './checkout-execution-fixture.ts';

const NOW = new Date('2026-10-19T05:00:00.000Z');
const NOTIFICATION_ID = 'f0000000-0000-4000-8000-000000000099';
const LEGACY_NOTIFICATION_ID = 'f0000000-0000-4000-8000-000000000098';
const RUN_ID = 'd1000000-0000-4000-8000-000000013099';
const OPEN_RUN_ID = 'd1000000-0000-4000-8000-000000013098';
const TEMPORAL_RUN_ID = CHECKOUT_EXECUTION_ID;
const WORKFLOW_ID = 'task:example/canary#13';
const HEAD = 'b'.repeat(40);
/** 照引擎 checkoutBlockedAlert 缺对象那一路写的整段正文。 */
const BODY =
  `目标 ${WORKFLOW_ID} 的 head ${HEAD}，目录 /var/lib/fleet-work/_tmp/verify-0f0e0d0c-0b0a-4908-8706-050403020100。` +
  '失败在「从镜像 git archive」这一步，原始错误：fatal: not a valid object name。' +
  `引擎镜像 /var/lib/fleet-github/mirrors/example/canary.git 里取不出目标 head ${HEAD}（git archive 认不出这个对象）。` +
  '请检查镜像里有没有这个提交，按既定 head 把它 fetch 进镜像后再验。这不是目录权限问题，别改属主或权限；引擎不自动重试。';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

function fixtureData(): Partial<MemoryData> {
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
  } as unknown as NonNullable<MemoryData['segmentRuns']>[number];
  data.segmentRuns = [...(data.segmentRuns ?? []), run];
  data.notifications = [
    ...(data.notifications ?? []),
    {
      id: NOTIFICATION_ID,
      level: 'alert',
      title: '冷验收放不进 PR 头的完整检出（从镜像 git archive）',
      body: BODY,
      link: 'https://github.com/example/canary/pull/39',
      taskId: IDS.task13,
      createdAt: '2026-10-19T03:10:00.000Z',
      raisedAt: '2026-10-19T03:10:00.000Z',
      dedupeKey: `cold-verify:checkout:${WORKFLOW_ID}`,
      deliveries: [],
    },
    {
      id: LEGACY_NOTIFICATION_ID,
      level: 'alert',
      title: '冷验收放不进 PR 头的完整检出（建检出目录）',
      body: BODY,
      createdAt: '2026-10-19T03:10:00.000Z',
      raisedAt: '2026-10-19T03:10:00.000Z',
      dedupeKey: 'cold-verify:checkout-dir',
      deliveries: [],
    },
  ];
  return data;
}

async function pgStore() {
  await resetTestDb(testDb);
  await seedPg(testDb.db, fixtureData());
  await testDb.db.update(runs).set({ temporalRunId: TEMPORAL_RUN_ID }).where(eq(runs.id, RUN_ID));
  return createPgStore(testDb.db, { now: () => NOW });
}

async function inputFor(
  store: Pick<Store, 'readHistoricalCheckoutCandidate'>,
  temporalRunId = TEMPORAL_RUN_ID,
  runId = RUN_ID,
) {
  const facts = await store.readHistoricalCheckoutCandidate({
    notificationId: NOTIFICATION_ID,
    dedupeKey: `cold-verify:checkout:${WORKFLOW_ID}`,
    repo: 'example/canary',
    taskId: IDS.task13,
    issueNumber: 13,
    workflowId: WORKFLOW_ID,
    runId,
    temporalRunId,
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
    runId,
    temporalRunId,
    executionRunId: CHECKOUT_EXECUTION_ID,
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

const reader: CheckoutExecutionReader = {
  async read(id, signal) {
    return checkoutFixture({
      ...id,
      runStartedAt: '2026-10-19T03:00:00.000Z',
      runEndedAt: '2026-10-19T03:40:00.000Z',
    }).reader.read(id, signal);
  },
};

async function cli(store: Store, args: string[], body: string, operator = 'founder', sourceReader = reader) {
  const out: string[] = [];
  const code = await runCli(['checkout-history', ...args], {
    checkoutExecutionReader: sourceReader,
    env: { DATABASE_URL: 'memory', FLEET_OPS_OPERATOR: operator },
    out: (text) => out.push(text),
    err: () => undefined,
    readStdin: async () => body,
    openStore: async () => ({ store, close: async () => undefined }),
    now: () => NOW,
  });
  return { code, json: JSON.parse(out[0] ?? '{}') as Record<string, unknown> };
}

const notificationOf = async (store: Store, id = NOTIFICATION_ID) =>
  (await store.listNotifications({ status: 'all', limit: 100 })).items.find((n) => n.id === id);
const audits = async (store: Store, id = NOTIFICATION_ID) =>
  (await store.listAudit({ target: `notification:${id}`, limit: 100 })).items;

describe('checkout-history 私有 CLI（内存版）', () => {
  it('默认只读预检，显式 archive 才撤卡；同一完整请求幂等', async () => {
    const store = createMemoryStore(fixtureData(), { now: () => NOW });
    const archiveInput = await inputFor(store);
    const preflight = await runCheckoutHistory({
      reader,
      store,
      body: JSON.stringify(archiveInput),
      archive: false,
      operator: 'founder',
    });
    expect(preflight.mode).toBe('preflight');
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    const archived = await runCheckoutHistory({
      reader,
      store,
      body: JSON.stringify(archiveInput),
      archive: true,
      operator: 'founder',
    });
    expect(archived).toMatchObject({ result: 'ok', conclusion: 'historical_unproven' });
    expect((await notificationOf(store))?.resolvedBy).toBe('ops:checkout-history');
    const replay = await runCheckoutHistory({
      reader,
      store,
      body: JSON.stringify(archiveInput),
      archive: true,
      operator: 'founder',
    });
    expect(replay).toMatchObject({ result: 'already_archived' });
  });
});

describe('checkout-history 私有 CLI（真实 Postgres Store）', () => {
  let store: Store;
  beforeEach(async () => {
    store = await pgStore();
  });

  it('#3546 首报旧 run 与后来正文 head 不得拼接为预检成功', async () => {
    await testDb.db.update(runs).set({ temporalRunId: null }).where(eq(runs.id, RUN_ID));
    // 通知正文/merged PR 是后来 HEAD；当前库没有 head 列，旧起止正好包含首报 raisedAt。
    // 可信 reader 明确拒绝这个 run/head 关联，命令不得忽略来源仍回 ok。
    const input = await inputFor(store, '');
    const out: string[] = [];
    const code = await runCli(['checkout-history'], {
      env: { DATABASE_URL: 'memory', FLEET_OPS_OPERATOR: 'founder' },
      out: (text) => out.push(text),
      err: () => undefined,
      readStdin: async () => JSON.stringify(input),
      openStore: async () => ({ store, close: async () => undefined }),
      now: () => NOW,
      checkoutExecutionReader: { read: async () => ({ kind: 'unknown', code: 'run_head_conflict' }) },
    });
    expect(code).toBe(1);
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('#3546 两个NULL旧列的真实活动形状：旧run+新head拒绝，后来run保留首报raisedAt可归档', async () => {
    await testDb.db.update(runs).set({ temporalRunId: null }).where(eq(runs.id, RUN_ID));
    const laterId = 'd1000000-0000-4000-8000-000000013096';
    await testDb.db.insert(runs).values({
      id: laterId,
      taskId: IDS.task13,
      issueNumber: 13,
      workflowId: WORKFLOW_ID,
      temporalRunId: null,
      segment: 'verify',
      model: 'opus-5.5',
      prNumber: 39,
      outcome: 'done',
      startedAt: new Date('2026-10-19T04:00:00.000Z'),
      endedAt: new Date('2026-10-19T04:10:00.000Z'),
    });
    let reads = 0;
    const original: CheckoutExecutionReader = {
      async read(identity, signal) {
        reads++;
        const old = checkoutFixture({
          ...identity,
          head: 'a'.repeat(40),
          runStartedAt: '2026-10-19T03:00:00.000Z',
          runEndedAt: '2026-10-19T03:10:00.000Z',
        });
        const later = checkoutFixture({
          ...identity,
          head: HEAD,
          runStartedAt: '2026-10-19T04:00:00.000Z',
          runEndedAt: '2026-10-19T04:10:00.000Z',
        });
        const events = [...old.events.slice(0, 4), ...later.events.slice(1)];
        events.forEach((event, i) => {
          event.eventId = temporal.api.history.v1.HistoryEvent.fromObject({ eventId: String(i + 1) }).eventId;
        });
        events[5]!.activityTaskStartedEventAttributes!.scheduledEventId = events[4]!.eventId;
        events[6]!.activityTaskCompletedEventAttributes!.scheduledEventId = events[4]!.eventId;
        events[6]!.activityTaskCompletedEventAttributes!.startedEventId = events[5]!.eventId;
        old.pages[0]!.history!.events = events;
        old.description.workflowExecutionInfo!.historyLength = events[7]!.eventId;
        return checkoutExecutionReader(old.connection as never, 'test').read(identity, signal);
      },
    };
    const old = await inputFor(store, '');
    expect((await cli(store, [], JSON.stringify(old), 'founder', original)).code).toBe(1);
    expect((await cli(store, ['--archive'], JSON.stringify(old), 'founder', original)).code).toBe(1);
    expect(await audits(store)).toEqual([]);
    const later = await inputFor(store, '', laterId);
    expect(later.raisedAt).toBe('2026-10-19T03:10:00.000Z');
    expect((await cli(store, [], JSON.stringify(later), 'founder', original)).code).toBe(0);
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect((await cli(store, ['--archive'], JSON.stringify(later), 'founder', original)).code).toBe(0);
    expect(reads).toBe(4);
    expect((await notificationOf(store))?.raisedAt).toBe(later.raisedAt);
    expect((await audits(store))[0]?.after).toMatchObject({
      runId: laterId,
      checkoutSource: { scheduled: '5', started: '6', completed: '7', head: HEAD },
    });
  });

  it('预检和执行分别重取可信来源；执行读失败不重用旧凭据，也不接caller上传proof', async () => {
    const input = await inputFor(store);
    expect((await cli(store, [], JSON.stringify(input))).code).toBe(0);
    const unreadable: CheckoutExecutionReader = {
      read: async () => ({ kind: 'unknown', code: 'read_failed' }),
    };
    expect((await cli(store, ['--archive'], JSON.stringify(input), 'founder', unreadable)).code).toBe(1);
    expect(
      (await cli(store, ['--archive'], JSON.stringify({ ...input, checkoutSource: { trusted: true } }))).code,
    ).toBe(1);
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('网络读取期间任务复活或通知换代：锁外取证完成后锁内CAS拒绝且不审计', async () => {
    const input = await inputFor(store);
    const changed: CheckoutExecutionReader = {
      async read(identity, signal) {
        const proof = await reader.read(identity, signal);
        // 在 reader 里正常写同一测试库，证明 RPC 调用没有包在 PG 持锁事务中。
        await testDb.db
          .update(notifications)
          .set({ raisedAt: new Date('2026-10-19T04:00:00.000Z') })
          .where(eq(notifications.id, NOTIFICATION_ID));
        return proof;
      },
    };
    expect((await cli(store, ['--archive'], JSON.stringify(input), 'founder', changed)).code).toBe(1);
    expect((await notificationOf(store))?.raisedAt).toBe('2026-10-19T04:00:00.000Z');
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('不带 --archive 是只读预检：回显事实，不写通知也不写审计', async () => {
    const input = await inputFor(store);
    const { code, json } = await cli(store, [], JSON.stringify(input));
    expect(code).toBe(0);
    expect(json).toMatchObject({ mode: 'preflight', conclusion: 'historical_unproven', activeRunIds: [] });
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('--archive 同事务落账：撤卡 + 审计保留原始失败证据，不改任务/run、不写 checkout_full', async () => {
    const input = await inputFor(store);
    const taskBefore = await store.getTask(IDS.task13);
    const runsBefore = await store.listSegmentRuns(IDS.task13);
    const { code, json } = await cli(store, ['--archive'], JSON.stringify(input));
    expect(code).toBe(0);
    expect(json).toMatchObject({ mode: 'archive', result: 'ok', conclusion: 'historical_unproven' });
    const archived = await notificationOf(store);
    expect(archived).toMatchObject({ resolvedBy: 'ops:checkout-history', body: BODY });
    const [record, ...rest] = await audits(store);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      action: 'notification.checkout_history_archive',
      actor: { kind: 'ops', id: 'ops:checkout-history' },
      via: 'ops',
      ok: true,
      after: {
        notificationBody: BODY,
        originalTitle: '冷验收放不进 PR 头的完整检出（从镜像 git archive）',
        runFailureReason: '缺对象',
        runOutcome: 'failed',
        operator: 'founder',
        conclusion: 'historical_unproven',
        evidence: input.evidence,
        gaps: input.gaps,
        responsibility: input.responsibility,
      },
    });
    expect(await store.getTask(IDS.task13)).toEqual(taskBefore);
    expect(await store.listSegmentRuns(IDS.task13)).toEqual(runsBefore);
    expect(
      (await store.listAudit({ limit: 100 })).items.some((a) => a.action.startsWith('cold_verify')),
    ).toBe(false);
    expect((await cli(store, ['--archive'], JSON.stringify(input))).json).toMatchObject({
      result: 'already_archived',
    });
    expect(await audits(store)).toHaveLength(1);
  });

  it('参数不对退出码 2；archive 必须带完整快照、实际操作者一致；都不写数据', async () => {
    const input = await inputFor(store);
    expect((await cli(store, ['--force'], JSON.stringify(input))).code).toBe(2);
    const { raisedAt: _drop, ...partial } = input;
    expect((await cli(store, ['--archive'], JSON.stringify(partial))).code).toBe(1);
    expect(
      (await cli(store, ['--archive'], JSON.stringify({ ...input, conclusion: 'recovered' }))).code,
    ).toBe(1);
    expect((await cli(store, ['--archive'], JSON.stringify(input), 'other')).code).toBe(1);
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('#3067 真实形状（outcome=done、temporal_run_id 为空、报警早于 run 起点 46ms）：预检可归档，--archive 写出归档记录', async () => {
    await testDb.db
      .update(runs)
      .set({
        outcome: 'done',
        failureReason: null,
        temporalRunId: null,
        startedAt: new Date('2026-10-19T03:10:00.046Z'),
        endedAt: new Date('2026-10-19T03:40:00.000Z'),
      })
      .where(eq(runs.id, RUN_ID));
    const input = await inputFor(store, '');
    expect(input).toMatchObject({
      temporalRunId: '',
      runOutcome: 'done',
      raisedAt: '2026-10-19T03:10:00.000Z',
      runStartedAt: '2026-10-19T03:10:00.046Z',
    });
    const preflight = await cli(store, [], JSON.stringify(input));
    expect(preflight.code).toBe(0);
    expect(preflight.json).toMatchObject({ mode: 'preflight', activeRunIds: [] });
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);

    const archived = await cli(store, ['--archive'], JSON.stringify(input));
    expect(archived.code).toBe(0);
    expect(archived.json).toMatchObject({ mode: 'archive', result: 'ok', conclusion: 'historical_unproven' });
    expect(await notificationOf(store)).toMatchObject({ resolvedBy: 'ops:checkout-history', body: BODY });
    const [record, ...rest] = await audits(store);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      action: 'notification.checkout_history_archive',
      actor: { kind: 'ops', id: 'ops:checkout-history' },
      ok: true,
      before: { workflowId: WORKFLOW_ID, runId: RUN_ID, temporalRunId: '' },
      after: {
        notificationBody: BODY,
        originalTitle: '冷验收放不进 PR 头的完整检出（从镜像 git archive）',
        runOutcome: 'done',
        runStartedAt: '2026-10-19T03:10:00.046Z',
        runFailureReason: null,
        temporalRunId: '',
        operator: 'founder',
        conclusion: 'historical_unproven',
        evidence: input.evidence,
        gaps: input.gaps,
        responsibility: input.responsibility,
      },
    });
    expect((await cli(store, ['--archive'], JSON.stringify(input))).json).toMatchObject({
      result: 'already_archived',
    });
    expect(await audits(store)).toHaveLength(1);
  });

  it('没进到放检出那一步的原 verify 段（admission_blocked）、或通知只是相似不是受管格式：预检和 archive 都拒，什么都不写', async () => {
    const input = await inputFor(store);
    await testDb.db
      .update(runs)
      .set({ outcome: 'admission_blocked', failureReason: null })
      .where(eq(runs.id, RUN_ID));
    const blocked = { ...input, runOutcome: 'admission_blocked' };
    expect((await cli(store, [], JSON.stringify(blocked))).code).toBe(1);
    expect((await cli(store, ['--archive'], JSON.stringify(blocked))).code).toBe(1);
    await testDb.db
      .update(runs)
      .set({ outcome: 'failed', failureReason: '缺对象' })
      .where(eq(runs.id, RUN_ID));
    const forged = `${BODY}另附一句。`;
    await testDb.db.update(notifications).set({ body: forged }).where(eq(notifications.id, NOTIFICATION_ID));
    const similar = { ...input, notificationBody: forged };
    expect((await cli(store, [], JSON.stringify(similar))).code).toBe(1);
    expect((await cli(store, ['--archive'], JSON.stringify(similar))).code).toBe(1);
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('alert-sweep 已在正文前补了立案/跳过立案前缀的真实历史卡：预检、archive 都认，审计保留带前缀的原正文', async () => {
    const prefixed = `已立案：#41（2026-10-09）\n\n没有可做的事，已跳过立案\n\n${BODY}`;
    await testDb.db
      .update(notifications)
      .set({ body: prefixed })
      .where(eq(notifications.id, NOTIFICATION_ID));
    const input = await inputFor(store);
    expect(input.notificationBody).toBe(prefixed);
    expect((await cli(store, [], JSON.stringify(input))).json).toMatchObject({ mode: 'preflight' });
    const archived = await cli(store, ['--archive'], JSON.stringify(input));
    expect(archived.code).toBe(0);
    expect(archived.json).toMatchObject({ result: 'ok' });
    expect(await notificationOf(store)).toMatchObject({ resolvedBy: 'ops:checkout-history', body: prefixed });
    const [record, ...rest] = await audits(store);
    expect(rest).toEqual([]);
    expect(record?.after).toMatchObject({ notificationBody: prefixed });
    expect((await cli(store, ['--archive'], JSON.stringify(input))).json).toMatchObject({
      result: 'already_archived',
    });
  });

  it('旧的无目标 checkout-dir 键仍拒绝', async () => {
    const input = await inputFor(store);
    const legacy = {
      ...input,
      notificationId: LEGACY_NOTIFICATION_ID,
      dedupeKey: 'cold-verify:checkout-dir',
      notificationLink: null,
    };
    expect((await cli(store, [], JSON.stringify(legacy))).code).toBe(1);
    expect((await cli(store, ['--archive'], JSON.stringify(legacy))).code).toBe(1);
    expect((await notificationOf(store, LEGACY_NOTIFICATION_ID))?.resolvedAt).toBeUndefined();
    expect(await audits(store, LEGACY_NOTIFICATION_ID)).toEqual([]);
  });

  it('仍有活执行：预检列出，archive 拒绝；归档不触碰任务活跃故障', async () => {
    const input = await inputFor(store);
    await testDb.db.insert(runs).values({
      id: OPEN_RUN_ID,
      segment: 'manual',
      taskId: IDS.task13,
      issueNumber: 13,
      workflowId: WORKFLOW_ID,
      model: 'opus-5.5',
      startedAt: new Date('2026-10-19T04:00:00.000Z'),
    });
    const pre = await cli(store, [], JSON.stringify(input));
    expect(pre.json).toMatchObject({ mode: 'preflight', activeRunIds: [OPEN_RUN_ID] });
    const out = await cli(store, ['--archive'], JSON.stringify(input));
    expect(out.code).toBe(1);
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(await audits(store)).toEqual([]);
  });

  it('预检后通知换代（同键重开、raisedAt 变了）：归档被拒，新事故保持打开', async () => {
    const input = await inputFor(store);
    await testDb.db
      .update(notifications)
      .set({ raisedAt: new Date('2026-10-19T04:00:00.000Z') })
      .where(eq(notifications.id, NOTIFICATION_ID));
    const out = await cli(store, ['--archive'], JSON.stringify(input));
    expect(out.code).toBe(1);
    const n = await notificationOf(store);
    expect(n?.resolvedAt).toBeUndefined();
    expect(n?.raisedAt).toBe('2026-10-19T04:00:00.000Z');
    expect(await audits(store)).toEqual([]);
  });

  it('appendAudit 失败：撤卡一起回滚，通知保持打开且没有审计', async () => {
    const input = await inputFor(store);
    await testDb.client.exec(`
      create function test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit write blocked by test'; end $$;
      create trigger fail_audit before insert on audit_log for each row execute function test_fail_audit();
    `);
    try {
      const out = await cli(store, ['--archive'], JSON.stringify(input));
      expect(out.code).toBe(1);
    } finally {
      await testDb.client.exec('drop trigger fail_audit on audit_log; drop function test_fail_audit();');
    }
    expect((await notificationOf(store))?.resolvedAt).toBeUndefined();
    expect(
      await testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.target, `notification:${NOTIFICATION_ID}`)),
    ).toEqual([]);
    expect((await cli(store, ['--archive'], JSON.stringify(input))).json).toMatchObject({ result: 'ok' });
  });

  it('并发：两个相同的 archive 请求恰一个 ok、一个 already_archived，只落一条审计', async () => {
    const input = await inputFor(store);
    const body = JSON.stringify(input);
    const results = await Promise.all([
      runCheckoutHistory({ reader, store, body, archive: true, operator: 'founder' }),
      runCheckoutHistory({ reader, store, body, archive: true, operator: 'founder' }),
    ]);
    expect(results.map((r) => ('result' in r ? r.result : undefined)).sort()).toEqual([
      'already_archived',
      'ok',
    ]);
    expect(await audits(store)).toHaveLength(1);
  });

  it('不是「已 resolved 就假成功」：别处手工处理过的通知，archive 被拒', async () => {
    const input = await inputFor(store);
    await testDb.db
      .update(notifications)
      .set({ resolvedAt: NOW, resolvedBy: 'someone' })
      .where(eq(notifications.id, NOTIFICATION_ID));
    expect((await cli(store, ['--archive'], JSON.stringify(input))).code).toBe(1);
    expect(await audits(store)).toEqual([]);
  });
});
