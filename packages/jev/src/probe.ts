// 判断题健康自检：最近一次真调用失败、又超过 30 分钟没有新调用时，用一道固定的小题再问一次上游。
// 不走 createJev：那条路会计入每日次数和花费上限，自检要么被上限拦住（红灯永远不回来），要么把业务额度吃掉。
// 结果仍写进 jev_answers，当作「最近一次」。通过只认这道题的固定答案；上游没答上、答错，都记成没成，原因以「自检失败」开头。
import { createHash, randomUUID } from 'node:crypto';
import { type Db, jevQuestions } from '@fleet-dao/db';
import type { BackendRequest, BackendResult, JevBackend } from './backend.ts';
import type { FieldDigest } from './evidence.ts';
import { JUDGE_PROBE_QUESTION_ID } from './probe-id.ts';
import { cutAt, scrubHead, wellFormed } from './scrub.ts';
import { type AnswerSample, insertAnswers, type SentCall } from './store.ts';
import { type NotJudgedReason, REASON_TEXT } from './verdict.ts';

export { JUDGE_PROBE_QUESTION_ID };

/** 「超过 30 分钟没有新调用」：刚好 30 分钟还不算过。 */
export const JUDGE_PROBE_STALE_MS = 30 * 60_000;

/** 这道题只有一个对的选项。答别的不算自检通过。 */
export const JUDGE_PROBE_EXPECTED = 'yes';

export const JUDGE_PROBE_INSTRUCTIONS =
  '这是健康自检，不是业务题。证据里的词如果就是「自检」，选 yes，否则选 no。';

const PROBE_OPTIONS = [
  { id: 'yes', criteria: '证据里的词就是「自检」' },
  { id: 'no', criteria: '证据里的词不是「自检」' },
] as const;

const EVIDENCE_LABEL = '词';
const EVIDENCE_TEXT = '自检';
const DETAIL_CHARS = 500;

export function probeRequest(): BackendRequest {
  return {
    questions: [
      {
        id: JUDGE_PROBE_QUESTION_ID,
        instructions: JUDGE_PROBE_INSTRUCTIONS,
        options: PROBE_OPTIONS.map((o) => ({ id: o.id, criteria: o.criteria })),
      },
    ],
    evidence: [{ label: EVIDENCE_LABEL, text: EVIDENCE_TEXT }],
  };
}

/**
 * 这一轮发不发自检。最近一次成功、还没有调用、失败还没超过 30 分钟：不发。
 * 没有「最近一次」时不发：健康检查把「还没调过」当成好，没有要恢复的红灯。
 */
export function probeDue(last: SentCall | undefined, now: Date): { send: boolean; why: string } {
  if (!last) return { send: false, why: '还没有判断题调用，不发自检' };
  if (last.ok) return { send: false, why: '最近一次调用成了，不发自检' };
  if (now.getTime() - last.at.getTime() <= JUDGE_PROBE_STALE_MS) {
    return { send: false, why: '最近一次失败还没超过 30 分钟，不发自检' };
  }
  return { send: true, why: '最近一次调用没成，而且超过 30 分钟没有新调用' };
}

export type ProbeVerdict =
  | { ok: true; option: string; confidence: number }
  | { ok: false; reason: NotJudgedReason; detail: string };

function fail(reason: NotJudgedReason, upstream: string): ProbeVerdict {
  const text = upstream.trim() || REASON_TEXT[reason];
  return { ok: false, reason, detail: `自检失败：${text}` };
}

/**
 * 自检算不算通过。只认：后端答了，而且答的就是固定答案，把握度在 0 到 1。
 * 上游报错、没这道题、答错，都是没成。不许把没成写成通过。
 */
export function probeCallOk(result: BackendResult): ProbeVerdict {
  if (!result.ok) return fail(result.reason, result.detail);
  const answer = result.answers[JUDGE_PROBE_QUESTION_ID];
  if (answer === undefined) return fail('no_answer', '回包里没有这道题');
  if ('invalid' in answer) return fail('bad_answer', answer.invalid);
  if (answer.option !== JUDGE_PROBE_EXPECTED) {
    return fail('bad_answer', `答了「${answer.option}」，这道题的答案是「${JUDGE_PROBE_EXPECTED}」`);
  }
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    return fail('bad_answer', `把握度不在 0–1 之间：${answer.confidence}`);
  }
  return { ok: true, option: answer.option, confidence: answer.confidence };
}

/** /healthz 的 judge 项写进日志的那句原因。自检题点明是自检失败，不写成普通的「问某道题」。 */
export function judgeFailureNote(call: SentCall): string {
  const what = call.questionId === JUDGE_PROBE_QUESTION_ID ? '自检失败' : `问 ${call.questionId}`;
  const reason = call.reason ?? '没写原因';
  const detail = call.detail ? `：${call.detail}` : '';
  return `${call.at.toISOString()} ${what}（判断记录 ${call.answerId}）：${reason}${detail}`;
}

function clip(detail: string): string {
  const text = scrubHead(detail, DETAIL_CHARS + 1);
  return text.length > DETAIL_CHARS ? `${cutAt(text, DETAIL_CHARS)}…` : text;
}

function digest(text: string): FieldDigest {
  return {
    chars: text.length,
    sha: createHash('sha256').update(text).digest('hex').slice(0, 16),
    head: text,
  };
}

/**
 * 把这一次自检写进 jev_answers。ok 只跟 probeCallOk 走：实际没成就记没成，不记花费、不记 token。
 * 题不在业务题库里，第一次自检时顺手登记（只记不拦）。
 */
export async function recordProbeCall(
  db: Db,
  input: { backend: JevBackend; routeId: string; result: BackendResult; at: Date },
): Promise<ProbeVerdict> {
  const verdict = probeCallOk(input.result);
  const model = input.backend.model;
  await db
    .insert(jevQuestions)
    .values({
      id: JUDGE_PROBE_QUESTION_ID,
      site: 'judge-probe',
      prompt: JUDGE_PROBE_INSTRUCTIONS,
      type: 'choice',
      options: PROBE_OPTIONS.map((o) => o.id),
      mode: 'shadow',
      confidenceLine: 0.5,
      model,
    })
    .onConflictDoNothing();
  const sample: AnswerSample = {
    rev: createHash('sha256').update(JUDGE_PROBE_INSTRUCTIONS).digest('hex').slice(0, 12),
    model,
    backend: input.backend.kind,
    route: wellFormed(input.routeId),
    evidence: { word: digest(EVIDENCE_TEXT) },
    batch: { id: randomUUID(), size: 1 },
    ...(verdict.ok ? {} : { detail: clip(verdict.detail) }),
  };
  const reported = input.result.model;
  await insertAnswers(db, [
    {
      questionId: JUDGE_PROBE_QUESTION_ID,
      askedAt: input.at,
      subject: 'judge-self-check',
      sample,
      shadow: true,
      ok: verdict.ok,
      answer: verdict.ok ? verdict.option : null,
      confidence: verdict.ok ? verdict.confidence : null,
      failReason: verdict.ok ? null : verdict.reason,
      modelVersion: reported !== undefined ? wellFormed(reported) : null,
      latencyMs: input.result.latencyMs,
    },
  ]);
  return verdict;
}
