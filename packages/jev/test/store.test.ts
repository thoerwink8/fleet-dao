// 库里的那一半：同步题库、换钉死的模型、补真值、准确率只按当前版本和钉死的模型算、逐题看要不要转真拦或退回。
import { auditLog, jevAnswers, jevQuestions, settings } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_NEXT, TRIAGE_UI } from '../src/bank.ts';
import { createJev } from '../src/jev.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { defineQuestion, questionRev, renderPrompt } from '../src/questions.ts';
import {
  driftCount,
  ensureQuestions,
  pinModel,
  productionWindow,
  recordTruth,
  reviewModes,
  syncQuestionBank,
} from '../src/store.ts';
import { DAY, fakeBackend, MODEL, ok } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const NOW = new Date('2026-10-10T00:00:00Z');
const request = { request: '把首页的额度卡片改成按清零时间排序' };

async function questionRow(id: string) {
  const [row] = await t.db.select().from(jevQuestions).where(eq(jevQuestions.id, id));
  return row;
}

describe('同步题库', () => {
  it('没有的登记成只记不拦；改了题面的更新题面，真拦的退回只记不拦并留操作记录；没改的不动', async () => {
    expect(await syncQuestionBank(t.db, [TRIAGE_UI, ERROR_NEXT], { model: MODEL })).toEqual([
      { id: 'triage-ui', change: 'added', demoted: false },
      { id: 'error-next', change: 'added', demoted: false },
    ]);
    await t.db.update(jevQuestions).set({ mode: 'enforce' }).where(eq(jevQuestions.id, 'triage-ui'));
    const rewritten = defineQuestion({ ...TRIAGE_UI, instructions: '要不要改界面？（改过题面）' });
    expect(await syncQuestionBank(t.db, [rewritten, ERROR_NEXT], { model: MODEL })).toEqual([
      { id: 'triage-ui', change: 'rewritten', demoted: true },
    ]);
    expect(await questionRow('triage-ui')).toMatchObject({ mode: 'shadow', prompt: renderPrompt(rewritten) });
    const [log] = await t.db.select().from(auditLog);
    expect(log).toMatchObject({ action: 'jev.question.rewrite', target: 'jev:triage-ui', via: 'engine' });
  });

  it('只改证据字段（给模型看的名字）也算换题：真拦的退回只记不拦，准确率和题面一起从头算', async () => {
    await syncQuestionBank(t.db, [TRIAGE_UI], { model: MODEL });
    await t.db.update(jevQuestions).set({ mode: 'enforce' }).where(eq(jevQuestions.id, 'triage-ui'));
    const relabeled = defineQuestion({
      ...TRIAGE_UI,
      evidence: [{ key: 'request', label: '需求原文（改过名字）', required: true }],
    });
    expect(questionRev(relabeled)).not.toBe(questionRev(TRIAGE_UI));
    expect(await syncQuestionBank(t.db, [relabeled], { model: MODEL })).toEqual([
      { id: 'triage-ui', change: 'rewritten', demoted: true },
    ]);
    expect(await questionRow('triage-ui')).toMatchObject({ mode: 'shadow', prompt: renderPrompt(relabeled) });
  });

  it('同步不覆盖库里的把握线、钉死的模型和状态', async () => {
    await syncQuestionBank(t.db, [TRIAGE_UI], { model: MODEL });
    await t.db
      .update(jevQuestions)
      .set({ confidenceLine: 0.8, model: 'claude-opus-5-5', mode: 'off' })
      .where(eq(jevQuestions.id, 'triage-ui'));
    await syncQuestionBank(t.db, [TRIAGE_UI], { model: MODEL });
    expect(await questionRow('triage-ui')).toMatchObject({
      confidenceLine: 0.8,
      model: 'claude-opus-5-5',
      mode: 'off',
    });
  });
});

describe('换钉死的模型', () => {
  it('真拦的退回只记不拦，留操作记录；换成同一个模型什么都不做', async () => {
    await ensureQuestions(t.db, [TRIAGE_UI], MODEL);
    await t.db.update(jevQuestions).set({ mode: 'enforce' }).where(eq(jevQuestions.id, 'triage-ui'));
    const input = {
      questionId: 'triage-ui',
      model: 'claude-opus-5-5',
      actorKind: 'user' as const,
      actorId: 'u1',
      reason: '构建期先用 Opus 5.5',
    };
    expect(await pinModel(t.db, input)).toBe(true);
    expect(await questionRow('triage-ui')).toMatchObject({ model: 'claude-opus-5-5', mode: 'shadow' });
    expect(await pinModel(t.db, input)).toBe(false);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });
});

