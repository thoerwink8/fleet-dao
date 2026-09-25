// 分流的行为：梯子怎么往下走、次数怎么封顶、认不出的怎么办、Jev 能碰什么、路由病了和原文重复时怎么跳。全是纯函数，不出网。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AttemptCounters,
  classifyFailure,
  DEFAULT_FAILURE_POLICY,
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
    const empty = routeBreaker([], { now: NOW, inFlight: 0 });
    expect(empty.window).toEqual({ samples: 0, failures: 0, failureRate: null });
    expect(classifyFailure({ ...NETWORK, routeHealth: empty.window }).action).toBe('retry');
    // 一小时前起的 8 次真实流量：成、败、败交替，没有三连败，失败 5 次（63%）。
    const minute = (n: number) => new Date(Date.parse(NOW) - (60 - n) * 60_000).toISOString();
    const results = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
      at: minute(n),
      result: n % 3 === 0 ? ('ok' as const) : ('fail' as const),
    }));
    const sick = routeBreaker(results, { now: NOW, inFlight: 0 });
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
  it('上游、网络、认不出的算；我们自己停的、断流、账号池、任务自己的问题、缺原因的不算', () => {
    const outcome = (e: FailureEvidence) => classifyFailure(session(e)).routeOutcome;
    expect(outcome({ message: 'socket hang up' })).toBe('fail');
    expect(outcome({ message: '503 status code (no body)' })).toBe('fail');
    expect(outcome({ code: 'agent_error', message: 'odd' })).toBe('fail');
    expect(outcome({ code: 'interrupted' })).toBe('neutral');
    expect(outcome({ code: 'incomplete' })).toBe('neutral');
    expect(outcome({ message: 'weekly limit reached' })).toBe('neutral');
    expect(outcome({ code: 'checks-failed' })).toBe('neutral');
    // 连为什么都不知道，不能拿它判一条路由坏了（errors.md 第 8 节第 11 条）。
    expect(outcome({ code: 'failed' })).toBe('neutral');
    expect(classifyFailure({ source: 'openPr', message: 'odd' }).routeOutcome).toBe('neutral');
  });
});

describe('插头没查成的：再起一个会话就可能跑两遍，只挂起报警', () => {
  const launch = (stray?: string) =>
    `起会话没查成：prompt 发出去了，没等到应答${
      stray ? `（收到过一条认不出是冲这一针来的报错：${stray}）` : ''
    }。它可能已经在跑——别重发（会烧两次额度），按工作目录和起针时间去 ~/.mirasim/sessions 对账`;
  const parked = (v: FailureVerdict | undefined) => ({
    rule: v?.rule,
    action: v?.action,
    alert: v?.alert,
    routeOutcome: v?.routeOutcome,
    counter: v?.counter,
  });

  it('起会话没查成：头一步就挂起报警，一次也不原路重派、不换路由；不记路由的失败', () => {
    const { trail, last } = drive(session({ hostId: 'mirasim', code: 'launch_unknown', message: launch() }));
    expect(trail).toEqual(['park']);
    expect(parked(last)).toEqual({
      rule: 'ST2',
      action: 'park',
      alert: true,
      routeOutcome: 'neutral',
      counter: null,
    });
    // 旧系统同一件事的原文（不带码）：起没起成同样不知道，也不重试
    const old = drive(
      session({ hostId: 'mirasim', message: '起会话没查成：没收到 prompt 的应答帧（没查成）' }),
    );
    expect(old.trail).toEqual(['park']);
    expect(parked(old.last)).toEqual({
      rule: 'ST2',
      action: 'park',
      alert: true,
      routeOutcome: 'neutral',
      counter: null,
    });
  });

  it('原话里夹着等应答时收到的别的报错：没有码时它们各归各的规则，有 launch_unknown 就压得过（尤其是繁忙 BZ1）', () => {
    const cases: [string, string][] = [
      ['Selected model is at capacity', 'BZ1'],
      ['{"type":"error","code":"overloaded_error"}', 'BZ1'],
      ['{"error":{"code":"account_banned","message":"当前绑定账号暂不可用"}}', 'AU1'],
      ['429 Too Many Requests', 'RL3'],
    ];
    for (const [stray, without] of cases) {
      const message = launch(stray);
      expect(classifyFailure(session({ hostId: 'mirasim', message })).rule).toBe(without);
      const v = classifyFailure(session({ hostId: 'mirasim', code: 'launch_unknown', message }));
      expect(parked(v)).toEqual({
        rule: 'ST2',
        action: 'park',
        alert: true,
        routeOutcome: 'neutral',
        counter: null,
      });
    }
  });

  it('中转没查成：活可能已经交了，不重跑、不换路由，挂起报警；和交付没查成（重查交付）分开', () => {
    for (const message of [
      '中转没查成：账本没读成：账本里没有这个会话的目录（可能一次上游调用都没有，也可能账本换了地方）',
      '中转没查成：没给账本目录，上游有没有真的干活核实不了',
    ]) {
      const { trail, last } = drive(session({ hostId: 'mirasim', code: 'relay_unknown', message }));
      expect(trail).toEqual(['park']);
      expect(parked(last)).toEqual({
        rule: 'DL3',
        action: 'park',
        alert: true,
        routeOutcome: 'neutral',
        counter: null,
      });
    }
    expect(classifyFailure(session({ code: 'delivery_unknown' })).action).toBe('retry');
  });

  it('测试输出里出现这两个码、旧系统那句原文（fleet-dao 自己的测试里满是）：带不带 CI 红的码都判 TS1 返工，不挂起', () => {
    // 两份真 vitest 失败输出（夹具 X60、X61）；先确认样本里真有这些字样，免得测的是空话
    const samples = JSON.parse(
      readFileSync(new URL('./fixtures/failure-samples.json', import.meta.url), 'utf8'),
    ) as { samples: { id: string; evidence: FailureEvidence }[] };
    const output = (id: string) => samples.samples.find((s) => s.id === id)?.evidence.message ?? '';
    expect(['launch_unknown', 'relay_unknown'].filter((w) => output('X60').includes(w))).toHaveLength(2);
    expect(output('X61')).toContain('没收到 prompt 的应答帧');
    for (const id of ['X60', 'X61']) {
      for (const code of ['checks_failed', 'checks-failed', undefined]) {
        const v = classifyFailure({
          source: 'waitCi',
          routeBound: false,
          ...(code ? { code } : {}),
          message: output(id),
          now: NOW,
        });
        expect({ id, code, rule: v.rule, action: v.action, counter: v.counter, alert: v.alert }).toEqual({
          id,
          code,
          rule: 'TS1',
          action: 'retry',
          counter: 'reworks',
          alert: false,
        });
      }
    }
    // 插头交来的结构化码照样认：原文里有什么都压得过
    expect(classifyFailure(session({ code: 'launch_unknown', message: output('X60') })).rule).toBe('ST2');
    expect(classifyFailure(session({ code: 'relay_unknown', message: output('X60') })).rule).toBe('DL3');
  });
});

