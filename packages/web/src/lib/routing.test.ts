// 路由页的白话和先看哪个（#574）：走的是不是首选、派不出去怎么说、进页面先看哪个用途、探针结论过没过期。
import { ROUTE_PROBE_STALE_MINUTES } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import type {
  LivenessVerdict,
  RoutingLayerModel,
  RoutingLayerPurpose,
  RoutingLayerRoute,
} from '../api/types';
import { TIME } from './format';
import {
  countByVerdict,
  firstLive,
  modelSummary,
  onFallback,
  pickPurpose,
  probeStale,
  purposeLine,
  routeSlots,
} from './routing';
import { actualRanks, modelSlotState, slotWord } from './routing-order';

describe('routeSlots：账号池满不满（#800，和引擎选路同一个判法）', () => {
  test('池上限 3、1 个在跑、2 个已选定还没开跑：满了，两样各写明（只数在跑的会说 1/3 没满）', () => {
    const s = routeSlots({ inFlight: 1, reserved: 2, maxConcurrency: 3 });
    expect(s).toMatchObject({ full: true, occupied: 3 });
    expect(s.count).toBe('3/3（在跑 1、已选定还没开跑 2）');
    expect(s.text).toBe('占 3/3（在跑 1、已选定还没开跑 2）');
  });

  test('没有已选定的：照旧写「在跑 1/3」，没满', () => {
    const s = routeSlots({ inFlight: 1, reserved: 0, maxConcurrency: 3 });
    expect(s).toMatchObject({ full: false, occupied: 1, count: '1/3', text: '在跑 1/3' });
  });

  test('预占过期被收掉（reserved 回到 0）、引擎重启清掉预占后：不再算满', () => {
    expect(routeSlots({ inFlight: 1, reserved: 2, maxConcurrency: 3 }).full).toBe(true);
    expect(routeSlots({ inFlight: 1, reserved: 0, maxConcurrency: 3 }).full).toBe(false);
  });

  test('【故意造出的失败】接口给的数不是非负整数：明确抛，不画成没满', () => {
    expect(() => routeSlots({ inFlight: 1, reserved: -1, maxConcurrency: 3 })).toThrow(/已选定数/);
  });
});

const NOW = Date.parse('2026-10-04T10:00:00Z');
const ago = (min: number) => new Date(NOW - min * TIME.MIN).toISOString();

const fact = (verdict: LivenessVerdict) => ({ verdict, reason: `原因：${verdict}` });

function route(
  id: string,
  verdict: LivenessVerdict,
  over: Partial<RoutingLayerRoute> = {},
): RoutingLayerRoute {
  return {
    routeId: id,
    channelId: 'ch',
    channelName: 'Claude 订阅',
    poolId: `pool-${id}`,
    hostId: 'claude-code',
    enabled: true,
    verdict,
    connect: fact(verdict),
    quota: fact('live'),
    ban: fact('live'),
    exhausted: [],
    inFlight: 0,
    reserved: 0,
    maxConcurrency: 2,
    ...over,
  };
}

function model(id: string, routes: RoutingLayerRoute[], verdict?: LivenessVerdict): RoutingLayerModel {
  const v =
    verdict ??
    (routes.some((r) => r.verdict === 'live')
      ? 'live'
      : routes.some((r) => r.verdict === 'unknown')
        ? 'unknown'
        : 'dead');
  return { modelId: id, displayName: id.toUpperCase(), verdict: v, routes };
}

function purpose(
  name: RoutingLayerPurpose['purpose'],
  models: RoutingLayerModel[],
  verdict: LivenessVerdict,
  problems: string[] = [],
): RoutingLayerPurpose {
  return { purpose: name, version: 0, verdict, problems, models };
}

