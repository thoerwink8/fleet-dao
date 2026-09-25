// 提问接口：ask(题, 证据) → 选项 + 把握度。调用方只看 verdict.act：
// - 真拦（题目在真拦、回话的就是钉死的模型、题面和库里一致、把握够）时是选项挂的效果；
// - 只记不拦、把握不够、没判出来（连不上、超时、被限流、答了题面外的选项……）一律 none，当它不存在、照默认走，不当成「否」。
// 每道题每次都记一行 jev_answers，包括本地就拦下的（停用、次数用完、证据不全）；记不上就当没判（store_error）。
// 请求发出去了就记账（出错也记，上游没报 token 数按事前估算），每日花费上限才不会被出错的调用绕过去。
// 真拦中的题答了题面外的选项、或回话的不是钉死的模型：和这一批判断一起当场退回只记不拦。
// 只有调用方自己的代码错（题写坏了、没说判的是谁）不记：那种题登记不进库，测试里就该暴露。
// 不抛：任何出错都变成一个没判出来的 verdict。
import { randomUUID } from 'node:crypto';
import { redact, sameModel } from '@fleet-dao/adapters';
import type { Db } from '@fleet-dao/db';
import {
  type BackendRequest,
  type BackendResult,
  estimateTokens,
  type JevBackend,
  requestTexts,
  usdOf,
} from './backend.ts';
import type { Effect } from './effects.ts';
import {
  dayStart,
  digestEvidence,
  type EvidenceInput,
  fieldsOf,
  missingKeys,
  unknownKeys,
} from './evidence.ts';
import { DEFAULT_POLICY, type JevPolicy } from './policy.ts';
import {
  checkBatch,
  checkQuestion,
  type EvidenceOf,
  type QuestionDef,
  questionRev,
  renderPrompt,
} from './questions.ts';
import {
  type AnswerRow,
  type AnswerSample,
  countAskedSince,
  type DriftDemotion,
  ensureQuestions,
  insertAnswers,
  type QuestionState,
  readPolicy,
  usdSpentSince,
} from './store.ts';
import {
  DRIFT_REASONS,
  type Judged,
  LOCAL_REASONS,
  type NotJudged,
  type NotJudgedReason,
  REASON_TEXT,
  type Verdict,
} from './verdict.ts';

export interface AskContext {
  /** 判的是谁：task:<id>、subtask:<id>、run:<id>、feishu:<消息号>…… */
  subject: string;
  /** 能复原原文的引用（例如 { issue: 'owner/repo#12', updatedAt }），记进库，以后从生产样本里挑考题用。 */
  ref?: unknown;
  signal?: AbortSignal;
}

/** 巡检考试：每道题的标准答案随答案一起记成真值（canary），考试从不真拦。 */
export interface ExamContext {
  runId: string;
  sampleId: string;
  expect: Readonly<Record<string, string>>;
}

export interface JevDeps {
  db: Db;
  backend: JevBackend;
  now?: () => Date;
  /** 设置表里没配时用的默认值。 */
  policy?: JevPolicy;
}

type VerdictsOf<QS extends readonly QuestionDef[]> = {
  -readonly [K in keyof QS]: QS[K] extends QuestionDef ? Verdict<QS[K]> : never;
};

export interface Jev {
  readonly backend: JevBackend;
  ask<const Q extends QuestionDef>(
    question: Q,
    evidence: EvidenceOf<Q>,
    ctx: AskContext,
  ): Promise<Verdict<Q>>;
  /** 几道题共用一份证据，一次问完（分诊四题就是这样问）。 */
  askAll<const QS extends readonly QuestionDef[]>(
    questions: QS,
    evidence: EvidenceOf<QS[number]>,
    ctx: AskContext,
  ): Promise<VerdictsOf<QS>>;
  /** 巡检考试：只问 expect 里有标准答案的题。 */
  exam(questions: readonly QuestionDef[], evidence: EvidenceInput, exam: ExamContext): Promise<Verdict[]>;
}

const DETAIL_CHARS = 500;
/**
 * 没判出来的原文进库、交回调用方之前一律过这一道：上游报错、认不出的回包里可能夹着令牌、邮箱、IP（驾驶舱看得到）。
 * 整段脱敏之后再截到 500 字，免得截断处把令牌截成认不出的半截。
 */
