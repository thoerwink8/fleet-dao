// 分流的行为：梯子怎么往下走、次数怎么封顶、认不出的怎么办、Jev 能碰什么、路由病了和原文重复时怎么跳。全是纯函数，不出网。
import { describe, expect, it } from 'vitest';
import {
  type AttemptCounters,
  classifyFailure,
  DEFAULT_FAILURE_POLICY,
  engineClassifier,
  type FailureEvidence,
  type FailurePolicy,
  type FailureVerdict,
  type JevPort,
  type JevReply,
  NO_JEV,
  routeBreaker,
  TRIAGE_OPTIONS,
  type TriageChoice,
  triageFailure,
} from '../../src/failure/index.ts';

const NOW = '2026-09-25T00:00:00.000Z';
const session = (e: FailureEvidence): FailureEvidence => ({
  source: 'session:execute',
  routeId: 'route-a',
  now: NOW,
  ...e,
});
const UNKNOWN = session({ code: 'agent_error', message: 'something odd happened in the harness' });
const NETWORK = session({ message: 'socket hang up' });
const BANNED = session({
  message:
    'unexpected status 403: {"error":{"code":"account_banned","status":403,"message":"当前绑定账号暂不可用，系统将自动处理，请稍后重试"}}',
});

/** 按结论给计数加一、再判，直到挂起：模拟引擎反复撞同一个错。 */
function drive(evidence: FailureEvidence, policy?: Partial<FailurePolicy>, maxSteps = 30) {
  const attempts: AttemptCounters = { retries: 0, reworks: 0, routeSwaps: 0, modelSwaps: 0 };
  const verdicts: FailureVerdict[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const v = classifyFailure({ ...evidence, attempts: { ...attempts } }, policy);
    verdicts.push(v);
    if (v.action === 'park') break;
    if (v.counter) attempts[v.counter] += 1;
  }
  return { trail: verdicts.map((v) => v.action), last: verdicts.at(-1), verdicts };
}

describe('认不出的：不停下等人，也不无限重试', () => {
  it('绑路由的一步：有界重试 → 换路由 → 换模型 → 挂起并报警', () => {
    const { trail, last } = drive(UNKNOWN);
    expect(trail).toEqual(['retry', 'retry', 'swapRoute', 'swapRoute', 'swapModel', 'park']);
    expect(last?.alert).toBe(true);
    expect(last?.rule).toBe('FB');
    expect(last?.classifiedAs).toBe('unknown');
  });

  it('不绑路由的一步（开 PR、查工作流）：重试完就挂起，不去换路由', () => {
    const { trail } = drive({ source: 'openPr', message: 'something odd happened' });
    expect(trail).toEqual(['retry', 'retry', 'park']);
  });

  it('上限调大调小都封得住，退避翻倍且封顶', () => {
    const policy = { retryAttempts: 6, routeSwaps: 0, modelSwaps: 0, retryMaxSeconds: 100 };
    const { trail, verdicts } = drive(UNKNOWN, policy);
    expect(trail).toEqual(['retry', 'retry', 'retry', 'retry', 'retry', 'retry', 'park']);
    expect(verdicts.map((v) => v.delaySeconds)).toEqual([15, 30, 60, 100, 100, 100, 0]);
    expect(drive(UNKNOWN, { retryAttempts: 0, routeSwaps: 0, modelSwaps: 0 }).trail).toEqual(['park']);
  });

  it('端口说重试没用：跳过原路重试，直接换路由', () => {
    const v = classifyFailure({ ...UNKNOWN, retryable: false });
    expect(v.action).toBe('swapRoute');
    expect(v.reason).toContain('端口说重试没用');
  });

  it('没有任何原文：单独标「缺原因」，照样走兜底梯；没东西可问就不出 Jev 题', () => {
    const v = classifyFailure(session({ code: 'failed' }));
    expect(v.missingReason).toBe(true);
    expect(v.action).toBe('retry');
    expect(v.jevQuestion).toBeUndefined();
    // 只剩退出码 1 也是缺原因；别的退出码本身就说明了点什么。
    expect(classifyFailure(session({ exitCode: 1 })).missingReason).toBe(true);
    expect(classifyFailure(session({ exitCode: 2 })).missingReason).toBeUndefined();
  });

  it('认不出时出一道 Jev 题：喂全文、只让选能撤回的动作', () => {
    const long = `boom ${'x'.repeat(5000)} tail-marker`;
    const v = classifyFailure(session({ code: 'agent_error', message: long, transcriptTail: ['最后一段'] }));
    expect(v.jevQuestion?.questionId).toBe('failure-triage');
    expect(v.jevQuestion?.options).toEqual(['retry', 'swapRoute', 'swapModel', 'unclear']);
    expect(v.jevQuestion?.sample).toContain('tail-marker');
    expect(v.jevQuestion?.sample).toContain('最后一段');
    expect(TRIAGE_OPTIONS).not.toContain('park');
  });

  it('认得出的不出 Jev 题', () => {
    expect(classifyFailure(NETWORK).jevQuestion).toBeUndefined();
    expect(classifyFailure(BANNED).jevQuestion).toBeUndefined();
  });
});

