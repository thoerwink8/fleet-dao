// ask 的行为：只记不拦、真拦、把握不够、没判出来都走默认；每次都记一行；每日上限；喂全文、库里只留脱敏的摘要。
import { auditLog, jevAnswers, jevQuestionStats, jevQuestions, settings } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { BackendResult } from '../src/backend.ts';
import {
  DEDUPE_PAIR,
  ERROR_NEXT,
  FEISHU_INTENT,
  TRIAGE_CLARITY,
  TRIAGE_GATE,
  TRIAGE_KIND,
  TRIAGE_QUESTIONS,
  TRIAGE_UI,
} from '../src/bank.ts';
import { createJev } from '../src/jev.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { defineQuestion, renderPrompt } from '../src/questions.ts';
import { fakeBackend, HOUR, MODEL, ok } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const NOW = new Date('2026-09-25T04:00:00Z');
const jevWith = (backend = fakeBackend()) => createJev({ db: t.db, backend, now: () => NOW });
const ctx = { subject: 'task:1' };
const request = { request: '给看板加一个额度页：每个账号池、每个时间窗还剩多少，几点清零。' };

async function rows() {
  return t.db.select().from(jevAnswers).orderBy(jevAnswers.id);
}

async function setMode(id: string, mode: 'shadow' | 'enforce' | 'off') {
  await t.db.update(jevQuestions).set({ mode }).where(eq(jevQuestions.id, id));
}

describe('只记不拦与真拦', () => {
  it('第一次问到就登记：只记不拦、钉在这次后端的模型上；判出来了也只记，act 是 none', async () => {
    const backend = fakeBackend(() => ok({ 'triage-ui': ['ui', 0.92] }));
    const v = await jevWith(backend).ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: true, option: 'ui', effect: 'reroute', enforced: false, act: 'none' });
    const [q] = await t.db.select().from(jevQuestions);
    expect(q).toMatchObject({
      id: 'triage-ui',
      mode: 'shadow',
      model: MODEL,
      prompt: renderPrompt(TRIAGE_UI),
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      questionId: 'triage-ui',
      subject: 'task:1',
      shadow: true,
      ok: true,
      answer: 'ui',
      confidence: 0.92,
      failReason: null,
      modelVersion: MODEL,
      latencyMs: 12,
      inputTokens: 400,
    });
    expect(v.answerId).toBe(row?.id);
  });

  it('题目在真拦、模型对得上、把握够：act 就是选项挂的效果，这一行记成真拦', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-ui': ['ui', 0.92] })));
    await jev.ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    const v = await jev.ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: true, enforced: true, act: 'reroute' });
    expect((await rows()).map((r) => r.shadow)).toEqual([true, false]);
  });

  it('选中「不改流程」的选项，真拦时 act 也是 none', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-ui': ['no_ui', 0.95] })));
    await jev.ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({
      judged: true,
      enforced: true,
      act: 'none',
    });
  });

  it('钉死的模型和这次后端的不一样：题目在真拦也只记不拦', async () => {
    await jevWith(fakeBackend()).ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    const other = fakeBackend(
      () => ok({ 'triage-ui': ['ui', 0.99] }, { model: 'claude-opus-5-5' }),
      'claude-opus-5-5',
    );
    const v = await jevWith(other).ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: true, enforced: false, act: 'none' });
    const last = (await rows()).at(-1);
    expect(last).toMatchObject({
      shadow: true,
      sample: expect.objectContaining({ model: 'claude-opus-5-5' }),
    });
  });

  it('库里的题面和代码对不上（改了题还没同步）：只记不拦', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-ui': ['ui', 0.99] })));
    await jev.ask(TRIAGE_UI, request, ctx);
    await t.db
      .update(jevQuestions)
      .set({ mode: 'enforce', prompt: '旧题面' })
      .where(eq(jevQuestions.id, 'triage-ui'));
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({
      judged: true,
      enforced: false,
      act: 'none',
    });
  });

  it('只改了证据字段（给模型看的名字）还没同步：也算题面对不上，这次只记不拦', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-ui': ['ui', 0.99] })));
    await jev.ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    const relabeled = defineQuestion({
      ...TRIAGE_UI,
      evidence: [{ key: 'request', label: '需求原文（改过名字）', required: true }],
    });
    expect(await jev.ask(relabeled, request, ctx)).toMatchObject({
      judged: true,
      enforced: false,
      act: 'none',
    });
  });

  it('把握度低于把握线 = 没判出来：act 是 none，但答了什么照记（统计里算「没把握」）', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-clarity': ['goal', 0.55] })));
    await jev.ask(TRIAGE_CLARITY, request, ctx);
    await setMode('triage-clarity', 'enforce');
    const v = await jev.ask(TRIAGE_CLARITY, request, ctx);
    expect(v).toMatchObject({
      judged: false,
      reason: 'unsure',
      option: 'goal',
      confidence: 0.55,
      act: 'none',
    });
    const [, row] = await rows();
    expect(row).toMatchObject({ ok: true, answer: 'goal', confidence: 0.55, failReason: null });
    const stats = await jevQuestionStats(t.db);
    expect(stats.find((s) => s.questionId === 'triage-clarity')).toMatchObject({ asked: 2, unsure: 2 });
  });
});

