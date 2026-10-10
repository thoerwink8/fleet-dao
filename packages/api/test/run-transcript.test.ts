// 任务详情每段的「会话内容」接口（#1640）：GET /api/tasks/:taskId/runs/:runId/transcript。
// 登录才能读（没登录 401、飞书网关通行证 403）；after 增量读；在跑的段 done=false；「没有记录」和「读不到」分开；
// 别的单的 runId 串进来 404；没接上 503。
import { appendRunTranscript, finishRun, startRun } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { RunTranscriptResponse } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRunTranscript, RUN_TRANSCRIPT_NOT_HERE, type RunTranscriptPort } from '../src/run-transcript.ts';
import { errorCode, harness, IDS, pgHarness, T0, viaGateway } from './harness.ts';

const RUN = 'e1000000-0000-4000-8000-000000000001';
const RUNNING = 'e1000000-0000-4000-8000-000000000002';
const OTHER_TASK_RUN = 'e1000000-0000-4000-8000-000000000003';
const url = (taskId: string, runId: string, q = '') => `/api/tasks/${taskId}/runs/${runId}/transcript${q}`;

/** 内存版 + 假的读：行是 (seq, kind, text)，按 after / limit 切，和真库的 readRunTranscript 同一个口径。 */
function fakePort(rows: Record<string, { seq: number; kind: string; text: string }[]>): RunTranscriptPort {
  return {
    async read(runId, { after, limit }) {
      const all = rows[runId] ?? [];
      const rest = all.filter((r) => after === undefined || r.seq > after);
      const page = rest.slice(0, limit);
      return {
        entries: page.map((r) => ({ seq: r.seq, at: T0, kind: r.kind as 'assistant', text: r.text })),
        any: all.length > 0,
        more: rest.length > limit,
      };
    },
  };
}

function withRuns(h: ReturnType<typeof harness>) {
  const base = { segment: 'manual' as const, model: 'opus-5.5', startedAt: T0.toISOString() };
  h.store.data.segmentRuns.push(
    // 已结束的
    { ...base, id: RUN, taskId: IDS.task12, endedAt: T0.toISOString(), outcome: 'done' },
    // 还在跑的
    { ...base, id: RUNNING, taskId: IDS.task12 },
    // 别的单的
    { ...base, id: OTHER_TASK_RUN, taskId: IDS.task13, endedAt: T0.toISOString(), outcome: 'done' },
  );
}

const body = async (res: Response) => RunTranscriptResponse.parse(await res.json());

describe('会话内容接口：权限', () => {
  it('没登录 401；飞书网关通行证 403（它只管查任务和叫停）；创始人登录 200', async () => {
    const h = harness({ runTranscript: fakePort({ [RUN]: [{ seq: 0, kind: 'prompt', text: 'p' }] }) });
    withRuns(h);
    expect((await h.cockpit.request(url(IDS.task12, RUN))).status).toBe(401);
    const gw = await h.cockpit.request(url(IDS.task12, RUN), viaGateway('GET', 'ou_dev_founder_a'));
    expect(gw.status).toBe(403);
    expect(await errorCode(gw)).toBe('gateway_route_not_allowed');
    const s = await h.login();
    expect((await h.cockpit.request(url(IDS.task12, RUN), { headers: { cookie: s.cookie } })).status).toBe(
      200,
    );
  });
});

