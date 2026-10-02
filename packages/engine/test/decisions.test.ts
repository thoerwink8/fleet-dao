// 流程判断全是纯函数：不起 Temporal 直接测。
// #556-2：Fusion 的判断（简报、验收、验证结论、状态机、Lead 检查、PR 正文、关单评论）和库主键（newIds）随 Fusion 删了，
// 只留 task.ts（#632）用的两样：上限（limits）和失败分流（failure）。
import { describe, expect, it } from 'vitest';
import { activityOptions, QUICK_TIMEOUT_SECONDS } from '../src/activity-options.ts';
import { createDecide, evidenceOf, nextAction, retryDelaySeconds } from '../src/decisions/index.ts';
import type { FailureVerdict } from '../src/failure/index.ts';
import { describeHolds, normalizeHolds } from '../src/holds.ts';
import {
  assertSessionFitsSlice,
  DEFAULT_LIMITS,
  FRANCE_RESIDENT_MB,
  FRANCE_USABLE_MB,
  historyAlertLine,
  LimitsConfigError,
  resolveLimits,
  SESSION_MEMORY_HIGH_MB,
  SESSION_MEMORY_MAX_MB,
  SLICE_MEMORY_HIGH_MB,
  SLICE_MEMORY_MAX_MB,
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

  it('会话内存上限（法国 2026-09-28 断链之后的新推导）：父节点 fleet-agents.slice 兜总量，单会话放宽到约一半', () => {
    // 父节点总上限 = 能分给会话的 - 平台常驻服务，软上限只比它低 512
    expect(SLICE_MEMORY_MAX_MB).toBe(FRANCE_USABLE_MB - FRANCE_RESIDENT_MB);
    expect(SLICE_MEMORY_HIGH_MB).toBe(SLICE_MEMORY_MAX_MB - 512);
    // 单会话硬上限比旧的三等分值（3554M）宽松得多——旧值连「tsc -b + 测试 + 代理」这一种会话内部的组合都放不下
    expect(SESSION_MEMORY_MAX_MB).toBeGreaterThan(3554);
    expect(DEFAULT_LIMITS).toMatchObject({ sessionMemoryMaxMb: 6144, sessionMemoryHighMb: 5888 });
    expect(DEFAULT_LIMITS.sessionMemoryHighMb).toBe(SESSION_MEMORY_HIGH_MB);
    // 但单会话的硬上限仍明显小于父节点的总上限：多个会话同时冲高时父节点兜得住，不是形同虚设
    expect(SESSION_MEMORY_MAX_MB).toBeLessThan(SLICE_MEMORY_MAX_MB);
    // 放得下法国实测开 2 个测试进程的峰值（约 2493 MiB，含页缓存）加 Claude Code（约 270）：原来的 1.5G / 2G 连 1 个都放不下
    expect(DEFAULT_LIMITS.sessionMemoryHighMb).toBeGreaterThan(2493 + 270);
  });

  it('【故意造出的失败】单会话硬上限配得比父节点总上限还大：校验要报错，不能悄悄用（否则父节点这道总闸形同没设）', () => {
    expect(() => assertSessionFitsSlice(SLICE_MEMORY_MAX_MB + 1, SLICE_MEMORY_MAX_MB)).toThrow(
      LimitsConfigError,
    );
    expect(() => assertSessionFitsSlice(SESSION_MEMORY_MAX_MB, SLICE_MEMORY_MAX_MB)).not.toThrow();
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

describe('人闸标记规整', () => {
  it('规整成小写、去重、排序；认不得的也留着（宁可多拦一次）', () => {
    expect(normalizeHolds([' Spend', 3, '', 'spend'])).toEqual(['spend']);
    expect(describeHolds(['release', 'spend', 'delete', '上线'])).toBe('对外发布、花钱、删数据、上线');
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

describe('这一次的花费（执行体报的是会话累计）', () => {
  it('头一回跑取累计；续会话取差；上一轮没读到就不给，不记 0', () => {
    expect(costOfRun(undefined, 0.3)).toBe(0.3);
    expect(costOfRun(0.3, 0.5)).toBe(0.2);
    expect(costOfRun(null, 0.5)).toBeUndefined();
    expect(costOfRun(0.3, undefined)).toBeUndefined();
    expect(costOfRun(0.5, 0.3)).toBe(0);
  });
});
