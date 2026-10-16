// runner/evidence.ts：一次性会话收场时的两样结论出自同一份证据——交给失败分流的证据（segmentEvidence），和这一次算不算这条
// 路由的账（routeOutcomeOf，写进 runs.route_outcome，选路的熔断、战绩读它，#758）。算不算路由的错和失败分流同一个判法。
import { describe, expect, it } from 'vitest';
import { evidenceOf as triageEvidence } from '../../src/decisions/failure.ts';
import { classifyFailure } from '../../src/failure/classify.ts';
import { routeOutcomeOf, segmentEvidence } from '../../src/runner/evidence.ts';
import type { OneShotResult } from '../../src/runner/one-shot.ts';
import { SEGMENT_STAGE } from '../../src/task-contract.ts';

const base: OneShotResult = {
  runId: 'x',
  outcome: 'failed',
  exitCode: 2,
  stdout: '',
  stderrTail: 'boom',
  startedAt: '2026-10-02T00:00:00Z',
  endedAt: '2026-10-02T00:01:00Z',
  runsNotWired: false,
};

describe('segmentEvidence：交给失败分流的证据', () => {
  it('没有原因码就按结局给码；有原因码原样；delivered / answered 不算失败原因；读不到的字段不写', () => {
    expect(segmentEvidence(base)).toMatchObject({ code: 'failed', exitCode: 2, quotaExhausted: false });
    expect(segmentEvidence({ ...base, outcome: 'killed', exitCode: null })).toMatchObject({ code: 'killed' });
    expect('exitCode' in segmentEvidence({ ...base, exitCode: null })).toBe(false);
    expect(segmentEvidence({ ...base, outcome: 'timeout' }).code).toBe('wall_clock_timeout');
    expect(
      segmentEvidence({ ...base, facts: { reason: 'relay_unknown', detail: '账本没读成' } }),
    ).toMatchObject({
      code: 'relay_unknown',
      message: expect.stringContaining('账本没读成'),
    });
    expect(segmentEvidence({ ...base, facts: { reason: 'answered' } }).code).toBe('failed');
    expect(segmentEvidence({ ...base, stderrTail: '' }).message).toContain('没跑成');
    expect(
      (segmentEvidence({ ...base, stderrTail: 'x'.repeat(10_000) }).message ?? '').length,
    ).toBeLessThanOrEqual(4000);
  });

  it('【故意造出的失败】one-shot 的时限先到（驱动没先收场）：驱动交回的 aborted 只是在回应我们的 kill，码还是 wall_clock_timeout，分流认 WT1，不认成「我们自己停的」（#1859/#1877/#1933）', () => {
    // 法国原样（#2759）：Mirasim 驱动没拿到时限，one-shot 60 分钟杀，驱动报 aborted，叫停原文带上种类和说明
    const stop = '引擎叫停（时限到了：one-shot timeout）';
    const echoed: OneShotResult = {
      ...base,
      outcome: 'timeout',
      exitCode: null,
      stderrTail: stop,
      failureReason: `exit=null killed=true；${stop}`,
      facts: { reason: 'aborted', detail: stop },
    };
    const e = segmentEvidence(echoed);
    expect(e.code).toBe('wall_clock_timeout');
    const verdict = classifyFailure({
      source: 'session:manual',
      routeBound: true,
      retryable: null,
      code: e.code ?? '',
      message: e.message ?? '',
    });
    // 原文里的 “one-shot timeout” 不能让 NT2 抢走：时限是我们定的，不算路由的错
    expect(verdict.rule).toBe('WT1');
    expect(verdict.routeOutcome).toBe('neutral');
    // 驱动自己报的别的原因（额度用满、繁忙）照样优先：只换掉「回应我们的 kill」那一个
    expect(segmentEvidence({ ...echoed, facts: { reason: 'quota_exhausted' } }).code).toBe('quota_exhausted');
    // 不是超时（切号、人叫停走 killed）的 aborted 原样
    expect(segmentEvidence({ ...echoed, outcome: 'killed' }).code).toBe('aborted');
  });
});

