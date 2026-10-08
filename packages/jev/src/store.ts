// Jev 读写库：jev_questions（题目、状态、钉死的模型、把握线）、jev_answers（每次判断一行）、
// settings（每日次数、花费上限）、audit_log（状态变化留痕）。表结构在 @fleet-dao/db。
// 每条判断的 sample 里带 rev（题目版本）和 model（钉死的模型）。
import { auditLog, type Db, jevAnswers, jevQuestions, settings } from '@fleet-dao/db';
import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { FieldDigest } from './evidence.ts';
import { DEFAULT_POLICY, type JevPolicy, mergePolicy, POLICY_SETTING_KEYS } from './policy.ts';
import { JUDGE_PROBE_QUESTION_ID } from './probe-id.ts';
import { type QuestionDef, renderPrompt } from './questions.ts';
import { LOCAL_REASONS, type NotJudgedReason } from './verdict.ts';

/** 题目的状态：off 停用、shadow 只记不拦、enforce 真拦（库里的枚举；现在没有任何代码会把题转成 enforce）。 */
export type JevMode = (typeof jevQuestions.$inferSelect)['mode'];

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
  /** 判断用途的哪条路由（routes.id，路由两层）；调用方没说就没有。 */
  route?: string;
  evidence: Record<string, FieldDigest>;
  /** 调用方给的、能复原原文的引用，例如 { issue: 'owner/repo#12', updatedAt: '…' }（库收不下的字已换成 U+FFFD）。 */
  ref?: unknown;
  /** 引用转不成 JSON（BigInt、循环引用……）、没写进来：为什么。 */
  refDropped?: string;
  /** 一次问了几道题（它们共用一次调用的耗时和 token）。 */
  batch: { id: string; size: number };
  tokensEstimated?: boolean;
  /** 按量计费的后端才有：这一问分摊到的美元花费（输入 token × 单价）。每日花费上限按它加总。 */
  costUsd?: number;
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
 * 把代码里的题库同步进库（引擎起来时跑一次）：没有的登记（只记不拦，钉在 model 上）；题面、选项或证据字段改了的更新，
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

/** 从 since 起问出去了几道业务题（本地拦下、没问出去的不算）。健康自检不占每日次数。 */
export async function countAskedSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jevAnswers)
    .where(
      and(
        gte(jevAnswers.askedAt, since),
        or(isNull(jevAnswers.failReason), notInArray(jevAnswers.failReason, [...LOCAL_REASONS])),
        ne(jevAnswers.questionId, JUDGE_PROBE_QUESTION_ID),
      ),
    );
  return countOf(row, '今天问了几道');
}

/** 从 since 起按量计费的后端一共花了多少美元（每条判断记录里分摊的 costUsd 加总）。健康自检不占这笔。 */
export async function usdSpentSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({
      usd: sql<number>`coalesce(sum((${jevAnswers.sample}->>'costUsd')::float8), 0)::float8`,
      n: sql<number>`count(*)::int`,
    })
    .from(jevAnswers)
    .where(
      and(
        gte(jevAnswers.askedAt, since),
        sql`(${jevAnswers.sample}->>'costUsd') is not null`,
        ne(jevAnswers.questionId, JUDGE_PROBE_QUESTION_ID),
      ),
    );
  countOf(row, '今天花了多少');
  const usd = Number(row?.usd);
  if (!Number.isFinite(usd)) throw new Error(`今天花了多少没查成：读到 ${String(row?.usd)}`);
  return usd;
}

/** 一次真发给后端的调用（jev_answers 的一行）。 */
export interface SentCall {
  answerId: number;
  questionId: string;
  at: Date;
  /** 后端答了（把握不够也算答了）。 */
  ok: boolean;
  /** 没成的原因（verdict.ts 的 NotJudgedReason）；成了是 null。 */
  reason: string | null;
  /** 没成时的原文（截过、脱过敏）。 */
  detail: string | null;
}

/**
 * 最近一次真发给后端的调用（业务提问和健康自检都算）。本地就拦下、没发出去的（停用、到了上限、证据不全、库出错）不算；
 * 只补记花费的那一行（unrecorded）说明的是库出了问题、不是调用成没成，也不算。/healthz 的 judge 项看它：没成就报红。
 */
export async function lastSentCall(db: Db): Promise<SentCall | undefined> {
  const notSent = [...LOCAL_REASONS, 'unrecorded'] as NotJudgedReason[];
  const [row] = await db
    .select({
      answerId: jevAnswers.id,
      questionId: jevAnswers.questionId,
      at: jevAnswers.askedAt,
      ok: jevAnswers.ok,
      reason: jevAnswers.failReason,
      detail: sql<string | null>`${jevAnswers.sample}->>'detail'`,
    })
    .from(jevAnswers)
    .where(or(isNull(jevAnswers.failReason), notInArray(jevAnswers.failReason, notSent)))
    .orderBy(desc(jevAnswers.askedAt), desc(jevAnswers.id))
    .limit(1);
  return row;
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

/** 真拦中的题这一问漂了（答了题面外的选项、回话的不是钉死的模型）：和这一批判断一起当场退回只记不拦。 */
export interface DriftDemotion {
  questionId: string;
  why: string;
}

/**
 * 记一批判断，返回每行的 id（顺序同 rows）。demote 里的题在同一个事务里从真拦退回只记不拦并留操作记录：
 * 判断记上了、题却还在真拦的中间态不会有；记不上就整批都不算（调用方当没判）。
 */
export async function insertAnswers(
  db: Db,
  rows: readonly AnswerRow[],
  demote: readonly DriftDemotion[] = [],
): Promise<number[]> {
  if (rows.length === 0) return [];
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(jevAnswers)
      .values([...rows])
      .returning({ id: jevAnswers.id });
    const ids = inserted.map((r) => r.id);
    for (const d of demote) {
      const changed = await tx
        .update(jevQuestions)
        .set({ mode: 'shadow' })
        .where(and(eq(jevQuestions.id, d.questionId), eq(jevQuestions.mode, 'enforce')))
        .returning({ id: jevQuestions.id });
      if (changed.length === 0) continue;
      const answerId = ids[rows.findIndex((r) => r.questionId === d.questionId)];
      await tx.insert(auditLog).values({
        actorKind: 'engine',
        actorId: 'jev',
        action: 'jev.mode',
        target: `jev:${d.questionId}`,
        before: { mode: 'enforce' },
        after: { mode: 'shadow', answerId },
        reason: d.why,
        via: 'engine',
      });
    }
    return ids;
  });
}
