// 分流的行为（#1072 瘦身后）：先认是哪一种打断原因，再按这一种的处置办（classify.ts 顶上那张表）——次数怎么封顶、最长等待怎么封顶、
// 认不出的怎么办、原文重复怎么停。全是纯函数，不出网。
// 瘦身前每条规则各有一套梯子（重试 → 换路由 → 换模型 → 挂起，还有避开多久、记哪本账），行为钉在 samples.test.ts 的 150 条真实样本上：
// 认出的规则、报警、算不算路由的失败一条没变，变的只有「换路由、换模型」那一级没了。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AttemptCounters,
  classifyFailure,
  DEFAULT_FAILURE_POLICY,
  type FailureEvidence,
  type FailurePolicy,
  type FailureVerdict,
  isUpstreamBlip,
  RULES,
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

describe('处置表：每一种打断原因怎么办、上限在哪', () => {
  it('每条规则都归五种之一；动作只有 retry、park，以及账号池停机时的换路由', () => {
    const kinds = new Set(RULES.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['resume', 'retry', 'rework', 'stop', 'wait']);
    const samples = JSON.parse(
      readFileSync(new URL('./fixtures/failure-samples.json', import.meta.url), 'utf8'),
    ) as { samples: { evidence: FailureEvidence }[] };
    const actions = new Set(
      samples.samples.map(
        (s) => classifyFailure({ source: 'session:execute', now: NOW, ...s.evidence }).action,
      ),
    );
    // 登录失效、封号、设备被撤销（AU1、AU2、DV1）绑了路由就换路由，不挂起这张单。别的规则仍只有 retry 和 park。
    expect([...actions].sort()).toEqual(['park', 'retry', 'swapRoute']);
  });

  it('retry 临时的（网络、上游出错、进程被杀……）：绑路由的原路重试两次，1 分钟起翻倍（决定 0093），再来就停下报警', () => {
    const { trail, verdicts, last } = drive(NETWORK);
    expect(trail).toEqual(['retry', 'retry', 'park']);
    expect(verdicts.slice(0, 2).map((v) => v.delaySeconds)).toEqual([60, 120]);
    expect(verdicts[0]?.cooldown).toEqual({ tier: 'other', by: 'backoff' });
    // 不绑路由的（开 PR、推分支）仍从 15 秒起
    const off = drive({ source: 'openPr', message: 'socket hang up' });
    expect(off.verdicts.slice(0, 2).map((v) => v.delaySeconds)).toEqual([15, 30]);
    expect(last?.alert).toBe(true);
    expect(last?.reason).toContain('已重试 2 次');
  });

  it('retry 里规则自己写了只试一次的（命令超时被杀、进程被杀、会话起不来）：重起一次，再来就停', () => {
    expect(drive(session({ message: 'Command timed out after 10m' })).trail).toEqual(['retry', 'park']);
    expect(drive(session({ exitCode: 137 })).trail).toEqual(['retry', 'park']);
    const { trail, verdicts } = drive(session({ code: 'SPAWN_TIMEOUT', message: '等了 45 秒进程还没起来' }));
    expect(trail).toEqual(['retry', 'park']);
    expect(verdicts.every((v) => v.rule === 'ST1')).toBe(true);
  });

  it('活动超时原文一字不差：引擎换过进程就原路续；没换过分流仍判挂起（#2710 就是这句）', () => {
    const restarted = session({
      code: 'timeout_start_to_close',
      message: 'activity StartToClose timeout',
      activity: 'runSegment',
      startToCloseSeconds: 4500,
      engineStartedAt: '2026-10-16T12:00:00.000Z',
      currentEngineStartedAt: '2026-10-16T12:01:00.000Z',
      engineRestarted: true,
      attempts: { retries: 1 },
      previousMessage: 'activity StartToClose timeout',
    });
    const resumed = classifyFailure(restarted);
    expect(resumed).toMatchObject({ rule: 'EN1', action: 'retry', resumeSame: true, alert: false });
    expect(resumed.reason).toContain('活动 runSegment');
    expect(resumed.reason).toContain('startToClose 75 分钟');
    expect(resumed.reason).toContain('引擎进程换过');

    const realTimeout = classifyFailure({
      ...restarted,
      engineRestarted: false,
      currentEngineStartedAt: '2026-10-16T12:00:00.000Z',
    });
    expect(realTimeout).toMatchObject({ rule: 'EN1', action: 'park', alert: true });
    // #2710 的 doing 就是这句：分流把可重试的 timeout_start_to_close 当成「原路再试不会变」。
    // 不是发版叫停（KL3 / #2797）、不是 Mirasim 接回（#2815）、不是 model_mismatch（MD3 / #2811，分流仍判停下，动手会话另按点名重派）。
    // 动手会话见到这个 park 不挂整单，停掉这一段按点名路由重派（task-session.ts，patched en1-timeout-redispatch）。
    expect(realTimeout.reason).toContain('引擎这边丢了这一步（timeout_start_to_close）');
    expect(realTimeout.reason).toContain('挂起并报警');
    expect(realTimeout.reason).toContain('和上一次的原文一字不差，原路再试不会变');
  });

  it('桥接连 Mirasim 超时：分流仍重试一次再挂起（#2710/#2742 的那句）', () => {
    const message = '没起来：桥接连 Mirasim 超时（100 秒）';
    const { trail, verdicts } = drive(session({ code: 'spawn_failed', message }));
    expect(trail).toEqual(['retry', 'park']);
    expect(verdicts.every((v) => v.rule === 'MB1')).toBe(true);
    // 第二次原文略有差别，凑不成「一字不差」，落到 maxRetries：这就是库里那句 last_problem。
    // 归类是「可重试的桥接连接超时被判成挂起」，不是探针离线（#2703）、不是引擎停时接回（#2815）、
    // 不是 timeout_start_to_close（#2824 / EN1）、不是 model_mismatch（#2811 / MD3）。
    // 动手会话不拿这个 park 挂整单（task-session.ts，patched mb1-bridge-redispatch）。
    const parked = classifyFailure(
      session({
        code: 'spawn_failed',
        message,
        attempts: { retries: 1 },
        previousMessage: '没起来：桥接连 Mirasim 超时（90 秒）',
      }),
    );
    expect(parked).toMatchObject({ rule: 'MB1', action: 'park', alert: true });
    expect(parked.reason).toBe('桥接连 Mirasim 超时（桥接连 Mirasim 超时）：挂起并报警（已重试 1 次）');
    // 码不是 spawn_failed 也认这句：认的是原文，不是起不来那个码。
    expect(classifyFailure(session({ code: 'failed', message })).rule).toBe('MB1');
  });

  it('retry 认不出的：同样按临时的办，不无限重试；绑不绑路由都一样', () => {
    const { trail, last } = drive(UNKNOWN);
    expect(trail).toEqual(['retry', 'retry', 'park']);
    expect(last).toMatchObject({ alert: true, rule: 'FB', classifiedAs: 'unknown' });
    expect(drive({ source: 'openPr', message: 'something odd happened' }).trail).toEqual([
      'retry',
      'retry',
      'park',
    ]);
  });

  it('上限调大调小都封得住，退避翻倍且封顶', () => {
    const { trail, verdicts } = drive(UNKNOWN, { retryAttempts: 6, retryMaxSeconds: 100 });
    expect(trail).toEqual(['retry', 'retry', 'retry', 'retry', 'retry', 'retry', 'park']);
    expect(verdicts.map((v) => v.delaySeconds)).toEqual([60, 100, 100, 100, 100, 100, 0]);
    const slow = drive(UNKNOWN, { retryAttempts: 6, routeRetryBaseSeconds: 15, retryMaxSeconds: 100 });
    expect(slow.verdicts.map((v) => v.delaySeconds)).toEqual([15, 30, 60, 100, 100, 100, 0]);
    expect(drive(UNKNOWN, { retryAttempts: 0 }).trail).toEqual(['park']);
  });

  it('端口说重试没用（只对认不出的）：不重试，直接停下报警', () => {
    const v = classifyFailure({ ...UNKNOWN, retryable: false });
    expect(v.action).toBe('park');
    expect(v.reason).toContain('端口说重试没用');
  });

  it('没有任何原文：单独标「缺原因」，照样按临时的办', () => {
    const v = classifyFailure(session({ code: 'failed' }));
    expect(v.missingReason).toBe(true);
    expect(v.action).toBe('retry');
    // 只剩退出码 1 也是缺原因；别的退出码本身就说明了点什么。
    expect(classifyFailure(session({ exitCode: 1 })).missingReason).toBe(true);
    expect(classifyFailure(session({ exitCode: 2 })).missingReason).toBeUndefined();
  });

  it('rework 返工（测试红、合并冲突、没交付）：退回会话去改，另记一本账，轮数到顶才停', () => {
    const conflict = session({ source: 'syncMainline', code: 'MERGE_CONFLICT', routeBound: false });
    // 基础设施的重试用光了也照样能返工
    const spent = classifyFailure({ ...conflict, attempts: { retries: 9 } });
    expect({ action: spent.action, counter: spent.counter }).toEqual({ action: 'retry', counter: 'reworks' });
    expect(drive(conflict).trail).toEqual(['retry', 'retry', 'park']);
    expect(drive(session({ code: 'not_delivered' })).trail).toEqual(['retry', 'retry', 'park']);
    expect(drive(session({ code: 'checks-failed' }), { reworkRounds: 3 }).trail).toEqual([
      'retry',
      'retry',
      'retry',
      'park',
    ]);
  });

  it('wait 额度用满（不是 Claude 订阅池）：等到上游给的清零时刻、续同一个会话；等过两次还满就停；等太久（周限）直接停', () => {
    const quota = session({ message: '5 小时额度已用完，约 20 分钟后重置' });
    const { trail, verdicts } = drive(quota);
    expect(trail).toEqual(['retry', 'retry', 'park']);
    expect(verdicts[0]).toMatchObject({
      delaySeconds: 1200,
      counter: 'retries',
      wait: 'quota',
      resumeSame: true,
      alert: false,
    });
    const weekly = classifyFailure(
      session({ message: 'weekly limit reached', resetsAt: '2026-09-29T00:00:00.000Z' }),
    );
    expect(weekly.action).toBe('park');
    expect(weekly.reason).toContain('超过最长等待');
    // 上游没说几点清零：按默认 15 分钟起翻倍
    const unknownReset = classifyFailure(session({ code: 'quota_exhausted' }));
    expect({ action: unknownReset.action, delay: unknownReset.delaySeconds }).toEqual({
      action: 'retry',
      delay: 900,
    });
    // 最长等待可调
    expect(classifyFailure(quota, { waitMaxSeconds: 600 }).action).toBe('park');
  });

  it('wait 额度用满（Claude 订阅池，#59）：不原地睡到清零，马上回去选路、续同一个会话等这条路由；切了号选路就换池接着干', () => {
    for (const orgKind of ['carpool', 'solo'] as const) {
      const quota = session({ message: '拼车 5 小时额度已用完，约 20 分钟后重置', orgKind });
      const { trail, verdicts } = drive(quota);
      // 回去选路也记重试的账：同一步反复被拒（切回去又被拒）有个头
      expect(trail).toEqual(['retry', 'retry', 'park']);
      expect(verdicts[0]).toMatchObject({
        action: 'retry',
        delaySeconds: 0,
        counter: 'retries',
        wait: 'quota',
        resumeSame: true,
        alert: false,
      });
      expect(verdicts[0]?.reason).toContain('不原地睡到清零，回去选路等');
      expect(verdicts[0]?.reason).toContain('约 20 分钟后清零');
    }
    // 要等太久（周限）和普通的一样直接停
    const weekly = classifyFailure(
      session({ message: 'weekly limit reached', resetsAt: '2026-09-29T00:00:00.000Z', orgKind: 'carpool' }),
    );
    expect(weekly.action).toBe('park');
    expect(weekly.reason).toContain('超过最长等待');
  });

  it('wait 限流、繁忙：上游给了时间就等那么久，没给按默认起翻倍；次数用完停；原文重复不改这条（上游自己给了时间）', () => {
    const given = classifyFailure(session({ message: '429 Too Many Requests', retryAfterSeconds: 30 }));
    expect({ rule: given.rule, action: given.action, delay: given.delaySeconds, wait: given.wait }).toEqual({
      rule: 'RL3',
      action: 'retry',
      delay: 30,
      wait: 'upstream',
    });
    expect(classifyFailure(session({ message: '429 Too Many Requests' })).delaySeconds).toBe(60);
    expect(drive(session({ message: '429 Too Many Requests', retryAfterSeconds: 30 })).trail).toEqual([
      'retry',
      'retry',
      'park',
    ]);
    // 按分钟限流只等一次
    const rpm = drive(session({ message: '429 Quota exceeded for requests per minute' }));
    expect(rpm.trail).toEqual(['retry', 'park']);
    expect(rpm.verdicts[0]?.delaySeconds).toBe(60);
    // 路由繁忙
    expect(classifyFailure(session({ message: 'Selected model is at capacity' })).rule).toBe('BZ1');
    expect(drive(session({ message: 'Selected model is at capacity' })).trail).toEqual([
      'retry',
      'retry',
      'park',
    ]);
    const repeat = classifyFailure(
      session({
        message: '429 Too Many Requests',
        attempts: { retries: 1 },
        previousMessage: '429 Too Many Requests',
      }),
    );
    expect(repeat.action).toBe('retry');
  });

  it('stop 只有人能修的：封号整池暂停并报警，这张单回去选路避开这个池；余额不够、配置不对仍挂起；不绑路由的登录失效仍挂起', () => {
    const banned = classifyFailure(BANNED);
    expect(banned).toMatchObject({
      action: 'swapRoute',
      rule: 'AU1',
      alert: true,
      routeOutcome: 'neutral',
      authReroute: 'pool',
      resumeSame: false,
    });
    expect(banned.shared).toEqual({ scope: 'pool', shared: true });
    expect(banned.reason).toContain('整池暂停，回去选路避开这个池');
    expect(banned.reason).toContain('并报警');
    // 路由自己的问题（配置不对、模型不存在）：停下报警，这条路由的失败记进熔断，不让整池暂停
    const model = classifyFailure(session({ code: 'model_not_found' }));
    expect({ action: model.action, alert: model.alert, routeOutcome: model.routeOutcome }).toEqual({
      action: 'park',
      alert: true,
      routeOutcome: 'fail',
    });
    expect(model.shared).toBeUndefined();
    // 不绑路由的一步撞上登录失效（比如推送的令牌过期）
    const v = classifyFailure({ source: 'pushBranch', message: 'HTTP 401 Unauthorized' });
    expect({ rule: v.rule, action: v.action, alert: v.alert }).toEqual({
      rule: 'AU2',
      action: 'park',
      alert: true,
    });
  });

  it('stop 设备被撤销（401 device_revoked）单独一类：不当额度用满、不当封号；停下等人重新登录，写清去哪台机器以谁的身份登录', () => {
    const revoked = session({
      code: 'agent_error',
      message: 'API Error: 401 device_revoked',
      poolId: 'claude-carpool',
      machine: '法国',
      runAsUser: 'fleet-agent-carpool',
    });
    const v = classifyFailure(revoked);
    expect({
      rule: v.rule,
      action: v.action,
      alert: v.alert,
      resumeSame: v.resumeSame,
      authReroute: v.authReroute,
    }).toEqual({
      rule: 'DV1',
      action: 'swapRoute',
      alert: true,
      resumeSame: false,
      authReroute: 'pool',
    });
    expect(v.shared).toEqual({ scope: 'pool', shared: true });
    expect(v.humanFix).toBe(
      '在「法国」上以会话用户 fleet-agent-carpool 重跑 reclaude login，按登录流程在浏览器里批准；然后在驾驶舱点「继续」',
    );
    expect(v.reason).toContain('整池暂停，回去选路避开这个池');
    expect(v.reason).toContain('要人：在「法国」上以会话用户 fleet-agent-carpool 重跑 reclaude login');
    // 机器、会话用户没报：写明没报，不瞎猜。
    expect(classifyFailure(session({ message: '401 device_revoked' })).humanFix).toBe(
      '在机器（没报）上以会话用户（没报）重跑 reclaude login，按登录流程在浏览器里批准；然后在驾驶舱点「继续」',
    );
    expect(
      classifyFailure(
        session({ message: 'API Error: 400 此设备已被解绑，请在终端重新运行 reclaude 完成登录' }),
      ).rule,
    ).toBe('DV1');
    expect(classifyFailure(session({ message: 'Not logged in · Please run /login' })).rule).toBe('AU2');
    expect(classifyFailure(BANNED).rule).toBe('AU1');
  });

  it('只凭 HTTP 401：第一次换路由、不暂停整池；同一个池第二次才整池暂停。明确的登录失效第一次就停池', () => {
    const bare = session({ code: 'agent_error', message: 'HTTP 401 Unauthorized', httpStatus: 401 });
    const once = classifyFailure(bare);
    expect(once).toMatchObject({
      action: 'swapRoute',
      rule: 'AU2',
      authReroute: 'route',
      alert: false,
      resumeSame: false,
    });
    expect(once.shared).toBeUndefined();
    expect(once.reason).toContain('第一次 401');
    expect(once.reason).not.toContain('并报警');
    const twice = classifyFailure({ ...bare, priorBare401: true });
    expect(twice).toMatchObject({
      action: 'swapRoute',
      rule: 'AU2',
      authReroute: 'pool',
      alert: true,
    });
    expect(twice.shared).toEqual({ scope: 'pool', shared: true });
    expect(twice.reason).toContain('第二次 401');
    expect(twice.reason).toContain('整池暂停');
    const explicit = classifyFailure(session({ message: 'Not logged in · Please run /login' }));
    expect(explicit).toMatchObject({ action: 'swapRoute', authReroute: 'pool', alert: true, rule: 'AU2' });
    expect(explicit.reason).not.toContain('第一次 401');
    const cursor = classifyFailure(session({ message: 'Your authentication is invalid.' }));
    expect(cursor).toMatchObject({ action: 'park', rule: 'AU5', alert: true });
    expect(cursor.authReroute).toBeUndefined();
  });

  it('只给结构化 httpStatus=401、原文没有登录语义：也按第一次临时失败换路由，第二次才停池', () => {
    const structured = session({
      code: 'agent_error',
      message: '上游返回了未注明原因的认证响应',
      httpStatus: 401,
    });
    expect(classifyFailure(structured)).toMatchObject({
      action: 'swapRoute',
      rule: 'AU2',
      authReroute: 'route',
      alert: false,
    });
    expect(classifyFailure({ ...structured, priorBare401: true })).toMatchObject({
      action: 'swapRoute',
      rule: 'AU2',
      authReroute: 'pool',
      alert: true,
    });
  });

  it('rework 卫生检查拦下了要公开的内容：退回会话去掉再交；同一处连续被拦两次就停；卫生检查没扫成不推、直接停', () => {
    const spots = '卫生检查拦下了要公开的内容：config/app.env:3 github-token';
    const blocked = (over: FailureEvidence = {}) =>
      classifyFailure({
        source: 'pushBranch',
        routeBound: false,
        code: 'HYGIENE_BLOCKED',
        retryable: false,
        message: spots,
        now: NOW,
        ...over,
      });
    // 端口说不可重试也照样退回会话：退回会话不是「原样再推一次」。
    expect(blocked()).toMatchObject({ rule: 'HY1', action: 'retry', counter: 'reworks', delaySeconds: 0 });
    expect(
      blocked({ attempts: { reworks: 1 }, previousMessage: '卫生检查拦下了要公开的内容：src/a.ts:9 email' })
        .action,
    ).toBe('retry');
    const again = blocked({ attempts: { reworks: 1 }, previousMessage: spots });
    expect({ action: again.action, alert: again.alert }).toEqual({ action: 'park', alert: true });
    expect(again.reason).toContain('一字不差');
    expect(blocked({ attempts: { reworks: 2 } }).action).toBe('park');
    // 码只认结构化的 code 字段：测试输出里带着这个词不算。
    expect(classifyFailure(session({ message: 'expected HYGIENE_BLOCKED to be thrown' })).rule).not.toBe(
      'HY1',
    );

    const unscanned = classifyFailure({
      source: 'pushBranch',
      routeBound: false,
      code: 'HYGIENE_UNSCANNED',
      retryable: false,
      message: '推之前的卫生检查没扫成：要推的 1a2b3c4 不在扫过的提交里',
      now: NOW,
    });
    expect({ rule: unscanned.rule, action: unscanned.action, alert: unscanned.alert }).toEqual({
      rule: 'HY2',
      action: 'park',
      alert: true,
    });
  });
});

