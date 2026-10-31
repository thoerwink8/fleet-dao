// 任务波次图的快照（#3784）：推导（各种活/交回/影子产物的组合 → 节点状态）、PGlite 真迁移上的读、HTTP 口的鉴权和参数、
// 以及「读的行数跟这一批走」的证据——每条查询在关掉顺序扫描后 EXPLAIN 出来走的是哪个索引。
import { type BatchesPage, GRAPH_NODE_MAX, type WorkGraph } from '@fleet-dao/harness-contract/work-graph';
import { freezeBatch, jobs, recordShadowRun, shadowCompare } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COCKPIT_COOKIE, type CockpitApi, createCockpitApi, signSessionCookie } from '../src/cockpit.ts';
import { appendToSession, appendToStream } from '../src/events.ts';
import {
  deriveNode,
  deriveNodeState,
  type HandbackRow,
  listBatches,
  loadBatchGraph,
  type NodeInput,
  workQueries,
} from '../src/work.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const SHA = 'a'.repeat(40);

const req = { eventId: 7, taskId: 't-1', repo: 'o/web', issue: 1, task: '修窄屏登录' };
const job = (over: Partial<NodeInput['job'] & object> = {}): NonNullable<NodeInput['job']> => ({
  key: 'spawn:7',
  state: 'pending',
  attempts: 0,
  leaseUntil: null,
  claimedAt: null,
  updatedAt: '2026-10-31T11:00:00.000000Z',
  lastError: null,
  ...over,
});
const hb = (over: Partial<HandbackRow> = {}): HandbackRow => ({
  eventId: 9,
  taskId: 't-1',
  runId: 'd7-a1',
  attempt: 1,
  final: true,
  outcome: 'completed',
  verdict: 'passed',
  reason: '核验通过',
  at: '2026-10-31T11:30:00.000000Z',
  ...over,
});
const input = (over: Partial<NodeInput> = {}): NodeInput => ({
  repo: 'o/web',
  issue: 1,
  request: req,
  job: undefined,
  handbacks: [],
  runs: [],
  shadowRuns: [],
  progress: null,
  score: null,
  ...over,
});
const stateOf = (over: Partial<NodeInput>) => deriveNodeState(input(over), NOW);