describe('没判出来一律走默认，不当成「否」', () => {
  const failures: [string, BackendResult][] = [
    ['超时', { ok: false, reason: 'timeout', detail: '8000 毫秒没回', latencyMs: 8000 }],
    ['过载 529', { ok: false, reason: 'overloaded', detail: 'HTTP 529', latencyMs: 30 }],
    ['连不上', { ok: false, reason: 'network', detail: 'ECONNREFUSED', latencyMs: 3 }],
    ['密钥不对', { ok: false, reason: 'auth', detail: 'HTTP 401', latencyMs: 20 }],
  ];
  for (const [what, result] of failures) {
    it(`${what}：真拦的题也照默认走（act 是 none），记一行原因`, async () => {
      await jevWith().ask(TRIAGE_CLARITY, request, { subject: 'setup' });
      await setMode('triage-clarity', 'enforce');
      const v = await jevWith(fakeBackend(() => result)).ask(TRIAGE_CLARITY, request, ctx);
      const reason = result.ok ? 'no-such-reason' : result.reason;
      expect(v).toMatchObject({ judged: false, reason, act: 'none' });
      expect((await rows()).at(-1)).toMatchObject({
        ok: false,
        answer: null,
        confidence: null,
        failReason: reason,
        shadow: false,
      });
    });
  }

  it('后端抛异常也不往外抛：没判（backend_error）', async () => {
    const jev = jevWith(
      fakeBackend(() => {
        throw new Error('炸了');
      }),
    );
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({
      judged: false,
      reason: 'backend_error',
      act: 'none',
    });
  });

  it('答了题面以外的选项：不采纳，记成 bad_option', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-ui': ['maybe', 0.99] })));
    const v = await jev.ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'bad_option', act: 'none' });
    expect((await rows())[0]).toMatchObject({ ok: false, failReason: 'bad_option' });
  });

  it('回话的模型不是钉死的那个：不采纳，记成 model_mismatch', async () => {
    const jev = jevWith(fakeBackend(() => ok({ 'triage-ui': ['ui', 0.99] }, { model: 'jev-1.14.0' })));
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({ judged: false, reason: 'model_mismatch' });
    expect((await rows())[0]).toMatchObject({ failReason: 'model_mismatch', modelVersion: 'jev-1.14.0' });
  });

  it('回包里没有这道题、形状认不出、把握度不在 0–1：各记各的原因', async () => {
    const jev = jevWith(
      fakeBackend(() => ({
        ok: true,
        answers: {
          'triage-kind': { invalid: '没有 choice' },
          'triage-ui': { option: 'ui', confidence: 1.7 },
        },
        model: MODEL,
        latencyMs: 5,
        inputTokens: 100,
        tokensEstimated: false,
      })),
    );
    const [kind, ui, clarity] = await jev.askAll([TRIAGE_KIND, TRIAGE_UI, TRIAGE_CLARITY], request, ctx);
    expect(kind).toMatchObject({ judged: false, reason: 'bad_answer' });
    expect(ui).toMatchObject({ judged: false, reason: 'bad_answer' });
    expect(clarity).toMatchObject({ judged: false, reason: 'no_answer' });
  });

  it('库出错：没判（store_error），也不问出去', async () => {
    const broken = await createTestDb();
    await broken.close();
    const backend = fakeBackend();
    const v = await createJev({ db: broken.db, backend, now: () => NOW }).ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'store_error', act: 'none' });
    expect(v.answerId).toBeUndefined();
    expect(backend.calls).toHaveLength(0);
  });
});