describe('同一个原文再犯：重试不会变，直接停', () => {
  it('和上一次的原文一字不差：重试过一次后不再原路重试，直接停下报警', () => {
    const again = classifyFailure({
      ...NETWORK,
      attempts: { retries: 1 },
      previousMessage: 'socket hang up',
    });
    expect(again.action).toBe('park');
    expect(again.reason).toContain('一字不差');
    // 第一次失败没有「上一次」；原文变了也照常重试。
    expect(classifyFailure({ ...NETWORK, previousMessage: 'socket hang up' }).action).toBe('retry');
    expect(
      classifyFailure({ ...NETWORK, attempts: { retries: 1 }, previousMessage: 'fetch failed' }).action,
    ).toBe('retry');
  });
});

describe('GitHub 写操作的幂等占用还在（IN_FLIGHT，#1971 卡了 8 小时）', () => {
  // 法国 2026-10-12 16:14:09Z 原样：开 PR 第一下没收到回执（fetch failed），幂等键留在「写到一半」；之后每次都撞同一句，
  // 占用要 2 分钟（packages/github 的 CLAIM_STALE_AFTER_MS）没续才过期、才能接过来重写。
  const MESSAGE =
    '同一个写操作（github.open_pr thoerwink8/fleet-dao:fleet/1971-t01a1307a）别处正在做，稍后重试';
  const IN_FLIGHT: FailureEvidence = {
    source: 'openPr',
    routeBound: false,
    code: 'IN_FLIGHT',
    retryable: true,
    message: MESSAGE,
    now: NOW,
  };

  it('不当成「认不出、原文一字不差」停下：等过占用过期（超过 2 分钟）再来，第二次照样等', () => {
    const first = classifyFailure(IN_FLIGHT);
    expect(first).toMatchObject({ action: 'retry', rule: 'GH3', alert: false, routeOutcome: 'neutral' });
    expect(first.delaySeconds).toBeGreaterThan(120);
    // 第二次原文一字不差：以前在这里就挂起了（15 秒退避根本等不到占用过期）
    const second = classifyFailure({ ...IN_FLIGHT, attempts: { retries: 1 }, previousMessage: MESSAGE });
    expect(second.action).toBe('retry');
    expect(second.delaySeconds).toBeGreaterThan(120);
  });

  it('等的次数有上限：等满还撞就停下报警，写明等过几次', () => {
    const { trail, last } = drive(IN_FLIGHT);
    expect(trail).toEqual(['retry', 'retry', 'park']);
    expect(last?.reason).toContain('已等过 2 次');
  });

  it('【故意造出的失败】只认端口交来的结构化码：原文里提到 IN_FLIGHT 不算', () => {
    const v = classifyFailure({ source: 'openPr', routeBound: false, message: '测试输出里有一行 IN_FLIGHT' });
    expect(v.rule).not.toBe('GH3');
  });
});

