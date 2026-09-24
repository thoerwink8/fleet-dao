// Jev 每道题判得准不准：只从带真值的记录算，「没判出来」「判了还没真值」「判对 / 判错」分开数。
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { jevAnswers, jevQuestions } from '../schema/index.ts';

export interface JevQuestionStats {
  questionId: string;
  mode: (typeof jevQuestions.$inferSelect)['mode'];
  /** 问了几次。 */
  asked: number;
  /** 没判出来（连不上、超时、答了题面外的选项……）。 */
  failed: number;
  /** 判出来了但把握度低于把握线：当没判，走默认。 */
  unsure: number;
  /** 判出来且把握够：真拦时会起作用的那些。 */
  decisive: number;
  /** decisive 里已经有真值的。 */
  withTruth: number;
  correct: number;
  /** correct / withTruth；一条真值都没有就是空（不是 0，也不是 100%）。 */
  accuracy: number | null;
}

export async function jevQuestionStats(db: Db, options: { since?: Date } = {}): Promise<JevQuestionStats[]> {
  const decisive = sql`${jevAnswers.ok} and ${jevAnswers.confidence} >= ${jevQuestions.confidenceLine}`;
  const rows = await db
    .select({
      questionId: jevQuestions.id,
      mode: jevQuestions.mode,
      asked: sql<number>`count(${jevAnswers.id})::int`,
      failed: sql<number>`(count(${jevAnswers.id}) filter (where not ${jevAnswers.ok}))::int`,
      unsure: sql<number>`(count(${jevAnswers.id}) filter (where ${jevAnswers.ok} and ${jevAnswers.confidence} < ${jevQuestions.confidenceLine}))::int`,
      decisive: sql<number>`(count(${jevAnswers.id}) filter (where ${decisive}))::int`,
      withTruth: sql<number>`(count(${jevAnswers.id}) filter (where ${decisive} and ${jevAnswers.truth} is not null))::int`,
      correct: sql<number>`(count(${jevAnswers.id}) filter (where ${decisive} and ${jevAnswers.truth} = ${jevAnswers.answer}))::int`,
    })
    .from(jevQuestions)
    .leftJoin(
      jevAnswers,
      and(
        eq(jevAnswers.questionId, jevQuestions.id),
        options.since ? gte(jevAnswers.askedAt, options.since) : undefined,
      ),
    )
    .groupBy(jevQuestions.id)
    .orderBy(asc(jevQuestions.id));
  return rows.map((r) => ({ ...r, accuracy: r.withTruth === 0 ? null : r.correct / r.withTruth }));
}
