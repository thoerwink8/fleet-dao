// 过滤：每条规则一正一反。被挡的留原因，no-slot 不算坏（等空位），额度没读成的主池不挡。
import { describe, expect, it } from 'vitest';
import { blocksFor, type FilterContext, hostUnfit } from '../../src/routing/filter.ts';
import { groupOf } from '../../src/routing/group.ts';
import {
  DEFAULT_ROUTING_POLICY,
  HOST_ABILITIES,
  type RouteFacts,
  STAGE_NEEDS,
} from '../../src/routing/index.ts';
import { at, entry, NOW, route, win } from './helpers.ts';

function ctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    stage: 'execute',
    weight: 'heavy',
    policy: { ...DEFAULT_ROUTING_POLICY },
    now: Date.parse(NOW),
    avoid: { routeIds: new Set(), poolIds: new Set(), modelIds: new Set() },
    ...overrides,
  };
}
const codes = (r: RouteFacts, c = ctx(), e = entry(r.routeId, 0)) => blocksFor(r, e, c).map((b) => b.code);

describe('候选查询给的被挡原因', () => {
  it('没被挡的能派', () => {
    expect(codes(route('a'))).toEqual([]);
  });

  it.each([
    ['offline', '不在线'],
    ['channel-disabled', '渠道关了'],
    ['pool-expired', '订阅过期'],
    ['model-retired', '模型已下架'],
  ] as const)('%s 是硬挡，带白话', (code, text) => {
    const blocks = blocksFor(route('a', { blockers: [code] }), entry('a', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual([code]);
    expect(blocks[0]?.text).toContain(text);
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
  });

  it('no-slot 不算坏：等空位', () => {
    const blocks = blocksFor(route('a', { blockers: ['no-slot'], inFlight: 5 }), entry('a', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['no-slot']);
    expect(blocks[0]?.text).toContain('5/5');
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'slot', until: null });
  });

  it('quota-exhausted 等额度：最早能派 = 用满的窗口里最晚清零的那个', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [
        win({ label: '5h', window: '5h', state: 'exhausted', used: 1, resetsAt: at(2) }),
        win({ label: '7d', state: 'exhausted', used: 1, resetsAt: at(30) }),
      ],
    });
    const blocks = blocksFor(r, entry('a', 0), ctx());
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'quota', until: Date.parse(at(30)) });
  });

  it('用满的窗口不知道清零时刻：最早能派也不知道（不编一个）', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [win({ state: 'exhausted', used: 1, resetsAt: null })],
    });
    expect(groupOf(blocksFor(r, entry('a', 0), ctx()))).toEqual({
      kind: 'wait',
      waitFor: 'quota',
      until: null,
    });
  });

  it('额度没读成的主池不挡', () => {
    expect(codes(route('a', { quota: 'unknown', windows: [] }))).toEqual([]);
  });
});

describe('禁令用 shared 的硬禁令，候选查询漏了也挡', () => {
  it('Fable 就算候选查询没标 banned 也挡（按显示名认）', () => {
    const r = route('f', { modelId: 'x-5.1', modelName: 'Fable 5.1' });
    const blocks = blocksFor(r, entry('f', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['banned']);
    expect(blocks[0]?.text).toContain('不用 Fable');
  });

  it('GPT 在 UI 阶段挡，在写码阶段不挡', () => {
    const gpt = route('g', {
      modelId: 'gpt-5.6-luna',
      modelName: 'GPT 5.6 luna',
      family: 'gpt',
      hostId: 'codex',
    });
    expect(codes(gpt, ctx({ stage: 'ui' }))).toEqual(['banned']);
    expect(codes(gpt, ctx({ stage: 'execute' }))).toEqual([]);
  });

  it('库里的禁令原因照写，不重复', () => {
    const r = route('k', { blockers: ['banned'], banReasons: ['创始人另加：Kimi 不做审查'] });
    const blocks = blocksFor(r, entry('k', 0), ctx({ stage: 'review' }));
    expect(blocks.map((b) => b.text)).toEqual(['犯禁令：创始人另加：Kimi 不做审查']);
  });
});

describe('单条开关', () => {
  it('关着的不派；开着的派', () => {
    expect(codes(route('a'), ctx(), entry('a', 0, { enabled: false }))).toEqual(['switched-off']);
    expect(codes(route('a'), ctx(), entry('a', 0, { enabled: true }))).toEqual([]);
  });
});

describe('执行方式 × 阶段是数据', () => {
  it('每个阶段都写了要什么，每个执行方式都写了会什么', () => {
    expect(Object.keys(STAGE_NEEDS).sort()).toEqual(
      ['execute', 'judge', 'plan', 'research', 'review', 'spec', 'triage', 'ui'].sort(),
    );
    expect(Object.keys(HOST_ABILITIES).sort()).toEqual(
      ['api-shell', 'claude-code', 'codex', 'cursor-agent', 'grok', 'mirasim'].sort(),
    );
  });

  it('写码、UI 要能改文件：接口外壳挡；判断题、分诊接口外壳和命令行都行', () => {
    expect(hostUnfit('api-shell', 'execute')).toContain('改文件');
    expect(hostUnfit('api-shell', 'ui')).toContain('改文件');
    expect(hostUnfit('api-shell', 'judge')).toBeNull();
    expect(hostUnfit('api-shell', 'triage')).toBeNull();
    expect(hostUnfit('claude-code', 'judge')).toBeNull();
    expect(hostUnfit('cursor-agent', 'execute')).toBeNull();
  });

  it('认不出的执行方式挡（不当它什么都会）', () => {
    expect(codes(route('x', { hostId: 'teleport' as never }))).toEqual(['host-unfit']);
  });
});

describe('熔断', () => {
  it('none 挡，等到试探时刻', () => {
    const r = route('a', {
      breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(0.2) },
    });
    const blocks = blocksFor(r, entry('a', 0), ctx());
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'breaker', until: Date.parse(at(0.2)) });
  });

  it('trial 放（已经有试探在途时熔断自己判 none）；all 放', () => {
    expect(
      codes(route('a', { breaker: { state: 'half_open', admit: 'trial', reason: '冷却到点' } })),
    ).toEqual([]);
    expect(codes(route('a'))).toEqual([]);
  });
});