describe('Jev 的回答', () => {
  const answered = (reply: JevReply<TriageChoice>) => classifyFailure({ ...UNKNOWN, jev: reply });

  it('把握够、真拦模式：按它选的那一级开始走梯子', () => {
    const v = answered({ asked: true, ok: true, choice: 'swapModel', confidence: 0.9, shadow: false });
    expect({ rule: v.rule, via: v.via, action: v.action, classifiedAs: v.classifiedAs }).toEqual({
      rule: 'JV',
      via: 'jev',
      action: 'swapModel',
      classifiedAs: 'swapModel',
    });
    expect(v.jevQuestion).toBeUndefined();
  });

  it('选的那一级次数用完，照样往下走到挂起', () => {
    const v = classifyFailure({
      ...UNKNOWN,
      attempts: { modelSwaps: 1 },
      jev: { asked: true, ok: true, choice: 'swapModel', confidence: 0.9, shadow: false },
    });
    expect(v.action).toBe('park');
  });

  it('把握低、只记不拦、没判出来、看不出、没问：都当没判，走兜底梯并写明原因', () => {
    const cases: [JevReply<TriageChoice>, string][] = [
      [{ asked: true, ok: true, choice: 'swapRoute', confidence: 0.4, shadow: false }, '把握 0.4 低于 0.7'],
      [{ asked: true, ok: true, choice: 'swapRoute', confidence: 0.95, shadow: true }, '只记不拦'],
      [{ asked: true, ok: false, reason: '超时' }, 'Jev 没判出来（超时）'],
      [{ asked: true, ok: true, choice: 'unclear', confidence: 0.9, shadow: false }, 'Jev 也看不出来'],
      [{ asked: false, reason: '没接 Jev，默认不问' }, '没问 Jev'],
    ];
    for (const [reply, why] of cases) {
      const v = answered(reply);
      expect({ rule: v.rule, action: v.action }).toEqual({ rule: 'FB', action: 'retry' });
      expect(v.reason).toContain(why);
    }
  });

  it('答了题面外的（比如 park）不算数：Jev 选不出挂起', () => {
    const v = answered({
      asked: true,
      ok: true,
      choice: 'park' as TriageChoice,
      confidence: 0.99,
      shadow: false,
    });
    expect(v.rule).toBe('FB');
    expect(v.reason).toContain('题面外');
  });

  it('规则认得出的，Jev 说什么都不改（尤其是账号池的事）', () => {
    const v = classifyFailure({
      ...BANNED,
      jev: { asked: true, ok: true, choice: 'retry', confidence: 0.99, shadow: false },
    });
    expect({ rule: v.rule, action: v.action }).toEqual({ rule: 'AU1', action: 'swapRoute' });
  });
});