describe('补真值', () => {
  it('真值必须是这道题的选项；补上之后算进准确率', async () => {
    const jev = createJev({
      db: t.db,
      backend: fakeBackend(() => ok({ 'triage-ui': ['ui', 0.9] })),
      now: () => NOW,
    });
    const v = await jev.ask(TRIAGE_UI, request, { subject: 'task:1' });
    const answerId = v.answerId ?? -1;
    expect(await recordTruth(t.db, { answerId, truth: 'maybe', source: 'human' })).toMatchObject({
      ok: false,
    });
    expect(await recordTruth(t.db, { answerId: 999, truth: 'ui', source: 'human' })).toMatchObject({
      ok: false,
    });
    expect(await recordTruth(t.db, { answerId, truth: 'no_ui', source: 'outcome' })).toEqual({ ok: true });
    const state = (await ensureQuestions(t.db, [TRIAGE_UI], MODEL)).get('triage-ui');
    if (!state) throw new Error('没登记');
    expect(await productionWindow(t.db, TRIAGE_UI, state, 50)).toMatchObject({ samples: 1, correct: 0 });
  });
});

/** 直接往库里写判断记录，模拟一段时间的生产数据。 */
async function seedAnswers(
  n: number,
  over: {
    correct?: number;
    rev?: string;
    model?: string;
    confidence?: number;
    source?: 'human' | 'outcome' | 'canary';
    at?: Date;
    exam?: string;
    failReason?: string;
  } = {},
) {
  await ensureQuestions(t.db, [TRIAGE_UI], MODEL);
  const rows = Array.from({ length: n }, (_, i) => {
    const right = i < (over.correct ?? n);
    const base = {
      questionId: 'triage-ui',
      askedAt: new Date((over.at ?? NOW).getTime() - (n - i) * 60_000),
      subject: over.exam ? `exam:${i}` : `task:${i}`,
      sample: {
        rev: over.rev ?? questionRev(TRIAGE_UI),
        model: over.model ?? MODEL,
        backend: 'fake',
        evidence: {},
        batch: { id: `b${i}`, size: 1 },
        ...(over.exam ? { exam: { runId: over.exam, sampleId: `s${i}` } } : {}),
      },
      shadow: true,
    };
    if (over.failReason) {
      // 考试的每一行都带真值（答没答出来都一样），latestExam 按它认出是哪一次考试。
      const truth = over.exam ? { truth: 'ui', truthSource: 'canary' as const } : {};
      return { ...base, ok: false, failReason: over.failReason, ...truth };
    }
    return {
      ...base,
      ok: true,
      answer: 'ui',
      confidence: over.confidence ?? 0.9,
      truth: right ? 'ui' : 'no_ui',
      truthSource: over.source ?? ('human' as const),
    };
  });
  await t.db.insert(jevAnswers).values(rows);
}

async function state() {
  const s = (await ensureQuestions(t.db, [TRIAGE_UI], MODEL)).get('triage-ui');
  if (!s) throw new Error('没登记');
  return s;
}

describe('准确率只按当前版本、钉死的模型、有把握、人或结局给的真值算', () => {
  it('旧版本、别的模型、没把握的、考试的真值都不算', async () => {
    await seedAnswers(3);
    await seedAnswers(4, { rev: 'old-rev' });
    await seedAnswers(5, { model: 'claude-opus-5-5' });
    await seedAnswers(6, { confidence: 0.5 });
    await seedAnswers(7, { source: 'canary', exam: 'run-0' });
    expect(await productionWindow(t.db, TRIAGE_UI, await state(), 50)).toMatchObject({
      samples: 3,
      correct: 3,
    });
  });

  it('只看最近 n 条；from 是这 n 条里最早那一条的时刻（漂移从这里算）', async () => {
    await seedAnswers(10, { correct: 5, at: new Date(NOW.getTime() - DAY) });
    await seedAnswers(5);
    expect(await productionWindow(t.db, TRIAGE_UI, await state(), 5)).toEqual({
      samples: 5,
      correct: 5,
      from: new Date(NOW.getTime() - 5 * 60_000),
    });
  });
});