describe('走的是不是首选', () => {
  test('第 1 个模型的第 1 条活着：首选活着，不算靠后备', () => {
    const p = purpose('execute', [model('opus', [route('a', 'live'), route('b', 'dead')])], 'live');
    expect(firstLive(p)).toMatchObject({ modelIndex: 0, routeIndex: 0 });
    expect(onFallback(p)).toBe(false);
    expect(purposeLine(p)).toEqual({ text: '首选活着：OPUS（Claude 订阅 · pool-a）', tone: 'done' });
  });

  test('首选那条路死了、同模型第 2 条活着：写明在用它的第 2 条', () => {
    const p = purpose('execute', [model('opus', [route('a', 'dead'), route('b', 'live')])], 'live');
    expect(onFallback(p)).toBe(true);
    expect(purposeLine(p)).toEqual({
      text: '首选那条路不行，顺位第一条活的是它的第 2 条：OPUS（Claude 订阅 · pool-b）',
      tone: 'stall',
    });
  });

  test('首选模型整个不行（不知道也算不行）：写首选不可用、实际派谁，不写第几个模型', () => {
    const p = purpose(
      'review',
      [model('grok', [route('g', 'unknown')]), model('gpt', [route('x', 'dead'), route('y', 'live')])],
      'live',
    );
    expect(firstLive(p)).toMatchObject({ modelIndex: 1, routeIndex: 1 });
    expect(purposeLine(p)).toEqual({
      text: '首选 GROK 不可用，实际派 GPT',
      tone: 'stall',
    });
  });

  test('首选已关：写首选已关、实际派谁', () => {
    const p = purpose(
      'execute',
      [
        model('grok', [route('g', 'dead', { enabled: false }), route('h', 'dead', { enabled: false })]),
        model('cursor', [route('c', 'live')]),
      ],
      'live',
    );
    expect(purposeLine(p)).toEqual({
      text: '首选 GROK 已关，实际派 CURSOR',
      tone: 'stall',
    });
  });

  test('前面有一个已下架的：顶部实际第几位和下架不占名次照旧；说明写首选已关', () => {
    const off = model('kimi', [route('k', 'dead', { enabled: false })]);
    const retired = model('opus-5', [route('old', 'dead')]);
    const live = model('opus', [route('a', 'live')]);
    const p = purpose('execute', [off, retired, live], 'live');
    const env = {
      retired: (id: string) => id === 'opus-5',
      channelOpen: () => true as boolean | undefined,
    };
    const states = p.models.map((m) => modelSlotState(m, env.channelOpen, env.retired(m.modelId)));
    const ranks = actualRanks(states);
    const liveRank = ranks[2];
    expect(states[1]).toBe('retired');
    expect(slotWord(states[1] ?? 'retired', ranks[1] ?? null, '模型')).toBe('已下架');
    expect(liveRank).toBe(1);
    expect(slotWord(states[2] ?? 'on', liveRank ?? null, '模型')).toBe('实际第 1 位');
    expect(purposeLine(p, env)).toEqual({
      text: '首选 KIMI 已关，实际派 OPUS',
      tone: 'stall',
    });
  });
  test('一条活的都没有、有不知道的：说没有确定活着的、几条不知道，不说派不出去', () => {
    const p = purpose(
      'review',
      [model('grok', [route('g', 'unknown'), route('h', 'dead')]), model('gpt', [route('y', 'unknown')])],
      'unknown',
    );
    expect(firstLive(p)).toBeUndefined();
    expect(purposeLine(p)).toEqual({
      text: '没有确定活着的：2 条不知道（探针没看过、额度没读成）',
      tone: 'stall',
    });
  });

  test('【故意造出的失败】这个用途没有模型：照后端写的缺口说，派不了', () => {
    const p = purpose('verify', [], 'dead', ['这个用途没有模型，派不了']);
    expect(purposeLine(p)).toEqual({ text: '这个用途没有模型，派不了', tone: 'fail' });
    expect(purposeLine(purpose('verify', [], 'dead', [])).text).toBe('这个用途没有模型，派不了');
  });

  test('【故意造出的失败】全死：派不出去，指向下面逐条的原因', () => {
    const p = purpose('execute', [model('opus', [route('a', 'dead')])], 'dead');
    expect(purposeLine(p)).toEqual({ text: '一条活的都没有：下面逐条写了为什么', tone: 'fail' });
  });
});

