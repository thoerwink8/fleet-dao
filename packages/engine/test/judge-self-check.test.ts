// 判断题自检（#1365）：最近一次失败超过 30 分钟才发一道固定题，结果写进 jev_answers 当最近一次。
// 通过则健康恢复；最近一次成功不发；自检失败仍红，原因写明自检失败。不占每日次数和花费。库是内存里的真迁移，后端不出网。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRoutingDefault,
  finishScheduleRun,
  loadCatalog,
  loadRoutingConfig,
  parseCatalog,
  seed,
  startScheduleRun,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  type BackendRequest,
  type BackendResult,
  countAskedSince,
  createJev,
  ERROR_NEXT,
  type JevBackend,
  judgeFailureNote,
  judgeHealth,
  lastSentCall,
  probeCallOk,
  usdSpentSince,
} from '@fleet-dao/jev';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type JudgeSelfCheckJobDeps, runJudgeSelfCheckJob } from '../src/jobs/judge-self-check.ts';
import { registerEngineJobs } from '../src/real/jobs.ts';

const T0 = new Date('2026-10-08T21:00:00.000Z');
const STALE_MS = 30 * 60_000;
const MODEL = 'jev-1.13.0';
const ROUTE = 'jev:jev-1.13:api-shell';
const EPOCH = new Date(0);
const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

let t: TestDb;
let machinePath: string;
const cleanups: (() => void)[] = [];

beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await seed(t.db);
  await loadCatalog(t.db, parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json'));
  await applyRoutingDefault(t.db, await loadRoutingConfig());
  await registerEngineJobs(t.db);
  const dir = mkdtempSync(join(tmpdir(), 'fleet-judge-probe-'));
  const keyFile = join(dir, 'typesafe.key');
  writeFileSync(keyFile, 'k-engine-test\n');
  machinePath = join(dir, 'jev.json');
  writeFileSync(
    machinePath,
    JSON.stringify({ typesafe: { endpoint: 'https://jev.example.invalid/v1', keyFile } }),
  );
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function probing(result: BackendResult, calls: BackendRequest[]): JevBackend {
  return {
    kind: 'fake',
    model: MODEL,
    usdPerMTok: 3,
    ask: async (request) => {
      calls.push(request);
      return result;
    },
  };
}

function jobAt(now: Date, backend: JevBackend): JudgeSelfCheckJobDeps {
  return {
    db: t.db,
    resolve: async () => ({ state: 'ready', backend, routeId: ROUTE }),
    runs: {
      start: (job, at) => startScheduleRun(t.db, job, at),
      finish: (id, result, at) => finishScheduleRun(t.db, id, result, at),
    },
    now: () => now,
    log: () => {},
  };
}

async function health() {
  return judgeHealth(t.db, {
    path: machinePath,
    explicit: false,
    makeBackend: async () => ({
      kind: 'fake',
      model: MODEL,
      ask: async () => {
        throw new Error('健康检查不该问上游');
      },
    }),
  });
}

function atMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

async function runs() {
  const { rows } = await t.client.query<{ outcome: string; why: string | null }>(
    `select outcome, why from schedule_runs where job = 'judge-self-check' order by id desc`,
  );
  return rows;
}

async function probeRows() {
  const { rows } = await t.client.query<{
    id: number;
    ok: boolean;
    answer: string | null;
    fail_reason: string | null;
    asked_at: Date | string;
    sample: { costUsd?: number };
  }>(
    `select id, ok, answer, fail_reason, asked_at, sample
     from jev_answers where question_id = 'judge-probe' order by id`,
  );
  return rows;
}

async function answerCount(): Promise<number> {
  const { rows } = await t.client.query<{ n: number }>('select count(*)::int as n from jev_answers');
  const n = rows[0]?.n;
  if (typeof n !== 'number') throw new Error('判断记录没数成');
  return n;
}

async function askBusiness(at: Date, result: BackendResult): Promise<void> {
  await createJev({
    db: t.db,
    backend: { kind: 'fake', model: MODEL, ask: async () => result },
    route: ROUTE,
    now: () => at,
  }).ask(
    ERROR_NEXT,
    { step: '任务 t1 的 execute 阶段（会话失败）', message: 'socket hang up' },
    { subject: 'issue:1365' },
  );
}

const overloaded: BackendResult = {
  ok: false,
  reason: 'overloaded',
  detail: 'HTTP 529 overloaded',
  latencyMs: 12,
};

const yes: BackendResult = {
  ok: true,
  answers: { 'judge-probe': { option: 'yes', confidence: 0.9 } },
  model: MODEL,
  latencyMs: 6,
  inputTokens: 1000,
  tokensEstimated: false,
};

describe('判断题自检', () => {
  it('最近一次失败超过 30 分钟：发自检，通过后健康恢复；刚好 30 分钟不发，也不占次数和花费', async () => {
    await askBusiness(T0, overloaded);
    const beforeCount = await countAskedSince(t.db, EPOCH);
    const calls: BackendRequest[] = [];
    const backend = probing(yes, calls);

    const early = await runJudgeSelfCheckJob(jobAt(new Date(T0.getTime() + STALE_MS), backend));
    expect(early.sent).toBe(false);
    expect(early.outcome).toBe('ok');
    expect(calls).toHaveLength(0);
    expect((await health()).state).toBe('failing');

    const dueAt = new Date(T0.getTime() + STALE_MS + 1);
    const later = await runJudgeSelfCheckJob(jobAt(dueAt, backend));
    expect(later.sent).toBe(true);
    expect(later.outcome).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(1);
    expect(calls[0]?.questions[0]?.id).toBe('judge-probe');
    expect(calls[0]?.evidence).toEqual([{ label: '词', text: '自检' }]);
    expect((await health()).state).toBe('ok');

    const [row] = await probeRows();
    if (!row) throw new Error('没有自检记录');
    expect(row.ok).toBe(true);
    expect(atMs(row.asked_at)).toBe(dueAt.getTime());
    expect(row.sample.costUsd).toBeUndefined();
    expect(await countAskedSince(t.db, EPOCH)).toBe(beforeCount);
    expect(await usdSpentSince(t.db, EPOCH)).toBe(0);

    await t.client.query(
      `update jev_answers set sample = sample || '{"costUsd":0.003}'::jsonb, input_tokens = 1000 where id = $1`,
      [row?.id],
    );
    expect(await usdSpentSince(t.db, EPOCH)).toBe(0);
    expect(await countAskedSince(t.db, EPOCH)).toBe(beforeCount);

    const logged = await runs();
    expect(logged).toHaveLength(2);
    expect(logged.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('最近一次成功（哪怕已经两小时）：不发自检，仍记一条跑完的定时记录', async () => {
    await askBusiness(T0, {
      ok: true,
      answers: { 'error-next': { option: 'retry', confidence: 0.9 } },
      model: MODEL,
      latencyMs: 5,
      inputTokens: 100,
      tokensEstimated: false,
    });
    const calls: BackendRequest[] = [];
    const before = await answerCount();
    const run = await runJudgeSelfCheckJob(
      jobAt(new Date(T0.getTime() + 2 * 60 * 60_000), probing(yes, calls)),
    );
    expect(run.sent).toBe(false);
    expect(run.outcome).toBe('ok');
    expect(calls).toHaveLength(0);
    expect(await answerCount()).toBe(before);
    expect(await runs()).toHaveLength(1);
    expect((await health()).state).toBe('ok');
  });

  it('自检也失败：健康仍红，定时记录和原因都写明是自检失败', async () => {
    await askBusiness(T0, overloaded);
    const beforeCount = await countAskedSince(t.db, EPOCH);
    const calls: BackendRequest[] = [];
    const run = await runJudgeSelfCheckJob(
      jobAt(new Date(T0.getTime() + STALE_MS + 1), probing(overloaded, calls)),
    );
    expect(calls).toHaveLength(1);
    expect(run.sent).toBe(true);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('自检失败');
    const h = await health();
    expect(h.state).toBe('failing');
    if (h.state === 'failing') {
      const note = judgeFailureNote(h.call);
      expect(note).toContain('自检失败');
      expect(note).toContain('overloaded');
    }
    const [logged] = await runs();
    expect(logged?.outcome).toBe('partial');
    expect(logged?.why).toContain('自检失败');
    expect(await countAskedSince(t.db, EPOCH)).toBe(beforeCount);
    expect(await usdSpentSince(t.db, EPOCH)).toBe(0);
  });

  it('【故意造出的失败】自检答错却被当成通过写进去：这一行必须是没成，写成通过这条就红', async () => {
    const wrong: BackendResult = {
      ok: true,
      answers: { 'judge-probe': { option: 'no', confidence: 0.99 } },
      model: MODEL,
      latencyMs: 4,
      inputTokens: 1000,
      tokensEstimated: false,
    };
    // 上游说调用成了（ok:true），但这道题的答案是 yes。判成通过再写进库，下面几条对不上。
    expect(probeCallOk(wrong).ok).toBe(false);
    await askBusiness(T0, overloaded);
    const calls: BackendRequest[] = [];
    const run = await runJudgeSelfCheckJob(
      jobAt(new Date(T0.getTime() + STALE_MS + 1), probing(wrong, calls)),
    );
    expect(calls).toHaveLength(1);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('自检失败');
    const [row] = await probeRows();
    expect(row?.ok).toBe(false);
    expect(row?.answer).toBeNull();
    expect(row?.fail_reason).toBe('bad_answer');
    const last = await lastSentCall(t.db);
    expect(last?.ok).toBe(false);
    expect((await health()).state).toBe('failing');
    if (last) expect(judgeFailureNote(last)).toContain('自检失败');
  });
});
