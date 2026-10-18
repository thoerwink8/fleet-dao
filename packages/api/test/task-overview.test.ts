// 任务详情的概览（#3140）和每一笔切好的步骤：真库（PGlite）上端到端——引擎写的 run_transcript、runs、task_rounds、step_timings、
// pull_requests、pr_head_files 经接口读出来。每一块读不到各写各的原因，不拿 0 顶、不连累别的块。
import {
  appendRunTranscript,
  finishRun,
  noteRunVerdict,
  prHeadFiles,
  pullRequests,
  recordPrHeadFiles,
  recordTaskRound,
  startRun,
  stepTimings,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { RunStepsResponse, TaskDetailResponse } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRunTranscript, type RunTranscriptPort } from '../src/run-transcript.ts';
import { TRANSCRIPT_NOT_WIRED } from '../src/task-overview.ts';
import { errorCode, harness, IDS, pgHarness, T0 } from './harness.ts';

const ago = (sec: number) => new Date(T0.getTime() - sec * 1000);
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);

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

/** 这张单上的三笔：已收场的动手（第 1 回合）、在跑的动手（第 2 回合，返工）、收场的验收（带结论）。 */
async function seedRuns() {
  const a = await startRun(t.db, {
    segment: 'manual',
    model: 'opus-5.5',
    taskId: IDS.task12,
    startedAt: ago(900),
    cause: 'main',
    roundSeq: 1,
    prNumber: 7,
    branch: 'fleet/12-x',
  });
  await finishRun(t.db, { runId: a.id, outcome: 'done', endedAt: ago(600) });
  const v = await startRun(t.db, {
    segment: 'verify',
    model: 'gpt-5.6',
    taskId: IDS.task12,
    startedAt: ago(590),
    roundSeq: 1,
    prNumber: 7,
  });
  await finishRun(t.db, { runId: v.id, outcome: 'done', endedAt: ago(560) });
  await noteRunVerdict(t.db, v.id, {
    pass: false,
    problems: ['第 2 条没做到'],
    failedCriteria: [2],
    handedOver: [],
  });
  const b = await startRun(t.db, {
    segment: 'manual',
    model: 'opus-5.5',
    taskId: IDS.task12,
    startedAt: ago(300),
    cause: 'rework_verify',
    causeSummary: '验收没过：第 2 条没做到',
    roundSeq: 2,
    resumeSessionId: 'claude:prev',
    prNumber: 7,
  });
  const e = (seq: number, sec: number, over: Record<string, unknown>) => ({
    seq,
    at: ago(sec),
    kind: 'assistant' as const,
    text: '',
    ...over,
  });
  await appendRunTranscript(t.db, a.id, [
    e(0, 899, { kind: 'prompt', text: '提示词' }),
    e(1, 898, { text: '先看代码' }),
    e(2, 897, { kind: 'tool_call', tool: 'Read', text: 'a.ts', meta: { callId: 'r1' } }),
    e(3, 896, { kind: 'tool_result', tool: 'Read', ok: true, text: '内容', meta: { callId: 'r1' } }),
    e(4, 800, { text: '改文件再测' }),
    e(5, 799, { kind: 'tool_call', tool: 'Edit', text: 'a.ts', meta: { callId: 'e1' } }),
    e(6, 798, {
      kind: 'tool_result',
      tool: 'Edit',
      ok: true,
      text: 'ok',
      meta: { callId: 'e1', added: 3, removed: 1 },
    }),
    e(7, 797, { kind: 'tool_call', tool: 'Bash', text: 'pnpm test', meta: { callId: 'b1' } }),
    e(8, 700, { kind: 'tool_result', tool: 'Bash', ok: false, text: 'FAIL', meta: { callId: 'b1' } }),
    e(9, 699, { kind: 'tool_call', tool: 'Bash', text: 'pnpm test', meta: { callId: 'b2' } }),
    e(10, 650, { kind: 'tool_result', tool: 'Bash', ok: true, text: 'ok', meta: { callId: 'b2' } }),
    e(11, 601, { kind: 'result', text: '收场摘要不该当汇报', ok: true }),
  ]);
  await appendRunTranscript(t.db, b.id, [
    e(0, 299, { kind: 'prompt', text: '返工提示词' }),
    e(1, 298, { text: '按验收意见改第 2 条' }),
    e(2, 297, { kind: 'tool_call', tool: 'Bash', text: 'pnpm test', meta: { callId: 'c1' } }),
    e(3, 296, { text: '子代理说的话不是汇报', meta: { subagent: 'agent-1' } }),
  ]);
  return { a: a.id, v: v.id, b: b.id };
}