describe('进页面先看哪个用途', () => {
  const live = purpose('triage', [model('opus', [route('a', 'live')])], 'live');
  const fallback = purpose('plan', [model('opus', [route('a', 'dead'), route('b', 'live')])], 'live');
  const unknown = purpose('review', [model('grok', [route('g', 'unknown')])], 'unknown');
  const dead = purpose('verify', [], 'dead', ['这个用途没有模型，派不了']);

  test('网址里点名的优先', () => {
    expect(pickPurpose([live, dead], 'triage')?.purpose).toBe('triage');
  });

  test('没点名：派不出去的 → 不知道的 → 靠后备撑着的 → 第一个', () => {
    expect(pickPurpose([live, fallback, unknown, dead], null)?.purpose).toBe('verify');
    expect(pickPurpose([live, fallback, unknown], null)?.purpose).toBe('review');
    expect(pickPurpose([live, fallback], null)?.purpose).toBe('plan');
    expect(pickPurpose([live], null)?.purpose).toBe('triage');
  });

  test('点名写错了（不在列表里）：照没点名算', () => {
    expect(pickPurpose([live, dead], 'nope')?.purpose).toBe('verify');
  });

  test('各结论几个用途', () => {
    expect(countByVerdict([live, fallback, unknown, dead])).toEqual({ live: 2, unknown: 1, dead: 1 });
  });
});

describe('一个模型几条路、几条活', () => {
  test('有路：几条、几条活', () => {
    expect(modelSummary(model('opus', [route('a', 'live'), route('b', 'dead')]))).toBe('2 条路，1 条活');
  });

  test('【故意造出的失败】一条路由都没有：照说，不写成「0 条活」', () => {
    expect(modelSummary(model('opus', [], 'dead'))).toBe('一条路由都没有');
  });
});

describe('探针结论过没过期（和引擎同一条线）', () => {
  test('每轮都探的：过了过期线算过期，没过不算；没探过不算过期', () => {
    expect(probeStale(route('a', 'live', { probedAt: ago(ROUTE_PROBE_STALE_MINUTES - 1) }), NOW)).toBe(false);
    expect(probeStale(route('a', 'live', { probedAt: ago(ROUTE_PROBE_STALE_MINUTES + 1) }), NOW)).toBe(true);
    expect(probeStale(route('a', 'unknown'), NOW)).toBe(false);
  });

  test('放慢的执行方式（cursor-agent 两小时一探）：按它自己的间隔算，一小时前的不算过期', () => {
    expect(probeStale(route('c', 'live', { hostId: 'cursor-agent', probedAt: ago(60) }), NOW)).toBe(false);
    expect(probeStale(route('c', 'live', { hostId: 'cursor-agent', probedAt: ago(200) }), NOW)).toBe(true);
  });

  test('退避中、或写了隔 30 分钟再探：过期线按那一档，不标成探针停了', () => {
    const backing = '没通。退避中，下次约 16:07 再探（连着不通 6 次）';
    expect(
      probeStale(
        route('b', 'dead', {
          probedAt: ago(200),
          probeDetail: backing,
          connect: { verdict: 'dead', reason: `探针判不在线：${backing}` },
        }),
        NOW,
      ),
    ).toBe(false);
    expect(probeStale(route('b', 'dead', { probedAt: ago(280), probeDetail: backing }), NOW)).toBe(true);
    const deferred = '答上了：OK。用途前 2 位，隔 30 分钟再探';
    expect(probeStale(route('d', 'live', { probedAt: ago(60), probeDetail: deferred }), NOW)).toBe(false);
    expect(probeStale(route('d', 'live', { probedAt: ago(80), probeDetail: deferred }), NOW)).toBe(true);
    // 按需探测：不主动探，放多久都不算探针停了
    const onDemand = '不主动探，要派给它时先探一次。上一次真探：通，10-09 08:00';
    expect(probeStale(route('o', 'unknown', { probedAt: ago(5000), probeDetail: onDemand }), NOW)).toBe(
      false,
    );
  });
});
