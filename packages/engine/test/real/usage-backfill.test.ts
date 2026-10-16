// 用量补记（#1935）连库跑一遍：经 Mirasim 起的会话结束时 runs 只有输出（快照的 turnOutputTokens），账本里先是全 0 的占位、
// 过几分钟才回填。只给占位的那一轮不许写成 0（故意造的失败），回填了就把四样整套写对，再跑一遍不改第二次；读不成的写明原因。
import type { MeterFs } from '@fleet-dao/adapters';
import { getRun, pools, type RunInsert, routes, seed, startRun, USAGE_TAIL_MARKER } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  meterWindowNote,
  runUsageBackfillJob,
  USAGE_BACKFILL_JOB,
  USAGE_TAIL_LOOKBACK_MS,
} from '../../src/jobs/usage-backfill.ts';
import { usageBackfillJob } from '../../src/real/usage-backfill.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
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
}, TEST_DB_TIMEOUT_MS);

const SESSION = '403c41e2-8629-410a-8d7a-d61f65add9be';
const ENDED = new Date('2026-10-12T06:40:00.000Z');
const STARTED = new Date('2026-10-12T06:30:00.000Z');
const DIR = '/home/fleet-agent-carpool/.mirasim/insights';

/** 一次走中转的 2xx 调用（法国账本的真形状，去掉了和用量无关的字段）。 */
function call(n: number, over: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    id: `${SESSION}:call-${n}`,
    ts: new Date(STARTED.getTime() + n * 60_000).toISOString(),
    sessionId: SESSION,
    agent: 'claude',
    upstreamHost: 'relay.mirasim.ai',
    viaRelay: true,
    leg: 'relay',
    model: 'claude-opus-5-5',
    status: 200,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...over,
  });
}

function meterFs(file: () => string): MeterFs {
  return {
    async readdir(dir) {
      if (dir !== DIR) throw Object.assign(new Error('no'), { code: 'ENOENT' });
      return ['usage-2026-10.ndjson', 'session-usage-2026-10.ndjson'];
    },
    async linesWith(needles, paths) {
      expect(paths).toEqual([`${DIR}/usage-2026-10.ndjson`]);
      return file()
        .split('\n')
        .filter((l) => needles.some((n) => l.includes(n)))
        .join('\n');
    },
  };
}

async function mirasimRun(over: Partial<RunInsert> = {}) {
  return startRun(t.db, {
    segment: 'verify',
    issueNumber: 7,
    model: 'opus-5.5',
    channel: 'mirasim-cloud',
    routeId: 'm-opus',
    startedAt: STARTED,
    endedAt: ENDED,
    outcome: 'done',
    // 会话结束时快照里只有本轮输出（近似值），输入、缓存照实留空
    outputTokens: 4100,
    sessionId: `claude:${SESSION}`,
    ...over,
  });
}

function job(file: () => string, now = new Date(ENDED.getTime() + 6 * 60_000)) {
  const finished: unknown[] = [];
  const deps = usageBackfillJob({
    db: t.db,
    user: 'fleet-agent-carpool',
    meterDir: () => DIR,
    meterFs: () => meterFs(file),
    now: () => now,
    log: () => undefined,
  })();
  return {
    run: () =>
      runUsageBackfillJob({
        ...deps,
        runs: { start: async () => 1, finish: async (_id, r) => void finished.push(r) },
      }),
    finished,
  };
}