const getDetail = async (h: NonNullable<typeof current>, cookie: string) => {
  const res = await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return TaskDetailResponse.parse(await res.json());
};

describe('任务详情的概览：真库', () => {
  it('每一笔的起因、回合、结论；命令计数按笔和合计；最新汇报取最近一笔动手的最后一句主会话的话；回合；引擎做的事', async () => {
    current = await pgHarness(t, { runTranscript: pgRunTranscript(t.db) });
    const s = await current.login();
    const ids = await seedRuns();
    await recordTaskRound(t.db, {
      taskId: IDS.task12,
      workflowId: 'wf',
      seq: 1,
      round: 1,
      outcome: 'verify_rejected',
      tier: 'medium',
      firstModel: 'opus-5.5',
      startedAt: ago(900),
      endedAt: ago(550),
      reworkSummary: '验收没过：第 2 条没做到',
    });
    await t.db.insert(stepTimings).values([
      {
        kind: 'activity',
        workflowId: 'wf',
        temporalRunId: 'r',
        workflowType: 'taskWorkflow',
        taskId: IDS.task12,
        activity: 'pushBranch',
        attempt: 1,
        scheduledAt: ago(610),
        startedAt: ago(600),
        endedAt: ago(595),
        queueMs: 0,
        runMs: 5000,
        outcome: 'ok',
      },
      {
        kind: 'activity',
        workflowId: 'wf',
        temporalRunId: 'r',
        workflowType: 'taskWorkflow',
        taskId: IDS.task12,
        activity: 'saveTaskState',
        attempt: 1,
        scheduledAt: ago(610),
        startedAt: ago(600),
        endedAt: ago(599),
        queueMs: 0,
        runMs: 100,
        outcome: 'ok',
      },
      {
        kind: 'wait',
        workflowId: 'wf',
        temporalRunId: 'r',
        workflowType: 'taskWorkflow',
        taskId: IDS.task12,
        waitFor: 'human',
        detail: '等人',
        startedAt: ago(540),
        endedAt: ago(500),
        waitMs: 40_000,
      },
    ]);
    const d = await getDetail(current, s.cookie);

    // 每一笔：起因、回合、是否接上一笔会话、验收结论
    const run = (id: string) => d.segmentRuns.find((r) => r.id === id);
    expect(run(ids.a)).toMatchObject({ cause: 'main', roundSeq: 1 });
    expect(run(ids.a)?.resumed).toBeUndefined();
    expect(run(ids.b)).toMatchObject({
      cause: 'rework_verify',
      causeSummary: '验收没过：第 2 条没做到',
      roundSeq: 2,
      resumed: true,
      running: true,
    });
    expect(run(ids.v)?.verdict).toMatchObject({ pass: false, failedCriteria: [2] });

    const o = d.overview;
    expect(o?.tally.state).toBe('ok');
    if (o?.tally.state !== 'ok') return;
    // 已收场的动手：2 个命令一成一败，读了 1 个文件，改了 1 次（+3 -1）
    expect(o.tally.byRun[ids.a]).toMatchObject({
      commands: 2,
      commandsDone: 1,
      commandsFailed: 1,
      commandsUnknown: 0,
      commandsRunning: 0,
      reads: 1,
      editsOk: 1,
      added: 3,
      removed: 1,
      uncounted: 0,
    });
    // 在跑的动手：1 个命令还没结果 = 在跑，不算成功也不算失败
    expect(o.tally.byRun[ids.b]).toMatchObject({ commands: 1, commandsDone: 0, commandsRunning: 1 });
    // 验收那一笔一条记录都没有：不在 byRun 里（页面写没记录，不写 0）
    expect(o.tally.byRun[ids.v]).toBeUndefined();
    expect(o.tally.total).toMatchObject({ commands: 3, commandsFailed: 1, commandsRunning: 1, reads: 1 });

    // 最新汇报：最近一笔动手（B）最后一句主会话的话，不取子代理的、不取 result
    expect(o.report).toMatchObject({ state: 'ok', text: '按验收意见改第 2 条', runId: ids.b });

    expect(o.rounds).toMatchObject({
      state: 'ok',
      items: [{ seq: 1, round: 1, outcome: 'verify_rejected', reworkSummary: '验收没过：第 2 条没做到' }],
    });
    if (o.rounds.state === 'ok') expect(o.rounds.items[0]?.startedAt).toBe(ago(900).toISOString());

    // 引擎在会话外做的事：只列要写出来的活动和等待，内部记账（saveTaskState）不列
    expect(o.engineSteps.state).toBe('ok');
    if (o.engineSteps.state === 'ok') {
      expect(o.engineSteps.items.map((i) => (i.kind === 'activity' ? i.activity : `等${i.waitFor}`))).toEqual(
        ['pushBranch', '等human'],
      );
    }
  });

  it('PR 横条：状态来自镜像；改了哪些文件来自按头记的 numstat，记的头不是镜像里现在的头就标 current:false；没记过的写 none 和原因', async () => {
    current = await pgHarness(t, { runTranscript: pgRunTranscript(t.db) });
    const s = await current.login();
    await seedRuns();
    await t.db.insert(pullRequests).values({
      repoId: IDS.repo,
      number: 7,
      state: 'open',
      headRef: 'fleet/12-x',
      headSha: H2,
      checks: 'failure',
      updatedAt: T0,
    });
    await recordPrHeadFiles(t.db, {
      repoId: IDS.repo,
      prNumber: 7,
      headSha: H1,
      files: [
        { path: 'a.ts', added: 3, removed: 1, binary: false },
        { path: 'logo.png', added: null, removed: null, binary: true },
      ],
    });
    const stale = (await getDetail(current, s.cookie)).overview?.prs;
    expect(stale).toHaveLength(1);
    expect(stale?.[0]).toMatchObject({ number: 7, branch: 'fleet/12-x', state: 'failed', headSha: H2 });
    expect(stale?.[0]?.files).toEqual({
      state: 'ok',
      headSha: H1,
      current: false,
      items: [
        { path: 'a.ts', added: 3, removed: 1, binary: false },
        { path: 'logo.png', added: null, removed: null, binary: true },
      ],
    });
    // 推了新头、也记了：最新那个头，current 为真
    await t.db.update(prHeadFiles).set({ recordedAt: ago(100) });
    await recordPrHeadFiles(t.db, {
      repoId: IDS.repo,
      prNumber: 7,
      headSha: H2,
      files: [{ path: 'b.ts', added: 1, removed: 0, binary: false }],
    });
    const fresh = (await getDetail(current, s.cookie)).overview?.prs[0]?.files;
    expect(fresh).toMatchObject({ state: 'ok', headSha: H2, current: true, items: [{ path: 'b.ts' }] });
    // 镜像里没有这个 PR、也没记过文件：状态 unknown 写原因，文件 none
    await t.db.delete(pullRequests);
    await t.db.delete(prHeadFiles);
    const bare = (await getDetail(current, s.cookie)).overview?.prs[0];
    expect(bare?.state).toBe('unknown');
    expect(bare?.note).toContain('没有这个 PR 的镜像');
    expect(bare?.files).toMatchObject({ state: 'none' });
  });

  it('一笔都没有动手：汇报写 none 和原因；回合、引擎步骤是空的但读到了（不是读不到）', async () => {
    current = await pgHarness(t, { runTranscript: pgRunTranscript(t.db) });
    const s = await current.login();
    const o = (await getDetail(current, s.cookie)).overview;
    expect(o?.report).toMatchObject({ state: 'none' });
    expect(o?.rounds).toEqual({ state: 'ok', items: [] });
    expect(o?.engineSteps).toEqual({ state: 'ok', items: [] });
    expect(o?.tally).toMatchObject({ state: 'ok' });
  });
});