describe('节点状态推导', () => {
  it('还没派工请求 → 排队中', () => {
    expect(stateOf({ request: undefined })).toBe('pending');
    expect(stateOf({ job: undefined })).toBe('pending');
  });

  it('活的各状态', () => {
    expect(stateOf({ job: job() })).toBe('pending');
    // 领过又退回来，等着重试
    expect(stateOf({ job: job({ attempts: 1 }) })).toBe('scheduled');
    // 发版暂停退回队列
    expect(
      stateOf({ job: job({ attempts: 1 }), handbacks: [hb({ final: false, outcome: 'released' })] }),
    ).toBe('paused');
    expect(
      stateOf({ job: job({ state: 'claimed', attempts: 1, leaseUntil: '2026-10-31T12:01:00.000000Z' }) }),
    ).toBe('running');
    // 租约过期还没人回收
    expect(
      stateOf({ job: job({ state: 'claimed', attempts: 1, leaseUntil: '2026-10-31T11:59:00.000000Z' }) }),
    ).toBe('blocked');
    expect(stateOf({ job: job({ state: 'cancelled' }) })).toBe('cancelled');
    expect(stateOf({ job: job({ state: 'dead', attempts: 3 }) })).toBe('failed');
    expect(stateOf({ job: job({ state: 'done' }) })).toBe('completed');
  });

  it('终局交回压过活的状态；核验没过算失败，结局不确定算被卡住', () => {
    const claimed = job({ state: 'claimed', attempts: 1, leaseUntil: '2026-10-31T12:01:00.000000Z' });
    expect(stateOf({ job: claimed, handbacks: [hb()] })).toBe('completed');
    expect(stateOf({ handbacks: [hb({ outcome: 'delivered', verdict: 'pass' })] })).toBe('completed');
    expect(stateOf({ handbacks: [hb({ verdict: 'failed' })] })).toBe('failed');
    expect(stateOf({ handbacks: [hb({ outcome: 'killed', verdict: 'failed' })] })).toBe('failed');
    expect(stateOf({ handbacks: [hb({ outcome: 'failed-to-start' })] })).toBe('failed');
    expect(stateOf({ handbacks: [hb({ outcome: 'cancelled' })] })).toBe('cancelled');
    expect(stateOf({ handbacks: [hb({ outcome: 'uncertain', verdict: 'unknown' })] })).toBe('blocked');
    // 非终局的交回（会重试）不改状态
    expect(
      stateOf({
        job: claimed,
        handbacks: [hb({ final: false, outcome: 'failed-to-start', verdict: 'failed' })],
      }),
    ).toBe('running');
  });

  it('没有活时看影子产物', () => {
    const run = { id: 1, runId: 'd7-a1', at: '2026-10-31T11:30:00.000000Z' };
    expect(stateOf({ shadowRuns: [{ ...run, verdict: 'passed' }] })).toBe('completed');
    expect(stateOf({ shadowRuns: [{ ...run, verdict: 'failed' }] })).toBe('failed');
  });

  it('节点：重试次数、运行号、一句话说明、完成时刻、打分', () => {
    const n = deriveNode(
      input({
        job: job({
          state: 'claimed',
          attempts: 2,
          leaseUntil: '2026-10-31T12:01:00.000000Z',
          claimedAt: '2026-10-31T11:50:00.000000Z',
        }),
        handbacks: [
          hb({ final: false, outcome: 'failed-to-start', verdict: 'failed', reason: '没起来', attempt: 1 }),
        ],
        runs: [
          { runId: 'd7-a1', startedAt: '2026-10-31T11:00:00.000000Z', model: 'm-1' },
          { runId: 'd7-a2', startedAt: '2026-10-31T11:50:00.000000Z', model: 'm-2' },
        ],
        progress: '  正在跑\n测试  ',
      }),
      NOW,
    );
    expect(n).toMatchObject({
      id: 'o/web#1',
      label: 'web#1',
      state: 'running',
      attempt: 2,
      startedAt: '2026-10-31T11:50:00.000000Z',
      completedAt: null,
      model: 'm-2',
      category: 'shadow',
      headline: '正在跑 测试',
      runIds: ['d7-a1', 'd7-a2'],
      score: null,
    });
    const done = deriveNode(input({ handbacks: [hb()], score: { lineJaccard: 0.5, fileJaccard: 1 } }), NOW);
    expect(done).toMatchObject({
      state: 'completed',
      completedAt: '2026-10-31T11:30:00.000000Z',
      headline: '核验通过',
    });
    expect(done.score).toEqual({ lineJaccard: 0.5, fileJaccard: 1 });
    // 失败：说明取交回的原因，退到出错原因，再退到任务标题
    expect(
      deriveNode(input({ handbacks: [hb({ outcome: 'killed', reason: '被叫停' })] }), NOW).headline,
    ).toBe('被叫停');
    expect(
      deriveNode(input({ job: job({ state: 'dead', lastError: '尝试 3 次都没起来' }) }), NOW).headline,
    ).toBe('尝试 3 次都没起来');
    expect(deriveNode(input({ job: job() }), NOW).headline).toBe('修窄屏登录');
    // 超长的说明截断
    expect(deriveNode(input({ progress: 'x'.repeat(500) }), NOW).headline).toHaveLength(160);
  });
});

// ---------------------------------------------------------------- 真库

const SECRET = 'test-secret-0123456789abcdef-test';
const FOUNDER = '00000000-0000-4000-8000-000000000001';
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await t.pg.exec(`
    create table public.users (
      id uuid primary key, role text not null, active boolean not null default true,
      session_version integer not null default 0
    );
    insert into public.users (id, role) values ('${FOUNDER}', 'founder');
  `);
}, 60_000);
afterAll(() => t.close());

const FUTURE = new Date(Date.now() + 3_600_000);
const PAST = new Date(Date.now() - 3_600_000);

interface Seeded {
  state: Record<string, string>;
}

