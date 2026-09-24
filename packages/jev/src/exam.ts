// 考题：每个接入点一份，放在 packages/jev/exams/<接入点>.json，是从旧系统真实记录里挑出来、脱过敏的样本和标准答案。
// 两个用处：巡检任务定时拿它考（准确率掉下去，真拦的题自动退回只记不拦，见 store.reviewModes）；换模型、改题之后先考一遍。
// 考试的每一问都照常记进 jev_answers（真值 = 标准答案，来源 canary），从不真拦，也占每日次数。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { questionsOfSite } from './bank.ts';
import type { Jev } from './jev.ts';
import type { ExamTally } from './mode.ts';
import { type QuestionDef, SITES, type SiteId } from './questions.ts';

export interface ExamSample {
  id: string;
  /** 取自哪条真实记录：旧仓单号 / PR 号、VPS 上的记录（去掉用户名）与时间。 */
  source: string;
  /** 证据字段 → 原文（脱过敏）。 */
  evidence: Record<string, string>;
  /** 题号 → 标准答案（选项 id）。 */
  expect: Record<string, string>;
  /** 题号 → 为什么是这个答案，尽量引事后结局。 */
  why: Record<string, string>;
}

export const EXAMS_DIR = fileURLToPath(new URL('../exams/', import.meta.url));

export function examPath(site: SiteId): string {
  return `${EXAMS_DIR}${site}.json`;
}

export function loadExam(site: SiteId): ExamSample[] {
  return JSON.parse(readFileSync(examPath(site), 'utf8')) as ExamSample[];
}

/** 考题本身写得对不对：字段、选项、理由都要对得上题库。返回问题清单。 */
export function checkExam(site: SiteId, samples: readonly ExamSample[]): string[] {
  const problems: string[] = [];
  const questions = questionsOfSite(site);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const fieldKeys = new Set(questions.flatMap((q) => q.evidence.map((f) => f.key)));
  const ids = new Set<string>();
  for (const s of samples) {
    const at = `${site}/${s.id}`;
    if (!s.id?.trim()) problems.push(`${site}：有考题没编号`);
    if (ids.has(s.id)) problems.push(`${at}：编号重复`);
    ids.add(s.id);
    if (!s.source?.trim()) problems.push(`${at}：没写取自哪条真实记录`);
    for (const k of Object.keys(s.evidence ?? {})) {
      if (!fieldKeys.has(k)) problems.push(`${at}：证据字段 ${k} 这个接入点的题都不认识`);
      if (typeof s.evidence[k] !== 'string') problems.push(`${at}：证据字段 ${k} 要是文字`);
    }
    const expected = Object.entries(s.expect ?? {});
    if (expected.length === 0) problems.push(`${at}：没有标准答案`);
    for (const [qid, option] of expected) {
      const q = byId.get(qid);
      if (!q) {
        problems.push(`${at}：题 ${qid} 不在这个接入点`);
        continue;
      }
      if (!q.options.some((o) => o.id === option)) problems.push(`${at}：题 ${qid} 没有选项 ${option}`);
      if (!s.why?.[qid]?.trim()) problems.push(`${at}：题 ${qid} 的标准答案没写理由`);
      for (const f of q.evidence) {
        if (f.required && !s.evidence?.[f.key]?.trim())
          problems.push(`${at}：题 ${qid} 必填的证据 ${f.key} 没给`);
      }
    }
  }
  return problems;
}

export interface QuestionExamReport extends ExamTally {
  questionId: string;
  /** 没判出来的原因 → 次数。 */
  reasons: Record<string, number>;
  /** 答错的（把握够却选错）和把握不够的。 */
  misses: { sampleId: string; expect: string; got?: string; confidence?: number; reason?: string }[];
}

export interface ExamReport {
  runId: string;
  site: SiteId;
  at: Date;
  questions: QuestionExamReport[];
}

/** 考一个接入点：按考题文件里的顺序取前 limit 道（不给就全考），逐道问、逐题记分。 */
export async function runExam(
  jev: Jev,
  site: SiteId,
  options: { limit?: number; runId?: string; now?: () => Date; samples?: readonly ExamSample[] } = {},
): Promise<ExamReport> {
  if (!(site in SITES)) throw new Error(`没有这个接入点：${site}`);
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const all = options.samples ?? loadExam(site);
  // 考题写坏了（选项对不上、缺证据）就不考：拿坏考题算出来的准确率会被当真。
  const problems = checkExam(site, all);
  if (problems.length) throw new Error(`${site} 的考题写得不对，不考：\n- ${problems.join('\n- ')}`);
  if (all.length === 0) throw new Error(`${site} 一道考题都没有，不考`);
  const samples = options.limit === undefined ? all : all.slice(0, options.limit);
  const questions: readonly QuestionDef[] = questionsOfSite(site);
  const reports = new Map<string, QuestionExamReport>(
    questions.map((q) => [
      q.id,
      {
        questionId: q.id,
        runId,
        at: now(),
        asked: 0,
        answered: 0,
        sure: 0,
        correct: 0,
        badOption: 0,
        reasons: {},
        misses: [],
      },
    ]),
  );
  for (const sample of samples) {
    const verdicts = await jev.exam(questions, sample.evidence, {
      runId,
      sampleId: sample.id,
      expect: sample.expect,
    });
    for (const v of verdicts) {
      const r = reports.get(v.questionId);
      const expect = sample.expect[v.questionId];
      if (!r || expect === undefined) continue;
      r.asked += 1;
      if (v.judged) {
        r.answered += 1;
        r.sure += 1;
        if (v.option === expect) r.correct += 1;
        else r.misses.push({ sampleId: sample.id, expect, got: v.option, confidence: v.confidence });
        continue;
      }
      r.reasons[v.reason] = (r.reasons[v.reason] ?? 0) + 1;
      if (v.reason === 'unsure') r.answered += 1;
      if (v.reason === 'bad_option') r.badOption += 1;
      r.misses.push({
        sampleId: sample.id,
        expect,
        reason: v.reason,
        ...(v.option === undefined ? {} : { got: v.option }),
        ...(v.confidence === undefined ? {} : { confidence: v.confidence }),
      });
    }
  }
  const at = now();
  return {
    runId,
    site,
    at,
    questions: [...reports.values()].filter((r) => r.asked > 0).map((r) => ({ ...r, at })),
  };
}