describe('避开', () => {
  it('按路由、池、模型避开；不相干的不挡', () => {
    const avoid = (a: Partial<FilterContext['avoid']>) =>
      ctx({ avoid: { routeIds: new Set(), poolIds: new Set(), modelIds: new Set(), ...a } });
    expect(codes(route('a'), avoid({ routeIds: new Set(['a']) }))).toEqual(['avoided']);
    expect(codes(route('a'), avoid({ poolIds: new Set(['pool-a']) }))).toEqual(['avoided']);
    expect(codes(route('a'), avoid({ modelIds: new Set(['opus-5.5']) }))).toEqual(['avoided']);
    expect(codes(route('a'), avoid({ routeIds: new Set(['b']) }))).toEqual([]);
  });
});

describe('备池（拼车号）', () => {
  const carpool = (o: Partial<RouteFacts> = {}) =>
    route('c', { poolRole: 'backup', poolName: '拼车号', ...o });

  it('只接短而轻的活：重活挡，轻活放', () => {
    expect(codes(carpool(), ctx({ weight: 'heavy' }))).toEqual(['backup-heavy']);
    expect(codes(carpool(), ctx({ weight: 'light' }))).toEqual([]);
  });

  it('主池不管轻重', () => {
    expect(codes(route('a'), ctx({ weight: 'heavy' }))).toEqual([]);
  });

  it('并发不超过 2：在跑 2 个就等空位，1 个放', () => {
    const light = ctx({ weight: 'light' });
    const full = blocksFor(carpool({ inFlight: 2 }), entry('c', 0), light);
    expect(full.map((b) => b.code)).toEqual(['backup-no-slot']);
    expect(groupOf(full)).toEqual({ kind: 'wait', waitFor: 'slot', until: null });
    expect(codes(carpool({ inFlight: 1 }), light)).toEqual([]);
  });

  it('池自己的上限更小时按池的', () => {
    expect(codes(carpool({ inFlight: 1, maxConcurrency: 1 }), ctx({ weight: 'light' }))).toEqual([
      'backup-no-slot',
    ]);
  });

  it('剩余不够跑一个活不派，等那个窗口清零；够就派', () => {
    const light = ctx({ weight: 'light' });
    const short = carpool({
      windows: [win({ label: '5h', window: '5h', used: 0.95, resetsAt: at(1) }), win()],
    });
    const blocks = blocksFor(short, entry('c', 0), light);
    expect(blocks.map((b) => b.code)).toEqual(['backup-quota-short']);
    expect(blocks[0]?.text).toContain('只剩 5%');
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'quota', until: Date.parse(at(1)) });
    const enough = carpool({
      windows: [win({ label: '5h', window: '5h', used: 0.85, resetsAt: at(1) }), win()],
    });
    expect(codes(enough, light)).toEqual([]);
  });

  it('周窗只剩 2% 也不派（一个活要 3%）', () => {
    const r = carpool({ windows: [win({ used: 0.98 })] });
    expect(codes(r, ctx({ weight: 'light' }))).toEqual(['backup-quota-short']);
  });

  it('额度没读成：判不了够不够，不派（主池额度未知照常派）', () => {
    const r = carpool({ quota: 'unknown', windows: [] });
    const blocks = blocksFor(r, entry('c', 0), ctx({ weight: 'light' }));
    expect(blocks.map((b) => b.code)).toEqual(['backup-quota-unknown']);
    expect(blocks[0]?.text).toContain('额度未知');
  });

  it('已用比例算不出来：同样判不了，不派', () => {
    const r = carpool({ windows: [win({ used: null })] });
    expect(codes(r, ctx({ weight: 'light' }))).toEqual(['backup-quota-unknown']);
  });
});
