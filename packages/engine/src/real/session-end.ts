// 会话的结局：把执行体的报告（HostReport）、进度库里的 fleet done / fleet blocked、停下的原因、交活核对和结论文件合成交给工作流的
// SessionEnd（endOf）；被信号杀掉的按证据写是谁杀的；这一轮花了多少（costOfThisRun）；三段 runner 的结局转换（sessionEndFromSegment）。
// 从 sessions.ts 拆出来，函数体原样。

import { judgeRun } from '@fleet-dao/adapters';
import { runProgressFacts } from '@fleet-dao/db';
import type { AwaitSessionInput, SessionEnd } from '../ports.ts';
import type { HostReport } from './hosts.ts';
import { explainKill, killSignal, scopeOomKills } from './kill-evidence.ts';
import { ENGINE_STOP_CODE, orgSwitchFailure } from './session-codes.ts';
import type { Live } from './session-live.ts';
import type { createOutput } from './session-output.ts';
import type { SessionShared } from './session-types.ts';
import { errorText, withRawError } from './session-util.ts';
import type { SegmentOutcome } from './sessions-segment.ts';

const NEEDS = new Set(['human', 'info', 'access', 'other']);

export function createEnd(shared: SessionShared, parts: ReturnType<typeof createOutput>) {
  const { deps, db, evidence } = shared;
  const { deliveryCheck, readOutput } = parts;

  function costOfThisRun(live: Live, sessionCost: number | undefined): number | undefined {
    if (sessionCost === undefined || live.mode === 'fork') return undefined;
    if (live.mode !== 'resume') return sessionCost;
    if (live.previousCost === null || live.previousCost === undefined) return undefined;
    return Math.max(0, sessionCost - live.previousCost);
  }

  /**
   * 交给工作流的会话号：执行体真用的那个（Claude、续会话一开始就知道；cursor 开新会话要 init 帧或终帧报上来；grok 开新会话
   * 要它真开了会话）。没报出来就是空串：工作流保留上一个，不拿临时号、没建成的号去续。
   */
  const agentIdOf = (live: Live, report?: HostReport): string =>
    live.agentSessionId ?? report?.sessionId ?? '';

  async function endOf(live: Live, report: HostReport): Promise<SessionEnd> {
    const common = {
      sessionId: agentIdOf(live, report),
      // 终帧报的这一轮的 token（含缓存读写）；读不到的不给，不记成 0。
      usage: report.usage,
      ...(report.sessionCostUsd === undefined ? {} : { sessionCostUsd: report.sessionCostUsd }),
    };
    const notes = [
      live.writeError ? `进度事件没写进库：${live.writeError}` : '',
      live.dropped > 0 ? `丢了 ${live.dropped} 条进度事件` : '',
    ].filter(Boolean);
    const failed = (code: string, message: string): SessionEnd => ({
      ...common,
      outcome: 'failed',
      failure: {
        code,
        message: [withRawError(message, report.rawError), ...notes].join('；'),
        ...(report.resetsAt ? { resetsAt: report.resetsAt } : {}),
        ...(report.httpStatus === undefined ? {} : { httpStatus: report.httpStatus }),
        exitCode: report.facts.exitCode ?? null,
        signal: report.facts.signal ?? null,
        transcriptTail: live.says.slice(-6),
        machine: deps.machine,
        runAsUser: live.user,
      },
    });
    /**
     * 没交终帧就退了、而且是被信号杀掉的（信号 SIGKILL、SIGTERM，或 sh 包着交回的 137、143）：按证据定是谁杀的
     * （kill-evidence.ts），码换成 engine_stop / oom_killed / signal_unexplained 交给失败分流，证据接在原文后面。不猜。
     */
    const failedOrKilled = async (code: string, message: string): Promise<SessionEnd> => {
      const signal =
        code === 'no_result' || code === 'exit_nonzero'
          ? killSignal(report.facts.exitCode, report.facts.signal)
          : null;
      if (!signal) return failed(code, message);
      const scopeNow = live.scopeUnit ? await scopeOomKills(evidence, live.scopeUnit) : undefined;
      const seen = [live.scopeOomSeen, scopeNow].filter((n): n is number => n !== undefined);
      const cause = await explainKill(evidence, {
        signal,
        endedAt: live.startedAt + report.wallMs,
        stopping: deps.drain?.stopping() ?? null,
        before: await live.oomBefore,
        scopeSeen: seen.length > 0 ? Math.max(...seen) : undefined,
        othersRunning: live.peersSeen,
      });
      return failed(cause.code, `${message}；${cause.why}`);
    };

    if (live.stop?.kind === 'stop') return { ...common, outcome: 'stopped' };
    // 切号停下的：交回 org_switch（可重试），工作流续同一个会话，换了池就 fork 续上（失败分流 OS1）
    if (live.stop?.kind === 'org-switch') {
      return {
        ...common,
        outcome: 'failed',
        failure: { ...orgSwitchFailure(live.stop.why), machine: deps.machine, runAsUser: live.user },
      };
    }
    // 排空到截止停下的：交回 engine_stop（可重试），新引擎起来工作流续同一个会话（失败分流 KL3，不记账）
    if (live.stop?.kind === 'engine-stop') {
      return {
        ...common,
        outcome: 'failed',
        failure: {
          code: ENGINE_STOP_CODE,
          message: `要发新版本，到了宽限的截止先停下：${live.stop.why}；新引擎起来按编号续上`,
          retryable: true,
          machine: deps.machine,
          runAsUser: live.user,
        },
      };
    }
    if (live.stop?.kind === 'stall') {
      return {
        ...common,
        outcome: 'stalled',
        failure: {
          code: 'SESSION_STALLED',
          message: `${live.stop.rule}：${live.stop.basis}`,
          retryable: true,
        },
      };
    }

    let progress: Awaited<ReturnType<typeof runProgressFacts>>;
    try {
      progress = await runProgressFacts(db, live.runId);
    } catch (error) {
      return failed('delivery_unknown', `会话交没交活没查成（读不到进度）：${errorText(error)}`);
    }
    const done = progress?.done ?? null;
    const blocked = progress?.blocked ?? null;
    if (blocked && (!done || blocked.at.getTime() > done.at.getTime())) {
      const needs = NEEDS.has(blocked.needs)
        ? (blocked.needs as 'human' | 'info' | 'access' | 'other')
        : 'other';
      return { ...common, outcome: 'blocked', blocked: { reason: blocked.reason || '会话说卡住了', needs } };
    }

    if (live.kind === 'delivery') {
      const delivery = await deliveryCheck(live);
      const verdict = judgeRun(report.facts, delivery.check);
      if (verdict.outcome === 'stalled') {
        return {
          ...common,
          outcome: 'stalled',
          failure: { code: 'SESSION_STALLED', message: verdict.detail, retryable: true },
        };
      }
      if (verdict.outcome === 'stopped') return { ...common, outcome: 'stopped' };
      if (verdict.outcome !== 'ok') return failedOrKilled(verdict.reason, verdict.detail);
      if (!done) {
        return failed('not_delivered', '会话结束了，但没用 fleet done 交活（也没用 fleet blocked 说卡在哪）');
      }
      if (!delivery.head) return failed('delivery_unknown', '读不到工作树的头');
      return {
        ...common,
        outcome: 'done',
        output: {
          kind: 'delivery',
          head: delivery.head,
          summary: done.summary,
          testsPassed: done.testsPassed === true,
          changedFiles: delivery.changed,
        },
      };
    }

    const verdict = judgeRun(report.facts);
    if (verdict.outcome === 'stalled') {
      return {
        ...common,
        outcome: 'stalled',
        failure: { code: 'SESSION_STALLED', message: verdict.detail, retryable: true },
      };
    }
    if (verdict.outcome === 'stopped') return { ...common, outcome: 'stopped' };
    if (verdict.outcome !== 'ok') return failedOrKilled(verdict.reason, verdict.detail);
    const output = await readOutput(live);
    if ('error' in output) return failed('wrong_output', output.error);
    return { ...common, outcome: 'done', output: output.ok };
  }

  /**
   * 三段（对题 / 动手 / 验收）走 runner 的 SessionEnd 转换（#554-4）：
   * runner 没 OutputKind / 没 .fleet-out/（那是 Lead / Verify 一路的形状），产出 = stdout 短句 + verdict。
   * - outcome done + verdict ok → done（会话跑通；output 不写——三段的调用方自己拿 SegmentOutcome 的事由 #554-2 接）
   * - outcome done + verdict failed / outcome != done → failed，failure.code 用 runner 的形状。
   * **没拿到 evidence 时不在这里判 manual 的业务对错**（那是 #554-2）；本切片只保证「会话起完不起坏」。
   */
  function sessionEndFromSegment(outcome: SegmentOutcome, input: AwaitSessionInput): SessionEnd {
    const { result, verdict } = outcome;
    const ok = result.outcome === 'done' && verdict.kind === 'ok';
    if (ok) {
      return { sessionId: outcome.sessionId, outcome: 'done' };
    }
    const failedReason = verdict.kind === 'failed' ? verdict.reason : `outcome=${result.outcome}`;
    return {
      sessionId: outcome.sessionId,
      outcome: result.outcome === 'timeout' || result.outcome === 'killed' ? 'stopped' : 'failed',
      failure: {
        code:
          result.outcome === 'done' ? 'SEGMENT_VERDICT_FAILED' : `SEGMENT_${result.outcome.toUpperCase()}`,
        message: `runner 段会话 ${input.runId} ${result.outcome}：${failedReason}`,
        retryable: result.outcome === 'timeout' || result.outcome === 'failed',
        exitCode: result.exitCode,
      },
    };
  }

  return { costOfThisRun, agentIdOf, endOf, sessionEndFromSegment };
}
