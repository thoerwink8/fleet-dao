// 用量补记（#1935）连库跑一遍：经 Mirasim 起的会话结束时 runs 只有输出（快照的 turnOutputTokens），账本里先是全 0 的占位、
// 过几分钟才回填。只给占位的那一轮不许写成 0（故意造的失败），回填了就把四样整套写对，再跑一遍不改第二次；读不成的写明原因。
import type { MeterFs } from '@fleet-dao/adapters';
import {
  getRun,
  pools,
  type RunInsert,
  routes,
  seed,
  startRun,
  USAGE_GAVE_UP_PREFIX,
  USAGE_REREAD_MARK,
  USAGE_TAIL_MARKER,
} from '@fleet-dao/db';
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

const TRAFFIC = '/home/fleet-agent-carpool/.mirasim/traffic';
const TRAFFIC_FILE = `${TRAFFIC}/${SESSION}/index-0.ndjson`;

/** 流量记录一行（每次上游调用一行，没有 token 数）。 */
function hit(n: number, status: number): string {
  return JSON.stringify({
    ts: new Date(STARTED.getTime() + n * 60_000).toISOString(),
    status,
    model: 'claude-opus-5-5',
    path: '/v1/messages',
    method: 'POST',
    upstreamHost: 'relay.mirasim.ai',
    viaRelay: true,
    sessionId: SESSION,
  });
}

/** traffic 不给是这个会话没有流量目录。 */
function meterFs(file: () => string, traffic?: () => string): MeterFs {
  return {
    async readdir(dir) {
      if (dir === DIR) return ['usage-2026-10.ndjson', 'session-usage-2026-10.ndjson'];
      if (traffic && dir === `${TRAFFIC}/${SESSION}`) return ['index-0.ndjson', 'meta.local.json'];
      throw Object.assign(new Error('no'), { code: 'ENOENT' });
    },
    async linesWith(needles, paths) {
      if (paths.length === 1 && paths[0] === TRAFFIC_FILE) {
        return (traffic?.() ?? '')
          .split('\n')
          .filter((l) => needles.some((n) => l.includes(n)))
          .join('\n');
      }
      expect(paths).toEqual([`${DIR}/usage-2026-10.ndjson`]);
      return file()
        .split('\n')
        .filter((l) => needles.some((n) => l.includes(n)))
        .join('\n');
    },
  };
}

async function mirasimRun(over: Partial<RunInsert> = {}, writtenAt?: Date) {
  return startRun(
    t.db,
    {
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
    },
    writtenAt,
  );
}