describe('真拦中的题漂了：当场退回只记不拦', () => {
  const mode = async () => (await t.db.select().from(jevQuestions))[0]?.mode;
  const drifts: [string, () => BackendResult][] = [
    ['答了题面外的选项', () => ok({ 'triage-ui': ['maybe', 0.99] })],
    ['回话的不是钉死的模型', () => ok({ 'triage-ui': ['ui', 0.99] }, { model: 'jev-1.14.0' })],
  ];
  for (const [what, reply] of drifts) {
    it(`${what}：这一问当场退回、留操作记录（指着这一问），下一问就不真拦了`, async () => {
      const good = fakeBackend(() => ok({ 'triage-ui': ['ui', 0.95] }));
      await jevWith(good).ask(TRIAGE_UI, request, ctx);
      await setMode('triage-ui', 'enforce');
      const v = await jevWith(fakeBackend(reply)).ask(TRIAGE_UI, request, ctx);
      expect(v).toMatchObject({ judged: false, act: 'none' });
      expect(await mode()).toBe('shadow');
      const logs = await t.db.select().from(auditLog);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: 'jev.mode',
        target: 'jev:triage-ui',
        before: { mode: 'enforce' },
        after: { mode: 'shadow', answerId: v.answerId },
      });
      expect(await jevWith(good).ask(TRIAGE_UI, request, ctx)).toMatchObject({
        judged: true,
        enforced: false,
        act: 'none',
      });
    });
  }

  it('考试里漂了也当场退回（不等考完再判，也不怕下一次考试把它洗掉）', async () => {
    await jevWith().ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    const drifting = fakeBackend(() => ok({ 'triage-ui': ['maybe', 0.99] }));
    await jevWith(drifting).exam([TRIAGE_UI], request, {
      runId: 'r1',
      sampleId: 's1',
      expect: { 'triage-ui': 'ui' },
    });
    expect(await mode()).toBe('shadow');
  });

  it('别的模型漂了不连累钉死的那个：题照旧真拦，不留记录', async () => {
    await jevWith().ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    const other = fakeBackend(
      () => ok({ 'triage-ui': ['maybe', 0.99] }, { model: 'claude-opus-5-5' }),
      'claude-opus-5-5',
    );
    expect(await jevWith(other).ask(TRIAGE_UI, request, ctx)).toMatchObject({ reason: 'bad_option' });
    expect(await mode()).toBe('enforce');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('本地就拦下的：不问出去，也记一行', () => {
  it('停用的题：不问，记成 off', async () => {
    const backend = fakeBackend();
    const jev = jevWith(backend);
    await jev.ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'off');
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({ judged: false, reason: 'off' });
    expect(backend.calls).toHaveLength(1);
    expect((await rows()).at(-1)).toMatchObject({ failReason: 'off', modelVersion: null, latencyMs: null });
  });

  it('必填证据没给或是空白：不问，记成 missing_evidence', async () => {
    const backend = fakeBackend();
    const v = await jevWith(backend).ask(ERROR_NEXT, { step: 'createWorktree', message: '   ' }, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'missing_evidence', detail: '没给：message' });
    expect(backend.calls).toHaveLength(0);
  });

  it('给了题目不认识的证据字段：不问，记成 bad_evidence', async () => {
    const backend = fakeBackend();
    const evidence = { ...request, requst: '拼错的键' } as unknown as typeof request;
    const v = await jevWith(backend).ask(TRIAGE_UI, evidence, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'bad_evidence' });
    expect(backend.calls).toHaveLength(0);
  });

  it('没给 subject：不问', async () => {
    const backend = fakeBackend();
    expect(await jevWith(backend).ask(TRIAGE_UI, request, { subject: ' ' })).toMatchObject({
      reason: 'bad_evidence',
    });
    expect(backend.calls).toHaveLength(0);
  });
});