describe('问 Jev 的那一步（默认不问）', () => {
  const port = (ask: JevPort['ask']): JevPort => ({ ask });

  it('默认实现不问：结论和兜底梯一样，原因里写明没问', async () => {
    const v = await triageFailure(UNKNOWN);
    expect({ rule: v.rule, action: v.action }).toEqual({ rule: 'FB', action: 'retry' });
    expect(v.reason).toContain('没接 Jev');
    expect(
      await NO_JEV.ask({
        questionId: 'failure-triage',
        prompt: '',
        options: [],
        hints: {},
        sample: '',
        confidenceFloor: 0.7,
      }),
    ).toEqual({
      asked: false,
      reason: '没接 Jev，默认不问',
    });
  });

  it('接上 Jev、它有把握：按它的走；认得出的根本不问', async () => {
    let asked = 0;
    const jev = port(async () => {
      asked += 1;
      return { asked: true, ok: true, choice: 'swapRoute', confidence: 0.9, shadow: false } as never;
    });
    expect((await triageFailure(UNKNOWN, { jev })).action).toBe('swapRoute');
    expect((await triageFailure(NETWORK, { jev })).rule).toBe('NT1');
    expect(asked).toBe(1);
  });

  it('Jev 抛错或超时：当没判出来，照样走兜底梯', async () => {
    const throwing = port(async () => {
      throw new Error('连不上');
    });
    const hanging = port(() => new Promise(() => {}));
    const a = await triageFailure(UNKNOWN, { jev: throwing });
    const b = await triageFailure(UNKNOWN, { jev: hanging, timeoutMs: 20 });
    expect([a.action, b.action]).toEqual(['retry', 'retry']);
    expect(a.reason).toContain('调用出错：连不上');
    expect(b.reason).toContain('超过 20 毫秒没回');
  });
});

