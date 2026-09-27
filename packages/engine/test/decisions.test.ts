// 流程判断全是纯函数：不起 Temporal 直接测。
import { startFlow } from '@fleet-dao/core';
import { describe, expect, it } from 'vitest';
import { activityOptions, QUICK_TIMEOUT_SECONDS } from '../src/activity-options.ts';
import {
  afterMergeReturn,
  checkDelivery,
  createDecide,
  decideAfterVerify,
  decideTriage,
  evidenceOf,
  fingerprint,
  mergeStep,
  nextAction,
  normalizeTouch,
  pickRunnable,
  retryDelaySeconds,
  type SchedItem,
  touchesOverlap,
  type VerifyInput,
  validatePlan,
} from '../src/decisions/index.ts';
import type { FailureVerdict } from '../src/failure/index.ts';
import { describeHolds, normalizeHolds } from '../src/holds.ts';
import {
  CONCURRENT_SESSIONS,
  DEFAULT_LIMITS,
  FRANCE_RESIDENT_MB,
  FRANCE_USABLE_MB,
  historyAlertLine,
  resolveLimits,
  SESSION_MEMORY_HIGH_MB,
  SESSION_MEMORY_MAX_MB,
} from '../src/limits.ts';
import { costOfRun } from '../src/usage.ts';

const limits = DEFAULT_LIMITS;
const failure = (code: string, retryable: boolean | null = null) => ({
  source: 'session:execute',
  code,
  message: code,
  retryable,
});

describe('上限：读时现算默认值', () => {
  it('老输入缺新字段按默认值补，不写回输入；非法值不认', () => {
    const old = { reviewRounds: 5 } as const;
    const resolved = resolveLimits(old);
    expect(resolved.reviewRounds).toBe(5);
    expect(resolved.stallSeconds).toBe(360);
    expect(old).toEqual({ reviewRounds: 5 });
    expect(resolveLimits({ ciFixRounds: -1, heartbeatSeconds: Number.NaN }).ciFixRounds).toBe(3);
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS);
  });

  it('会话内存上限按法国实测容量算：(11G - 常驻 0.6G) ÷ 同时 3 个会话；软上限只比硬上限低 256', () => {
    expect(SESSION_MEMORY_MAX_MB).toBe(Math.floor((11 * 1024 - 600) / 3));
    expect(DEFAULT_LIMITS).toMatchObject({ sessionMemoryMaxMb: 3554, sessionMemoryHighMb: 3298 });
    // 同时跑满的会话都顶到硬上限，加上常驻服务也不超过能分的
    expect(CONCURRENT_SESSIONS * DEFAULT_LIMITS.sessionMemoryMaxMb + FRANCE_RESIDENT_MB).toBeLessThanOrEqual(
      FRANCE_USABLE_MB,
    );
    // 放得下法国实测开 2 个测试进程的峰值（约 2493 MiB，含页缓存）加 Claude Code（约 270）：原来的 1.5G / 2G 连 1 个都放不下
    expect(DEFAULT_LIMITS.sessionMemoryHighMb).toBeGreaterThan(2493 + 270);
    expect(DEFAULT_LIMITS.sessionMemoryHighMb).toBe(SESSION_MEMORY_HIGH_MB);
  });

  it('事件数报警线：在途任务记下的那一套里没有这一项（它加进来之前开工的），按现在的默认值，不报「报警线 undefined」', () => {
    const { historyAlertEvents: _missing, ...old } = DEFAULT_LIMITS;
    expect(historyAlertLine(old)).toBe(DEFAULT_LIMITS.historyAlertEvents);
    expect(historyAlertLine({ ...old, historyAlertEvents: 20 })).toBe(20);
  });

  it('合并队列空闲收工有下限：不短于排队活动一次尝试的限时（30 秒），给小了取下限', () => {
    const floor = QUICK_TIMEOUT_SECONDS / 60;
    expect(floor).toBe(0.5);
    expect(
      [0, 0.1, 0.5, 5].map((m) => resolveLimits({ mergeQueueIdleMinutes: m }).mergeQueueIdleMinutes),
    ).toEqual([0.5, 0.5, 0.5, 5]);
    // 下限和排队活动的真实限时是同一个数（改了一边另一边跟着变）。
    expect(activityOptions('enqueueMerge', DEFAULT_LIMITS).startToCloseTimeout).toBe(
      `${QUICK_TIMEOUT_SECONDS} seconds`,
    );
  });
});