/** 一批 9 张单，覆盖：排队、在跑、做完（带打分）、失败、重试中、暂停、租约过期、放弃、取消。 */
async function seedBatch(batchId: string, at: Date, prefix = 'o/web'): Promise<Seeded> {
  const { db } = t;
  const issues = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  await freezeBatch(
    db,
    batchId,
    issues.map((issue) => ({ repo: prefix, issue, baseSha: SHA, snapshotAt: at })),
  );
  const session = `shadow-${batchId}`;
  const want: Record<string, string> = {};
  const request = async (issue: number) => {
    const ev = await appendToSession(db, session, 'worker.spawn.requested', {
      taskId: `${batchId}-t${issue}`,
      task: `第 ${issue} 张单\n后面还有很多`,
      shadow: { batchId, repo: prefix, issue, baseSha: SHA },
    });
    return ev.id;
  };
  const addJob = async (
    eventId: number,
    over: Partial<typeof jobs.$inferInsert> & { state: string },
  ): Promise<void> => {
    await db.insert(jobs).values({
      queue: 'worker',
      key: `spawn:${eventId}`,
      payload: {},
      ...(over.state === 'claimed' ? { claimToken: 'tok', leaseUntil: FUTURE } : {}),
      ...over,
    });
  };
  const spawned = (runId: string, model = 'claude-sonnet-5-5') =>
    appendToStream(db, `worker:${runId}`, 'worker.spawned', { runId, model, shadow: true });
  const handback = (issue: number, p: Record<string, unknown>) =>
    appendToSession(db, session, 'handback.recorded', { taskId: `${batchId}-t${issue}`, ...p });

  // 1 排队：只在清单里，没有派工请求（want pending）
  want['1'] = 'pending';
  // 2 在跑
  let e = await request(2);
  await addJob(e, { state: 'claimed', attempts: 1 });
  await spawned(`d${e}-a1`);
  await appendToSession(db, `worker-d${e}-a1`, 'worker.progress.reported', { summary: '第一句' });
  await appendToSession(db, `worker-d${e}-a1`, 'worker.progress.reported', { summary: '最近一句' });
  want['2'] = 'running';
  // 3 做完（有影子产物和打分）
  e = await request(3);
  await addJob(e, { state: 'done', attempts: 1 });
  await spawned(`d${e}-a1`);
  await handback(3, {
    runId: `d${e}-a1`,
    attempt: 1,
    final: true,
    outcome: 'completed',
    verdict: 'passed',
    reasons: ['改动只在登录页'],
  });
  const runRowId = await recordShadowRun(db, {
    runId: `d${e}-a1`,
    batchId,
    repo: prefix,
    issue: 3,
    baseSha: SHA,
    verdict: 'passed',
    patch: 'diff --git a/x b/x\n'.repeat(2000),
    wallMs: 1000,
  });
  await db.insert(shadowCompare).values({
    shadowRunId: runRowId,
    batchId,
    mergedPr: 1,
    mergedSha: SHA,
    score: { lineJaccard: 0.62, fileJaccard: 1 },
  });
  want['3'] = 'completed';
  // 4 失败
  e = await request(4);
  await addJob(e, { state: 'done', attempts: 1 });
  await spawned(`d${e}-a1`);
  await handback(4, {
    runId: `d${e}-a1`,
    attempt: 1,
    final: true,
    outcome: 'killed',
    verdict: 'failed',
    reasons: ['被停：no_progress'],
  });
  want['4'] = 'failed';
  // 5 重试中（第 2 次在跑）
  e = await request(5);
  await addJob(e, { state: 'claimed', attempts: 2 });
  await spawned(`d${e}-a1`, 'm-old');
  await spawned(`d${e}-a2`, 'm-new');
  await handback(5, {
    runId: `d${e}-a1`,
    attempt: 1,
    final: false,
    willRetry: true,
    outcome: 'failed-to-start',
    verdict: 'failed',
    reasons: ['没起来'],
  });
  want['5'] = 'running';
  // 6 暂停（发版退回队列）
  e = await request(6);
  await addJob(e, { state: 'pending', attempts: 1 });
  await handback(6, {
    runId: `d${e}-a1`,
    attempt: 1,
    final: false,
    willRetry: true,
    outcome: 'released',
    verdict: 'unknown',
    reasons: ['派工器停机'],
  });
  want['6'] = 'paused';
  // 7 租约过期
  e = await request(7);
  await addJob(e, { state: 'claimed', attempts: 1, leaseUntil: PAST });
  want['7'] = 'blocked';
  // 8 放弃
  e = await request(8);
  await addJob(e, { state: 'dead', attempts: 3, lastError: '三次都没起来' });
  want['8'] = 'failed';
  // 9 取消
  e = await request(9);
  await addJob(e, { state: 'cancelled', attempts: 1 });
  want['9'] = 'cancelled';
  return { state: want };
}