describe('认得出的：按各自的梯子走', () => {
  it('网络不通：重试两次再换路由，不换模型', () => {
    const { trail, verdicts } = drive(NETWORK);
    expect(trail).toEqual(['retry', 'retry', 'swapRoute', 'swapRoute', 'park']);
    expect(verdicts.slice(0, 2).map((v) => v.delaySeconds)).toEqual([15, 30]);
    expect(verdicts[2]?.avoid).toEqual({ scope: 'route', shared: false });
  });

  it('账号被封：原文说「请稍后重试」也不在同一个池里重试；换池，所有任务避开这个池，报警', () => {
    const { trail, verdicts } = drive(BANNED);
    expect(trail).toEqual(['swapRoute', 'swapRoute', 'park']);
    expect(verdicts[0]?.avoid).toEqual({ scope: 'pool', shared: true });
    expect(verdicts.every((v) => v.alert)).toBe(true);
    expect(verdicts[0]?.reason).toBe(
      '账号被封（account_banned）：换一个账号池，这个池在处理好之前不派，并报警',
    );
  });

  it('不绑路由的一步撞上登录失效（比如推送的令牌过期）：没路可换，挂起报警', () => {
    const v = classifyFailure({ source: 'pushBranch', message: 'HTTP 401 Unauthorized' });
    expect({ rule: v.rule, action: v.action, alert: v.alert }).toEqual({
      rule: 'AU2',
      action: 'park',
      alert: true,
    });
  });

  it('额度用满：先换池，这个池避到清零；池都换过了就等到清零再试；要等太久就挂起报警', () => {
    const quota = session({ message: '拼车 5 小时额度已用完，约 20 分钟后重置' });
    const { trail, verdicts } = drive(quota);
    expect(trail).toEqual(['swapRoute', 'swapRoute', 'retry', 'retry', 'park']);
    expect(verdicts[0]?.avoid).toEqual({ scope: 'pool', shared: true, until: '2026-09-25T00:20:00.000Z' });
    expect(verdicts[2]?.delaySeconds).toBe(1200);
    expect(verdicts[2]?.counter).toBe('retries');
    expect(verdicts[0]?.alert).toBe(false);

    const weekly = classifyFailure(
      session({
        message: 'weekly limit reached',
        resetsAt: '2026-09-29T00:00:00.000Z',
        attempts: { routeSwaps: 2 },
      }),
    );
    expect(weekly.action).toBe('park');
    expect(weekly.reason).toContain('太久了');

    const unknownReset = classifyFailure(session({ code: 'quota_exhausted', attempts: { routeSwaps: 2 } }));
    expect({ action: unknownReset.action, delay: unknownReset.delaySeconds }).toEqual({
      action: 'retry',
      delay: 900,
    });
  });

  it('限流：上游给了不长的等待就原地等，没给或太长就换路由并让所有任务避开', () => {
    const short = classifyFailure(session({ message: '429 Too Many Requests', retryAfterSeconds: 30 }));
    expect({ action: short.action, delay: short.delaySeconds }).toEqual({ action: 'retry', delay: 30 });
    const none = classifyFailure(session({ message: '429 Too Many Requests' }));
    expect(none.action).toBe('swapRoute');
    expect(none.avoid).toEqual({ scope: 'route', shared: true, until: '2026-09-25T00:10:00.000Z' });
    const long = classifyFailure(session({ message: '429 Too Many Requests', retryAfterSeconds: 1800 }));
    expect(long.action).toBe('swapRoute');
    expect(long.avoid?.until).toBe('2026-09-25T00:30:00.000Z');
    expect(long.reason).toContain('不原地等');
    expect(drive(session({ message: '429 Too Many Requests', retryAfterSeconds: 30 })).trail).toEqual([
      'retry',
      'retry',
      'swapRoute',
      'swapRoute',
      'park',
    ]);
  });

  it('按分钟限流不停账号池：等一分钟，再不行换路由', () => {
    const { trail, verdicts } = drive(session({ message: '429 Quota exceeded for requests per minute' }));
    expect(trail).toEqual(['retry', 'swapRoute', 'swapRoute', 'park']);
    expect(verdicts[0]?.delaySeconds).toBe(60);
    expect(verdicts.some((v) => v.avoid?.scope === 'pool')).toBe(false);
  });

  it('命令超时被杀、进程被杀：重起一次，再来就交帅位', () => {
    expect(drive(session({ message: 'Command timed out after 10m' })).trail).toEqual(['retry', 'park']);
    expect(drive(session({ exitCode: 137 })).trail).toEqual(['retry', 'park']);
  });

  it('会话卡住：续一句、再开新会话，然后换模型', () => {
    expect(drive(session({ code: 'idle_timeout' })).trail).toEqual(['retry', 'retry', 'swapModel', 'park']);
  });

  it('返工另记一本账：基础设施的重试用光了也照样能返工；返工轮数到顶才挂起', () => {
    const conflict = session({ source: 'syncMainline', code: 'MERGE_CONFLICT', routeBound: false });
    const withInfraSpent = classifyFailure({ ...conflict, attempts: { retries: 9 } });
    expect({ action: withInfraSpent.action, counter: withInfraSpent.counter }).toEqual({
      action: 'retry',
      counter: 'reworks',
    });
    expect(drive(conflict).trail).toEqual(['retry', 'retry', 'park']);
    expect(drive(session({ code: 'not_delivered' })).trail).toEqual(['retry', 'retry', 'swapModel', 'park']);
  });
});

describe('路由健康和原文重复', () => {
  it('这条路由最近真实流量失败率到线：不在它身上原路重试，直接换路由', () => {
    const v = classifyFailure({ ...NETWORK, routeHealth: { samples: 10, failureRate: 0.7 } });
    expect(v.action).toBe('swapRoute');
    expect(v.reason).toContain('这条路由最近 10 次里失败 70%');
    // 样本不够不算病。
    expect(classifyFailure({ ...NETWORK, routeHealth: { samples: 5, failureRate: 1 } }).action).toBe('retry');
  });

  it('熔断结果里的 window 直接当路由健康传进来', () => {
    const empty = routeBreaker([], { now: NOW });
    expect(empty.window).toEqual({ samples: 0, failures: 0, failureRate: null });
    expect(classifyFailure({ ...NETWORK, routeHealth: empty.window }).action).toBe('retry');
    // 一小时前起的 8 次真实流量：成、败、败交替，没有三连败，失败 5 次（63%）。
    const minute = (n: number) => new Date(Date.parse(NOW) - (60 - n) * 60_000).toISOString();
    const results = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
      at: minute(n),
      result: n % 3 === 0 ? ('ok' as const) : ('fail' as const),
    }));
    const sick = routeBreaker(results, { now: NOW });
    expect(sick.window).toEqual({ samples: 8, failures: 5, failureRate: 0.625 });
    expect(classifyFailure({ ...NETWORK, routeHealth: sick.window }).action).toBe('swapRoute');
  });

  it('和上一次的原文一字不差：重试过一次后不再原路重试', () => {
    const again = classifyFailure({
      ...NETWORK,
      attempts: { retries: 1 },
      previousMessage: 'socket hang up',
    });
    expect(again.action).toBe('swapRoute');
    expect(again.reason).toContain('一字不差');
    // 第一次失败没有「上一次」；原文变了也照常重试。
    expect(classifyFailure({ ...NETWORK, previousMessage: 'socket hang up' }).action).toBe('retry');
    expect(
      classifyFailure({ ...NETWORK, attempts: { retries: 1 }, previousMessage: 'fetch failed' }).action,
    ).toBe('retry');
  });
});