describe('每天的上限', () => {
  it('次数到上限就不再问出去；本地拦下的不占次数；「今天」从 UTC 0 点算', async () => {
    await t.db.insert(settings).values({ key: 'judge.dailyCallLimit', value: 2 });
    const backend = fakeBackend();
    const at = (iso: string) => createJev({ db: t.db, backend, now: () => new Date(iso) });
    // 前一天问的不算今天。
    await at('2026-09-24T23:59:00Z').ask(TRIAGE_UI, request, ctx);
    await at('2026-09-25T00:10:00Z').ask(TRIAGE_UI, request, ctx);
    await at('2026-09-25T00:20:00Z').ask(ERROR_NEXT, { step: 's', message: '' }, ctx); // 本地拦下
    await at('2026-09-25T00:30:00Z').ask(TRIAGE_UI, request, ctx);
    const capped = await at('2026-09-25T00:40:00Z').ask(TRIAGE_UI, request, ctx);
    expect(capped).toMatchObject({ judged: false, reason: 'daily_cap', act: 'none' });
    if (!capped.judged) expect(capped.detail).toContain('因每日次数上限没问');
    expect(backend.calls).toHaveLength(3);
  });

  it('按量计费的后端：花费按回包的 token 记进库；再问会超每日花费上限就停调、走默认，库里记「因上限没问」', async () => {
    // 价格定成每百万 token 1 美元：回包报 400 token = 0.0004 美元一问；事先按字数估每问约 0.0001 美元。
    // 上限 0.0009：第三问时已花 0.0008 + 估 0.0001 超了，不问。
    await t.db.insert(settings).values({ key: 'judge.dailyUsdCap', value: 0.0009 });
    const paid = { ...fakeBackend(), usdPerMTok: 1 };
    const short = { request: '改首页标题' };
    const first = await jevWith(paid).ask(TRIAGE_UI, short, ctx);
    const second = await jevWith(paid).ask(TRIAGE_UI, short, ctx);
    expect([first.judged, second.judged]).toEqual([true, true]);
    const third = await jevWith(paid).ask(TRIAGE_UI, short, ctx);
    expect(third).toMatchObject({ judged: false, reason: 'daily_cap', act: 'none' });
    if (!third.judged) expect(third.detail).toContain('因每日花费上限没问');
    expect(paid.calls).toHaveLength(2);
    const recorded = await rows();
    expect(recorded.map((r) => (r.sample as { costUsd?: number }).costUsd)).toEqual([
      0.0004,
      0.0004,
      undefined,
    ]);
    expect(recorded[2]).toMatchObject({
      ok: false,
      failReason: 'daily_cap',
      sample: expect.objectContaining({ detail: expect.stringContaining('因每日花费上限没问') }),
    });
  });

  it('发出去就记账：超时的调用按事前估算记花费（标明是估的），一直出错也照样被花费上限拦下', async () => {
    const timeout: BackendResult = { ok: false, reason: 'timeout', detail: '8000 毫秒没回', latencyMs: 8000 };
    const paid = { ...fakeBackend(() => timeout), usdPerMTok: 1 };
    const short = { request: '改首页标题' };
    await jevWith(paid).ask(TRIAGE_UI, short, ctx);
    const [first] = await rows();
    const estimated = first?.inputTokens ?? 0;
    expect(estimated).toBeGreaterThan(0);
    expect(first).toMatchObject({
      ok: false,
      failReason: 'timeout',
      sample: expect.objectContaining({ tokensEstimated: true, costUsd: estimated / 1_000_000 }),
    });
    // 上限只够两问多一点：第二问照问；第三问时已花两问、再加这一问的估算就超了，不问。
    await t.db.insert(settings).values({ key: 'judge.dailyUsdCap', value: (2.5 * estimated) / 1_000_000 });
    await jevWith(paid).ask(TRIAGE_UI, short, ctx);
    const third = await jevWith(paid).ask(TRIAGE_UI, short, ctx);
    expect(third).toMatchObject({ judged: false, reason: 'daily_cap', act: 'none' });
    if (!third.judged) expect(third.detail).toContain('因每日花费上限没问');
    expect(paid.calls).toHaveLength(2);
  });

  it('发出去就记账：出错的回包里上游报了 token 数按报的记；后端抛异常按估算记', async () => {
    const mismatch = {
      ...fakeBackend(() => ({
        ok: false,
        reason: 'model_mismatch',
        detail: '钉死的是 jev-1.13.0，回话的是 jev-1.14.0',
        latencyMs: 30,
        model: 'jev-1.14.0',
        inputTokens: 700,
      })),
      usdPerMTok: 1,
    };
    await jevWith(mismatch).ask(TRIAGE_UI, request, ctx);
    const throwing = {
      ...fakeBackend(() => {
        throw new Error('炸了');
      }),
      usdPerMTok: 1,
    };
    await jevWith(throwing).ask(TRIAGE_UI, request, ctx);
    const [reported, thrown] = await rows();
    expect(reported).toMatchObject({
      inputTokens: 700,
      sample: expect.objectContaining({ costUsd: 0.0007 }),
    });
    expect(reported?.sample).not.toHaveProperty('tokensEstimated');
    expect(thrown).toMatchObject({
      failReason: 'backend_error',
      sample: expect.objectContaining({ tokensEstimated: true, costUsd: expect.any(Number) }),
    });
    expect(thrown?.inputTokens).toBeGreaterThan(0);
  });

  it('巡检考试另算次数：生产问满了不挡考试，考试按自己的上限数、不占生产的', async () => {
    await t.db.insert(settings).values([
      { key: 'judge.dailyCallLimit', value: 1 },
      { key: 'judge.examDailyCallLimit', value: 2 },
    ]);
    const backend = fakeBackend();
    const jev = jevWith(backend);
    const exam = async (sampleId: string) =>
      (await jev.exam([TRIAGE_UI], request, { runId: 'r1', sampleId, expect: { 'triage-ui': 'ui' } }))[0];
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({ judged: true });
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({ reason: 'daily_cap' });
    expect([(await exam('s1'))?.judged, (await exam('s2'))?.judged]).toEqual([true, true]);
    const capped = await exam('s3');
    expect(capped).toMatchObject({ judged: false, reason: 'daily_cap' });
    if (capped && !capped.judged) expect(capped.detail).toContain('因考试每日次数上限没问');
    expect(backend.calls).toHaveLength(3);
  });

  it('订阅内的后端（没有单价）不受花费上限管', async () => {
    await t.db.insert(settings).values({ key: 'judge.dailyUsdCap', value: 0 });
    const backend = fakeBackend();
    expect(await jevWith(backend).ask(TRIAGE_UI, request, ctx)).toMatchObject({ judged: true });
    expect((await rows())[0]?.sample).not.toHaveProperty('costUsd');
  });

  it('花费上限默认就是旧系统的日帽，设置里配了以设置为准', async () => {
    expect(DEFAULT_POLICY.dailyUsdCap).toBe(0.3);
    await t.db.insert(settings).values({ key: 'judge.dailyUsdCap', value: -1 });
    const v = await jevWith({ ...fakeBackend(), usdPerMTok: 1 }).ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'bad_setting' });
  });

  it('一次问几道算几道：剩的次数不够这一批就整批不问', async () => {
    await t.db.insert(settings).values({ key: 'judge.dailyCallLimit', value: 3 });
    const backend = fakeBackend();
    const verdicts = await jevWith(backend).askAll(TRIAGE_QUESTIONS, request, ctx);
    expect(verdicts.map((v) => (v.judged ? 'judged' : v.reason))).toEqual([
      'daily_cap',
      'daily_cap',
      'daily_cap',
      'daily_cap',
    ]);
    expect(backend.calls).toHaveLength(0);
  });

  it('设置里没配就用默认上限', async () => {
    const backend = fakeBackend();
    const jev = createJev({
      db: t.db,
      backend,
      now: () => NOW,
      policy: { ...DEFAULT_POLICY, dailyCallLimit: 1 },
    });
    await jev.ask(TRIAGE_UI, request, ctx);
    expect(await jev.ask(TRIAGE_UI, request, ctx)).toMatchObject({ reason: 'daily_cap' });
  });

  it('设置里的上限认不出：不问出去，明说是设置坏了（不拿默认值顶上）', async () => {
    await t.db.insert(settings).values({ key: 'judge.dailyCallLimit', value: '很多' });
    const backend = fakeBackend();
    const v = await jevWith(backend).ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'bad_setting', act: 'none' });
    if (!v.judged) expect(v.detail).toContain('judge.dailyCallLimit');
    expect(backend.calls).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ ok: false, failReason: 'bad_setting' });
  });
});