describe('用量补记：经 Mirasim 起的会话按中转计量补齐', () => {
  it('【故意造的失败】账本里只有全 0 的占位：输入、缓存照旧留空，不写成 0；写明在等回填', async () => {
    const { id } = await mirasimRun();
    const lines = [call(1, {}), call(2, {})].join('\n');
    await job(() => lines).run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: 4100,
    });
    expect(row?.usageNote).toContain('等中转计量回填');
  });

  it('回填了：四样整套换成计量的数（输出也换：快照的只是近似），清掉原因；再跑一遍不改第二次', async () => {
    const { id } = await mirasimRun();
    let lines = [call(1, {}), call(2, {})].join('\n');
    const j = job(() => lines);
    await j.run();
    lines = [
      call(1, { input: 2, output: 3963, cacheRead: 341543, cacheWrite: 4923, relayMetered: true }),
      call(2, { input: 7297, output: 160, cacheRead: 0, cacheWrite: 62513, relayMetered: true }),
      // 别的会话的不算
      JSON.stringify({ ...JSON.parse(call(3, { input: 9, output: 9, relayMetered: true })), sessionId: 'x' }),
    ].join('\n');
    await j.run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({
      inputTokens: 7299,
      outputTokens: 4123,
      cacheReadTokens: 341543,
      cacheWriteTokens: 67436,
      costUsd: null,
      usageNote: meterWindowNote(),
    });
    expect(j.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 1 });
    // 补齐了的不再是候选：再跑一遍一笔都不碰（扫的是那一次查询）
    await j.run();
    expect(j.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: 7299, outputTokens: 4123 });
  });

  it('中转没有这次调用的记录：不写数、写明原因，这一轮记 partial', async () => {
    const { id } = await mirasimRun();
    const lines = [
      call(1, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, relayMetered: true }),
      call(2, { noRelayRecord: true }),
    ].join('\n');
    const j = job(() => lines);
    await j.run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({ inputTokens: null, outputTokens: 4100 });
    expect(row?.usageNote).toContain('中转没有这次调用的计量记录');
    expect(j.finished.at(-1)).toMatchObject({ outcome: 'partial' });
  });

  it('会话结束半小时还没回填齐：原因里写迟迟没回填', async () => {
    const { id } = await mirasimRun();
    const lines = call(1, {});
    await job(() => lines, new Date(ENDED.getTime() + 45 * 60_000)).run();
    expect((await getRun(t.db, id))?.usageNote).toContain('中转计量还没回填齐');
  });

  it('不补的：不是 Mirasim 路由的、没记会话号的、尾巴已经补过的', async () => {
    await mirasimRun({ routeId: 'c-opus', channel: 'claude-subscription' });
    await mirasimRun({ sessionId: null });
    await mirasimRun({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      usageNote: `${USAGE_TAIL_MARKER}：测试`,
    });
    const j = job(() => {
      throw new Error('不该读账本');
    });
    await j.run();
    expect(j.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('叫停后 30 秒的调用算进来；没有下一笔时，宽限外的不算。再跑一遍不把这 30 秒再加一次', async () => {
    const { id } = await mirasimRun();
    const lines = [
      call(1, { input: 10, output: 1, cacheRead: 2, cacheWrite: 3, relayMetered: true }),
      call(0, {
        ts: new Date(ENDED.getTime() + 30_000).toISOString(),
        input: 4,
        output: 5,
        cacheRead: 6,
        cacheWrite: 7,
        relayMetered: true,
        relayUsd: 0.02,
      }),
      call(0, {
        ts: new Date(ENDED.getTime() + 3 * 60_000).toISOString(),
        input: 100,
        output: 100,
        cacheRead: 100,
        cacheWrite: 100,
        relayMetered: true,
        relayUsd: 9,
      }),
    ].join('\n');
    const j = job(() => lines);
    await j.run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({
      inputTokens: 14,
      outputTokens: 6,
      cacheReadTokens: 8,
      cacheWriteTokens: 10,
      usageNote: meterWindowNote(),
    });
    expect(row?.usageNote?.startsWith(USAGE_TAIL_MARKER)).toBe(true);
    await j.run();
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: 14, outputTokens: 6 });
    expect(j.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('宽限还没走完先不定案：账本里已经有叫停后 30 秒的调用也不写，宽限过了才算进来', async () => {
    const { id } = await mirasimRun();
    const lines = [
      call(1, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, relayMetered: true }),
      call(0, {
        ts: new Date(ENDED.getTime() + 30_000).toISOString(),
        input: 4,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        relayMetered: true,
      }),
    ].join('\n');
    await job(() => lines, new Date(ENDED.getTime() + 60_000)).run();
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: null, usageNote: null });
    await job(() => lines, new Date(ENDED.getTime() + 6 * 60_000)).run();
    expect(await getRun(t.db, id)).toMatchObject({
      inputTokens: 14,
      outputTokens: 2,
      usageNote: meterWindowNote(),
    });
  });

  it('下一笔起点之后的调用不算进这一笔（别的会话插在中间也不把窗口提前封上）', async () => {
    const { id: a } = await mirasimRun();
    const { id: b } = await mirasimRun({
      startedAt: new Date(ENDED.getTime() + 20_000),
      // 收到宽限（结束后 2 分钟）要落在这一轮的「现在」之前，这一轮才定案
      endedAt: new Date(ENDED.getTime() + 90_000),
    });
    await mirasimRun({
      sessionId: 'claude:11111111-1111-4111-8111-111111111111',
      startedAt: new Date(ENDED.getTime() + 5_000),
      endedAt: new Date(ENDED.getTime() + 15_000),
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      usageNote: `${USAGE_TAIL_MARKER}：别的会话`,
    });
    const lines = [
      call(1, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, relayMetered: true }),
      call(0, {
        ts: new Date(ENDED.getTime() + 10_000).toISOString(),
        input: 3,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        relayMetered: true,
      }),
      call(0, {
        ts: new Date(ENDED.getTime() + 30_000).toISOString(),
        input: 7,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        relayMetered: true,
      }),
      call(0, {
        ts: new Date(ENDED.getTime() + 60_000).toISOString(),
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        relayMetered: true,
      }),
    ].join('\n');
    await job(() => lines).run();
    expect(await getRun(t.db, a)).toMatchObject({ inputTokens: 13 });
    expect(await getRun(t.db, b)).toMatchObject({ inputTokens: 8 });
  });

  it('已补齐的近 14 天老行按新窗口重读一次，补上尾巴；记号挡住第二次', async () => {
    expect(USAGE_TAIL_LOOKBACK_MS).toBe(14 * 24 * 60 * 60_000);
    const { id } = await mirasimRun({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      costUsd: 0.5,
    });
    const lines = [
      call(1, { input: 10, output: 1, cacheRead: 2, cacheWrite: 3, relayMetered: true, relayUsd: 0.5 }),
      call(0, {
        ts: new Date(ENDED.getTime() + 30_000).toISOString(),
        input: 4,
        output: 5,
        cacheRead: 6,
        cacheWrite: 7,
        relayMetered: true,
        relayUsd: 0.25,
      }),
      call(0, {
        ts: new Date(ENDED.getTime() + 3 * 60_000).toISOString(),
        input: 100,
        output: 100,
        cacheRead: 100,
        cacheWrite: 100,
        relayMetered: true,
        relayUsd: 9,
      }),
    ].join('\n');
    const j = job(() => lines);
    await j.run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({
      inputTokens: 14,
      outputTokens: 6,
      cacheReadTokens: 8,
      cacheWriteTokens: 10,
      costUsd: 0.75,
    });
    expect(row?.usageNote?.startsWith(USAGE_TAIL_MARKER)).toBe(true);
    await j.run();
    expect(await getRun(t.db, id)).toMatchObject({
      inputTokens: 14,
      costUsd: 0.75,
      usageNote: row?.usageNote,
    });
    expect(j.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('尾巴还是占位：先不写记号，回填了再补；结束超过 14 天的已补齐行不再重读', async () => {
    const { id } = await mirasimRun({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });
    const waiting = call(0, { ts: new Date(ENDED.getTime() + 30_000).toISOString() });
    await job(() => waiting).run();
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: 10, usageNote: null });
    const filled = call(0, {
      ts: new Date(ENDED.getTime() + 30_000).toISOString(),
      input: 4,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      relayMetered: true,
    });
    await job(() => filled).run();
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: 14, usageNote: meterWindowNote() });

    const { id: old } = await mirasimRun({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      endedAt: new Date(ENDED.getTime() - 15 * 24 * 60 * 60_000),
      startedAt: new Date(ENDED.getTime() - 15 * 24 * 60 * 60_000 - 60_000),
    });
    const late = job(() => {
      throw new Error('不该读账本');
    });
    await late.run();
    expect(await getRun(t.db, old)).toMatchObject({ inputTokens: 1, usageNote: null });
    expect(late.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('账本目录读不了：这一轮没跑成（failed 再抛），不写数也不写原因', async () => {
    const { id } = await mirasimRun();
    const deps = usageBackfillJob({
      db: t.db,
      user: 'fleet-agent-carpool',
      meterDir: () => '/nope',
      meterFs: () => meterFs(() => ''),
      now: () => new Date(ENDED.getTime() + 6 * 60_000),
      log: () => undefined,
    })();
    const finished: unknown[] = [];
    await expect(
      runUsageBackfillJob({
        ...deps,
        runs: { start: async () => 1, finish: async (_i, r) => void finished.push(r) },
      }),
    ).rejects.toThrow('没有 Mirasim 用量账本目录');
    expect(finished[0]).toMatchObject({ outcome: 'failed' });
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: null, usageNote: null });
  });

  it('读不成的退避着读，读满次数定案不再补：数仍留空，不写成 0，也不再每 5 分钟白读一次', async () => {
    const { id } = await mirasimRun();
    let reads = 0;
    const lines = call(1, { noRelayRecord: true });
    const at = (min: number) => new Date(ENDED.getTime() + min * 60_000);
    const tick = async (min: number) => {
      const j = job(() => {
        reads += 1;
        return lines;
      }, at(min));
      await j.run();
      return j;
    };
    await tick(6);
    expect((await getRun(t.db, id))?.usageNote).toContain('第 1 次');
    expect(reads).toBe(1);
    // 退避里（10 分钟）：这一轮不碰，不读账本，不记 partial
    const quiet = await tick(11);
    expect(reads).toBe(1);
    expect(quiet.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
    // 满了第 1 档（10 分钟）、第 2 档（20 分钟）……每次读完记下第几次
    let now = 6;
    for (const [i, waitMin] of [10, 20, 40, 80, 160].entries()) {
      now += waitMin;
      await tick(now);
      expect(reads).toBe(i + 2);
    }
    const row = await getRun(t.db, id);
    expect(row?.usageNote).toMatch(/^用量不再补：查了 6 次都读不成/);
    expect(row).toMatchObject({ inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
    // 定案之后不再是候选
    const done = await tick(now + 1000);
    expect(reads).toBe(6);
    expect(done.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('登记的编号是 usage-backfill', () => {
    expect(USAGE_BACKFILL_JOB.id).toBe('usage-backfill');
  });
});