describe('routeOutcomeOf：这一次算不算这条路由的账（#758）', () => {
  it('跑通了算 ok', () => {
    expect(routeOutcomeOf({ ...base, outcome: 'done', exitCode: 0 }, 'manual')).toBe('ok');
  });

  it('失败了过失败分流：路由的错（繁忙、限流）算 fail；账号池的事（额度用满、封号）、自己停的不算', () => {
    const refused = (reason: string, detail = '上游说的') => ({ ...base, facts: { reason, detail } });
    expect(routeOutcomeOf(refused('overloaded'), 'manual')).toBe('fail');
    expect(routeOutcomeOf(refused('rate_limited'), 'verify')).toBe('fail');
    expect(routeOutcomeOf(refused('quota_exhausted'), 'manual')).toBe('neutral');
    expect(routeOutcomeOf(refused('account_banned'), 'manual')).toBe('neutral');
    // 总时长到顶（one-shot 的时限兜底杀的）：分流 WT1 不算路由的错
    expect(routeOutcomeOf({ ...base, outcome: 'timeout', exitCode: null }, 'manual')).toBe('neutral');
  });

  it('【故意造出的失败】one-shot 时限强停（原文带 one-shot timeout）记 neutral；上游超时、连不上照旧 fail（#2759）', () => {
    const stop = '引擎叫停（时限到了：one-shot timeout）';
    const oneShot: OneShotResult = {
      ...base,
      outcome: 'timeout',
      exitCode: null,
      stderrTail: stop,
      failureReason: `exit=null killed=true；${stop}`,
      facts: { reason: 'aborted', detail: stop },
    };
    expect(routeOutcomeOf(oneShot, 'manual')).toBe('neutral');
    // 上游 504：状态码和 “gateway timeout” 都是 UP1，算路由的错
    expect(
      routeOutcomeOf(
        {
          ...base,
          outcome: 'failed',
          facts: { httpStatus: 504, detail: 'HTTP 504 Gateway Timeout' },
        },
        'manual',
      ),
    ).toBe('fail');
    // 连不上：ETIMEDOUT 是 NT1；只有 “connection timed out” 这句是 NT2。都算路由的错
    expect(
      routeOutcomeOf(
        {
          ...base,
          outcome: 'failed',
          facts: { reason: 'etimedout', detail: 'connect ETIMEDOUT 10.0.0.1:443' },
        },
        'manual',
      ),
    ).toBe('fail');
    expect(routeOutcomeOf({ ...base, outcome: 'failed', stderrTail: 'connection timed out' }, 'manual')).toBe(
      'fail',
    );
  });

  it('和任务工作流的失败分流对同一次失败下的结论一样（照 workflows/task.ts 的 classify 那样把证据交给分流）', () => {
    for (const result of [
      base,
      { ...base, facts: { reason: 'overloaded', detail: 'at capacity' } },
      { ...base, facts: { reason: 'quota_exhausted', resetsAt: '2026-10-02T05:00:00Z' } },
      { ...base, stderrTail: 'HTTP 529 overloaded_error' },
      { ...base, facts: { reason: 'relay_unknown', detail: '账本没读成' } },
      { ...base, outcome: 'timeout' as const, exitCode: null },
      {
        ...base,
        outcome: 'timeout' as const,
        exitCode: null,
        stderrTail: '引擎叫停（时限到了：one-shot timeout）',
        failureReason: 'exit=null killed=true；引擎叫停（时限到了：one-shot timeout）',
        facts: { reason: 'aborted', detail: '引擎叫停（时限到了：one-shot timeout）' },
      },
      { ...base, outcome: 'failed' as const, facts: { httpStatus: 504, detail: 'HTTP 504 Gateway Timeout' } },
      {
        ...base,
        outcome: 'failed' as const,
        facts: { reason: 'etimedout', detail: 'connect ETIMEDOUT 10.0.0.1:443' },
      },
    ]) {
      const e = segmentEvidence(result);
      const triaged = classifyFailure(
        triageEvidence({
          failure: {
            source: 'session:execute',
            code: e.code ?? 'failed',
            message: e.message ?? '',
            retryable: null,
          },
          limits: { retryAttempts: 3, routeSwaps: 2, modelSwaps: 1 },
          routeBound: true,
          context: {
            stage: SEGMENT_STAGE.manual,
            route: { routeId: 'r1', poolId: 'p1', modelId: 'm1', hostId: 'claude-code' },
            ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}),
            ...(e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}),
            ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
          },
        }),
      );
      expect(routeOutcomeOf(result, 'manual'), JSON.stringify(result.facts ?? result.outcome)).toBe(
        triaged.routeOutcome,
      );
    }
  });

  it('【故意造出的失败】切号停下、内存放不下没开跑、起不来、被叫停：都不算路由的错，再像路由的错的原文也不算', () => {
    // 执行体被杀时报的原因码（繁忙）不能把「我们停的」翻成路由的错
    const loud = { stderrTail: 'overloaded_error', facts: { reason: 'overloaded' } };
    for (const outcome of ['org_switch', 'admission_blocked', 'spawn_failed', 'killed'] as const) {
      expect(routeOutcomeOf({ ...base, ...loud, outcome, exitCode: null }, 'manual'), outcome).toBe(
        'neutral',
      );
    }
  });
});
