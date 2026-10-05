// 库里的那一半：同步题库（新题登记成只记不拦，改了题的退回只记不拦，库里的把握线、模型、状态不覆盖）。
import { auditLog, jevQuestions } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_NEXT } from '../src/bank.ts';
import { defineQuestion, questionRev, renderPrompt } from '../src/questions.ts';
import { syncQuestionBank } from '../src/store.ts';
import { TRIAGE_UI } from './fixtures.ts';
import { MODEL } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

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