describe('一次问几道题', () => {
  it('分诊四题共用一份证据，一次调用问完；token 按道分摊，同一批带同一个批号', async () => {
    const backend = fakeBackend(() =>
      ok(
        {
          'triage-kind': ['code', 0.9],
          'triage-ui': ['ui', 0.88],
          'triage-clarity': ['clear', 0.8],
          'triage-gate': ['none', 0.97],
        },
        { inputTokens: 1000 },
      ),
    );
    const [kind, ui, clarity, gate] = await jevWith(backend).askAll(TRIAGE_QUESTIONS, request, ctx);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.questions.map((q) => q.id)).toEqual([
      'triage-kind',
      'triage-ui',
      'triage-clarity',
      'triage-gate',
    ]);
    expect(backend.calls[0]?.evidence).toEqual([
      { label: '需求原文（标题、正文、评论）', text: request.request },
    ]);
    expect([kind.judged, ui.judged, clarity.judged, gate.judged]).toEqual([true, true, true, true]);
    const recorded = await rows();
    expect(recorded.map((r) => r.inputTokens)).toEqual([250, 250, 250, 250]);
    const batches = new Set(recorded.map((r) => (r.sample as { batch: { id: string } }).batch.id));
    expect(batches.size).toBe(1);
  });

  it('类型上：option 收窄到这道题的选项，act 收窄到这道题的效果', async () => {
    const [kind, gate] = await jevWith().askAll([TRIAGE_KIND, TRIAGE_GATE], request, ctx);
    if (kind.judged) expectTypeOf(kind.option).toEqualTypeOf<'code' | 'research' | 'manual'>();
    if (gate.judged) expectTypeOf(gate.act).toEqualTypeOf<'none' | 'stop'>();
    const dedupe = await jevWith().ask(DEDUPE_PAIR, { new_request: 'a', existing: 'b' }, ctx);
    expectTypeOf(dedupe.act).toEqualTypeOf<'none' | 'stop'>();
  });
});

