// 一次性回填（#1948）：#1946 上线前没有会话号的老 run，按分支名加起止对上账本。
// 唯一对得上的只补空字段（已有的输出、原因不动）；对不上、对上不唯一的不改数、写下原因；再跑一次一行都不改。
// 默认只读。
import { getRun, pools, type RunInsert, routes, seed, startRun } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runUsageBackfillOnce } from '../../src/jobs/usage-backfill-once.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

const T0 = Date.parse('2026-10-05T01:00:00.000Z');
const WIN_END = T0 + 10 * 60_000;
const S_HIT = '11111111-1111-4111-8111-111111111111';
const S_PART = '22222222-2222-4222-8222-222222222222';
const S_AMB1 = '33333333-3333-4333-8333-333333333333';
const S_AMB2 = '44444444-4444-4444-8444-444444444444';
const S_PEND = '55555555-5555-4555-8555-555555555555';
const S_SEQ_A = '66666666-6666-4666-8666-666666666666';
const S_SEQ_B = '77777777-7777-4777-8777-777777777777';
const S_KEEP = '88888888-8888-4888-8888-888888888888';
const S_OTHER = '99999999-9999-4999-8999-999999999999';
const S_ODD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S_BAD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const S_BAD_OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const HIT = '1001-t00000001';
const PART = '1002-t00000002';
const MISS = '1003-t00000003';
const AMB = '1004-t00000004';
const OUT = '1005-t00000005';
const PEND = '1006-t00000006';
const SEQ = '1008-t00000008';
const KEEP = '1009-t00000009';
const OTHER = '1010-t0000000a';
const FULL = '1011-t0000000b';
const FAILED = '1012-t0000000c';
const BAD = '1013-t0000000d';

const ID_HIT = '00000000-0000-4000-8000-000000000001';
const ID_PART = '00000000-0000-4000-8000-000000000002';
const ID_MISS = '00000000-0000-4000-8000-000000000003';
const ID_AMB = '00000000-0000-4000-8000-000000000004';
const ID_OUT = '00000000-0000-4000-8000-000000000005';
const ID_PEND = '00000000-0000-4000-8000-000000000006';
const ID_NOBRANCH = '00000000-0000-4000-8000-000000000007';
const ID_NOTED = '00000000-0000-4000-8000-000000000008';
const ID_SEQ_A = '00000000-0000-4000-8000-000000000010';
const ID_SEQ_B = '00000000-0000-4000-8000-000000000011';
const ID_KEEP = '00000000-0000-4000-8000-000000000012';
const ID_OTHER = '00000000-0000-4000-8000-000000000013';
const ID_FULL = '00000000-0000-4000-8000-000000000014';
const ID_FAILED = '00000000-0000-4000-8000-000000000015';
const ID_BAD = '00000000-0000-4000-8000-000000000016';

let seq = 0;
function call(sessionId: string, leaf: string, at: number, over: Record<string, unknown> = {}): string {
  seq += 1;
  return JSON.stringify({
    v: 1,
    id: `${sessionId}:c${seq}`,
    ts: new Date(at).toISOString(),
    sessionId,
    agent: 'claude',
    viaRelay: true,
    leg: 'relay',
    model: 'claude-sonnet-5-5',
    status: 200,
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    relayMetered: true,
    repo: leaf,
    workspace: `/var/lib/fleet-work/thoerwink8_fleet-dao/${leaf}`,
    ...over,
  });
}