describe('方案校验', () => {
  it('改动位置规整：通配符截成前缀、去掉 ./ 和首尾斜杠；没写就是整个仓', () => {
    expect(normalizeTouch('./src/login/')).toBe('src/login');
    expect(normalizeTouch('src\\login\\form.ts')).toBe('src/login/form.ts');
    expect(normalizeTouch('src/**/*.ts')).toBe('src');
    expect(normalizeTouch('*.md')).toBe('*');
    const ok = validatePlan({ subtasks: [{ key: 'a', title: 'A' }], maxSubtasks: 12 });
    expect(ok.ok && ok.subtasks[0]?.touches).toEqual(['*']);
  });

  it('编号不合规、重复、依赖不存在、依赖成环都挑出来', () => {
    const bad = validatePlan({
      subtasks: [
        { key: 'A B', title: 'x' },
        { key: 'a', title: 'x', dependsOn: ['missing'] },
        { key: 'a', title: '' },
      ],
      maxSubtasks: 12,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.join('\n')).toContain('「A B」不合规');
      expect(bad.problems.join('\n')).toContain('「a」重复');
      expect(bad.problems.join('\n')).toContain('「missing」不存在');
      expect(bad.problems.join('\n')).toContain('没有标题');
    }
    const cycle = validatePlan({
      subtasks: [
        { key: 'a', title: 'a', dependsOn: ['b'] },
        { key: 'b', title: 'b', dependsOn: ['a'] },
      ],
      maxSubtasks: 12,
    });
    expect(cycle.ok ? '' : cycle.problems[0]).toContain('依赖成环');
    expect(validatePlan({ subtasks: [], maxSubtasks: 12 }).ok).toBe(false);
  });

  it('只有高风险合并前要第二意见，没写风险按高风险算；UI 活单独标出来', () => {
    const plan = validatePlan({
      subtasks: [
        { key: 'docs', title: 'd', touches: ['docs'], risk: 'low' },
        { key: 'api', title: 'a', touches: ['api'], risk: 'normal' },
        { key: 'db', title: 'm', touches: ['db'], risk: 'high' },
        { key: 'page', title: 'p', touches: ['web'], stage: 'ui' },
      ],
      maxSubtasks: 12,
    });
    expect(plan.ok && plan.subtasks.map((s) => [s.key, s.secondOpinion, s.stage])).toEqual([
      ['docs', false, 'execute'],
      ['api', false, 'execute'],
      ['db', true, 'execute'],
      ['page', true, 'ui'],
    ]);
  });

  it('人闸：方案标的和整个需求的合在一起，规整成小写、去重、排序；认不得的也留着（宁可多拦一次）', () => {
    const plan = validatePlan({
      subtasks: [
        { key: 'api', title: 'a', holds: ['Delete', ' release ', 'delete'] },
        { key: 'page', title: 'p' },
        { key: 'misc', title: 'm', holds: ['上线'] },
      ],
      maxSubtasks: 12,
      holds: ['spend'],
    });
    expect(plan.ok && plan.subtasks.map((s) => s.holds)).toEqual([
      ['delete', 'release', 'spend'],
      ['spend'],
      ['spend', '上线'],
    ]);
    expect(normalizeHolds([' Spend', 3, '', 'spend'])).toEqual(['spend']);
    expect(describeHolds(['release', 'spend', 'delete', '上线'])).toBe('对外发布、花钱、删数据、上线');
  });
});

describe('不撞车调度', () => {
  it('同一块地方按路径段判：前缀相同算撞，名字相近不算', () => {
    expect(touchesOverlap(['src/login'], ['src/login/form.ts'])).toBe(true);
    expect(touchesOverlap(['src/login'], ['src/login-page'])).toBe(false);
    expect(touchesOverlap(['*'], ['README.md'])).toBe(true);
  });

  const item = (key: string, over: Partial<SchedItem> = {}): SchedItem => ({
    key,
    touches: [`src/${key}`],
    dependsOn: [],
    state: 'pending',
    ...over,
  });

  it('依赖没合并的等依赖，撞地方的等它做完，并发满了的等空位', () => {
    const decision = pickRunnable({
      items: [
        item('a', { state: 'running', touches: ['src/login'] }),
        item('b', { touches: ['src/login/form.ts'] }),
        item('c', { dependsOn: ['a'] }),
        item('d'),
        item('e'),
      ],
      maxParallel: 2,
    });
    expect(decision.start).toEqual(['d']);
    expect(decision.waiting).toEqual([
      { key: 'b', kind: 'overlap', on: ['a'] },
      { key: 'c', kind: 'deps', on: ['a'] },
      { key: 'e', kind: 'capacity', on: ['a', 'd'] },
    ]);
  });

  it('同一轮里新起的也算「在跑」：两个撞地方的不会一起起', () => {
    const decision = pickRunnable({
      items: [item('a', { touches: ['src'] }), item('b', { touches: ['src/x'] })],
      maxParallel: 5,
    });
    expect(decision.start).toEqual(['a']);
    expect(decision.waiting).toEqual([{ key: 'b', kind: 'overlap', on: ['a'] }]);
  });

  it('依赖（直接或间接）没做成的永远起不来；依赖了不存在的也一样，不会干等', () => {
    const decision = pickRunnable({
      items: [
        item('a', { state: 'stopped' }),
        item('b', { dependsOn: ['a'] }),
        item('c', { dependsOn: ['b'] }),
        item('d', { dependsOn: ['ghost'] }),
      ],
      maxParallel: 3,
    });
    expect(decision.start).toEqual([]);
    expect(decision.unreachable).toEqual([
      { key: 'b', because: ['a'] },
      { key: 'c', because: ['b'] },
      { key: 'd', because: ['ghost'] },
    ]);
  });
});

