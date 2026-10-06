// 流程判断全是纯函数：不起 Temporal 直接测。
// #556-2：Fusion 的判断（简报、验收、验证结论、状态机、Lead 检查、PR 正文、关单评论）和库主键（newIds）随 Fusion 删了，
// 只留 task.ts（#632）用的两样：上限（limits）和失败分流（failure）。
import { describe, expect, it } from 'vitest';
import { createDecide, evidenceOf, nextAction, retryDelaySeconds } from '../src/decisions/index.ts';
import type { FailureVerdict } from '../src/failure/index.ts';
import {
  assertSessionFitsSlice,
  DEFAULT_LIMITS,
  FRANCE_RESIDENT_MB,
  FRANCE_USABLE_MB,
  LimitsConfigError,
  resolveLimits,
  SESSION_MEMORY_HIGH_MB,
  SESSION_MEMORY_MAX_MB,
  SLICE_MEMORY_HIGH_MB,
  SLICE_MEMORY_MAX_MB,
} from '../src/limits.ts';

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

  it('错误码不分大小写、原文也认：额度用满先等清零（续同一个会话），繁忙等一等，丢了的活原路重试', () => {
    const quota = nextAction({ failure: failure('quota_exhausted'), limits, routeBound: true });
    expect(quota).toMatchObject({ action: 'retry', wait: 'quota', resumeSame: true, rule: 'QT1' });
    expect(nextAction({ failure: failure('route_busy'), limits, routeBound: true })).toMatchObject({
      action: 'retry',
      wait: 'upstream',
      rule: 'BZ1',
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

  it('认不出的从重试爬起：重试两次，次数用完就挂起并报警（没有换路由、换模型这一级）', () => {
    const steps = [
      nextAction({ failure: failure('WEIRD'), limits, routeBound: true }),
      nextAction({ failure: failure('WEIRD'), counters: { retries: 1 }, limits, routeBound: true }),
      nextAction({ failure: failure('WEIRD'), counters: { retries: 2 }, limits, routeBound: true }),
    ];
    expect(steps.map((s) => s.action)).toEqual(['retry', 'retry', 'park']);
    expect(steps.map((s) => s.delaySeconds)).toEqual([15, 30, 0]);
    expect(steps.map((s) => s.counter)).toEqual(['retries', 'retries', null]);
    expect(steps.map((s) => s.classifiedAs)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(steps[2]?.alert).toBe(true);
  });

  it('上游繁忙、容量满、限流（没给等多久）：按默认等一等再来，不是挂起等人（D8、F2）', () => {
    for (const code of ['ROUTE_BUSY', 'CAPACITY', 'RATE_LIMITED']) {
      expect(nextAction({ failure: failure(code), limits, routeBound: true })).toMatchObject({
        action: 'retry',
        wait: 'upstream',
        delaySeconds: 60,
      });
    }
  });

  it('端口明说重试没用的（只对认不出的），不重试，直接挂起', () => {
    expect(nextAction({ failure: failure('WEIRD', false), limits, routeBound: true }).action).toBe('park');
    expect(nextAction({ failure: failure('WEIRD', false), limits, routeBound: false }).action).toBe('park');
  });

  it('账号池的事：封号直接挂起并报警、整池暂停；额度用满在 Claude 订阅池马上回去选路（等切号），别的池等到清零', () => {
    expect(nextAction({ failure: failure('account_banned'), limits, routeBound: true })).toMatchObject({
      action: 'park',
      alert: true,
      shared: { scope: 'pool' },
    });
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
    // 同样的额度用满在别的池：等到清零（上游给的时刻）。
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
  });

  it('设备被撤销：挂起（不换池、不等清零），整池暂停，写明去哪台机器、以谁的身份重新登录；人点继续后续同一个会话', () => {
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
    expect(next.humanFix).toContain('在「法国」上以会话用户 fleet-agent-carpool 重跑');
  });

  it('要人的直接挂起并报警', () => {
    expect(nextAction({ failure: failure('PERMISSION_DENIED'), limits, routeBound: true })).toMatchObject({
      action: 'park',
      alert: true,
    });
  });

  it('上一次失败的原文一字不差：原路再试不会变，直接挂起', () => {
    const again = nextAction({
      failure: { ...failure('agent_error'), message: 'socket hang up' },
      counters: { retries: 1 },
      limits,
      routeBound: true,
      context: { previousMessage: 'socket hang up' },
    });
    expect(again.action).toBe('park');
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

describe('渠道运行中失败：分流判停下又算这条路由的账，就换同一个模型的下一个渠道（#1118）', () => {
  const onChannel = {
    route: { routeId: 'r1', poolId: 'p1', modelId: 'm1', hostId: 'claude-code', channelId: 'c1' },
  };
  /** 「回话的模型不是点名的那个」：分流判停下（stop），算这条路由的账（routeOutcome fail）。 */
  const mismatch = failure('model_mismatch');

  it('停下 + 算路由的账 + 知道渠道：换渠道（swapRoute），记一次换路由、不报警、要标渠道不可用；原因写明第几次', () => {
    const next = nextAction({ failure: mismatch, limits, routeBound: true, context: onChannel });
    expect(next).toMatchObject({
      action: 'swapRoute',
      avoid: 'route',
      counter: 'routeSwaps',
      failChannel: true,
      resumeSame: false,
      delaySeconds: 0,
      alert: false,
      rule: 'MD3',
    });
    expect(next.reason).toContain('换同一个模型的下一个渠道（第 1/2 次）');
  });

  it('原路重试用完（认不出的、算路由的账）：也是换渠道，不是停下报人', () => {
    const steps = [0, 1, 2].map((retries) =>
      nextAction({
        failure: failure('WEIRD'),
        counters: { retries },
        limits,
        routeBound: true,
        context: onChannel,
      }),
    );
    expect(steps.map((s) => s.action)).toEqual(['retry', 'retry', 'swapRoute']);
    expect(steps[2]?.failChannel).toBe(true);
  });

  it('【故意造出的失败】换渠道的次数用完（所有渠道都试过）：停下报人，原因写明已经换过几次，不再换、不死循环', () => {
    const next = nextAction({
      failure: mismatch,
      counters: { routeSwaps: 2 },
      limits,
      routeBound: true,
      context: onChannel,
    });
    expect(next).toMatchObject({ action: 'park', alert: true });
    expect(next).not.toHaveProperty('failChannel');
    expect(next.reason).toContain('已换过 2 次渠道仍失败');
  });

  it('不换的：不知道渠道（老历史里的路由没有）、不绑路由、不算路由的账（账号封了、任务自己的问题）都照旧停下', () => {
    expect(nextAction({ failure: mismatch, limits, routeBound: true })).toMatchObject({ action: 'park' });
    expect(
      nextAction({
        failure: mismatch,
        limits,
        routeBound: true,
        context: { route: { ...onChannel.route, channelId: undefined } },
      }).action,
    ).toBe('park');
    expect(nextAction({ failure: mismatch, limits, routeBound: false, context: onChannel }).action).toBe(
      'park',
    );
    const banned = nextAction({
      failure: failure('account_banned'),
      limits,
      routeBound: true,
      context: onChannel,
    });
    expect(banned).toMatchObject({ action: 'park', alert: true });
    expect(banned).not.toHaveProperty('failChannel');
  });

  it('换上的分流不给 routeOutcome（读不出算不算路由的账）：不换，照旧停下，不当成算路由的账', () => {
    const triage = () =>
      ({
        action: 'park',
        delaySeconds: 0,
        reason: '换上的分流说挂起',
        rule: 'T1',
        title: '换上的',
        via: 'signal',
        classifiedAs: 'park',
        alert: true,
        counter: null,
        resumeSame: false,
      }) as unknown as FailureVerdict;
    expect(
      nextAction({ failure: mismatch, limits, routeBound: true, context: onChannel }, triage).action,
    ).toBe('park');
  });
});
