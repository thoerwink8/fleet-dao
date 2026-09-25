// Jev 读写库：jev_questions（题目、状态、钉死的模型、把握线）、jev_answers（每次判断一行，真值也记在这一行）、
// settings（每日次数、准确率线）、audit_log（状态变化留痕）。表结构在 @fleet-dao/db。
// 每条判断的 sample 里带 rev（题目版本）和 model（钉死的模型）：准确率只按「当前版本 + 钉死的模型」算，换题或换模型都从头攒。
import { auditLog, type Db, jevAnswers, jevQuestions, settings } from '@fleet-dao/db';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { FieldDigest } from './evidence.ts';
import {
  decideMode,
  type ExamTally,
  examOutcome,
  type JevMode,
  type ModeDecision,
  type ProductionWindow,
  shadowStalled,
} from './mode.ts';
import { DEFAULT_POLICY, type JevPolicy, mergePolicy, POLICY_SETTING_KEYS } from './policy.ts';
import { type QuestionDef, questionRev, renderPrompt } from './questions.ts';
import { DRIFT_REASONS, LOCAL_REASONS, type NotJudgedReason } from './verdict.ts';

export interface QuestionState {
  id: string;
  mode: JevMode;
  /** 这道题钉死的模型：只有这个模型答的才可能真拦、才算进准确率。 */
  model: string;
  confidenceLine: number;
  /** 库里存的题面。和代码里的不一样 = 题改了还没同步，这次一律只记不拦。 */
  prompt: string;
}

/** 写进 jev_answers.sample 的东西。 */
export interface AnswerSample {
  rev: string;
  /** 这次问的钉死模型（后端报的实际版本在 model_version 列）。 */
  model: string;
  backend: string;
  evidence: Record<string, FieldDigest>;
  /** 调用方给的、能复原原文的引用，例如 { issue: 'owner/repo#12', updatedAt: '…' }。 */
  ref?: unknown;
  /** 一次问了几道题（它们共用一次调用的耗时和 token）。 */
  batch: { id: string; size: number };
  tokensEstimated?: boolean;
  /** 按量计费的后端才有：这一问分摊到的美元花费（输入 token × 单价）。每日花费上限按它加总。 */
  costUsd?: number;
  /** 考试：哪一次、哪一道考题。 */
  exam?: { runId: string; sampleId: string };
  /** 没判出来时的原文（上游报错、认不出的回包、题面外的选项……），截到 500 字。 */
  detail?: string;
}

export type AnswerRow = typeof jevAnswers.$inferInsert;

/** 第一次问到的题登记进库：只记不拦，钉在这次后端的模型上。已登记的一个字不动（改题走 syncQuestionBank）。 */
export async function ensureQuestions(
  db: Db,
  questions: readonly QuestionDef[],
  model: string,
): Promise<Map<string, QuestionState>> {
  if (questions.length === 0) return new Map();
  await db
    .insert(jevQuestions)
    .values(questions.map((q) => questionRow(q, model)))
    .onConflictDoNothing();
  const rows = await db
    .select({
      id: jevQuestions.id,
      mode: jevQuestions.mode,
      model: jevQuestions.model,
      confidenceLine: jevQuestions.confidenceLine,
      prompt: jevQuestions.prompt,
    })
    .from(jevQuestions)
    .where(
      inArray(
        jevQuestions.id,
        questions.map((q) => q.id),
      ),
    );
  return new Map(rows.map((r) => [r.id, r]));
}

function questionRow(q: QuestionDef, model: string): typeof jevQuestions.$inferInsert {
  return {
    id: q.id,
    site: q.site,
    prompt: renderPrompt(q),
    type: 'choice',
    options: q.options.map((o) => o.id),
    mode: 'shadow',
    confidenceLine: q.confidenceLine,
    model,
  };
}

export interface SyncChange {
  id: string;
  change: 'added' | 'rewritten';
  /** 改题之前在真拦、这次退回只记不拦的。 */
  demoted: boolean;
}

/**
 * 把代码里的题库同步进库（引擎起来时跑一次）：没有的登记（只记不拦，钉在 model 上）；题面或选项改了的更新，
 * 在真拦的退回只记不拦——换了题，之前攒的准确率不算数。把握线、钉死的模型、状态都以库里为准，不覆盖。
 */
