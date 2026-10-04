// 一次性会话收场时的两样结论，出自同一份证据：
// - segmentEvidence：没跑成时交给任务工作流的失败分流（real/task-segment.ts 的 runSegment 回 ok:false 时带上）；
// - routeOutcomeOf：这一次算不算这条路由的账，收场那一笔写进 runs.route_outcome（runner/one-shot.ts），选路的熔断、战绩
//   和 Fusion 的会话并起来读（db 的 pool-runs.ts，#758）。
//
// 改这里之前必须知道：
// - 两样必须是同一份证据、同一个判法：熔断认的「算不算路由的错」就是失败分流（failure/classify.ts）对这份证据下的 routeOutcome，
//   和 Fusion 的会话同一个口径（real/sessions.ts 的 holdOrRelease：跑通了 ok；跑了、失败了过分流，分流说是路由的错才 fail；
//   没起来的、我们停的 neutral）。另写一套判法，熔断和分流就会对同一次失败说两样话。
// - 没起来的（spawn_failed）、我们停的（killed：叫停、引擎重启收掉；org_switch：切号，分流 OS1）、内存放不下没开跑的
//   （admission_blocked）一律 neutral：不是路由的错，不进熔断、战绩。

import { classifyFailure } from '../failure/classify.ts';
import type { SegmentEvidence } from '../task-contract.ts';
import type { RunRecord } from './not-wired.ts';
import type { OneShotInput, OneShotResult } from './one-shot.ts';

const MESSAGE_MAX = 4000;

/** one-shot 的结局 → 失败分流要的证据：原因码原样带过去，没有才按结局给一个。 */
export function segmentEvidence(result: OneShotResult): SegmentEvidence {
  // 切号停下的（#59）：码就是结局本身（失败分流 OS1 认 org_switch，不算失败、不记账），不让被杀时执行体报的原因码盖掉它
  if (result.outcome === 'org_switch') {
    return {
      code: 'org_switch',
      message: (result.failureReason ?? '切号：先停下这一段，切完在原分支上重跑').slice(0, MESSAGE_MAX),
      quotaExhausted: false,
    };
  }
  const facts = result.facts;
  const reason =
    facts?.reason && facts.reason !== 'delivered' && facts.reason !== 'answered' ? facts.reason : undefined;
  const code =
    reason ??
    (result.outcome === 'timeout'
      ? 'wall_clock_timeout'
      : result.outcome === 'admission_blocked'
        ? 'memory_busy'
        : result.outcome);
  const text = [facts?.detail, facts?.rawError, result.failureReason, result.stderrTail]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join('\n');
  return {
    code,
    message: (text || `会话没跑成（${result.outcome}）`).slice(0, MESSAGE_MAX),
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    ...(facts?.httpStatus === undefined ? {} : { httpStatus: facts.httpStatus }),
    ...(facts?.resetsAt === undefined ? {} : { resetsAt: facts.resetsAt }),
    quotaExhausted: facts?.quotaExhausted === true,
  };
}

/** 这一次算不算这条路由的账（runs.route_outcome）。 */
export function routeOutcomeOf(result: OneShotResult, segment: OneShotInput['segment']): RunRecord['routeOutcome'] {
  switch (result.outcome) {
    case 'done':
      return 'ok';
    case 'failed':
    case 'timeout': {
      // 和任务工作流的失败分流交给分流的同一份（workflows/task.ts 的 classify：session 来源、绑路由、码和原文照证据）
      const e = segmentEvidence(result);
      return classifyFailure({
        source: `session:${segment}`,
        routeBound: true,
        retryable: null,
        ...(e.code === undefined ? {} : { code: e.code }),
        ...(e.message === undefined ? {} : { message: e.message }),
        ...(e.exitCode === undefined ? {} : { exitCode: e.exitCode }),
        ...(e.httpStatus === undefined ? {} : { httpStatus: e.httpStatus }),
        ...(e.resetsAt === undefined ? {} : { resetsAt: e.resetsAt }),
      }).routeOutcome;
    }
    case 'killed':
    case 'spawn_failed':
    case 'admission_blocked':
    case 'org_switch':
      return 'neutral';
  }
}