describe('resume 切号停下的（org_switch，#59）和发布排空', () => {
  const SWITCH_MESSAGE = '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干';
  const SWITCH = session({ code: 'org_switch', retryable: true, message: SWITCH_MESSAGE });

  it('马上续同一个会话：不算失败、不进路由失败率、不记重试的账', () => {
    const v = classifyFailure(SWITCH);
    expect(v).toMatchObject({
      action: 'retry',
      delaySeconds: 0,
      rule: 'OS1',
      counter: null,
      resumeSame: true,
      routeOutcome: 'neutral',
      alert: false,
    });
    expect(v.reason).toContain('马上接着干（不算重试）');
  });

  it('切几次续几次：重试次数用光了、原文和上一次一字不差，照样续，不停下', () => {
    const { trail } = drive(SWITCH, undefined, 10);
    expect(trail).toEqual(Array.from({ length: 10 }, () => 'retry'));
    const v = classifyFailure({ ...SWITCH, attempts: { retries: 99 }, previousMessage: SWITCH_MESSAGE });
    expect(v).toMatchObject({ action: 'retry', counter: null });
  });

  it('引擎为发布排空（engine_stopping）、要发新版本先停下（engine_stop）：同样马上续，不记账', () => {
    for (const [code, rule] of [
      ['engine_stopping', 'ES1'],
      ['engine_stop', 'KL3'],
    ] as const) {
      const v = classifyFailure(session({ code, retryable: true, message: '引擎在停' }));
      expect({ rule: v.rule, action: v.action, counter: v.counter, alert: v.alert }).toEqual({
        rule,
        action: 'retry',
        counter: null,
        alert: false,
      });
    }
  });

  it('【故意造出的失败】只认插头交来的结构化码：原文里提到 org_switch 不算', () => {
    const v = classifyFailure(session({ code: 'agent_error', message: 'grep org_switch in the logs' }));
    expect(v.rule).not.toBe('OS1');
  });
});