describe('一笔切好的步骤：GET /tasks/:taskId/runs/:runId/steps', () => {
  it('按这一笔的轻量行切好：标题、起止、用时、小计；命令成败按调用号对；这一笔在跑最后一步 running', async () => {
    current = await pgHarness(t, { runTranscript: pgRunTranscript(t.db) });
    const s = await current.login();
    const ids = await seedRuns();
    const get = async (runId: string) =>
      current!.cockpit.request(`/api/tasks/${IDS.task12}/runs/${runId}/steps`, {
        headers: { cookie: s.cookie },
      });
    const done = RunStepsResponse.parse(await (await get(ids.a)).json());
    expect(done.state).toBe('ok');
    if (done.state !== 'ok') return;
    expect(done.running).toBe(false);
    expect(done.process.steps.map((x) => x.title)).toEqual(['先看代码', '改文件再测']);
    expect(done.process.steps[1]).toMatchObject({
      commands: 2,
      commandsFailed: 1,
      failed: true,
      files: [{ path: 'a.ts', edits: 1, added: 3, removed: 1 }],
    });
    expect(done.process.counts).toMatchObject({ commandsDone: 1, commandsFailed: 1, reads: 1 });
    expect(done.process.legacyCalls).toBe(0);

    const live = RunStepsResponse.parse(await (await get(ids.b)).json());
    expect(live).toMatchObject({ state: 'ok', running: true });
    if (live.state === 'ok') {
      expect(live.process.steps.at(-1)).toMatchObject({ running: true, commandsRunning: 1 });
      expect(live.process.steps.at(-1)?.endedAt).toBeUndefined();
    }

    // 验收那一笔一条记录都没有、已收场：noRecord
    expect(RunStepsResponse.parse(await (await get(ids.v)).json())).toEqual({ state: 'noRecord' });
  });

  it('权限和归属：没登录 401；别的单的 runId 404；没有这张单 404', async () => {
    current = await pgHarness(t, { runTranscript: pgRunTranscript(t.db) });
    const s = await current.login();
    const ids = await seedRuns();
    const url = (task: string, run: string) => `/api/tasks/${task}/runs/${run}/steps`;
    expect((await current.cockpit.request(url(IDS.task12, ids.a))).status).toBe(401);
    const cross = await current.cockpit.request(url(IDS.task13, ids.a), { headers: { cookie: s.cookie } });
    expect(cross.status).toBe(404);
    expect(await errorCode(cross)).toBe('run_not_found');
    const miss = await current.cockpit.request(url('00000000-0000-4000-8000-0000000000ff', ids.a), {
      headers: { cookie: s.cookie },
    });
    expect(miss.status).toBe(404);
  });
});