describe('逐题看要不要转真拦或退回', () => {
  it('攒满 50 条、准确率过线、最近一次考试及格：转真拦，留操作记录', async () => {
    await seedAnswers(DEFAULT_POLICY.minSamples, { correct: 47 });
    await seedAnswers(5, { source: 'canary', exam: 'run-1' });
    const [report] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(report).toMatchObject({ questionId: 'triage-ui', from: 'shadow', mode: 'enforce', changed: true });
    expect((await questionRow('triage-ui'))?.mode).toBe('enforce');
    const [log] = await t.db.select().from(auditLog);
    expect(log).toMatchObject({ action: 'jev.mode', after: { mode: 'enforce' } });
  });

  it('考试不及格：真拦的退回只记不拦', async () => {
    await seedAnswers(50);
    await seedAnswers(5, { source: 'canary', exam: 'run-2', correct: 3 });
    await t.db.update(jevQuestions).set({ mode: 'enforce' }).where(eq(jevQuestions.id, 'triage-ui'));
    const [report] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(report).toMatchObject({ mode: 'shadow', changed: true, exam: { runId: 'run-2', correct: 3 } });
  });

  it('攒样本期间答过题面外的选项：真拦的退回只记不拦（提问当场已经退过，这里兜底）', async () => {
    await seedAnswers(50);
    await seedAnswers(5, { source: 'canary', exam: 'run-3', at: new Date(NOW.getTime() - DAY) });
    await seedAnswers(1, { failReason: 'bad_option' });
    await t.db.update(jevQuestions).set({ mode: 'enforce' }).where(eq(jevQuestions.id, 'triage-ui'));
    const s = await state();
    const window = await productionWindow(t.db, TRIAGE_UI, s, DEFAULT_POLICY.minSamples);
    expect(await driftCount(t.db, TRIAGE_UI, s, window.from)).toBe(1);
    const [report] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(report).toMatchObject({ mode: 'shadow', drift: 1 });
  });

  it('再考一次洗不掉漂移：答过题面外的选项之后又考了一次（没考成），真拦的照样退回', async () => {
    const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    await seedAnswers(50, { at: ago(3) });
    await seedAnswers(1, { failReason: 'bad_option', at: ago(2) });
    // 之后的考试一道都没答出来（上游超时）：没考成。
    await seedAnswers(5, { exam: 'run-void', failReason: 'timeout', at: ago(1) });
    await t.db.update(jevQuestions).set({ mode: 'enforce' }).where(eq(jevQuestions.id, 'triage-ui'));
    const [report] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(report?.exam).toMatchObject({ runId: 'run-void', answered: 0 });
    expect(report).toMatchObject({ mode: 'shadow', changed: true, drift: 1 });
  });

  it('漂过之后考及格也不马上转真拦：要在漂移之后重新攒够一批样本', async () => {
    const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    await seedAnswers(50, { at: ago(5) });
    await seedAnswers(1, { failReason: 'bad_option', at: ago(4) });
    await seedAnswers(5, { source: 'canary', exam: 'run-pass', at: ago(3) });
    const [held] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(held).toMatchObject({ mode: 'shadow', changed: false, drift: 1 });
    await seedAnswers(50, { at: ago(1) });
    const [promoted] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(promoted).toMatchObject({ mode: 'enforce', changed: true, drift: 0 });
  });

  it('只记不拦挂了 14 天还没攒够：标影子停滞', async () => {
    await seedAnswers(3, { at: new Date(NOW.getTime() - 20 * DAY) });
    const [report] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY });
    expect(report).toMatchObject({ mode: 'shadow', changed: false, stalled: true });
  });

  it('题在代码里改了还没同步：不动它', async () => {
    await seedAnswers(50);
    await seedAnswers(5, { source: 'canary', exam: 'run-4' });
    await t.db.update(jevQuestions).set({ prompt: '旧题面' }).where(eq(jevQuestions.id, 'triage-ui'));
    expect(await reviewModes(t.db, [TRIAGE_UI], { now: NOW, policy: DEFAULT_POLICY })).toEqual([]);
  });

  it('线从设置读：设置认不出就报错，不拿默认线去判真拦', async () => {
    await seedAnswers(50);
    await seedAnswers(5, { source: 'canary', exam: 'run-5' });
    await t.db.insert(settings).values({ key: 'judge.accuracyLine', value: 9 });
    await expect(reviewModes(t.db, [TRIAGE_UI], { now: NOW })).rejects.toThrow(/judge\.accuracyLine/);
    expect((await questionRow('triage-ui'))?.mode).toBe('shadow');
    await t.db.update(settings).set({ value: 0.8 }).where(eq(settings.key, 'judge.accuracyLine'));
    const [report] = await reviewModes(t.db, [TRIAGE_UI], { now: NOW });
    expect(report).toMatchObject({ mode: 'enforce', changed: true });
  });
});