describe('读一批的快照（PGlite 真迁移）', () => {
  let graph: WorkGraph;
  beforeAll(async () => {
    await seedBatch('b-one', new Date('2026-10-30T10:00:00Z'));
    graph = (await loadBatchGraph(t.db, 'b-one')) as WorkGraph;
  });

  it('一张单一个节点，状态由活、交回、影子产物推出；全在第 0 波、没有边', () => {
    expect(graph.nodes.map((n) => [n.id, n.state])).toEqual([
      ['o/web#1', 'pending'],
      ['o/web#2', 'running'],
      ['o/web#3', 'completed'],
      ['o/web#4', 'failed'],
      ['o/web#5', 'running'],
      ['o/web#6', 'paused'],
      ['o/web#7', 'blocked'],
      ['o/web#8', 'failed'],
      ['o/web#9', 'cancelled'],
    ]);
    expect(graph.waves).toEqual([{ index: 0, nodeIds: graph.nodes.map((n) => n.id) }]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncatedFrom).toBeNull();
    expect(graph.batchId).toBe('b-one');
  });

  it('在跑的带最近一句进度和模型；重试过的带两个运行号、第 2 次的模型', () => {
    const by = (n: number) => graph.nodes.find((x) => x.id === `o/web#${n}`);
    expect(by(2)).toMatchObject({
      headline: '最近一句',
      attempt: 1,
      model: 'claude-sonnet-5-5',
      category: 'shadow',
    });
    expect(by(2)?.runIds).toHaveLength(1);
    expect(by(5)).toMatchObject({ attempt: 2, model: 'm-new' });
    expect(by(5)?.runIds).toHaveLength(2);
    expect(by(5)?.runIds[0]).toMatch(/-a1$/);
    expect(by(5)?.runIds[1]).toMatch(/-a2$/);
    // 排队的没有运行号、没有开始时间
    expect(by(1)).toMatchObject({ attempt: 0, runIds: [], startedAt: null, headline: null });
  });

  it('做完的带打分、完成时刻和交回的原因；失败的说明是原因', () => {
    const by = (n: number) => graph.nodes.find((x) => x.id === `o/web#${n}`);
    expect(by(3)?.score).toEqual({ lineJaccard: 0.62, fileJaccard: 1 });
    expect(by(3)?.headline).toBe('改动只在登录页');
    expect(by(3)?.completedAt).not.toBeNull();
    expect(by(4)?.headline).toBe('被停：no_progress');
    expect(by(8)?.headline).toBe('三次都没起来');
    expect(by(2)?.score).toBeNull();
  });

  it('批次不存在返回 null', async () => {
    expect(await loadBatchGraph(t.db, 'no-such')).toBeNull();
  });

  it('批次列表：从新到老、带单数和各状态数、翻页游标接得上', async () => {
    await seedBatch('b-two', new Date('2026-10-31T10:00:00Z'), 'o/api');
    await seedBatch('b-three', new Date('2026-10-29T10:00:00Z'), 'o/lib');
    const p1 = await listBatches(t.db, { limit: 2 });
    expect(p1.batches.map((b) => b.batchId)).toEqual(['b-two', 'b-one']);
    expect(p1.batches[0]).toMatchObject({ items: 9, snapshotAt: '2026-10-31T10:00:00.000000Z' });
    expect(p1.batches[0]?.counts).toEqual({
      pending: 1,
      running: 2,
      completed: 1,
      failed: 2,
      paused: 1,
      blocked: 1,
      cancelled: 1,
    });
    expect(p1.nextBefore).toBe('2026-10-30T10:00:00.000000Z');
    const p2 = await listBatches(t.db, { limit: 2, before: p1.nextBefore as string });
    expect(p2.batches.map((b) => b.batchId)).toEqual(['b-three']);
    expect(p2.nextBefore).toBeNull();
    expect((await listBatches(t.db, { limit: 10 })).nextBefore).toBeNull();
  });

  it('清单超过上限只给前面的，truncatedFrom 写真实总数', async () => {
    const n = GRAPH_NODE_MAX + 3;
    await freezeBatch(
      t.db,
      'b-big',
      Array.from({ length: n }, (_, i) => ({
        repo: 'o/big',
        issue: i + 1,
        baseSha: SHA,
        snapshotAt: new Date('2026-10-01T00:00:00Z'),
      })),
    );
    const g = (await loadBatchGraph(t.db, 'b-big')) as WorkGraph;
    expect(g.nodes).toHaveLength(GRAPH_NODE_MAX);
    expect(g.truncatedFrom).toBe(n);
    await t.pg.exec("delete from fleet2.shadow_batch_items where batch_id = 'b-big'");
  });
});

