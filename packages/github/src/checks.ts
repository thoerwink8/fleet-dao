// CI 结论（纯判断，不碰网络）：按必过检查的名字逐个看，同名只认最新一条（rerun、pull_request 与 push 双触发都会出两条，C9）。
// 三态纪律：一条都没有 ≠ 绿（零条检查不当绿），读不到 ≠ 零条（读不到由调用方判「没查成」，不走这里）。
import { z } from 'zod';

export const CheckRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  output: z
    .object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const CommitStatusSchema = z.object({
  context: z.string(),
  state: z.string(),
  updated_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  target_url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type CommitStatus = z.infer<typeof CommitStatusSchema>;

export type CheckState = 'success' | 'failure' | 'pending' | 'missing';

export interface CheckVerdict {
  name: string;
  state: CheckState;
  /** GitHub 原样的结论（success / failure / timed_out …）或提交状态。 */
  conclusion?: string | undefined;
  url?: string | undefined;
  /** 失败时的一句摘要（检查输出的标题或描述）。 */
  detail?: string | undefined;
  /** 同名的第几次（多次时说明有过 rerun 或双触发）。 */
  attempts: number;
}

export interface CiEvaluation {
  /** green = 必过检查全绿；red = 有一条红；pending = 还有没跑完或没出现的；none = 一条都还没出现。 */
  overall: 'green' | 'red' | 'pending' | 'none';
  checks: CheckVerdict[];
  failed: string[];
  pending: string[];
  missing: string[];
}

const PASS = new Set(['success', 'neutral', 'skipped']);
const FAIL = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled']);

function time(s: string | null | undefined): number {
  const t = s ? Date.parse(s) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

/** 同名只取最新：先比开始时间，再比编号（编号大的后建）。 */
export function latestRun(runs: readonly CheckRun[]): CheckRun | undefined {
  let best: CheckRun | undefined;
  for (const r of runs) {
    if (!best) {
      best = r;
      continue;
    }
    const a = time(r.started_at ?? r.completed_at);
    const b = time(best.started_at ?? best.completed_at);
    if (a > b || (a === b && r.id > best.id)) best = r;
  }
  return best;
}

function fromRun(name: string, run: CheckRun, attempts: number): CheckVerdict {
  const url = run.html_url ?? undefined;
  if (run.status !== 'completed') return { name, state: 'pending', conclusion: run.status, url, attempts };
  const c = run.conclusion ?? '';
  if (PASS.has(c)) return { name, state: 'success', conclusion: c, url, attempts };
  if (FAIL.has(c)) {
    const detail = run.output?.title || run.output?.summary?.split('\n')[0] || undefined;
    return { name, state: 'failure', conclusion: c, url, detail, attempts };
  }
  // stale 等：GitHub 认为该重跑了，当「还没出结论」
  return { name, state: 'pending', conclusion: c || 'unknown', url, attempts };
}

function fromStatus(name: string, st: CommitStatus): CheckVerdict {
  const url = st.target_url ?? undefined;
  if (st.state === 'success') return { name, state: 'success', conclusion: st.state, url, attempts: 1 };
  if (st.state === 'failure' || st.state === 'error') {
    return {
      name,
      state: 'failure',
      conclusion: st.state,
      url,
      detail: st.description ?? undefined,
      attempts: 1,
    };
  }
  return { name, state: 'pending', conclusion: st.state, url, attempts: 1 };
}

export function evaluateChecks(
  required: readonly string[],
  runs: readonly CheckRun[],
  statuses: readonly CommitStatus[],
): CiEvaluation {
  const checks: CheckVerdict[] = required.map((name) => {
    const same = runs.filter((r) => r.name === name);
    const run = latestRun(same);
    const status = statuses.find((s) => s.context === name);
    if (run && status) {
      // 两种都有：取更新的那个
      const runAt = time(run.completed_at ?? run.started_at);
      const stAt = time(status.updated_at ?? status.created_at);
      return stAt > runAt ? fromStatus(name, status) : fromRun(name, run, same.length);
    }
    if (run) return fromRun(name, run, same.length);
    if (status) return fromStatus(name, status);
    return { name, state: 'missing', attempts: 0 };
  });
  const failed = checks.filter((c) => c.state === 'failure').map((c) => c.name);
  const pending = checks.filter((c) => c.state === 'pending').map((c) => c.name);
  const missing = checks.filter((c) => c.state === 'missing').map((c) => c.name);
  let overall: CiEvaluation['overall'];
  if (failed.length > 0) overall = 'red';
  else if (checks.length > 0 && checks.every((c) => c.state === 'success')) overall = 'green';
  else if (missing.length === checks.length) overall = 'none';
  else overall = 'pending';
  return { overall, checks, failed, pending, missing };
}

/** 给 PR 镜像（pull_requests.checks）的汇总。 */
export function mirrorChecks(e: CiEvaluation): 'success' | 'failure' | 'pending' | 'none' {
  switch (e.overall) {
    case 'green':
      return 'success';
    case 'red':
      return 'failure';
    case 'none':
      return 'none';
    default:
      return 'pending';
  }
}

/** 失败摘要：失败的检查名 + 第一条的输出标题。引擎用它判「同一处连红两轮」。 */
export function failureDigest(e: CiEvaluation): string | undefined {
  const first = e.checks.find((c) => c.state === 'failure');
  if (!first) return undefined;
  return [first.name, first.conclusion, first.detail].filter(Boolean).join('：');
}