describe('Mirasim 服务重启把正在跑的会话杀掉（#2186）', () => {
  const MESSAGE =
    '会话结束，没有终帧：读状态的连接建不起来：/home/u/.mirasim/run 下没有 local-<端口>.token：这个会话用户还没单独起一份 Mirasim 服务';
  const evidence = session({ code: 'no_result', message: MESSAGE });

  it('认成可重试的续跑，不落到认不出', () => {
    const v = classifyFailure(evidence);
    expect(v).toMatchObject({
      action: 'retry',
      rule: 'MR1',
      delaySeconds: 0,
      counter: null,
      resumeSame: true,
      routeOutcome: 'neutral',
      alert: false,
    });
    expect(v.reason).toContain('马上接着干');
  });

  it('原文和上一次一字不差：照样续，不因「认不出」挂起', () => {
    const again = classifyFailure({
      ...evidence,
      attempts: { retries: 1 },
      previousMessage: MESSAGE,
    });
    expect(again).toMatchObject({ action: 'retry', rule: 'MR1', counter: null, alert: false });
    const { trail } = drive(evidence, undefined, 5);
    expect(trail).toEqual(['retry', 'retry', 'retry', 'retry', 'retry']);
  });

  it('服务从没起来（没有「读状态的连接建不起来」）：不按这次被杀来续', () => {
    const never = classifyFailure(
      session({
        message:
          '没起来：/home/u/.mirasim/run 下没有 local-<端口>.token：这个会话用户还没单独起一份 Mirasim 服务',
      }),
    );
    expect(never.rule).not.toBe('MR1');
  });
});