describe('失败分流：接的是规则表（failure/classify.ts），认不出的走兜底梯', () => {
  const verdict = (over: Partial<FailureVerdict> = {}): FailureVerdict => ({
    action: 'park',
    delaySeconds: 0,
    reason: '换上的分流说挂起',
    rule: 'T1',
    title: '换上的',
    via: 'signal',
    classifiedAs: 'park',
    alert: true,
    counter: null,
    routeOutcome: 'neutral',
    resumeSame: false,
    ...over,
  });

  it('错误码不分大小写、原文也认：额度用满先等清零（续同一个会话），繁忙换路由，丢了的活原路重试', () => {
    const quota = nextAction({ failure: failure('quota_exhausted'), limits, routeBound: true });
    expect(quota).toMatchObject({ action: 'retry', wait: 'quota', resumeSame: true, rule: 'QT1' });
    expect(quota.shared).toEqual({ scope: 'pool' });
    expect(nextAction({ failure: failure('route_busy'), limits, routeBound: true })).toMatchObject({
      action: 'swapRoute',
      avoid: 'route',
    });
    expect(nextAction({ failure: failure('SESSION_LOST'), limits, routeBound: true })).toMatchObject({
      action: 'retry',
      resumeSame: true,
    });
    expect(
      nextAction({
        failure: { ...failure('agent_error'), message: 'API Error: 401 device_revoked' },
        limits,
        routeBound: true,
      }).rule,
    ).toBe('DV1');
    expect(nextAction({ failure: failure('什么鬼'), limits, routeBound: true }).classifiedAs).toBe('unknown');
  });

  it('会话失败带回的 Jev 答案进分流：只记不拦的照兜底梯（理由里写明），真拦有把握的按它走；规则认得出的不看它', () => {
    const jev = { asked: true, ok: true, choice: 'swapRoute', confidence: 0.9, shadow: true } as const;
    expect(evidenceOf({ failure: failure('WEIRD'), limits, routeBound: true, context: { jev } }).jev).toEqual(
      jev,
    );
    const shadowed = nextAction({ failure: failure('WEIRD'), limits, routeBound: true, context: { jev } });
    expect(shadowed).toMatchObject({ action: 'retry', rule: 'FB' });
    expect(shadowed.reason).toContain('这道题还在只记不拦');
    const enforced = nextAction({
      failure: failure('WEIRD'),
      limits,
      routeBound: true,
      context: { jev: { ...jev, shadow: false } },
    });
    expect(enforced).toMatchObject({ action: 'swapRoute', rule: 'JV', avoid: 'route' });
    const known = nextAction({
      failure: failure('route_busy'),
      limits,
      routeBound: true,
      context: { jev: { ...jev, choice: 'swapModel', shadow: false } },
    });
    expect(known).toMatchObject({ action: 'swapRoute', avoid: 'route' });
    expect(known.rule).not.toBe('JV');
  });

  it('认不出的从重试爬起：重试 → 换路由 → 换模型 → 挂起，每级额度用完才往下走', () => {
    const steps = [
      nextAction({ failure: failure('WEIRD'), limits, routeBound: true }),
      nextAction({ failure: failure('WEIRD'), counters: { retries: 2 }, limits, routeBound: true }),
      nextAction({
        failure: failure('WEIRD'),
        counters: { retries: 2, routeSwaps: 2 },
        limits,
        routeBound: true,
      }),
      nextAction({
        failure: failure('WEIRD'),
        counters: { retries: 2, routeSwaps: 2, modelSwaps: 1 },
        limits,
        routeBound: true,
      }),
    ];
    expect(steps.map((s) => s.action)).toEqual(['retry', 'swapRoute', 'swapModel', 'park']);
    expect(steps[0]?.delaySeconds).toBe(15);
    expect(steps.map((s) => s.counter)).toEqual(['retries', 'routeSwaps', 'modelSwaps', null]);
    expect(steps.map((s) => s.classifiedAs)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  });

  it('上游繁忙、容量满、限流（没给等多久）：先换路由，不是挂起等人（D8、F2）', () => {
    for (const code of ['ROUTE_BUSY', 'CAPACITY', 'RATE_LIMITED']) {
      expect(nextAction({ failure: failure(code), limits, routeBound: true }).action).toBe('swapRoute');
    }
  });

  it('端口明说重试没用的，跳过重试；不绑路由的一步只有重试和挂起两级', () => {
    expect(nextAction({ failure: failure('WEIRD', false), limits, routeBound: true }).action).toBe(
      'swapRoute',
    );
    expect(nextAction({ failure: failure('WEIRD', false), limits, routeBound: false }).action).toBe('park');
  });

  it('账号池的事：封号换池并报警、换不了就挂起；额度用满在 Claude 订阅池马上回去选路（等切号）；别的换路由只避这条路由', () => {
    expect(nextAction({ failure: failure('account_banned'), limits, routeBound: true })).toMatchObject({
      action: 'swapRoute',
      avoid: 'pool',
      alert: true,
      shared: { scope: 'pool' },
    });
    expect(
      nextAction({
        failure: failure('account_banned'),
        counters: { routeSwaps: 2 },
        limits,
        routeBound: true,
      }).action,
    ).toBe('park');
    // Claude 订阅池（带组织类型）：不原地睡到清零，马上回去选路续同一个会话（切了号选路就换池 fork 续上，#59）
    const org = nextAction({
      failure: failure('QUOTA_EXHAUSTED'),
      limits,
      routeBound: true,
      context: {
        now: '2026-09-25T00:00:00.000Z',
        resetsAt: '2026-09-25T00:20:00.000Z',
        route: {
          routeId: 'r-carpool',
          poolId: 'carpool',
          modelId: 'opus',
          hostId: 'claude-code',
          orgKind: 'carpool',
        },
      },
    });
    expect(org).toMatchObject({ action: 'retry', delaySeconds: 0, wait: 'quota', resumeSame: true });
    expect(org.shared).toEqual({ scope: 'pool', until: '2026-09-25T00:20:00.000Z' });
    // 同样的额度用满在别的池：等到清零（上游给的时刻），不换池。
    const plain = nextAction({
      failure: failure('QUOTA_EXHAUSTED'),
      limits,
      routeBound: true,
      context: {
        now: '2026-09-25T00:00:00.000Z',
        resetsAt: '2026-09-25T00:20:00.000Z',
        route: { routeId: 'r-kimi', poolId: 'kimi', modelId: 'k2', hostId: 'mirasim' },
      },
    });
    expect(plain).toMatchObject({ action: 'retry', delaySeconds: 1200, wait: 'quota', resumeSame: true });
    expect(nextAction({ failure: failure('ROUTE_BUSY'), limits, routeBound: true }).avoid).toBe('route');
    expect(
      nextAction({ failure: failure('WEIRD'), counters: { retries: 2 }, limits, routeBound: true }).avoid,
    ).toBe('route');
  });

  it('设备被撤销：挂起（不换池、不等清零），整池暂停，写明去哪台机器、以谁的身份重跑 reclaude login；人点继续后续同一个会话', () => {
    const next = nextAction({
      failure: { ...failure('agent_error'), message: 'API Error: 401 device_revoked' },
      limits,
      routeBound: true,
      context: {
        route: {
          routeId: 'r1',
          poolId: 'carpool',
          modelId: 'opus',
          hostId: 'claude-code',
          orgKind: 'carpool',
        },
        machine: '法国',
        runAsUser: 'fleet-agent-carpool',
      },
    });
    expect(next).toMatchObject({ action: 'park', rule: 'DV1', resumeSame: true, alert: true });
    expect(next.shared).toEqual({ scope: 'pool' });
    expect(next.humanFix).toContain('在「法国」上以会话用户 fleet-agent-carpool 重跑 reclaude login');
  });

  it('要人的直接挂起并报警', () => {
    expect(nextAction({ failure: failure('PERMISSION_DENIED'), limits, routeBound: true })).toMatchObject({
      action: 'park',
      alert: true,
    });
  });

  it('上一次失败的原文一字不差：原路再试不会变，跳过重试', () => {
    const again = nextAction({
      failure: { ...failure('agent_error'), message: 'socket hang up' },
      counters: { retries: 1 },
      limits,
      routeBound: true,
      context: { previousMessage: 'socket hang up' },
    });
    expect(again.action).toBe('swapRoute');
    expect(again.reason).toContain('一字不差');
  });

  it('退避是确定的：15 秒起翻倍，封顶 10 分钟', () => {
    expect([0, 1, 2, 10].map(retryDelaySeconds)).toEqual([15, 30, 60, 600]);
  });

  it('分流可以换；换上的出错或答非所问，退回只看次数的兜底梯，并报警', async () => {
    const decide = createDecide({ triage: () => verdict() });
    expect((await decide('failure', { failure: failure('X'), limits, routeBound: true })).action).toBe(
      'park',
    );
    const broken = createDecide({
      triage: () => {
        throw new Error('表坏了');
      },
    });
    const fromBroken = await broken('failure', { failure: failure('X'), limits, routeBound: true });
    expect(fromBroken).toMatchObject({ action: 'retry', rule: 'EF', alert: true, classifiedAs: 'unknown' });
    expect(fromBroken.reason).toContain('表坏了');
    const junk = createDecide({ triage: () => verdict({ action: 'explode' as never }) });
    expect(await junk('failure', { failure: failure('X'), limits, routeBound: true })).toMatchObject({
      rule: 'EF',
      classifiedAs: 'unknown',
    });
    const negative = createDecide({ triage: () => verdict({ action: 'retry', delaySeconds: -5 }) });
    expect((await negative('failure', { failure: failure('X'), limits, routeBound: false })).rule).toBe('EF');
    // 兜底梯也有次数：不绑路由的重试用完就挂起。
    expect(
      (
        await broken('failure', {
          failure: failure('X'),
          counters: { retries: 2 },
          limits,
          routeBound: false,
        })
      ).action,
    ).toBe('park');
  });
});

describe('验证之后怎么走', () => {
  const base: VerifyInput = {
    sync: { state: 'clean', head: 'h1', conflictFiles: [] },
    ci: { state: 'green', head: 'h1', failedChecks: [] },
    review: { verdict: 'pass', head: 'h1', findings: [] },
    reviewRequired: true,
    limits,
  };

  it('CI 绿、第二意见通过：合并；小毛病不挡合并，带出来攒着', () => {
    const d = decideAfterVerify({
      ...base,
      review: { verdict: 'changes', head: 'h1', findings: [{ severity: 'minor', text: '变量名' }] },
    });
    expect(d).toMatchObject({ action: 'merge', minorFindings: [{ text: '变量名' }] });
  });

  it('没查成不是没过也不是过了：交人，不合也不返工', () => {
    expect(
      decideAfterVerify({ ...base, ci: { state: 'unknown', head: 'h1', failedChecks: [] } }).action,
    ).toBe('escalate');
  });

  it('证据要绑头：CI 或第二意见的头对不上送检的头，交人', () => {
    expect(decideAfterVerify({ ...base, ci: { state: 'green', head: 'old', failedChecks: [] } }).action).toBe(
      'escalate',
    );
    expect(
      decideAfterVerify({ ...base, review: { verdict: 'pass', head: 'old', findings: [] } }).action,
    ).toBe('escalate');
  });

  it('同步主线有冲突：回主会话解决，冲突轮数单独计', () => {
    const d = decideAfterVerify({
      ...base,
      sync: { state: 'conflict', head: 'h1', conflictFiles: ['a.ts'] },
      ci: null,
      review: null,
    });
    expect(d).toMatchObject({
      action: 'rework',
      count: 'conflict',
      feedback: [{ kind: 'conflict', items: ['a.ts'] }],
    });
  });

  it('CI 修了几轮不占第二意见的额度（F1）', () => {
    const d = decideAfterVerify({
      ...base,
      review: { verdict: 'changes', head: 'h1', findings: [{ severity: 'blocking', text: '漏了过期' }] },
      rounds: { ciFix: 3, review: 0 },
    });
    expect(d).toMatchObject({ action: 'rework', count: 'review' });
  });

  it('第二意见最多两轮；同一条必须改连续两轮出现就交人，不开第三轮（F4）', () => {
    const blocking = {
      ...base,
      review: {
        verdict: 'changes' as const,
        head: 'h1',
        findings: [{ severity: 'blocking' as const, text: '第 12 行漏了过期' }],
      },
    };
    const first = decideAfterVerify(blocking);
    expect(first.action).toBe('rework');
    const print = first.action === 'rework' ? first.fingerprint : '';
    const again = decideAfterVerify({
      ...blocking,
      review: {
        verdict: 'changes',
        head: 'h1',
        findings: [{ severity: 'blocking', text: '第 13 行漏了过期' }],
      },
      rounds: { review: 1 },
      lastFingerprints: { review: print },
    });
    expect(again).toMatchObject({ action: 'escalate' });
    expect(decideAfterVerify({ ...blocking, rounds: { review: 2 } }).action).toBe('escalate');
  });

  it('CI 红：带失败摘要的，同一处连红两轮就交人；不带摘要的只按轮数上限', () => {
    const red = { state: 'red' as const, head: 'h1', failedChecks: ['check'], digest: 'login.test.ts 超时' };
    const first = decideAfterVerify({ ...base, ci: red, review: null, reviewRequired: false });
    expect(first).toMatchObject({ action: 'rework', count: 'ciFix' });
    const print = first.action === 'rework' ? first.fingerprint : '';
    expect(
      decideAfterVerify({
        ...base,
        ci: red,
        review: null,
        reviewRequired: false,
        lastFingerprints: { ci: print },
      }).action,
    ).toBe('escalate');
    const noDigest = { state: 'red' as const, head: 'h1', failedChecks: ['check'] };
    const r1 = decideAfterVerify({ ...base, ci: noDigest, review: null, reviewRequired: false });
    const r2 = decideAfterVerify({
      ...base,
      ci: noDigest,
      review: null,
      reviewRequired: false,
      rounds: { ciFix: 1 },
      lastFingerprints: { ci: r1.action === 'rework' ? r1.fingerprint : '' },
    });
    expect(r2.action).toBe('rework');
    expect(
      decideAfterVerify({ ...base, ci: noDigest, review: null, reviewRequired: false, rounds: { ciFix: 3 } })
        .action,
    ).toBe('escalate');
  });

  it('指纹不看行号和提交号', () => {
    expect(fingerprint('第 12 行漏了过期 abcdef1')).toBe(fingerprint('第 99 行漏了过期 1234567890ab'));
    expect(fingerprint('漏了过期')).not.toBe(fingerprint('漏了测试'));
  });
});

describe('交付对账（windsurf-dao#1572 的假完成）', () => {
  const touches = ['src/login'];
  it('改在方案点名的地方：收；顺手改了方案外的也收，但记下来', () => {
    expect(checkDelivery({ touches, changedFiles: ['src/login/a.ts'], offPlanSoFar: 0, limits })).toEqual({
      action: 'accept',
      outside: [],
      note: '',
    });
    expect(
      checkDelivery({ touches, changedFiles: ['src/login/a.ts', 'package.json'], offPlanSoFar: 0, limits }),
    ).toMatchObject({ action: 'accept', outside: ['package.json'] });
  });

  it('一个都对不上：退回重做；再对不上就交人', () => {
    const off = { touches, changedFiles: ['docs/x.md'], limits };
    expect(checkDelivery({ ...off, offPlanSoFar: 0 })).toMatchObject({
      action: 'rework',
      feedback: [{ kind: 'plan' }],
    });
    expect(checkDelivery({ ...off, offPlanSoFar: 1 }).action).toBe('escalate');
  });

  it('改动清单没查成的先收下（不当成对不上）；方案写的是整个仓的都收', () => {
    expect(checkDelivery({ touches, changedFiles: undefined, offPlanSoFar: 0, limits }).action).toBe(
      'accept',
    );
    expect(checkDelivery({ touches: ['*'], changedFiles: ['x'], offPlanSoFar: 0, limits }).action).toBe(
      'accept',
    );
  });
});

describe('子任务的墙钟预算（F5）', () => {
  const red = {
    sync: { state: 'clean' as const, head: 'h1', conflictFiles: [] },
    ci: { state: 'red' as const, head: 'h1', failedChecks: ['check'] },
    review: null,
    reviewRequired: false,
    limits,
  };
  it('超了预算不再自动返工，交帅位；能合的照合', () => {
    expect(decideAfterVerify({ ...red, elapsedMinutes: 30 }).action).toBe('rework');
    expect(decideAfterVerify({ ...red, elapsedMinutes: 300 })).toMatchObject({
      action: 'escalate',
      reason: '子任务已经干了 300 分钟，超过预算 240 分钟',
    });
    expect(
      decideAfterVerify({
        ...red,
        ci: { state: 'green', head: 'h1', failedChecks: [] },
        elapsedMinutes: 300,
      }).action,
    ).toBe('merge');
  });
});

describe('这一次的花费（执行体报的是会话累计）', () => {
  it('头一回跑取累计；续会话取差；上一轮没读到就不给，不记 0', () => {
    expect(costOfRun(undefined, 0.3)).toBe(0.3);
    expect(costOfRun(0.3, 0.5)).toBe(0.2);
    expect(costOfRun(null, 0.5)).toBeUndefined();
    expect(costOfRun(0.3, undefined)).toBeUndefined();
    expect(costOfRun(0.5, 0.3)).toBe(0);
  });
});

describe('合并队列的条目状态机', () => {
  const clean = { state: 'clean' as const, head: 'h2', conflictFiles: [] };
  it('同步 → 测试（新头上）→ 合并（带头约束）→ 合上', () => {
    const none = { withdrawn: false, sync: null, tests: null, merge: null };
    expect(mergeStep(none)).toEqual({ next: 'sync' });
    expect(mergeStep({ ...none, sync: clean })).toEqual({ next: 'test', head: 'h2' });
    const tests = { passed: true, head: 'h2', summary: '绿' };
    expect(mergeStep({ ...none, sync: clean, tests })).toEqual({ next: 'merge', head: 'h2' });
    expect(mergeStep({ ...none, sync: clean, tests, merge: { merged: true, mergeCommit: 'm' } })).toEqual({
      next: 'done',
      result: 'merged',
      mergeCommit: 'm',
    });
  });

  it('冲突、测红、测的不是这个头、回读没合上、某一步出错：都退回', () => {
    const none = { withdrawn: false, sync: null, tests: null, merge: null };
    const reason = (input: Parameters<typeof mergeStep>[0]) => {
      const step = mergeStep(input);
      return step.next === 'done' && step.result === 'returned' ? step.reason : step.next;
    };
    expect(reason({ ...none, sync: { state: 'conflict', head: 'h2', conflictFiles: ['x'] } })).toBe(
      'conflict',
    );
    expect(reason({ ...none, sync: clean, tests: { passed: false, head: 'h2', summary: '红' } })).toBe(
      'tests-red',
    );
    expect(reason({ ...none, sync: clean, tests: { passed: true, head: 'old', summary: '绿' } })).toBe(
      'tests-stale',
    );
    expect(
      reason({
        ...none,
        sync: clean,
        tests: { passed: true, head: 'h2', summary: '' },
        merge: { merged: false },
      }),
    ).toBe('merge-failed');
    expect(reason({ ...none, failed: { step: 'sync', message: 'GitHub 挂了' } })).toBe('infra');
    expect(mergeStep({ ...none, withdrawn: true })).toMatchObject({ result: 'withdrawn' });
  });

  it('撤出晚到一步、已经合上了：按合上算，不当成撤回丢掉；没合上的才算撤回', () => {
    const tests = { passed: true, head: 'h2', summary: '绿' };
    const late = { withdrawn: true, sync: clean, tests };
    expect(mergeStep({ ...late, merge: { merged: true, mergeCommit: 'm' } })).toEqual({
      next: 'done',
      result: 'merged',
      mergeCommit: 'm',
    });
    expect(mergeStep({ ...late, merge: { merged: false } })).toMatchObject({ result: 'withdrawn' });
    expect(mergeStep({ ...late, merge: null })).toMatchObject({ result: 'withdrawn' });
  });

  it('退回之后：基础设施出错等一会儿原样重排；冲突、测红回主会话；次数到了交人', () => {
    const lim = { mergeReturns: 3 };
    expect(
      afterMergeReturn({ reason: 'infra', detail: 'x', files: [], returnsSoFar: 0, limits: lim }).action,
    ).toBe('requeue');
    expect(
      afterMergeReturn({ reason: 'conflict', detail: 'x', files: ['a.ts'], returnsSoFar: 1, limits: lim }),
    ).toMatchObject({ action: 'rework', feedback: [{ kind: 'merge-return', items: ['a.ts'] }] });
    expect(
      afterMergeReturn({ reason: 'tests-red', detail: 'x', files: [], returnsSoFar: 3, limits: lim }).action,
    ).toBe('escalate');
  });
});

describe('分诊之后', () => {
  it('清楚开工；没判出来按默认走，不当成「否」；看不懂就问，问够了按假设继续', () => {
    expect(decideTriage({ verdict: { clear: true }, asked: 0, maxQuestions: 2 }).action).toBe('proceed');
    expect(decideTriage({ verdict: { clear: null }, asked: 0, maxQuestions: 2 })).toMatchObject({
      action: 'proceed',
      assumed: true,
    });
    expect(
      decideTriage({ verdict: { clear: false, question: '哪个页面？' }, asked: 0, maxQuestions: 2 }),
    ).toEqual({
      action: 'ask',
      question: '哪个页面？',
    });
    expect(
      decideTriage({ verdict: { clear: false, question: '哪个页面？' }, asked: 2, maxQuestions: 2 }),
    ).toMatchObject({ action: 'proceed', assumed: true });
  });

  it('分诊判出的人闸（会碰花钱、删数据、对外发布）带出来，规整过', () => {
    expect(
      decideTriage({ verdict: { clear: true, holds: ['Spend', 'spend'] }, asked: 0, maxQuestions: 2 }),
    ).toEqual({ action: 'proceed', assumed: false, note: '需求清楚', holds: ['spend'] });
    expect(decideTriage({ verdict: { clear: null }, asked: 0, maxQuestions: 2 })).toMatchObject({
      holds: [],
    });
  });
});

describe('编号（库主键）', () => {
  it('newIds 给要的个数，都是 UUID、互不相同；给 0 个就是空', async () => {
    const decide = createDecide();
    const ids = await decide('newIds', { count: 3 });
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(3);
    expect(await decide('newIds', { count: 0 })).toEqual([]);
  });
});

describe('Fusion 的判断经 decide 调（core 包，0003 第 12 条）', () => {
  const decide = createDecide();

  it('状态机、简报、验收、验证、流程配置都接上了', async () => {
    const state = startFlow('fusion', false);
    const step = await decide('fusionFlow', { state, event: { kind: 'discussed' } });
    expect(step).toMatchObject({ ok: true, action: 'intake' });
    expect((await decide('brief', { goal: 'x' })).ok).toBe(false);
    expect(await decide('parallelBriefs', [])).toEqual({ ok: true });
    const verdict = await decide('verdict', {
      criteria: ['a'],
      sentHead: 'abc1234',
      report: { head: 'abc1234', results: [{ criterion: 'a', answer: 'done', evidence: 'e' }], findings: [] },
      verifierFamily: 'gpt',
      authorFamilies: ['claude'],
      rebuttals: [],
    });
    expect(verdict.verdict).toBe('pass');
    const lines = await decide('verifyLines', [
      {
        round: 1,
        verifier: 'Kimi k3（kimi 族）',
        criteria: 1,
        rebuttals: [],
        final: { verdict: 'pass', notes: [], rebutted: [] },
      },
    ]);
    expect(lines.verified).toEqual([
      '开 PR 前别家验证第 1 轮（Kimi k3（kimi 族））：过，逐条核了 1 条「怎么算做完」',
    ]);
  });

  it('【故意造出的失败】验证一轮都没有：PR 正文明说没有记录，不空着', async () => {
    expect(await decide('verifyLines', [])).toEqual({ verified: ['开 PR 前别家验证：没有记录'], owed: [] });
  });

  it('【故意造出的失败】全组织默认读不到：判停派，不拿空配置顶', async () => {
    const got = await decide('flowConfig', { org: { kind: 'missing' }, project: { kind: 'missing' } });
    expect(got).toMatchObject({ ok: false, scope: 'org' });
  });

  it('Fusion 工作流用的几样也接上了：起步、需求文档目录、配置副本、Lead 交回的、PR 正文、关单评论', async () => {
    expect(await decide('fusionStart', { mode: 'fusion', mother: false, verifyRounds: 1 })).toMatchObject({
      step: 'discuss',
      verifyLimit: 1,
    });
    expect(await decide('specDir', { body: '文档：`specs/12-登录/需求.md`', issueNumber: 12 })).toEqual({
      ok: 'specs/12-登录',
      docs: {
        requirement: 'specs/12-登录/需求.md',
        plan: 'specs/12-登录/方案.md',
        result: 'specs/12-登录/结果.md',
      },
    });
    const setup = await decide('fusionSetup', {
      read: {
        replica: { syncedAt: null, error: null, unread: null, testCommand: null },
        source: null,
        config: null,
      },
      now: '2026-09-27T08:00:00.000Z',
      category: '需求',
    });
    expect(setup.ok).toBe(false);
    expect((await decide('leadPlan', { output: {}, specDir: 'specs/12-登录' })).ok).toBe(false);
    expect((await decide('leadReview', { output: {}, specDir: 'specs/12-登录', committed: [] })).ok).toBe(
      false,
    );
    expect(await decide('rebuttable', { head: 'h', results: [], findings: [] })).toEqual([]);
    expect(await decide('filesUnder', { paths: ['web/'], files: ['web/a.tsx', 'src/b.ts'] })).toEqual([
      'web/a.tsx',
    ]);
    const pr = await decide('fusionPr', {
      mode: 'single',
      planSummary: '加验证码',
      summary: '',
      testsPassed: true,
      verify: null,
      highRisk: false,
      planReviewSkipped: false,
      flowSource: 'project',
    });
    expect(pr.did[0]).toBe('方案：加验证码');
    const comment = await decide('closeComment', {
      prNumber: 7,
      mergeCommit: 'c'.repeat(40),
      did: ['加了验证码'],
      elapsedMs: 60_000,
      offClockMs: 0,
      usage: [],
      verified: pr.verified,
      owed: [],
      docs: { requirement: 'r', plan: 'p', result: 'x' },
      flowSource: 'project',
      mode: 'single',
    });
    expect(comment).toContain('做完了：PR #7 已合并');
  });

  it('【故意造出的失败】单子正文指的是别的单的需求文档：判认不出，不拿别人的顶', async () => {
    expect(await decide('specDir', { body: '文档：`specs/13-别的/需求.md`', issueNumber: 12 })).toEqual({
      error: expect.stringContaining('不是这张单 #12 的'),
    });
  });
});