function ledger(): string {
  return [
    call(S_HIT, HIT, T0 + 60_000, { input: 2, output: 10, cacheRead: 5, cacheWrite: 7, relayUsd: 0.01 }),
    call(S_HIT, HIT, T0 + 120_000, { input: 3, output: 20, cacheRead: 0, cacheWrite: 1, relayUsd: 0.02 }),
    // 同一会话、不在分支目录里的一次调用：第二次按会话号读才看得到，要算进合计
    call(S_HIT, HIT, T0 + 180_000, {
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      relayUsd: 0.01,
      repo: 'somewhere',
      workspace: '/tmp/somewhere',
    }),
    // 目录名和 repo 不一致：不把这一行算成另一个会话
    call(S_ODD, HIT, T0 + 30_000, {
      input: 9999,
      output: 9999,
      repo: HIT,
      workspace: '/var/lib/fleet-work/x/not-the-leaf',
    }),
    call(S_PART, PART, T0 + 60_000, {
      input: 100,
      output: 50,
      cacheRead: 3,
      cacheWrite: 0,
      relayUsd: undefined,
      relayMetered: true,
    }),
    call(S_AMB1, AMB, T0 + 60_000, { input: 8 }),
    call(S_AMB2, AMB, T0 + 120_000, { input: 9 }),
    call(S_HIT, OUT, T0 - 60_000, { input: 70, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    call(S_PEND, PEND, T0 + 60_000, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      relayMetered: undefined,
    }),
    call(S_SEQ_A, SEQ, T0 + 60 * 60_000 + 60_000, { input: 11, output: 11, cacheRead: 11, cacheWrite: 11 }),
    call(S_SEQ_B, SEQ, T0 + 2 * 60 * 60_000 + 60_000, {
      input: 22,
      output: 22,
      cacheRead: 22,
      cacheWrite: 22,
    }),
    call(S_KEEP, KEEP, T0 + 60_000, { input: 80 }),
    call(S_OTHER, OTHER, T0 + 60_000, { input: 81 }),
    call(S_OTHER, FULL, T0 + 60_000, { input: 100, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    call(S_OTHER, FAILED, T0 + 60_000, { input: 82, sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
    call(S_BAD, BAD, T0 + 60_000, { input: 30, output: 31, cacheRead: 32, cacheWrite: 33, relayUsd: 0.01 }),
    // 同一分支另一会话，时间认不出：不能排除它也落在这一笔里
    JSON.stringify({
      v: 1,
      id: `${S_BAD_OTHER}:bad-time`,
      ts: 'not-a-time',
      sessionId: S_BAD_OTHER,
      agent: 'claude',
      viaRelay: true,
      leg: 'relay',
      model: 'claude-sonnet-5-5',
      status: 200,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      relayMetered: true,
      repo: BAD,
      workspace: `/var/lib/fleet-work/thoerwink8_fleet-dao/${BAD}`,
    }),
  ].join('\n');
}

async function add(id: string, branch: string | null, over: Partial<RunInsert> = {}): Promise<void> {
  const row: RunInsert = {
    id,
    segment: 'manual',
    issueNumber: 1948,
    model: 'opus-5.5',
    channel: 'mirasim-cloud',
    routeId: 'm-opus',
    startedAt: new Date(T0),
    endedAt: new Date(WIN_END),
    outcome: 'done',
    ...(branch ? { branch } : {}),
  };
  await startRun(t.db, Object.assign(row, over));
}

beforeEach(async () => {
  seq = 0;
  await resetTestDb(t);
  await seed(t.db);
  await t.db.insert(pools).values({ id: 'mirasim-a', channelId: 'mirasim-cloud', maxConcurrency: 2 });
  await t.db.insert(pools).values({ id: 'claude-a', channelId: 'claude-subscription', maxConcurrency: 2 });
  await t.db.insert(routes).values([
    { id: 'm-opus', channelId: 'mirasim-cloud', poolId: 'mirasim-a', modelId: 'opus-5.5', hostId: 'mirasim' },
    {
      id: 'c-opus',
      channelId: 'claude-subscription',
      poolId: 'claude-a',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
    },
  ]);
  await add(ID_HIT, `fleet/${HIT}`, { outputTokens: 4100 });
  await add(ID_PART, `fleet/${PART}`, { inputTokens: 7 });
  await add(ID_MISS, `fleet/${MISS}`);
  await add(ID_AMB, `fleet/${AMB}`);
  await add(ID_OUT, `fleet/${OUT}`);
  await add(ID_PEND, `fleet/${PEND}`);
  await add(ID_NOBRANCH, null);
  await add(ID_NOTED, `fleet/${MISS}`);
  await add(ID_SEQ_A, `fleet/${SEQ}`, {
    startedAt: new Date(T0 + 60 * 60_000),
    endedAt: new Date(T0 + 60 * 60_000 + 10 * 60_000),
  });
  await add(ID_SEQ_B, `fleet/${SEQ}`, {
    startedAt: new Date(T0 + 2 * 60 * 60_000),
    endedAt: new Date(T0 + 2 * 60 * 60_000 + 10 * 60_000),
  });
  await add(ID_KEEP, `fleet/${KEEP}`, { sessionId: `claude:${S_KEEP}` });
  await add(ID_OTHER, `fleet/${OTHER}`, { routeId: 'c-opus', channel: 'claude-subscription' });
  await add(ID_FULL, `fleet/${FULL}`, {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  });
  await add(ID_FAILED, `fleet/${FAILED}`, { outcome: 'failed' });
  await add(ID_BAD, `fleet/${BAD}`);
}, TEST_DB_TIMEOUT_MS);

// startRun 不收 usageNote。补上「原先就有原因」的那一笔。
async function presetNotes(): Promise<void> {
  const { noteHistoricalRunUsage } = await import('@fleet-dao/db');
  await noteHistoricalRunUsage(t.db, {
    runId: ID_PART,
    note: '先记着',
    at: new Date('2026-10-05T00:00:00.000Z'),
  });
  await noteHistoricalRunUsage(t.db, {
    runId: ID_NOTED,
    note: '原先的原因',
    at: new Date('2026-10-05T00:00:00.000Z'),
  });
}

let now = new Date('2026-10-12T08:00:00.000Z');

function harness(out: string[]) {
  const text = ledger();
  return {
    pending: async () => {
      const { runsAwaitingHistoricalMeter } = await import('@fleet-dao/db');
      return runsAwaitingHistoricalMeter(t.db);
    },
    readLedger: async (needles: readonly string[]) =>
      text
        .split('\n')
        .filter((line) => needles.some((needle) => line.includes(needle)))
        .join('\n'),
    fill: async (
      runId: string,
      usage: Parameters<typeof import('@fleet-dao/db').fillHistoricalRunUsage>[1]['usage'],
      at: Date,
    ) => {
      const { fillHistoricalRunUsage } = await import('@fleet-dao/db');
      return fillHistoricalRunUsage(t.db, { runId, usage, at });
    },
    note: async (runId: string, note: string, at: Date) => {
      const { noteHistoricalRunUsage } = await import('@fleet-dao/db');
      return noteHistoricalRunUsage(t.db, { runId, note, at });
    },
    now: () => now,
    out: (line: string) => out.push(line),
    err: () => undefined,
  };
}

async function view(id: string) {
  const row = await getRun(t.db, id);
  if (!row) throw new Error(`没有 ${id}`);
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    usageNote: row.usageNote,
    sessionId: row.sessionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

describe('fleet-api usage-backfill-once', () => {
  it('默认只读：列出会改的行，库一行都不写', async () => {
    await presetNotes();
    const before = await view(ID_HIT);
    const out: string[] = [];
    expect(await runUsageBackfillOnce([], harness(out))).toBe(0);
    expect(out[0]).toBe('只读，没写库。能补 4 笔，对不上 6 笔（对上不唯一 1 笔）。');
    expect(out.join('\n')).toContain(ID_HIT);
    expect(out.join('\n')).toContain('没有这个分支在这一笔起止之间的会话');
    expect(out.join('\n')).toContain('对上不唯一');
    expect(out.join('\n')).not.toContain(ID_NOTED);
    expect(await view(ID_HIT)).toEqual(before);
  });

  it('唯一对得上的只补空字段；对不上的不改数并留下原因；已有的数和原因不动', async () => {
    await presetNotes();
    now = new Date('2026-10-12T08:00:00.000Z');
    const keepBefore = await view(ID_KEEP);
    const otherBefore = await view(ID_OTHER);
    const fullBefore = await view(ID_FULL);
    const failedBefore = await view(ID_FAILED);
    const out: string[] = [];
    expect(await runUsageBackfillOnce(['--apply'], harness(out))).toBe(0);
    expect(out[0]).toBe('已写入。能补 4 笔，对不上 6 笔（对上不唯一 1 笔）。');
    expect(await view(ID_HIT)).toMatchObject({
      inputTokens: 9,
      outputTokens: 4100,
      cacheReadTokens: 5,
      cacheWriteTokens: 8,
      costUsd: 0.04,
      usageNote: null,
      sessionId: null,
    });
    expect(await view(ID_PART)).toMatchObject({
      inputTokens: 7,
      outputTokens: 50,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      costUsd: null,
      usageNote: '先记着',
    });
    expect(await view(ID_MISS)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      usageNote: '对不上：Mirasim 用量账本里没有这个分支在这一笔起止之间的会话',
    });
    expect((await view(ID_AMB)).usageNote).toContain('对上不唯一');
    expect((await view(ID_AMB)).inputTokens).toBeNull();
    expect((await view(ID_OUT)).usageNote).toContain('没有这个分支在这一笔起止之间的会话');
    expect((await view(ID_PEND)).inputTokens).toBeNull();
    expect((await view(ID_PEND)).usageNote).toContain('回填');
    expect((await view(ID_NOBRANCH)).usageNote).toContain('没有分支名');
    expect(await view(ID_BAD)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      sessionId: null,
      usageNote: '对不上：账本里有这个分支的一行时间认不出，判不了它落不落在这一笔起止之间，不猜',
    });
    expect((await view(ID_NOTED)).usageNote).toBe('原先的原因');
    expect(await view(ID_SEQ_A)).toMatchObject({
      inputTokens: 11,
      outputTokens: 11,
      cacheReadTokens: 11,
      cacheWriteTokens: 11,
    });
    expect(await view(ID_SEQ_B)).toMatchObject({ inputTokens: 22, outputTokens: 22 });
    expect(await view(ID_KEEP)).toEqual(keepBefore);
    expect(await view(ID_OTHER)).toEqual(otherBefore);
    expect(await view(ID_FULL)).toEqual(fullBefore);
    expect(await view(ID_FAILED)).toEqual(failedBefore);
  });

  it('再跑一次一行都不改', async () => {
    await presetNotes();
    now = new Date('2026-10-12T08:00:00.000Z');
    expect(await runUsageBackfillOnce(['--apply'], harness([]))).toBe(0);
    const ids = [
      ID_HIT,
      ID_PART,
      ID_MISS,
      ID_AMB,
      ID_OUT,
      ID_PEND,
      ID_NOBRANCH,
      ID_NOTED,
      ID_SEQ_A,
      ID_SEQ_B,
      ID_KEEP,
      ID_OTHER,
      ID_FULL,
      ID_FAILED,
      ID_BAD,
    ];
    const before = await Promise.all(ids.map((id) => view(id)));
    now = new Date('2026-10-12T09:00:00.000Z');
    const out: string[] = [];
    expect(await runUsageBackfillOnce(['--apply'], harness(out))).toBe(0);
    expect(out[0]).toBe('已写入。能补 0 笔，对不上 0 笔（对上不唯一 0 笔）。');
    expect(await Promise.all(ids.map((id) => view(id)))).toEqual(before);
  });

  it('参数不对不连库', async () => {
    let opened = false;
    const code = await runUsageBackfillOnce(['--force'], {
      pending: async () => {
        opened = true;
        return [];
      },
      readLedger: async () => '',
      fill: async () => false,
      note: async () => false,
      now: () => now,
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(2);
    expect(opened).toBe(false);
  });
});