export async function syncQuestionBank(
  db: Db,
  questions: readonly QuestionDef[],
  options: { model: string; actor?: string },
): Promise<SyncChange[]> {
  const actor = options.actor ?? 'jev';
  return db.transaction(async (tx) => {
    const changes: SyncChange[] = [];
    for (const q of questions) {
      const [row] = await tx.select().from(jevQuestions).where(eq(jevQuestions.id, q.id));
      const prompt = renderPrompt(q);
      const optionIds = q.options.map((o) => o.id);
      if (!row) {
        await tx.insert(jevQuestions).values(questionRow(q, options.model));
        changes.push({ id: q.id, change: 'added', demoted: false });
        continue;
      }
      const same = row.prompt === prompt && JSON.stringify(row.options ?? []) === JSON.stringify(optionIds);
      if (same && row.site === q.site) continue;
      const demoted = row.mode === 'enforce';
      await tx
        .update(jevQuestions)
        .set({ prompt, options: optionIds, site: q.site, ...(demoted ? { mode: 'shadow' as const } : {}) })
        .where(eq(jevQuestions.id, q.id));
      await tx.insert(auditLog).values({
        actorKind: 'engine',
        actorId: actor,
        action: 'jev.question.rewrite',
        target: `jev:${q.id}`,
        before: { prompt: row.prompt, options: row.options, mode: row.mode },
        after: { prompt, options: optionIds, mode: demoted ? 'shadow' : row.mode },
        reason: demoted ? '题目改了，之前攒的准确率不算数，退回只记不拦' : '题目改了',
        via: 'engine',
      });
      changes.push({ id: q.id, change: 'rewritten', demoted });
    }
    return changes;
  });
}

/** 换钉死的模型（例如从 Opus 5.5 换到 Jev 1.13）：真拦的退回只记不拦，准确率按新模型从头攒。 */
export async function pinModel(
  db: Db,
  input: {
    questionId: string;
    model: string;
    actorKind: 'user' | 'ai' | 'engine';
    actorId: string;
    reason: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(jevQuestions).where(eq(jevQuestions.id, input.questionId));
    if (!row || row.model === input.model) return false;
    const mode = row.mode === 'enforce' ? 'shadow' : row.mode;
    await tx.update(jevQuestions).set({ model: input.model, mode }).where(eq(jevQuestions.id, row.id));
    await tx.insert(auditLog).values({
      actorKind: input.actorKind,
      actorId: input.actorId,
      action: 'jev.question.pin_model',
      target: `jev:${row.id}`,
      before: { model: row.model, mode: row.mode },
      after: { model: input.model, mode },
      reason: input.reason,
      via: input.actorKind === 'user' ? 'cockpit' : 'engine',
    });
    return true;
  });
}

/** 从 since 起问出去了几道题（本地拦下、没问出去的不算）。 */
export async function countAskedSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jevAnswers)
    .where(
      and(
        gte(jevAnswers.askedAt, since),
        or(isNull(jevAnswers.failReason), notInArray(jevAnswers.failReason, [...LOCAL_REASONS])),
      ),
    );
  return countOf(row, '今天问了几道');
}

/** 从 since 起按量计费的后端一共花了多少美元（每条判断记录里分摊的 costUsd 加总）。 */
export async function usdSpentSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({
      usd: sql<number>`coalesce(sum((${jevAnswers.sample}->>'costUsd')::float8), 0)::float8`,
      n: sql<number>`count(*)::int`,
    })
    .from(jevAnswers)
    .where(and(gte(jevAnswers.askedAt, since), sql`(${jevAnswers.sample}->>'costUsd') is not null`));
  countOf(row, '今天花了多少');
  const usd = Number(row?.usd);
  if (!Number.isFinite(usd)) throw new Error(`今天花了多少没查成：读到 ${String(row?.usd)}`);
  return usd;
}

/** count(*) 一定回一行；没回就是没查成，不当成 0。 */
function countOf(row: { n: number } | undefined, what: string): number {
  if (typeof row?.n !== 'number') throw new Error(`${what}没查成：计数查询没有返回结果`);
  return row.n;
}