describe('证据：喂全文，库里只留摘要', () => {
  it('五万字的正文原样喂给后端，不裁剪；库里只有长度、哈希和前 200 字', async () => {
    const backend = fakeBackend();
    const long = `需求：${'很长的正文。'.repeat(10_000)}`;
    await jevWith(backend).ask(TRIAGE_UI, { request: long }, ctx);
    expect(backend.calls[0]?.evidence[0]?.text).toBe(long);
    const [row] = await rows();
    const sample = row?.sample as { evidence: Record<string, { chars: number; sha: string; head?: string }> };
    expect(sample.evidence.request?.chars).toBe(long.length);
    expect(sample.evidence.request?.head).toBe(long.slice(0, 200));
    expect(JSON.stringify(row?.sample).length).toBeLessThan(2_000);
  });

  it('证据开头写库前脱敏（令牌、邮箱、IP）；喂给后端的还是原文', async () => {
    const backend = fakeBackend();
    const raw =
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 发给 someone@example.com，机器 10.2.3.4';
    await jevWith(backend).ask(TRIAGE_UI, { request: raw }, ctx);
    expect(backend.calls[0]?.evidence[0]?.text).toBe(raw);
    const sample = (await rows())[0]?.sample as { evidence: Record<string, { head?: string }> };
    expect(sample.evidence.request?.head).toBe('Authorization: Bearer <令牌> 发给 <邮箱>，机器 <IP>');
  });

  it('上游报错原文进库、交回调用方之前脱敏', async () => {
    const leak =
      'HTTP 401：{"error":"bad key sk-live1234567890abcdef","echo":"Bearer abcdefghijklmnopqrstuvwxyz"}';
    const jev = jevWith(fakeBackend(() => ({ ok: false, reason: 'auth', detail: leak, latencyMs: 20 })));
    const v = await jev.ask(TRIAGE_UI, request, ctx);
    const [row] = await rows();
    const stored = (row?.sample as { detail?: string } | undefined)?.detail;
    for (const detail of [v.judged ? '' : v.detail, stored ?? '']) {
      expect(detail).toContain('<密钥>');
      expect(detail).toContain('Bearer <令牌>');
      expect(detail).not.toContain('sk-live');
      expect(detail).not.toContain('abcdefghijklmnop');
    }
  });

  it('私聊字段只留长度和哈希，不留开头', async () => {
    await jevWith().ask(FEISHU_INTENT, { message: '今天进度怎么样？', recent_tasks: '看板额度页' }, ctx);
    const [row] = await rows();
    const sample = row?.sample as { evidence: Record<string, { head?: string }> };
    expect(sample.evidence.message?.head).toBeUndefined();
    expect(sample.evidence.recent_tasks?.head).toBe('看板额度页');
  });

  it('调用方给的引用（能复原原文的）照记', async () => {
    const ref = { issue: 'owner/repo#12', updatedAt: '2026-09-25T01:00:00Z' };
    await jevWith().ask(TRIAGE_UI, request, { subject: 'task:1', ref });
    expect((await rows())[0]?.sample).toMatchObject({ ref });
  });

  it('后端没报 token 数：按字符数估，标明是估的，不记 0', async () => {
    const backend = fakeBackend(() =>
      ok({ 'triage-ui': ['ui', 0.9] }, { inputTokens: 321, tokensEstimated: true }),
    );
    await jevWith(backend).ask(TRIAGE_UI, request, ctx);
    expect((await rows())[0]).toMatchObject({
      inputTokens: 321,
      sample: expect.objectContaining({ tokensEstimated: true }),
    });
  });
});