describe('规则的边界', () => {
  it('「(not your usage limit)」是服务端临时限流，不是额度用满：换路由，不避开整个账号池', () => {
    const v = classifyFailure(
      session({ message: 'API Error: Server is temporarily limiting requests (not your usage limit)' }),
    );
    expect({ rule: v.rule, action: v.action }).toEqual({ rule: 'RL3', action: 'swapRoute' });
    expect(v.avoid?.scope).toBe('route');
    // 真用满的说法照样认成额度用满。
    expect(classifyFailure(session({ message: "You've reached your 5-hour usage limit" })).rule).toBe('QT1');
  });

  it('GitHub 的限流、校验失败、没权限只认不是会话的步骤；AI 渠道报同样的字按它自己的事处置', () => {
    const inSession = classifyFailure(session({ message: 'API rate limit exceeded' }));
    expect({ rule: inSession.rule, action: inSession.action }).toEqual({ rule: 'RL3', action: 'swapRoute' });
    const onGithub = classifyFailure({ source: 'openPr', message: 'API rate limit exceeded' });
    expect({ rule: onGithub.rule, action: onGithub.action }).toEqual({ rule: 'RL2', action: 'retry' });
    expect(classifyFailure(session({ message: 'HTTP 422: Validation Failed' })).rule).not.toBe('GH1');
    expect(classifyFailure(session({ message: 'Resource not accessible by integration' })).rule).not.toBe(
      'GH2',
    );
  });

  it('原文里带个 /login 的网址不算登录失效：不能因此停掉整个账号池', () => {
    const v = classifyFailure(
      session({ message: 'upstream error, see https://status.example.com/login for details' }),
    );
    expect(v.rule).not.toBe('AU2');
    expect(v.avoid?.scope).not.toBe('pool');
    expect(classifyFailure(session({ message: 'Not logged in · Please run /login' })).rule).toBe('AU2');
  });

  it('模型不存在：只这个任务换模型、报警；不让所有任务一起避开这个模型，这条路由的失败记进熔断', () => {
    const v = classifyFailure(session({ code: 'model_not_found' }));
    expect({ action: v.action, alert: v.alert, routeOutcome: v.routeOutcome }).toEqual({
      action: 'swapModel',
      alert: true,
      routeOutcome: 'fail',
    });
    expect(v.avoid).toEqual({ scope: 'model', shared: false });
  });
});

describe('策略参数', () => {
  it('引擎的上限对象可以直接当策略传进来（多出来的字段不管）', () => {
    const v = classifyFailure({ ...UNKNOWN, attempts: { retries: 3 } }, {
      retryAttempts: 5,
      maxParallel: 3,
    } as Partial<FailurePolicy>);
    expect(v.action).toBe('retry');
    expect(DEFAULT_FAILURE_POLICY.retryAttempts).toBe(2);
  });

  it('给了但不对的报错，不悄悄换成默认值；梯子上的次数可以是 0', () => {
    const bad: [Partial<FailurePolicy>, string][] = [
      [{ retryAttempts: -1 }, '失败分流策略的 retryAttempts 不对：要不小于 0 的整数，给的是 -1'],
      [{ routeSwaps: 1.5 }, 'routeSwaps 不对：要不小于 0 的整数'],
      [{ sickRouteMinSamples: 0 }, 'sickRouteMinSamples 不对：要不小于 1 的整数'],
      [{ sickRouteFailureRate: 1.2 }, 'sickRouteFailureRate 不对：要在 0 到 1 之间（不含 0）'],
      [{ jevConfidenceFloor: Number.NaN }, 'jevConfidenceFloor 不对：要在 0 到 1 之间'],
    ];
    for (const [policy, message] of bad) expect(() => classifyFailure(UNKNOWN, policy)).toThrow(message);
    expect(classifyFailure(UNKNOWN, { retryAttempts: 0 }).action).toBe('swapRoute');
  });
});