describe('证据里的时刻读坏了', () => {
  it('分流照样给出能撤回的动作（它不能跟着失败），但原因里写明哪项没读成、按默认时长走', () => {
    const quota = { source: 'session:execute', routeId: 'route-a', message: 'weekly limit reached' };
    const badNow = classifyFailure({ ...quota, now: '昨天' });
    expect(badNow.action).toBe('swapRoute');
    expect(badNow.avoid).toEqual({ scope: 'pool', shared: true });
    expect(badNow.reason).toContain('now 认不出（昨天），不写到期时刻');

    const badReset = classifyFailure({ ...quota, now: NOW, resetsAt: 'soon' });
    expect(badReset.avoid?.until).toBe('2026-09-25T00:15:00.000Z');
    expect(badReset.reason).toContain('resetsAt 认不出（soon），按默认时长');

    const badAfter = classifyFailure(
      session({ message: '429 Too Many Requests', retryAfterSeconds: Number.NaN }),
    );
    expect(badAfter.action).toBe('swapRoute');
    expect(badAfter.reason).toContain('retryAfterSeconds 认不出（NaN）');
  });
});

describe('喂熔断：哪些算路由的失败', () => {
  it('上游、网络算；我们自己停的、断流、账号池、任务自己的问题不算', () => {
    const outcome = (e: FailureEvidence) => classifyFailure(session(e)).routeOutcome;
    expect(outcome({ message: 'socket hang up' })).toBe('fail');
    expect(outcome({ message: '503 status code (no body)' })).toBe('fail');
    expect(outcome({ code: 'interrupted' })).toBe('neutral');
    expect(outcome({ code: 'incomplete' })).toBe('neutral');
    expect(outcome({ message: 'weekly limit reached' })).toBe('neutral');
    expect(outcome({ code: 'checks-failed' })).toBe('neutral');
    expect(outcome({ code: 'agent_error', message: 'odd' })).toBe('fail');
    expect(classifyFailure({ source: 'openPr', message: 'odd' }).routeOutcome).toBe('neutral');
  });
});

describe('接引擎的兜底梯', () => {
  const classify = engineClassifier();
  const info = (code: string, message = '') => ({
    source: 'session:execute',
    code,
    message,
    retryable: null,
  });

  it('认得的回第一选择，认不出回 unknown', () => {
    expect(classify(info('agent_error', 'account_banned'))).toBe('swapRoute');
    expect(classify(info('model_not_found'))).toBe('swapModel');
    expect(classify(info('TIMEOUT_START_TO_CLOSE', 'activity StartToClose timeout'))).toBe('retry');
    expect(classify(info('TMPRL1100'))).toBe('park');
    expect(classify(info('Error', '429 Too Many Requests'))).toBe('swapRoute');
    expect(classify(info('SESSION_FAILED', 'odd'))).toBe('unknown');
  });

  it('引擎的上限对象可以直接当策略传进来', () => {
    const v = classifyFailure({ ...UNKNOWN, attempts: { retries: 3 } }, {
      retryAttempts: 5,
      maxParallel: 3,
    } as Partial<FailurePolicy>);
    expect(v.action).toBe('retry');
    expect(DEFAULT_FAILURE_POLICY.retryAttempts).toBe(2);
  });
});