describe('写不进库的字与写不进库的时候', () => {
  const HIGH = /[\uD800-\uDBFF]$/;

  it('证据开头截在 emoji 中间：去掉落单的前一半，照常记进库（改之前整行被 jsonb 拒收、返回 store_error）', async () => {
    const backend = fakeBackend(() => ok({ 'triage-ui': ['ui', 0.9] }));
    const v = await jevWith(backend).ask(TRIAGE_UI, { request: `${'字'.repeat(199)}🔴后面还有` }, ctx);
    expect(v).toMatchObject({ judged: true });
    const [row] = await rows();
    const sample = row?.sample as { evidence: Record<string, { head?: string }> } | undefined;
    expect(sample?.evidence.request?.head).toBe('字'.repeat(199));
  });

  it('没判出来的原文截在 emoji 中间：同样去掉落单的前一半，原因照常记进库', async () => {
    const detail = `${'错'.repeat(499)}🔴尾巴`;
    const backend = fakeBackend(() => ({ ok: false, reason: 'timeout', detail, latencyMs: 8000 }));
    const v = await jevWith(backend).ask(TRIAGE_UI, request, ctx);
    expect(v).toMatchObject({ judged: false, reason: 'timeout' });
    if (!v.judged) expect(v.detail).toBe(`${'错'.repeat(499)}…`);
    const [row] = await rows();
    expect(row).toMatchObject({ failReason: 'timeout' });
    expect((row?.sample as { detail?: string } | undefined)?.detail).not.toMatch(HIGH);
  });

  it('判断没记进库、可这一问已经发给后端：花费另记一行（unrecorded），每日花费照样算；调用方拿到 store_error，原因开头说清', async () => {
    const paid = { ...fakeBackend(() => ok({ 'triage-ui': ['ui', 0.9] })), usdPerMTok: 1 };
    // 引用里带着落单的代理项：jsonb 收不下，这一行写不进去（调用方给的引用，什么都可能有）。
    const v = await jevWith(paid).ask(TRIAGE_UI, request, { subject: 'task:1', ref: { note: '\uD83D' } });
    expect(v).toMatchObject({ judged: false, reason: 'store_error', act: 'none' });
    if (!v.judged)
      expect(v.detail.startsWith('这一问已经发给后端，花费另记了一行。判断没记进库：')).toBe(true);
    expect(paid.calls).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({ ok: false, failReason: 'unrecorded', inputTokens: 400, shadow: true });
    const sample = row?.sample as { costUsd?: number; ref?: unknown; evidence: Record<string, object> };
    expect(sample.costUsd).toBe(0.0004);
    expect(sample.ref).toBeUndefined();
    expect(sample.evidence.request).toEqual({ chars: request.request.length, sha: expect.any(String) });
    // 补记的这一行占每日花费：上限只比这一问多一点（0.0004 + 下一问估约 0.0001 超了 0.00045），再问就不问了。
    await t.db.insert(settings).values({ key: 'judge.dailyUsdCap', value: 0.00045 });
    expect(await jevWith(paid).ask(TRIAGE_UI, { request: '改首页标题' }, ctx)).toMatchObject({
      reason: 'daily_cap',
    });
  });

  it(
    '补记也补不上：原因开头明说花了钱没记上，不静默丢',
    async () => {
      const own = await createTestDb();
      const paid = {
        ...fakeBackend(async () => {
          await own.close();
          return ok({ 'triage-ui': ['ui', 0.9] });
        }),
        usdPerMTok: 1,
      };
      const v = await createJev({ db: own.db, backend: paid, now: () => NOW }).ask(TRIAGE_UI, request, ctx);
      expect(v).toMatchObject({ judged: false, reason: 'store_error' });
      if (!v.judged) expect(v.detail.startsWith('这一问已经发给后端，花了钱没记上（补记也失败：')).toBe(true);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('本地就拦下的（没发出去）写不进库时不补记：没花钱，也不说花了钱', async () => {
    const backend = fakeBackend();
    const v = await jevWith(backend).ask(
      ERROR_NEXT,
      { step: 'createWorktree', message: '   ' },
      { subject: 'task:1', ref: { note: '\uD83D' } },
    );
    expect(v).toMatchObject({ judged: false, reason: 'store_error' });
    if (!v.judged) expect(v.detail.startsWith('判断没记进库：')).toBe(true);
    expect(backend.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe('考试', () => {
  it('标准答案记成真值（canary），从不真拦；只问有标准答案的题', async () => {
    const backend = fakeBackend(() => ok({ 'triage-ui': ['ui', 0.95] }));
    const jev = jevWith(backend);
    await jev.ask(TRIAGE_UI, request, ctx);
    await setMode('triage-ui', 'enforce');
    const [v] = await jev.exam(TRIAGE_QUESTIONS, request, {
      runId: 'run-1',
      sampleId: 'triage-01',
      expect: { 'triage-ui': 'ui' },
    });
    expect(v).toMatchObject({ judged: true, enforced: false, act: 'none' });
    expect(backend.calls.at(-1)?.questions.map((q) => q.id)).toEqual(['triage-ui']);
    expect((await rows()).at(-1)).toMatchObject({
      subject: 'exam:triage-01',
      shadow: true,
      truth: 'ui',
      truthSource: 'canary',
      sample: expect.objectContaining({ exam: { runId: 'run-1', sampleId: 'triage-01' } }),
    });
  });
});

describe('时间', () => {
  it('记下的时刻就是注入的时钟', async () => {
    const at = new Date(NOW.getTime() - HOUR);
    await createJev({ db: t.db, backend: fakeBackend(), now: () => at }).ask(TRIAGE_UI, request, ctx);
    expect((await rows())[0]?.askedAt.toISOString()).toBe(at.toISOString());
  });
});