describe('证据里的时刻读坏了', () => {
  it('分流照样给出动作（它不能跟着失败），但原因里写明哪项没读成、按默认时长走', () => {
    const quota = { source: 'session:execute', routeId: 'route-a', message: 'weekly limit reached' };
    const badNow = classifyFailure({ ...quota, now: '昨天' });
    expect(badNow.action).toBe('retry');
    expect(badNow.reason).toContain('now 认不出（昨天），不写到期时刻');

    const badReset = classifyFailure({ ...quota, now: NOW, resetsAt: 'soon' });
    expect(badReset.action).toBe('retry');
    expect(badReset.delaySeconds).toBe(900);
    expect(badReset.reason).toContain('resetsAt 认不出（soon），按默认时长');

    const badAfter = classifyFailure(
      session({ message: '429 Too Many Requests', retryAfterSeconds: Number.NaN }),
    );
    expect(badAfter.action).toBe('retry');
    expect(badAfter.delaySeconds).toBe(60);
    expect(badAfter.reason).toContain('retryAfterSeconds 认不出（NaN）');
  });
});

describe('喂熔断：哪些算路由的失败', () => {
  it('上游、网络、认不出的算；我们自己停的、断流、账号池、任务自己的问题、缺原因的不算', () => {
    const outcome = (e: FailureEvidence) => classifyFailure(session(e)).routeOutcome;
    expect(outcome({ message: 'socket hang up' })).toBe('fail');
    expect(outcome({ message: '503 status code (no body)' })).toBe('fail');
    expect(outcome({ code: 'agent_error', message: 'odd' })).toBe('fail');
    // one-shot 到点强停（#2759）：原文里的 timeout 是我们的时限，不算路由的错。上游超时照旧算。
    expect(outcome({ code: 'wall_clock_timeout', message: '引擎叫停（时限到了：one-shot timeout）' })).toBe(
      'neutral',
    );
    expect(outcome({ httpStatus: 504, message: 'HTTP 504 Gateway Timeout' })).toBe('fail');
    expect(outcome({ message: 'connect ETIMEDOUT 10.0.0.1:443' })).toBe('fail');
    expect(outcome({ message: 'connection timed out' })).toBe('fail');
    expect(outcome({ code: 'interrupted' })).toBe('neutral');
    expect(outcome({ code: 'incomplete' })).toBe('neutral');
    expect(outcome({ message: 'weekly limit reached' })).toBe('neutral');
    expect(outcome({ code: 'checks-failed' })).toBe('neutral');
    // 连为什么都不知道，不能拿它判一条路由坏了（errors.md 第 8 节第 11 条）。
    expect(outcome({ code: 'failed' })).toBe('neutral');
    expect(classifyFailure({ source: 'openPr', message: 'odd' }).routeOutcome).toBe('neutral');
  });
});