/** 设置表里和 Jev 有关的几项，合并进默认值。读到不合法的值不用它，并把问题交回去——由调用方当成失败处理。 */
export async function readPolicy(
  db: Db,
  base: JevPolicy = DEFAULT_POLICY,
): Promise<{ policy: JevPolicy; problems: string[] }> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, Object.values(POLICY_SETTING_KEYS)));
  return mergePolicy(base, Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export async function insertAnswers(db: Db, rows: readonly AnswerRow[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(jevAnswers)
    .values([...rows])
    .returning({ id: jevAnswers.id });
  return inserted.map((r) => r.id);
}

export type TruthSource = 'human' | 'outcome' | 'canary';

/**
 * 给一次判断补真值：驾驶舱上人改判（human）、收尾对账回填（outcome，例如分诊判「清楚」后来却追问过）。
 * 真值必须是这道题的选项之一；准确率只从有真值的判定算。
 */
export async function recordTruth(
  db: Db,
  input: { answerId: number; truth: string; source: TruthSource; by?: string; at?: Date },
): Promise<{ ok: true } | { ok: false; why: string }> {
  const [row] = await db
    .select({ id: jevAnswers.id, options: jevQuestions.options })
    .from(jevAnswers)
    .innerJoin(jevQuestions, eq(jevQuestions.id, jevAnswers.questionId))
    .where(eq(jevAnswers.id, input.answerId));
  if (!row) return { ok: false, why: `没有这条判断记录：${input.answerId}` };
  if (!(row.options ?? []).includes(input.truth)) {
    return { ok: false, why: `真值 ${input.truth} 不是这道题的选项（${(row.options ?? []).join(' / ')}）` };
  }
  await db
    .update(jevAnswers)
    .set({
      truth: input.truth,
      truthSource: input.source,
      truthBy: input.by ?? null,
      truthAt: input.at ?? new Date(),
    })
    .where(eq(jevAnswers.id, input.answerId));
  return { ok: true };
}

/** 这道题当前版本、钉死模型下的判断记录。 */
function currentRev(q: QuestionDef, state: QuestionState) {
  return and(
    eq(jevAnswers.questionId, q.id),
    sql`${jevAnswers.sample}->>'rev' = ${questionRev(q)}`,
    sql`${jevAnswers.sample}->>'model' = ${state.model}`,
  );
}

/** 生产里最近 n 条「有把握、有真值（人改判或结局回填）」的判定。考试的真值不算。 */
export async function productionWindow(
  db: Db,
  q: QuestionDef,
  state: QuestionState,
  n: number,
): Promise<ProductionWindow> {
  const rows = await db
    .select({ answer: jevAnswers.answer, truth: jevAnswers.truth })
    .from(jevAnswers)
    .where(
      and(
        currentRev(q, state),
        eq(jevAnswers.ok, true),
        gte(jevAnswers.confidence, state.confidenceLine),
        isNotNull(jevAnswers.truth),
        inArray(jevAnswers.truthSource, ['human', 'outcome']),
      ),
    )
    .orderBy(desc(jevAnswers.askedAt), desc(jevAnswers.id))
    .limit(n);
  return { samples: rows.length, correct: rows.filter((r) => r.truth === r.answer).length };
}

/** 最近一次巡检考试里这道题的答卷；没考过就是 undefined。 */
export async function latestExam(
  db: Db,
  q: QuestionDef,
  state: QuestionState,
): Promise<ExamTally | undefined> {
  const examRun = sql<string>`${jevAnswers.sample}->'exam'->>'runId'`;
  const [last] = await db
    .select({ runId: examRun })
    .from(jevAnswers)
    .where(and(currentRev(q, state), eq(jevAnswers.truthSource, 'canary')))
    .orderBy(desc(jevAnswers.askedAt), desc(jevAnswers.id))
    .limit(1);
  if (!last?.runId) return undefined;
  const rows = await db
    .select({
      ok: jevAnswers.ok,
      answer: jevAnswers.answer,
      confidence: jevAnswers.confidence,
      truth: jevAnswers.truth,
      failReason: jevAnswers.failReason,
      askedAt: jevAnswers.askedAt,
    })
    .from(jevAnswers)
    .where(and(currentRev(q, state), eq(jevAnswers.truthSource, 'canary'), sql`${examRun} = ${last.runId}`))
    .orderBy(asc(jevAnswers.askedAt));
  const sure = rows.filter((r) => r.ok && (r.confidence ?? 0) >= state.confidenceLine);
  return {
    runId: last.runId,
    at: rows.reduce((max, r) => (r.askedAt > max ? r.askedAt : max), new Date(0)),
    asked: rows.length,
    answered: rows.filter((r) => r.ok).length,
    sure: sure.length,
    correct: sure.filter((r) => r.answer === r.truth).length,
    badOption: rows.filter((r) => r.failReason === 'bad_option').length,
  };
}

/** since 之后（不给就是一直以来）答了题面外的选项、或回话模型不对的次数。 */
export async function driftCount(
  db: Db,
  q: QuestionDef,
  state: QuestionState,
  since?: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jevAnswers)
    .where(
      and(
        currentRev(q, state),
        inArray(jevAnswers.failReason, [...DRIFT_REASONS] as NotJudgedReason[]),
        since ? gt(jevAnswers.askedAt, since) : undefined,
      ),
    );
  return countOf(row, '漂移次数');
}

async function firstAskedAt(db: Db, q: QuestionDef, state: QuestionState): Promise<Date | undefined> {
  const [row] = await db
    .select({ at: sql<Date | null>`min(${jevAnswers.askedAt})`.mapWith(jevAnswers.askedAt) })
    .from(jevAnswers)
    .where(currentRev(q, state));
  return row?.at ?? undefined;
}

export async function setMode(
  db: Db,
  input: { questionId: string; from: JevMode; to: JevMode; why: string; actorId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(jevQuestions).set({ mode: input.to }).where(eq(jevQuestions.id, input.questionId));
    await tx.insert(auditLog).values({
      actorKind: 'engine',
      actorId: input.actorId,
      action: 'jev.mode',
      target: `jev:${input.questionId}`,
      before: { mode: input.from },
      after: { mode: input.to },
      reason: input.why,
      via: 'engine',
    });
  });
}