function clean(detail: string): string {
  const text = redact(detail, Number.POSITIVE_INFINITY);
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isLocal = (reason: NotJudgedReason) => (LOCAL_REASONS as readonly string[]).includes(reason);
const isDrift = (reason: NotJudgedReason) => (DRIFT_REASONS as readonly string[]).includes(reason);

function notJudged(q: QuestionDef, reason: NotJudgedReason, detail: string): NotJudged {
  return { judged: false, questionId: q.id, reason, detail: clean(detail), act: 'none' };
}

export function createJev(deps: JevDeps): Jev {
  const now = deps.now ?? (() => new Date());

  async function run(
    questions: readonly QuestionDef[],
    evidence: EvidenceInput,
    ctx: AskContext,
    exam?: ExamContext,
  ): Promise<Verdict[]> {
    const { db, backend } = deps;
    if (questions.length === 0) return [];
    const askedAt = now();

    // 题写错了、没说判的是谁：调用方的代码问题，连库都不碰（写错的题登记不进去）。
    const callerProblems = [...checkBatch(questions), ...questions.flatMap(checkQuestion)];
    if (!ctx.subject.trim()) callerProblems.push('没给 subject（判的是谁）');
    if (callerProblems.length) {
      return questions.map((q) => notJudged(q, 'bad_evidence', callerProblems.join('；')));
    }

    let states: Map<string, QuestionState>;
    try {
      states = await ensureQuestions(db, questions, backend.model);
    } catch (err) {
      return questions.map((q) => notJudged(q, 'store_error', message(err)));
    }

    // 本地先过一遍：证据字段不对、停用的、必填证据没给的，不问出去，但照样记一行。
    const unknown = unknownKeys(questions, evidence);
    const outcome = new Map<string, Verdict>();
    const askable: QuestionDef[] = [];
    for (const q of questions) {
      const state = states.get(q.id);
      const missing = missingKeys(q, evidence);
      if (!state) outcome.set(q.id, notJudged(q, 'store_error', '题目没登记进库'));
      else if (unknown.length)
        outcome.set(q.id, notJudged(q, 'bad_evidence', `这几道题都不认识的证据字段：${unknown.join('、')}`));
      else if (state.mode === 'off') outcome.set(q.id, notJudged(q, 'off', '这道题停用了'));
      else if (missing.length)
        outcome.set(q.id, notJudged(q, 'missing_evidence', `没给：${missing.join('、')}`));
      else askable.push(q);
    }

    const request: BackendRequest = {
      questions: askable.map((q) => ({
        id: q.id,
        instructions: q.instructions,
        options: q.options.map((o) => ({ id: o.id, criteria: o.criteria })),
      })),
      evidence: fieldsOf(askable)
        .filter((f) => evidence[f.key] !== undefined)
        .map((f) => ({ label: f.label, text: evidence[f.key] ?? '' })),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    // 这一问要喂多少 token，事先按字符数保守估（一个字一个 token）：花费上限按它预判；上游没报 token 数时也按它记账。
    const estimatedTokens = estimateTokens(requestTexts(request));

    // 每日上限：次数（一次问几道算几次；巡检考试和生产各算各的）和按量后端的花费（考试也算在内）。
    // 到了就不问、走默认，库里记「因上限没问」。设置认不出也不问：拿默认值顶上等于假装读到了。
    if (askable.length > 0) {
      try {
        const refuseAll = (reason: NotJudgedReason, detail: string) => {
          for (const q of askable.splice(0)) outcome.set(q.id, notJudged(q, reason, detail));
        };
        const { policy, problems } = await readPolicy(db, deps.policy ?? DEFAULT_POLICY);
        const today = dayStart(askedAt);
        if (problems.length) {
          refuseAll('bad_setting', problems.join('；'));
        } else {
          const used = await countAskedSince(db, today, { exam: exam !== undefined });
          const limit = exam ? policy.examDailyCallLimit : policy.dailyCallLimit;
          if (used + askable.length > limit) {
            refuseAll(
              'daily_cap',
              exam
                ? `因考试每日次数上限没问：今天考试已经问了 ${used} 道，上限 ${limit}`
                : `因每日次数上限没问：今天已经问了 ${used} 道，上限 ${limit}`,
            );
          } else if (backend.usdPerMTok !== undefined) {
            const spent = await usdSpentSince(db, today);
            // 宁可早停一问也不超。
            const estimate = usdOf(estimatedTokens, backend.usdPerMTok);
            if (spent + estimate > policy.dailyUsdCap) {
              refuseAll(
                'daily_cap',
                `因每日花费上限没问：今天已花 $${spent.toFixed(6)}，这一问估 $${estimate.toFixed(6)}，上限 $${policy.dailyUsdCap}`,
              );
            }
          }
        }
      } catch (err) {
        return questions.map((q) => notJudged(q, 'store_error', message(err)));
      }
    }

    let result: BackendResult | undefined;
    if (askable.length > 0) {
      try {
        result = await backend.ask(request);
      } catch (err) {
        result = {
          ok: false,
          reason: 'backend_error',
          detail: `后端抛了异常：${message(err)}`,
          latencyMs: 0,
        };
      }
    }

    const batch = { id: randomUUID(), size: questions.length };
    const rows: AnswerRow[] = [];
    const demote: DriftDemotion[] = [];
    for (const q of questions) {
      const state = states.get(q.id);
      if (!state) continue;
      const enforceable =
        !exam &&
        state.mode === 'enforce' &&
        state.model === backend.model &&
        state.prompt === renderPrompt(q);
      const verdict =
        outcome.get(q.id) ??
        (result ? judge(q, state, result, backend, enforceable) : notJudged(q, 'store_error', '没有结果'));
      outcome.set(q.id, verdict);
      // 漂的是这道题钉死的那个模型（考试里漂也算）：当场退回，不等 reviewModes。别的模型漂了不连累它。
      if (
        !verdict.judged &&
        isDrift(verdict.reason) &&
        state.mode === 'enforce' &&
        state.model === backend.model
      ) {
        demote.push({
          questionId: q.id,
          why: `${REASON_TEXT[verdict.reason]}（${verdict.detail}），当场退回只记不拦`,
        });
      }
      rows.push(
        answerRow(q, verdict, result, {
          askedAt,
          evidence,
          ctx,
          exam,
          batch,
          enforceable,
          backend,
          askedCount: askable.length,
          estimatedTokens,
        }),
      );
    }

    let ids: number[];
    try {
      ids = await insertAnswers(db, rows, demote);
    } catch (err) {
      // 没记上就当没判：调用方照默认走，不带着一个库里查不到的判断去拦。
      return questions.map((q) => notJudged(q, 'store_error', `判断没记进库：${message(err)}`));
    }
    const idOf = new Map(rows.map((r, i) => [r.questionId, ids[i]]));
    return questions.map((q) => {
      const v = outcome.get(q.id) ?? notJudged(q, 'store_error', '没有结果');
      const answerId = idOf.get(q.id);
      return answerId === undefined ? v : { ...v, answerId };
    });
  }

  return {
    backend: deps.backend,
    async ask(question, evidence, ctx) {
      const [v] = await run([question], evidence as EvidenceInput, ctx);
      return v as Verdict<typeof question>;
    },
    async askAll(questions, evidence, ctx) {
      return (await run(questions, evidence as EvidenceInput, ctx)) as VerdictsOf<typeof questions>;
    },
    async exam(questions, evidence, exam) {
      const asked = questions.filter((q) => exam.expect[q.id] !== undefined);
      return run(asked, evidence, { subject: `exam:${exam.sampleId}` }, exam);
    },
  };
}

function judge(
  q: QuestionDef,
  state: QuestionState,
  result: BackendResult,
  backend: JevBackend,
  enforceable: boolean,
): Verdict {
  if (!result.ok) return notJudged(q, result.reason, result.detail);
  if (!sameModel(backend.model, result.model)) {
    return notJudged(q, 'model_mismatch', `钉死的是 ${backend.model}，回话的是 ${result.model}`);
  }
  const a = result.answers[q.id];
  if (a === undefined) return notJudged(q, 'no_answer', '回包里没有这道题');
  if ('invalid' in a) return notJudged(q, 'bad_answer', a.invalid);
  const option = q.options.find((o) => o.id === a.option);
  if (!option) return notJudged(q, 'bad_option', `答了题面以外的选项「${a.option}」`);
  if (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
    return notJudged(q, 'bad_answer', `把握度不在 0–1 之间：${a.confidence}`);
  }
  if (a.confidence < state.confidenceLine) {
    return {
      ...notJudged(
        q,
        'unsure',
        `答「${option.id}」，把握度 ${a.confidence} 低于把握线 ${state.confidenceLine}`,
      ),
      option: option.id,
      confidence: a.confidence,
    };
  }
  const verdict: Judged<string, Effect> = {
    judged: true,
    questionId: q.id,
    option: option.id,
    confidence: a.confidence,
    effect: option.effect,
    enforced: enforceable,
    act: enforceable ? option.effect : 'none',
    model: result.model,
    latencyMs: result.latencyMs,
    // 记进库之后换成那一行的 id。
    answerId: 0,
  };
  return verdict;
}

function answerRow(
  q: QuestionDef,
  verdict: Verdict,
  result: BackendResult | undefined,
  c: {
    askedAt: Date;
    evidence: EvidenceInput;
    ctx: AskContext;
    exam: ExamContext | undefined;
    batch: { id: string; size: number };
    enforceable: boolean;
    backend: JevBackend;
    askedCount: number;
    /** 这一问事先估的输入 token（整批）。 */
    estimatedTokens: number;
  },
): AnswerRow {
  const sent = result !== undefined && (verdict.judged || !isLocal(verdict.reason));
  // 把握不够也是答了：答案和把握度照记（统计里算「没把握」），只是不作数。
  const answered = verdict.judged || (verdict.reason === 'unsure' && verdict.option !== undefined);
  // 发出去就记账：超时、回包认不出、回话模型不对时上游可能已经计费。上游报了 token 数按它，没报按事前估算、标明是估的。
  const billed = sent && result ? billedTokens(result, c.estimatedTokens) : undefined;
  // 一次问几道题共用一次调用：token 和花费按道分摊。
  const tokens = billed === undefined ? undefined : Math.ceil(billed.tokens / Math.max(1, c.askedCount));
  const price = c.backend.usdPerMTok;
  const sample: AnswerSample = {
    rev: questionRev(q),
    model: c.backend.model,
    backend: c.backend.kind,
    evidence: digestEvidence(q.evidence, c.evidence),
    ...(c.ctx.ref === undefined ? {} : { ref: c.ctx.ref }),
    batch: c.batch,
    ...(billed?.estimated ? { tokensEstimated: true } : {}),
    ...(tokens !== undefined && price !== undefined ? { costUsd: usdOf(tokens, price) } : {}),
    ...(c.exam ? { exam: { runId: c.exam.runId, sampleId: c.exam.sampleId } } : {}),
    ...(verdict.judged ? {} : { detail: verdict.detail }),
  };
  const truth = c.exam?.expect[q.id];
  return {
    questionId: q.id,
    askedAt: c.askedAt,
    subject: c.exam ? `exam:${c.exam.sampleId}` : c.ctx.subject,
    sample,
    shadow: !c.enforceable,
    ok: answered,
    answer: answered ? (verdict.option ?? null) : null,
    confidence: answered ? (verdict.confidence ?? null) : null,
    failReason: answered || verdict.judged ? null : verdict.reason,
    modelVersion: sent && result ? (result.model ?? null) : null,
    latencyMs: sent && result ? result.latencyMs : null,
    inputTokens: tokens ?? null,
    ...(truth === undefined ? {} : { truth, truthSource: 'canary' as const }),
  };
}

/**
 * 一次发出去的调用记多少输入 token：成功的按回包（后端没报时它自己按字符估过，照它的 tokensEstimated）；
 * 出错的，上游报了按它，没报按事前估算——不记 0，否则出错的调用不占花费上限。
 */
function billedTokens(result: BackendResult, estimated: number): { tokens: number; estimated: boolean } {
  if (result.ok) return { tokens: result.inputTokens, estimated: result.tokensEstimated };
  if (result.inputTokens !== undefined) return { tokens: result.inputTokens, estimated: false };
  return { tokens: estimated, estimated: true };
}
