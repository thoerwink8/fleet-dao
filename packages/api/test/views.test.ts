import {
  type Channel,
  hardBanFor,
  LEGACY_ASK_CLOSED_ANSWER,
  type Model,
  type Route,
  type SessionRun,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { AskRecord, SegmentRunRecord } from '../src/ports.ts';
import {
  askLate,
  findBan,
  homeDecisions,
  jobView,
  legacyAskViews,
  routeLookup,
  routeProblem,
  runView,
  segmentRunViews,
  usageView,
} from '../src/views.ts';

const gpt: Model = { id: 'gpt-5.6', family: 'GPT', displayName: 'GPT 5.6' };
const opus: Model = { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' };
/** Fable 算在 claude 族里。 */
const fable: Model = { id: 'claude-fable-5-1', family: 'claude', displayName: 'Fable 5.1' };

const route = (id: string, modelId: string): Route => ({
  id,
  channelId: 'c',
  poolId: 'p',
  modelId,
  hostId: 'claude-code',
  alive: true,
});

describe('硬禁令（写死在 shared/bans.ts）', () => {
  it('GPT 按族认、不做 UI（族名不分大小写）', () => {
    expect(hardBanFor(gpt, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor({ ...gpt, family: ' gpt ' }, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor(opus, 'ui')).toBeUndefined();
    // 族写成 openai、或族写错了但名字里带 gpt，照样认成 GPT。
    expect(hardBanFor({ ...gpt, family: 'OpenAI' }, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor({ ...gpt, family: 'luna' }, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor({ ...gpt, family: 'openai' }, 'review')).toBeUndefined();
  });

  it('判路由时连上游串和别名一起看：模型叫 opus、上游发的是 Fable 或 GPT，照样拦', () => {
    expect(hardBanFor({ ...opus, upstreamModel: 'claude-fable-5-1' }, 'execute')?.id).toBe('no-fable');
    expect(hardBanFor({ ...opus, upstreamAliases: ['fable'] }, 'execute')?.id).toBe('no-fable');
    expect(hardBanFor({ ...opus, upstreamModel: 'gpt-5.6' }, 'ui')?.id).toBe('gpt-no-ui');
    expect(
      hardBanFor({ ...opus, upstreamModel: 'claude-opus-5-5', upstreamAliases: [] }, 'ui'),
    ).toBeUndefined();
  });

  it('Fable 按模型认（它属 claude 族），哪个阶段都不用', () => {
    for (const stage of ['triage', 'execute', 'ui', 'review', undefined] as const) {
      expect(hardBanFor(fable, stage)?.id).toBe('no-fable');
    }
    expect(hardBanFor({ ...opus, id: 'x-FABLE' }, 'execute')?.id).toBe('no-fable');
    expect(hardBanFor(opus, 'execute')).toBeUndefined();
  });

  it('库里的 bans 表是空的，路由检查照样被硬禁令拦下', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const ctx = {
      route: routeLookup([route('r-gpt', gpt.id), route('r-fable', fable.id)], [gpt, fable]),
      bans: [],
      now,
    };
    expect(routeProblem('r-gpt', 'ui', ctx)).toContain('GPT 不做 UI');
    expect(routeProblem('r-fable', 'execute', ctx)).toContain('不用 Fable');
  });
});

describe('库里配的禁令', () => {
  const bans = [
    { family: 'kimi', stage: 'ui' as const, reason: '库里配的：Kimi 不进 UI' },
    { stage: 'review' as const, reason: '只写了阶段的禁令不算数' },
  ];
  const kimi: Model = { id: 'kimi-k3', family: 'Kimi', displayName: 'Kimi k3' };

  it('和硬禁令一起生效；只写阶段、没写族或模型的不生效', () => {
    expect(findBan(kimi, 'ui', bans)?.reason).toBe('库里配的：Kimi 不进 UI');
    expect(findBan(opus, 'review', bans)).toBeUndefined();
    const now = new Date('2026-09-25T08:00:00Z');
    const ctx = { route: routeLookup([route('r-kimi', kimi.id)], [kimi]), bans, now };
    expect(routeProblem('r-kimi', 'ui', ctx)).toContain('Kimi 不进 UI');
  });

  it('已下架的模型、目录里没有的模型、不存在的路由都不许挂', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const old: Model = {
      id: 'old',
      family: 'claude',
      displayName: '老模型',
      retiredAt: '2026-09-01T00:00:00Z',
    };
    const ctx = {
      route: routeLookup([route('r-old', 'old'), route('r-ghost', 'ghost')], [old]),
      bans,
      now,
    };
    expect(routeProblem('r-old', 'execute', ctx)).toContain('已下架');
    expect(routeProblem('r-ghost', 'execute', ctx)).toContain('不在模型目录里');
    expect(routeProblem('r-none', 'execute', ctx)).toContain('不存在');
  });
});

describe('旧追问的展示（#928）', () => {
  const ask = (id: string, taskId: string): AskRecord => ({
    id,
    taskId,
    runId: 'r1',
    question: '几位？',
    options: ['4', '6'],
    askedAt: '2026-09-25T08:00:00Z',
  });

  it('legacyAskViews：带「#号 标题」背景和任务页链接；单子读不到照样给出这一条（要能被关掉），只是没有背景', () => {
    const views = legacyAskViews([ask('a1', 't1'), ask('a2', 'gone')], (id) =>
      id === 't1' ? { issueNumber: 12, title: '登录页加验证码' } : undefined,
    );
    expect(views).toEqual([
      {
        id: 'a1',
        taskId: 't1',
        question: '几位？',
        askedAt: '2026-09-25T08:00:00Z',
        context: '#12 登录页加验证码',
        link: '/tasks/t1',
      },
      { id: 'a2', taskId: 'gone', question: '几位？', askedAt: '2026-09-25T08:00:00Z', link: '/tasks/gone' },
    ]);
  });

  it('关闭写进去的标记不冒充回答：按推荐先做的追问被关闭后，不算出「回答之后会怎样」', () => {
    const scoped: AskRecord = { ...ask('a1', 't1'), scope: 'task', recommended: '4' };
    expect(askLate({ ...scoped, answer: '6' }, 'running')).toBeDefined();
    expect(askLate({ ...scoped, answer: LEGACY_ASK_CLOSED_ANSWER }, 'running')).toBeUndefined();
  });

  it('主页「要你拍的」只有通知：没有任何一条叫追问', () => {
    const decisions = homeDecisions({ notifications: [], taskOf: () => undefined });
    expect(decisions).toEqual([]);
  });
});

describe('定时任务新鲜度', () => {
  it('上次跑成超过 expectEveryMinutes 就算过期（这个数登记时已含余量，不再加倍）；从没跑成是 never', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const job = (minutesAgo: number) => ({
      id: 'j',
      name: 'j',
      schedule: '每小时',
      expectEveryMinutes: 75,
      lastSuccessAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    });
    expect(jobView(job(74), now).status).toBe('fresh');
    expect(jobView(job(76), now).status).toBe('overdue');
    expect(jobView({ id: 'j', name: 'j', schedule: '每小时', expectEveryMinutes: 75 }, now).status).toBe(
      'never',
    );
  });

  it('四种结局原样给前端（partial 也是跑成，算新鲜）', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const view = jobView(
      {
        id: 'j',
        name: 'j',
        schedule: '每小时',
        expectEveryMinutes: 75,
        lastRun: {
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          outcome: 'partial',
          scanned: 4,
          why: '一个仓没查成',
        },
        lastSuccessAt: now.toISOString(),
      },
      now,
    );
    expect(view).toMatchObject({ status: 'fresh', lastRun: { outcome: 'partial', scanned: 4 } });
  });
});

describe('任务详情的花费分清按量、套餐内', () => {
  const channels: Channel[] = [
    { id: 'c', name: '订阅', billing: 'subscription', enabled: true },
    { id: 'm', name: '按量接口', billing: 'metered', enabled: true },
  ];
  const onChannel = (id: string, channelId: string): Route => ({ ...route(id, opus.id), channelId });
  const ended = (id: string, routeId: string, costUsd?: number): SessionRun => ({
    id,
    stage: 'execute',
    routeId,
    whyRoute: '测试',
    queuedAt: '2026-09-27T01:00:00.000Z',
    startedAt: '2026-09-27T01:01:00.000Z',
    endedAt: '2026-09-27T01:11:00.000Z',
    outcome: 'ok',
    ...(costUsd === undefined ? {} : { costUsd }),
  });

  it('计费方式从路由所在的渠道来：会话带上它，汇总按它分', () => {
    const route = routeLookup([onChannel('r-sub', 'c'), onChannel('r-api', 'm')], [opus], channels);
    expect(runView(ended('a', 'r-api', 0.04), route('r-api')).billing).toBe('metered');
    const usage = usageView(
      [ended('a', 'r-api', 0.04), ended('b', 'r-sub', 0.25), ended('c', 'r-sub')],
      route,
    );
    expect(usage.total.cost).toEqual({
      metered: { runs: 1, usd: 0.04, missing: 0 },
      subscription: { runs: 2, usd: 0.25, missing: 1 },
      unknown: { runs: 0, usd: 0, missing: 0 },
    });
  });

  it('渠道查不到、路由查不到、没传渠道表：计费方式留空，汇总记进分不清，不猜成套餐内', () => {
    const route = routeLookup([onChannel('r-lost', 'gone'), onChannel('r-sub', 'c')], [opus], channels);
    expect(route('r-lost').billing).toBeUndefined();
    expect(route('r-none').billing).toBeUndefined();
    expect(routeLookup([onChannel('r-sub', 'c')], [opus])('r-sub').billing).toBeUndefined();
    const usage = usageView([ended('a', 'r-lost', 0.1), ended('b', 'r-none')], route);
    expect(usage.total.cost.unknown).toEqual({ runs: 2, usd: 0.1, missing: 1 });
    expect(usage.total.cost.subscription.runs).toBe(0);
  });

  it('三段的一笔：模型名查目录（查不到照写模型编号），计费方式查渠道（渠道没记、查不到都不给，汇总记进分不清）', () => {
    const seg = (id: string, model: string, channel?: string): SegmentRunRecord => ({
      id,
      segment: 'verify',
      taskId: 't',
      model,
      ...(channel === undefined ? {} : { channel }),
      startedAt: '2026-09-27T01:00:00.000Z',
      endedAt: '2026-09-27T01:08:00.000Z',
      outcome: 'done',
      costUsd: 0.1,
      matchedBy: 'task',
    });
    const views = segmentRunViews([seg('a', opus.id, 'm'), seg('b', 'mystery-9', 'gone'), seg('c', gpt.id)], {
      models: [opus, gpt],
      channels,
      taskFinished: true,
    });
    expect(views.map((v) => [v.modelName, v.billing ?? null])).toEqual([
      ['Opus 5.5', 'metered'],
      ['mystery-9', null],
      ['GPT 5.6', null],
    ]);
    const usage = usageView([], routeLookup([], []), views);
    expect(usage.total.cost.metered).toEqual({ runs: 1, usd: 0.1, missing: 0 });
    expect(usage.total.cost.unknown).toEqual({ runs: 2, usd: 0.2, missing: 0 });
  });
});