export interface ModeReport extends ModeDecision {
  questionId: string;
  from: JevMode;
  production: ProductionWindow;
  exam?: ExamTally;
  drift: number;
  /** 只记不拦挂太久还没攒够样本，日报要报。 */
  stalled: boolean;
}

/**
 * 逐题看要不要转真拦或退回只记不拦，变了就写库并留操作记录。巡检考完、以及每天定时各跑一次。
 * 题在代码里改了还没同步（库里题面对不上）的不动，等 syncQuestionBank。
 * 设置里的线认不出就抛错：拿默认线判真拦，等于假装读到了设置。
 */
export async function reviewModes(
  db: Db,
  questions: readonly QuestionDef[],
  options: { now?: Date; actorId?: string; policy?: JevPolicy } = {},
): Promise<ModeReport[]> {
  const now = options.now ?? new Date();
  let policy = options.policy;
  if (!policy) {
    const read = await readPolicy(db);
    if (read.problems.length) throw new Error(`判断题设置认不出，不判状态：${read.problems.join('；')}`);
    policy = read.policy;
  }
  const reports: ModeReport[] = [];
  const rows = await db
    .select()
    .from(jevQuestions)
    .where(
      inArray(
        jevQuestions.id,
        questions.map((q) => q.id),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const q of questions) {
    const row = byId.get(q.id);
    if (!row || row.prompt !== renderPrompt(q)) continue;
    const state: QuestionState = row;
    const production = await productionWindow(db, q, state, policy.minSamples);
    const exam = await latestExam(db, q, state);
    const drift = await driftCount(db, q, state, exam?.at);
    const decision = decideMode(
      { mode: row.mode, production, exam: exam && examOutcome(exam, policy), drift },
      policy,
    );
    if (decision.changed) {
      await setMode(db, {
        questionId: q.id,
        from: row.mode,
        to: decision.mode,
        why: decision.why,
        actorId: options.actorId ?? 'jev',
      });
    }
    const stalled = shadowStalled(
      {
        mode: decision.mode,
        samples: production.samples,
        firstAskedAt: await firstAskedAt(db, q, state),
        now,
      },
      policy,
    );
    reports.push({
      ...decision,
      questionId: q.id,
      from: row.mode,
      production,
      ...(exam ? { exam } : {}),
      drift,
      stalled,
    });
  }
  return reports;
}