describe('读不到的各写各的原因', () => {
  const failing = (what: keyof RunTranscriptPort): RunTranscriptPort => {
    const throws = async () => {
      throw new Error(`${String(what)} 读不了`);
    };
    return {
      read: async () => ({ entries: [], any: false, more: false }),
      processRows: async () => [],
      tallies: async () => new Map(),
      lastSay: async () => null,
      rounds: async () => [],
      engineSteps: async () => [],
      prFiles: async () => null,
      [what]: throws,
    } as RunTranscriptPort;
  };

  it('【故意造出的失败】某一块读不了：那一块写「没读成」和原因，别的块照样读到，详情照样 200', async () => {
    const run = {
      segment: 'manual' as const,
      model: 'opus-5.5',
      taskId: IDS.task12,
      startedAt: T0.toISOString(),
    };
    for (const [what, block] of [
      ['tallies', 'tally'],
      ['lastSay', 'report'],
      ['rounds', 'rounds'],
      ['engineSteps', 'engineSteps'],
    ] as const) {
      const h = harness({ runTranscript: failing(what) });
      h.store.data.segmentRuns.push({ ...run, id: 'e3000000-0000-4000-8000-000000000001' });
      const s = await h.login();
      const res = await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers: { cookie: s.cookie } });
      expect(res.status).toBe(200);
      const o = TaskDetailResponse.parse(await res.json()).overview;
      expect(o?.[block]).toMatchObject({ state: 'unavailable' });
      expect(o?.[block]).toMatchObject({ reason: expect.stringContaining(`${what} 读不了`) });
      const others = (['tally', 'report', 'rounds', 'engineSteps'] as const).filter((k) => k !== block);
      for (const k of others) expect(o?.[k]?.state).not.toBe('unavailable');
    }
  });

  it('会话内容没接上（内存版、开发环境）：四块都写没接上，不是空；PR 的文件也写没接上', async () => {
    const h = harness();
    h.store.data.segmentRuns.push({
      segment: 'manual',
      model: 'opus-5.5',
      taskId: IDS.task12,
      id: 'e3000000-0000-4000-8000-000000000002',
      startedAt: T0.toISOString(),
      prNumber: 7,
    });
    const s = await h.login();
    const res = await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers: { cookie: s.cookie } });
    const o = TaskDetailResponse.parse(await res.json()).overview;
    for (const k of ['tally', 'report', 'rounds', 'engineSteps'] as const) {
      expect(o?.[k]).toEqual({ state: 'unavailable', reason: TRANSCRIPT_NOT_WIRED });
    }
    expect(o?.prs[0]?.files).toEqual({ state: 'unavailable', reason: TRANSCRIPT_NOT_WIRED });
  });
});
