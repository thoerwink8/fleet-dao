// 三段会话的过程记录（run_transcript，#1640）：写（冲突跳过）、增量读、没有记录和读不到分开、库里的约束。
import { randomUUID } from 'node:crypto';
import { TRANSCRIPT_KINDS } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendRunTranscript, readRunTranscript } from '../src/queries/run-transcript.ts';
import { startRun } from '../src/queries/runs.ts';
import { RUN_TRANSCRIPT_KINDS, runs, runTranscript } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addTask, catalog, expectViolation, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let runId: string;
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'kimi-r', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
  const repo = await addRepo(t.db);
  const task = await addTask(t.db, repo.id);
  runId = (
    await startRun(t.db, {
      segment: 'manual',
      model: 'kimi-k3',
      taskId: task.id,
      startedAt: new Date(NOW.getTime() - MIN),
    })
  ).id;
});

const row = (seq: number, over: Partial<Parameters<typeof appendRunTranscript>[2][number]> = {}) => ({
  seq,
  at: new Date(NOW.getTime() + seq * 1000),
  kind: 'assistant' as const,
  text: `第 ${seq} 条`,
  ...over,
});

describe('写', () => {
  it('一批写进去，读出来按 seq 排；空字段不写成 0 或空串', async () => {
    await appendRunTranscript(t.db, runId, [
      row(1, { kind: 'tool_call', tool: 'Bash', text: 'ls' }),
      row(0, { kind: 'prompt', text: '提示词' }),
      row(2, {
        kind: 'tool_result',
        tool: 'Bash',
        ok: false,
        text: '没有',
        meta: { truncated: true, originalChars: 9000 },
      }),
    ]);
    const page = await readRunTranscript(t.db, runId, { limit: 10 });
    expect(page.any).toBe(true);
    expect(page.more).toBe(false);
    expect(page.entries.map((e) => [e.seq, e.kind])).toEqual([
      [0, 'prompt'],
      [1, 'tool_call'],
      [2, 'tool_result'],
    ]);
    expect(page.entries[0]).toEqual({ seq: 0, at: new Date(NOW.getTime()), kind: 'prompt', text: '提示词' });
    expect(page.entries[2]).toMatchObject({
      tool: 'Bash',
      ok: false,
      meta: { truncated: true, originalChars: 9000 },
    });
  });

  it('同一个 seq 再写：跳过，已有的那一条不改（引擎重启后重读输出不会写两遍）', async () => {
    await appendRunTranscript(t.db, runId, [row(0), row(1)]);
    await appendRunTranscript(t.db, runId, [row(0, { text: '改过的' }), row(1), row(2)]);
    const page = await readRunTranscript(t.db, runId, { limit: 10 });
    expect(page.entries.map((e) => [e.seq, e.text])).toEqual([
      [0, '第 0 条'],
      [1, '第 1 条'],
      [2, '第 2 条'],
    ]);
  });

  it('run 不在 runs 表里：外键拦下并抛（调用方只记日志）；空批什么都不做', async () => {
    await expect(appendRunTranscript(t.db, randomUUID(), [row(0)])).rejects.toThrow();
    await appendRunTranscript(t.db, randomUUID(), []);
  });

  it('runs 那一行删了，记录跟着删', async () => {
    await appendRunTranscript(t.db, runId, [row(0)]);
    await t.db.delete(runs).where(eq(runs.id, runId));
    expect(await t.db.select().from(runTranscript)).toEqual([]);
  });
});

describe('增量读', () => {
  beforeEach(async () => {
    await appendRunTranscript(
      t.db,
      runId,
      [0, 1, 2, 3, 4].map((n) => row(n)),
    );
  });

  it('after 不给从头读；给了只回序号更大的', async () => {
    expect((await readRunTranscript(t.db, runId, { limit: 10 })).entries.map((e) => e.seq)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect((await readRunTranscript(t.db, runId, { after: 2, limit: 10 })).entries.map((e) => e.seq)).toEqual(
      [3, 4],
    );
    // after = 0 是「读过第 0 条了」，和不给不同
    expect((await readRunTranscript(t.db, runId, { after: 0, limit: 10 })).entries.map((e) => e.seq)).toEqual(
      [1, 2, 3, 4],
    );
  });

  it('limit 截页，more 说明后面还有', async () => {
    const first = await readRunTranscript(t.db, runId, { limit: 2 });
    expect(first.entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(first.more).toBe(true);
    const last = await readRunTranscript(t.db, runId, { after: 2, limit: 2 });
    expect(last.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(last.more).toBe(false);
  });

  it('读到头：回空页，但 any 仍是 true（这一段有记录，只是没有更新的）', async () => {
    const page = await readRunTranscript(t.db, runId, { after: 4, limit: 10 });
    expect(page).toEqual({ entries: [], any: true, more: false });
  });
});

describe('没有记录', () => {
  it('这一段一条都没有：any 是 false（和读不到不同，读不到是抛）', async () => {
    expect(await readRunTranscript(t.db, runId, { limit: 10 })).toEqual({
      entries: [],
      any: false,
      more: false,
    });
    expect(await readRunTranscript(t.db, runId, { after: 3, limit: 10 })).toEqual({
      entries: [],
      any: false,
      more: false,
    });
  });

  it('编号不是 uuid：当没有记录，不拿去查库', async () => {
    expect(await readRunTranscript(t.db, 'run-1', { limit: 10 })).toEqual({
      entries: [],
      any: false,
      more: false,
    });
  });
});

describe('库里的约束', () => {
  const insert = (over: Record<string, unknown>) =>
    t.db
      .insert(runTranscript)
      .values({ runId, seq: 9, at: NOW, kind: 'assistant', text: 'x', ...over } as never);

  it('种类只收七种，和 shared 的清单一致', async () => {
    expect([...RUN_TRANSCRIPT_KINDS]).toEqual([...TRANSCRIPT_KINDS]);
    for (const [i, kind] of RUN_TRANSCRIPT_KINDS.entries()) await insert({ seq: i, kind });
    await expectViolation(insert({ kind: 'thinking' }), 'run_transcript_kind_known');
  });

  it('seq 不能是负数；(run_id, seq) 不能重', async () => {
    await expectViolation(insert({ seq: -1 }), 'run_transcript_seq_nonneg');
    await insert({ seq: 3 });
    await expectViolation(insert({ seq: 3 }), 'run_transcript_pk');
  });
});