describe('插头没查成的：再起一个会话就可能跑两遍，只停下报警', () => {
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

  it('起会话没查成：头一步就停下报警，一次也不原路重派；不记路由的失败', () => {
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
    expect(old.last?.rule).toBe('ST2');
  });

  it('原话里夹着等应答时收到的别的报错：没有码时它们各归各的规则，有 launch_unknown 就压得过', () => {
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

  it('中转没查成：活可能已经交了，不重跑，停下报警；和交付没查成（重查交付）分开', () => {
    for (const message of [
      '中转没查成：账本没读成：账本里没有这个会话的目录（可能一次上游调用都没有，也可能账本换了地方）',
      '中转没查成：没给账本目录，上游有没有真的干活核实不了',
    ]) {
      const { trail, last } = drive(session({ hostId: 'mirasim', code: 'relay_unknown', message }));
      expect(trail).toEqual(['park']);
      expect(parked(last).rule).toBe('DL3');
    }
    expect(classifyFailure(session({ code: 'delivery_unknown' })).action).toBe('retry');
  });

  it('测试输出里出现这两个码、旧系统那句原文（fleet-dao 自己的测试里满是）：带不带 CI 红的码都判 TS1 返工，不停下', () => {
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
    expect(classifyFailure(session({ code: 'launch_unknown', message: output('X60') })).rule).toBe('ST2');
    expect(classifyFailure(session({ code: 'relay_unknown', message: output('X60') })).rule).toBe('DL3');
  });
});

describe('规则的边界', () => {
  it('「(not your usage limit)」是服务端临时限流，不是额度用满：等一等，不当额度', () => {
    const v = classifyFailure(
      session({ message: 'API Error: Server is temporarily limiting requests (not your usage limit)' }),
    );
    expect({ rule: v.rule, action: v.action, wait: v.wait }).toEqual({
      rule: 'RL3',
      action: 'retry',
      wait: 'upstream',
    });
    // 真用满的说法照样认成额度用满。
    expect(classifyFailure(session({ message: "You've reached your 5-hour usage limit" })).rule).toBe('QT1');
    expect(classifyFailure(session({ message: "You've hit your limit · resets 3pm" })).rule).toBe('QT1');
  });

  it('GitHub 的限流、校验失败、没权限只认不是会话的步骤；AI 渠道报同样的字按它自己的事处置', () => {
    const inSession = classifyFailure(session({ message: 'API rate limit exceeded' }));
    expect(inSession.rule).toBe('RL3');
    const onGithub = classifyFailure({ source: 'openPr', message: 'API rate limit exceeded' });
    expect({ rule: onGithub.rule, action: onGithub.action }).toEqual({ rule: 'RL2', action: 'retry' });
    expect(classifyFailure(session({ message: 'HTTP 422: Validation Failed' })).rule).not.toBe('GH1');
    expect(classifyFailure(session({ message: 'Resource not accessible by integration' })).rule).not.toBe(
      'GH2',
    );
  });

  it('上游临时故障标在规则表上：容量满、503、429、连接被重置是 blip；额度用满不是', () => {
    expect(classifyFailure(session({ message: 'Selected model is at capacity' })).rule).toBe('BZ1');
    expect(
      classifyFailure(session({ message: 'gpt-6.1-sol 当前容量已满（503 Service Unavailable）' })).rule,
    ).toBe('BZ1');
    expect(classifyFailure(session({ message: '503 Service Unavailable' })).rule).toBe('UP1');
    expect(classifyFailure(session({ message: '429 Too Many Requests' })).rule).toBe('RL3');
    expect(classifyFailure(session({ message: '限流' })).rule).toBe('RL3');
    expect(classifyFailure(session({ message: '连接被重置' })).rule).toBe('NT1');
    expect(classifyFailure(session({ message: 'connection reset by peer' })).rule).toBe('NT1');
    expect(classifyFailure(session({ message: 'stream disconnected before completion' })).rule).toBe('SB1');
    for (const id of ['BZ1', 'RL1', 'RL3', 'UP1', 'NT1', 'SB1']) expect(isUpstreamBlip(id)).toBe(true);
    expect(isUpstreamBlip('QT1')).toBe(false);
  });

  it('原文里带个 /login 的网址不算登录失效：不能因此停掉整个账号池', () => {
    const v = classifyFailure(
      session({ message: 'upstream error, see https://status.example.com/login for details' }),
    );
    expect(v.rule).not.toBe('AU2');
    expect(v.shared).toBeUndefined();
    expect(classifyFailure(session({ message: 'Not logged in · Please run /login' })).rule).toBe('AU2');
  });
});

describe('策略参数', () => {
  it('引擎的上限对象可以直接当策略传进来（多出来的字段不管）', () => {
    const v = classifyFailure({ ...UNKNOWN, attempts: { retries: 3 } }, {
      retryAttempts: 5,
      routeSwaps: 2,
      maxParallel: 3,
    } as Partial<FailurePolicy>);
    expect(v.action).toBe('retry');
    expect(DEFAULT_FAILURE_POLICY.retryAttempts).toBe(2);
  });

  it('给了但不对的报错，不悄悄换成默认值；次数可以是 0', () => {
    const bad: [Partial<FailurePolicy>, string][] = [
      [{ retryAttempts: -1 }, '失败分流策略的 retryAttempts 不对：要不小于 0 的整数，给的是 -1'],
      [{ reworkRounds: 1.5 }, 'reworkRounds 不对：要不小于 0 的整数'],
      [{ waitMaxSeconds: Number.NaN }, 'waitMaxSeconds 不对：要不小于 0 的数'],
    ];
    for (const [policy, message] of bad) expect(() => classifyFailure(UNKNOWN, policy)).toThrow(message);
    expect(classifyFailure(UNKNOWN, { retryAttempts: 0 }).action).toBe('park');
  });
});

describe('分档冷却（决定 0093，借 magpie gateway-routing：额度歇到清零、限流按 Retry-After、其他 1 分钟起翻倍）', () => {
  const quota = (extra: Partial<FailureEvidence> = {}) =>
    session({ code: 'quota_exhausted', message: 'usage limit reached', ...extra });

  it('额度用完、读到清零时刻：歇到那个时刻，写明按读数', () => {
    const v = classifyFailure(quota({ resetsAt: '2026-09-25T00:40:00.000Z' }));
    expect(v).toMatchObject({ action: 'retry', delaySeconds: 2400, wait: 'quota' });
    expect(v.cooldown).toEqual({ tier: 'quota', by: 'resets' });
    expect(v.reason).toContain('按读到的清零时刻');
  });

  it('额度用完、清零时刻没读到：按现有估计（15 分钟起），写明是估计', () => {
    const v = classifyFailure(quota());
    expect(v).toMatchObject({ action: 'retry', delaySeconds: 900 });
    expect(v.cooldown).toEqual({ tier: 'quota', by: 'estimate' });
    expect(v.reason).toContain('清零时刻没读到，按估计');
  });

  it('清零时刻已经过了（旧读数）：不当成马上就好、等 0 秒原路再撞，按估计并写明', () => {
    const v = classifyFailure(quota({ resetsAt: '2026-09-24T23:00:00.000Z' }));
    expect(v.delaySeconds).toBe(900);
    expect(v.cooldown).toEqual({ tier: 'quota', by: 'estimate' });
    expect(v.reason).toContain('resetsAt 已经过了');
  });

  it('限流给了 Retry-After：按对方给的时间；没给：1 分钟起翻倍', () => {
    const given = classifyFailure(
      session({ httpStatus: 429, message: 'Too Many Requests. Retry-After: 42' }),
    );
    expect(given).toMatchObject({ action: 'retry', delaySeconds: 42, wait: 'upstream' });
    expect(given.cooldown).toEqual({ tier: 'rate', by: 'retry-after' });
    expect(given.reason).toContain('按上游给的时间');
    const { verdicts } = drive(session({ httpStatus: 429, message: 'Too Many Requests' }));
    expect(verdicts.slice(0, 2).map((v) => v.delaySeconds)).toEqual([60, 120]);
    expect(verdicts[0]?.cooldown).toEqual({ tier: 'rate', by: 'backoff' });
  });

  it('停下、返工不带冷却档', () => {
    expect(drive(NETWORK).last?.cooldown).toBeUndefined();
    expect(classifyFailure(BANNED).cooldown).toBeUndefined();
  });
});
