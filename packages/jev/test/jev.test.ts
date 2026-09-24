// ask 的行为：只记不拦、真拦、把握不够、没判出来都走默认；每次都记一行；每日次数；喂全文、库里只留摘要。
import { jevAnswers, jevQuestionStats, jevQuestions, settings } from '@fleet-dao/db';
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
import { renderPrompt } from '../src/questions.ts';
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

describe('每天的次数', () => {
  it('到上限就不再问出去；本地拦下的不占次数；「今天」按北京时间 0 点算', async () => {
    await t.db.insert(settings).values({ key: 'judge.dailyCallLimit', value: 2 });
    const backend = fakeBackend();
    const at = (iso: string) => createJev({ db: t.db, backend, now: () => new Date(iso) });
    // 北京时间 9 月 25 日 0 点 = UTC 9 月 24 日 16 点：前一天问的不算今天。
    await at('2026-09-24T15:59:00Z').ask(TRIAGE_UI, request, ctx);
    await at('2026-09-24T16:10:00Z').ask(TRIAGE_UI, request, ctx);
    await at('2026-09-24T16:20:00Z').ask(ERROR_NEXT, { step: 's', message: '' }, ctx); // 本地拦下
    await at('2026-09-24T16:30:00Z').ask(TRIAGE_UI, request, ctx);
    const capped = await at('2026-09-24T16:40:00Z').ask(TRIAGE_UI, request, ctx);
    expect(capped).toMatchObject({ judged: false, reason: 'daily_cap', act: 'none' });
    expect(backend.calls).toHaveLength(3);
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
      policy: {
        minSamples: 50,
        accuracyLine: 0.9,
        examMinAnswered: 3,
        examAnsweredShare: 0.8,
        shadowStallDays: 14,
        dailyCallLimit: 1,
      },
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