describe('会话内容接口：读', () => {
  const rows = {
    [RUN]: [0, 1, 2, 3, 4].map((seq) => ({
      seq,
      kind: seq === 0 ? 'prompt' : 'assistant',
      text: `第 ${seq} 条`,
    })),
    [RUNNING]: [0, 1].map((seq) => ({ seq, kind: 'assistant', text: `在跑 ${seq}` })),
  };

  it('结束的段读完：done=true；after 增量只回更新的；读到头回空、nextAfter 原样', async () => {
    const h = harness({ runTranscript: fakePort(rows) });
    withRuns(h);
    const s = await h.login();
    const get = async (q: string) =>
      body(await h.cockpit.request(url(IDS.task12, RUN, q), { headers: { cookie: s.cookie } }));

    const all = await get('');
    expect(all.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(all).toMatchObject({ nextAfter: 4, done: true, noRecord: false });
    expect(all.entries[0]).toMatchObject({ kind: 'prompt', text: '第 0 条', at: T0.toISOString() });

    const tail = await get('?after=2');
    expect(tail.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(tail.nextAfter).toBe(4);

    const none = await get('?after=4');
    expect(none).toEqual({ entries: [], nextAfter: 4, done: true, noRecord: false });
  });

  it('limit 分页：没读完 done=false，接着用 nextAfter 读完才 true', async () => {
    const h = harness({ runTranscript: fakePort(rows) });
    withRuns(h);
    const s = await h.login();
    const get = async (q: string) =>
      body(await h.cockpit.request(url(IDS.task12, RUN, q), { headers: { cookie: s.cookie } }));
    const first = await get('?limit=3');
    expect(first).toMatchObject({ nextAfter: 2, done: false });
    expect(first.entries).toHaveLength(3);
    const second = await get(`?after=${first.nextAfter}&limit=3`);
    expect(second.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(second.done).toBe(true);
  });

  it('在跑的段 done 恒为 false；还没有条目也不算「没有记录」（引擎攒批最多隔一两秒才写）', async () => {
    const h = harness({ runTranscript: fakePort({ [RUNNING]: [] }) });
    withRuns(h);
    const s = await h.login();
    const res = await body(
      await h.cockpit.request(url(IDS.task12, RUNNING), { headers: { cookie: s.cookie } }),
    );
    expect(res).toEqual({ entries: [], nextAfter: null, done: false, noRecord: false });

    const h2 = harness({ runTranscript: fakePort(rows) });
    withRuns(h2);
    const s2 = await h2.login();
    const live = await body(
      await h2.cockpit.request(url(IDS.task12, RUNNING, '?after=1'), { headers: { cookie: s2.cookie } }),
    );
    expect(live).toEqual({ entries: [], nextAfter: 1, done: false, noRecord: false });
  });

  it('参数不合法 400：after 不是整数、limit 超上限', async () => {
    const h = harness({ runTranscript: fakePort(rows) });
    withRuns(h);
    const s = await h.login();
    for (const q of ['?after=abc', '?after=-1', '?limit=0', '?limit=100000']) {
      const res = await h.cockpit.request(url(IDS.task12, RUN, q), { headers: { cookie: s.cookie } });
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
  });
});

describe('会话内容接口：没有记录和读不到分开', () => {
  it('段已结束、一条都没有：200 + noRecord=true（跑在记录会话内容之前）', async () => {
    const h = harness({ runTranscript: fakePort({}) });
    withRuns(h);
    const s = await h.login();
    const res = await h.cockpit.request(url(IDS.task12, RUN), { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ entries: [], nextAfter: null, done: true, noRecord: true });
  });

  it('【故意造出的失败】库读不了：503 写明「没读成」和原因，不是 200 的空列表', async () => {
    const h = harness({
      runTranscript: {
        read: async () => {
          throw new Error('connection terminated');
        },
      },
    });
    withRuns(h);
    const s = await h.login();
    const res = await h.cockpit.request(url(IDS.task12, RUN), { headers: { cookie: s.cookie } });
    expect(res.status).toBe(503);
    const err = (await res.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('run_transcript_unreadable');
    expect(err.error.message).toContain('没读成');
    expect(err.error.message).toContain('connection terminated');
  });

  it('没接上（内存版、开发环境）：503 写明，不拿空列表冒充没有记录', async () => {
    const h = harness();
    withRuns(h);
    const s = await h.login();
    const res = await h.cockpit.request(url(IDS.task12, RUN), { headers: { cookie: s.cookie } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      RUN_TRANSCRIPT_NOT_HERE,
    );
  });

  it('单不存在 404；runId 不是这张单的（串到别的单）404，不泄漏别的单的过程', async () => {
    const h = harness({
      runTranscript: fakePort({ [OTHER_TASK_RUN]: [{ seq: 0, kind: 'prompt', text: '别的单' }] }),
    });
    withRuns(h);
    const s = await h.login();
    const miss = await h.cockpit.request(url('00000000-0000-4000-8000-0000000000ff', RUN), {
      headers: { cookie: s.cookie },
    });
    expect(miss.status).toBe(404);
    expect(await errorCode(miss)).toBe('task_not_found');
    const cross = await h.cockpit.request(url(IDS.task12, OTHER_TASK_RUN), { headers: { cookie: s.cookie } });
    expect(cross.status).toBe(404);
    expect(await errorCode(cross)).toBe('run_not_found');
  });
});

describe('会话内容接口：真库', () => {
  let t: TestDb;
  let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });

  it('引擎写的条目经接口读得出来：增量、done、没有记录', async () => {
    current = await pgHarness(t, { runTranscript: pgRunTranscript(t.db) });
    const s = await current.login();
    const done = await startRun(t.db, {
      segment: 'manual',
      model: 'opus-5.5',
      taskId: IDS.task12,
      startedAt: new Date(T0.getTime() - 60_000),
    });
    await finishRun(t.db, { runId: done.id, outcome: 'done', endedAt: T0 });
    const running = await startRun(t.db, {
      segment: 'verify',
      model: 'opus-5.5',
      taskId: IDS.task12,
      startedAt: new Date(T0.getTime() - 30_000),
    });
    const old = await startRun(t.db, {
      segment: 'scope',
      model: 'opus-5.5',
      taskId: IDS.task12,
      startedAt: new Date(T0.getTime() - 120_000),
    });
    await finishRun(t.db, { runId: old.id, outcome: 'done', endedAt: T0 });
    await appendRunTranscript(t.db, done.id, [
      { seq: 0, at: T0, kind: 'prompt', text: '提示词' },
      { seq: 1, at: T0, kind: 'tool_call', text: 'ls', tool: 'Bash' },
      {
        seq: 2,
        at: T0,
        kind: 'tool_result',
        text: '没有',
        tool: 'Bash',
        ok: false,
        meta: { truncated: true },
      },
    ]);
    await appendRunTranscript(t.db, running.id, [{ seq: 0, at: T0, kind: 'prompt', text: '验收提示词' }]);

    const get = async (id: string, q = '') =>
      body(await current!.cockpit.request(url(IDS.task12, id, q), { headers: { cookie: s.cookie } }));
    const full = await get(done.id);
    expect(full).toMatchObject({ nextAfter: 2, done: true, noRecord: false });
    expect(full.entries[2]).toMatchObject({
      kind: 'tool_result',
      tool: 'Bash',
      ok: false,
      meta: { truncated: true },
    });
    expect((await get(done.id, '?after=1')).entries.map((e) => e.seq)).toEqual([2]);
    // 在跑的段
    expect(await get(running.id)).toMatchObject({ done: false, noRecord: false, nextAfter: 0 });
    // 老段：结束了、没有条目
    expect(await get(old.id)).toEqual({ entries: [], nextAfter: null, done: true, noRecord: true });
  });
});