function job(file: () => string, now = new Date(ENDED.getTime() + 6 * 60_000), traffic?: () => string) {
  const finished: unknown[] = [];
  const deps = usageBackfillJob({
    db: t.db,
    user: 'fleet-agent-carpool',
    meterDir: () => DIR,
    trafficDir: () => TRAFFIC,
    meterFs: () => meterFs(file, traffic),
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
        // 原来按旧窗口已经记进整笔的、结束前 1 秒调用，尾巴不能再加一次。
        ts: new Date(ENDED.getTime() - 1_000).toISOString(),
        input: 90,
        output: 90,
        cacheRead: 90,
        cacheWrite: 90,
        relayMetered: true,
        relayUsd: 9,
      }),
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
      trafficDir: () => TRAFFIC,
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

  // #2675：「没调用」和「没对上」分开记，三种情形各一条
  it('一次上游调用都没有（会话起不来、初始化超时）：四样和花费记 0，原因写明这一笔没有发出过模型调用', async () => {
    const { id } = await mirasimRun({ outcome: 'failed', outputTokens: null });
    // 流量目录在、一行都没有（codex app-server initialize 超时的真样子）；会话结束 11 分钟，过了等落盘的那几分钟
    const j = job(
      () => '',
      new Date(ENDED.getTime() + 11 * 60_000),
      () => '',
    );
    await j.run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    expect(row?.usageNote).toContain('这一笔没有发出过模型调用');
    expect(j.finished.at(-1)).toEqual({ outcome: 'ok', scanned: 1, found: 1 });
  });

  it('判成没调用但会话刚结束：先不记 0，写明在等账本落盘', async () => {
    const { id } = await mirasimRun({ outputTokens: null });
    await job(
      () => '',
      new Date(ENDED.getTime() + 3 * 60_000),
      () => '',
    ).run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(row?.usageNote).toContain('等 Mirasim 账本落盘再定');
  });

  it('有调用但没对上（流量记录里有 2xx、用量账本里没有）：照旧留空，原因写清是哪种没对上，这一轮记 partial', async () => {
    const { id } = await mirasimRun();
    const j = job(
      () => '',
      new Date(ENDED.getTime() + 11 * 60_000),
      () => hit(1, 200),
    );
    await j.run();
    const row = await getRun(t.db, id);
    expect(row).toMatchObject({ inputTokens: null, cacheReadTokens: null, outputTokens: 4100 });
    expect(row?.usageNote).toMatch(
      /^用量没读成（第 1 次，还会再读）：没对上：Mirasim 流量记录里这一笔有 1 次上游调用回了 2xx/,
    );
    expect(j.finished.at(-1)).toMatchObject({ outcome: 'partial' });
  });

  it('对上了：账本行比这一笔起点早几秒的同一会话调用也算进这一笔', async () => {
    const { id } = await mirasimRun();
    const early = JSON.stringify({
      ...JSON.parse(call(0, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, relayMetered: true })),
      ts: new Date(STARTED.getTime() - 3_000).toISOString(),
    });
    const lines = [
      early,
      call(1, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, relayMetered: true }),
    ].join('\n');
    await job(() => lines).run();
    expect(await getRun(t.db, id)).toMatchObject({
      inputTokens: 6,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheWriteTokens: 12,
      usageNote: meterWindowNote(),
    });
  });

  it('同一会话续跑：起点往前放宽不越过上一笔的终点，上一笔的调用不算两遍', async () => {
    // 上一笔 06:29:58 结束（已经齐了），这一笔 06:30:00 起；06:29:57 那次是上一笔的
    await mirasimRun({
      startedAt: new Date(STARTED.getTime() - 10 * 60_000),
      endedAt: new Date(STARTED.getTime() - 2_000),
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    });
    const { id } = await mirasimRun();
    const prev = JSON.stringify({
      ...JSON.parse(call(0, { input: 900, output: 900, relayMetered: true })),
      ts: new Date(STARTED.getTime() - 3_000).toISOString(),
    });
    const lines = [
      prev,
      call(1, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, relayMetered: true }),
    ].join('\n');
    await job(() => lines).run();
    expect(await getRun(t.db, id)).toMatchObject({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
  });

  it('改读法之前定案不再补的老行：按新读法再读一次（只一次），读成就补上', async () => {
    const gaveUp = `${USAGE_GAVE_UP_PREFIX}查了 6 次都读不成，不再补；这一笔的用量留空（不是 0）：Mirasim 用量账本里没有这个会话在这一笔起止之间的计费调用`;
    // 三天前结束的：已经过了 24 小时的回看窗口，照样重读
    const old = new Date(ENDED.getTime() - 3 * 24 * 60 * 60_000);
    const now = new Date(ENDED.getTime() + 6 * 60_000);
    const zero = await mirasimRun({
      id: '11111111-1111-4111-8111-111111111111',
      startedAt: new Date(old.getTime() - 60_000),
      endedAt: old,
      outputTokens: null,
      usageNote: gaveUp,
    });
    const fill = await mirasimRun({ id: '22222222-2222-4222-8222-222222222222', usageNote: gaveUp });
    const still = await mirasimRun({
      id: '33333333-3333-4333-8333-333333333333',
      startedAt: new Date(STARTED.getTime() + 20 * 60_000),
      endedAt: new Date(STARTED.getTime() + 30 * 60_000),
      usageNote: gaveUp,
    });
    let reads = 0;
    // fill 那一笔的窗里有回填好的调用；still 那一笔的窗里流量记录有一次 2xx、用量账本里没有；zero 那一笔什么都没有
    const lines = call(1, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, relayMetered: true });
    const traffic = [hit(1, 200), hit(25, 200)].join('\n');
    const run = () =>
      job(
        () => {
          reads += 1;
          return lines;
        },
        now,
        () => traffic,
      ).run();
    await run();
    expect(reads).toBe(1);
    const z = await getRun(t.db, zero.id);
    expect(z).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(z?.usageNote).toContain('这一笔没有发出过模型调用');
    expect(await getRun(t.db, fill.id)).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
      usageNote: expect.stringContaining(meterWindowNote()),
    });
    const s = await getRun(t.db, still.id);
    expect(s).toMatchObject({ inputTokens: null });
    expect(s?.usageNote).toMatch(
      new RegExp(`^${USAGE_GAVE_UP_PREFIX}改读法之前定案的这一笔按新读法重读了一次`),
    );
    expect(s?.usageNote).toContain('没对上');
    expect(s?.usageNote?.endsWith(USAGE_REREAD_MARK)).toBe(true);
    // 只一次：再跑一轮，重读过的不再是候选，不读账本
    await run();
    expect(reads).toBe(1);
  });

  it('按新读法读满次数定案的：带上读过的记号，不当成老行再重读', async () => {
    // 第 5 次读不成已经是 3 小时前（过了第 5 档 160 分钟的退避）
    const { id } = await mirasimRun(
      { usageNote: '用量没读成（第 5 次，还会再读）：没对上：x' },
      new Date(ENDED.getTime() - 3 * 60 * 60_000),
    );
    let reads = 0;
    const run = () =>
      job(
        () => {
          reads += 1;
          return call(1, { noRelayRecord: true });
        },
        new Date(ENDED.getTime() + 6 * 60_000),
      ).run();
    await run();
    const note = (await getRun(t.db, id))?.usageNote;
    expect(note).toMatch(/^用量不再补：查了 6 次都读不成/);
    expect(note?.endsWith(USAGE_REREAD_MARK)).toBe(true);
    await run();
    expect(reads).toBe(1);
  });

  it('登记的编号是 usage-backfill', () => {
    expect(USAGE_BACKFILL_JOB.id).toBe('usage-backfill');
  });
});