describe('读的行数跟这一批走：每条查询走的索引（关掉顺序扫描后 EXPLAIN）', () => {
  async function plan(q: ReturnType<(typeof workQueries)[keyof typeof workQueries]>): Promise<string> {
    await t.pg.exec('set enable_seqscan = off; set enable_bitmapscan = off');
    try {
      const r = (await t.db.execute(sql`explain ${q}`)) as unknown as { rows: Record<string, string>[] };
      return r.rows.map((x) => Object.values(x)[0]).join('\n');
    } finally {
      await t.pg.exec('reset enable_seqscan; reset enable_bitmapscan');
    }
  }

  it.each([
    ['清单', () => workQueries.items('b', 10), 'shadow_batch_items_unique'],
    ['派工请求和交回', () => workQueries.requestsAndHandbacks('session:shadow-b'), 'events_stream_id_idx'],
    ['活（按键）', () => workQueries.jobs(['spawn:1', 'spawn:2']), 'jobs_key_unique'],
    ['开工记录', () => workQueries.workerSpawned(['worker:d1-a1']), 'events_stream_id_idx'],
    ['最近一句进度', () => workQueries.latestProgress(['session:worker-d1-a1']), 'events_stream_id_idx'],
    ['影子产物', () => workQueries.shadowRuns('b'), 'shadow_runs_batch_idx'],
    ['影子打分', () => workQueries.shadowCompare('b'), 'shadow_compare_batch_idx'],
    ['批次列表', () => workQueries.batches(5, undefined), 'shadow_batch_items_snapshot_idx'],
    [
      '批次列表（翻页）',
      () => workQueries.batches(5, '2026-10-30T10:00:00.000000Z'),
      'shadow_batch_items_snapshot_idx',
    ],
  ])('%s走 %s', async (_name, q, index) => {
    const text = await plan(q());
    expect(text).toContain(index);
    expect(text).not.toMatch(/Seq Scan on (shadow_batch_items|events|jobs|shadow_runs|shadow_compare)/);
  });
});

describe('HTTP 口', () => {
  let api: CockpitApi;
  let base: string;
  beforeAll(async () => {
    api = createCockpitApi({ db: t.db, sessionSecret: SECRET, pollMs: 30 });
    base = `http://127.0.0.1:${await api.listen()}`;
  });
  afterAll(() => api.close());
  const now = Math.floor(Date.now() / 1000);
  const cookie = `${COCKPIT_COOKIE}=${signSessionCookie(SECRET, { uid: FOUNDER, sid: 's', iat: now, exp: now + 3600, v: 0 })}`;
  const get = (path: string, headers: Record<string, string> = { cookie }) =>
    fetch(`${base}${path}`, { headers });

  it('没登录 401，登录了给 JSON 且不缓存', async () => {
    expect((await get('/next/api/work/batches', {})).status).toBe(401);
    expect((await get('/next/api/work/batches/b-one', {})).status).toBe(401);
    const r = await get('/next/api/work/batches/b-one');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(((await r.json()) as WorkGraph).nodes).toHaveLength(9);
    const l = (await (await get('/next/api/work/batches?limit=1')).json()) as BatchesPage;
    expect(l.batches).toHaveLength(1);
  });

  it('不存在的批次 404，参数不合规矩 400，只收 GET', async () => {
    expect((await get('/next/api/work/batches/nope')).status).toBe(404);
    expect((await get('/next/api/work/batches/a%2Fb')).status).toBe(404);
    expect((await get('/next/api/work/batches?limit=0')).status).toBe(400);
    expect((await get('/next/api/work/batches?limit=51')).status).toBe(400);
    expect((await get('/next/api/work/batches?limit=x')).status).toBe(400);
    expect((await get('/next/api/work/batches?before=yesterday')).status).toBe(400);
    expect(
      (await fetch(`${base}/next/api/work/batches`, { method: 'POST', headers: { cookie } })).status,
    ).toBe(405);
    // 网址里带令牌照旧 400
    expect((await get('/next/api/work/batches?token=x')).status).toBe(400);
  });
});
