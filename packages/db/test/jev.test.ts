import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jevQuestionStats } from '../src/queries/jev.ts';
import { jevAnswers, jevQuestions } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { ago, DAY } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await t.db.insert(jevQuestions).values([
    {
      id: 'triage.clear',
      site: 'triage',
      prompt: '说清楚了吗？',
      type: 'noul',
      confidenceLine: 0.7,
      model: 'jev-2026-09-01',
    },
    {
      id: 'triage.kind',
      site: 'triage',
      prompt: '哪类活？',
      type: 'choice',
      options: ['ui', 'backend'],
      confidenceLine: 0.6,
      model: 'jev-2026-09-01',
    },
  ]);
});

const answer = (over: Partial<typeof jevAnswers.$inferInsert>) => ({
  questionId: 'triage.clear',
  subject: 'task:1',
  sample: { issue: 1 },
  shadow: true,
  ok: true,
  answer: 'yes',
  confidence: 0.9,
  ...over,
});

describe('Jev 每道题判得准不准', () => {
  it('没判出来、把握不够、判了没真值、判对判错分开数；准确率只从有真值的算', async () => {
    await t.db
      .insert(jevAnswers)
      .values([
        answer({ truth: 'yes', truthSource: 'human' }),
        answer({ truth: 'no', truthSource: 'outcome' }),
        answer({}),
        answer({ confidence: 0.5, truth: 'yes', truthSource: 'canary' }),
        answer({ ok: false, answer: null, confidence: null, failReason: 'timeout' }),
      ]);
    const [clear, kind] = await jevQuestionStats(t.db);
    expect(clear).toEqual({
      questionId: 'triage.clear',
      mode: 'shadow',
      asked: 5,
      failed: 1,
      unsure: 1,
      decisive: 3,
      withTruth: 2,
      correct: 1,
      accuracy: 0.5,
    });
    // 一次都没问过的题也列出来；没有真值时准确率是空，不是 0。
    expect(kind).toMatchObject({ questionId: 'triage.kind', asked: 0, accuracy: null });
  });

  it('可以只看最近一段时间', async () => {
    await t.db
      .insert(jevAnswers)
      .values([
        answer({ askedAt: ago(40 * DAY), truth: 'no', truthSource: 'human' }),
        answer({ askedAt: ago(DAY), truth: 'yes', truthSource: 'human' }),
      ]);
    const [clear] = await jevQuestionStats(t.db, { since: ago(30 * DAY) });
    expect(clear).toMatchObject({ asked: 1, withTruth: 1, correct: 1, accuracy: 1 });
  });
});
