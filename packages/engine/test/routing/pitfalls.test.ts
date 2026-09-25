// docs/reference/quota.md 里跟选路有关的坑，逐条写成用例（编号对应手册）。
// 额度读取、失败分类那几条（Q1–Q6、Q9–Q10、Q12–Q16、Q18–Q29、D 系列）不归选路，在读额度与失败分流的测试里。
import type { StageKind } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { chooseRoute, type RouteFacts } from '../../src/routing/index.ts';
import { at, entry, input, route, win } from './helpers.ts';

describe('〇.1 / Q7 每个窗口都看，不只看最紧的那个', () => {
  it('周窗用了 55.7%（最紧）但 20 小时后清零：快清零的信号不丢，照样提前', () => {
    const relay = route('relay', {
      poolName: 'Mirasim 中转',
      windows: [
        win({ label: '5h', window: '5h', used: 0.008, resetsAt: at(3) }),
        win({ label: '7d', used: 0.557, resetsAt: at(20) }),
      ],
    });
    expect(chooseRoute(input([route('a'), relay]))).toMatchObject({ routeId: 'relay' });
  });
});

describe('〇.4 试探必须真派、并在派工记录上打标', () => {
  it('试探的结果就是派出去的路由，trial 标 explore', () => {
    const r = chooseRoute(input([route('a'), route('b')], { draw: 0.05, policy: { trialEnabled: true } }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: 'explore' });
  });
});

describe('Q8 模型组窗口只卡对应模型', () => {
  it('7d_fable 用满只挡带这个窗口的路由，其余照常', () => {
    const scoped = route('scoped', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [win({ label: '7d_x', window: '7d_model', scope: 'x', state: 'exhausted', used: 0.9904 })],
    });
    const other = route('other', { windows: [win({ label: '7d', used: 0.557 })] });
    expect(chooseRoute(input([scoped, other]))).toMatchObject({ routeId: 'other' });
  });
});

describe('Q11 读数过期不当现值', () => {
  it('过期的主池不当「还够」：排到读到了的后面，理由写额度未知', () => {
    const stale = route('stale', { quota: 'unknown', windows: [win({ state: 'stale' })] });
    const r = chooseRoute(input([stale, route('fresh')]));
    expect(r).toMatchObject({ routeId: 'fresh' });
    expect(r.verdicts[1]?.nudges.map((n) => n.kind)).toEqual(['quota-unknown']);
  });

  it('过期的备池不派', () => {
    const stale = route('stale', {
      poolRole: 'backup',
      quota: 'unknown',
      windows: [win({ state: 'stale' })],
    });
    expect(chooseRoute(input([stale], { stage: 'triage' })).kind).toBe('wait');
  });
});

describe('Q17 账号的失败不算到模型头上', () => {
  it('Grok 在 A 池战绩差，同一个模型在 B 池不受牵连', () => {
    const grok = { modelId: 'grok-4.7', modelName: 'Grok 4.7', family: 'grok', hostId: 'grok' as const };
    const xai = route('grok-xai', { ...grok, poolName: 'xAI', record: { samples: 145, successes: 23 } });
    const cursor = route('grok-cursor', {
      ...grok,
      poolName: 'Cursor',
      record: { samples: 20, successes: 19 },
    });
    const r = chooseRoute(input([xai, cursor]));
    expect(r).toMatchObject({ routeId: 'grok-cursor' });
    expect(r.verdicts.map((v) => [v.routeId, v.nudges.map((n) => n.kind)])).toEqual([
      ['grok-cursor', []],
      ['grok-xai', ['poor-record']],
    ]);
  });
});

describe('3.2 淘汰的候选留在列表里、带原因码', () => {
  it('被挡的每条都在 verdicts 里，带码和白话', () => {
    const r = chooseRoute(
      input([route('a', { blockers: ['offline'] }), route('b', { blockers: ['pool-expired'] }), route('c')]),
    );
    expect(r.verdicts.map((v) => [v.routeId, v.blocks.map((b) => b.code)])).toEqual([
      ['a', ['offline']],
      ['b', ['pool-expired']],
      ['c', []],
    ]);
  });
});

describe('3.3 战绩差只后置不淘汰', () => {
  it('全员战绩差：照样派，按人排的顺序', () => {
    const bad = (id: string) => route(id, { record: { samples: 20, successes: 2 } });
    expect(chooseRoute(input([bad('a'), bad('b')]))).toMatchObject({ kind: 'dispatch', routeId: 'a' });
  });
});

describe('R1 状态不许成化石：选路自己不存任何状态', () => {
  it('上一次挡住的路由，这一次事实变了就照常派（没有留在别处的冷却表）', () => {
    const blocked = chooseRoute(input([route('a', { blockers: ['offline'] }), route('b')]));
    expect(blocked).toMatchObject({ routeId: 'b' });
    expect(chooseRoute(input([route('a'), route('b')]))).toMatchObject({ routeId: 'a' });
  });

  it('快清零过了清零时刻就不再提前（按现在的时刻现算）', () => {
    const r = route('b', { windows: [win({ used: 0.3, resetsAt: at(-1) })] });
    expect(chooseRoute(input([route('a'), r]))).toMatchObject({ routeId: 'a' });
  });
});

describe('R2 改选路逻辑要对每个阶段读回首选', () => {
  // 一份典型的调度台：每个阶段各自的首选。改了选路规则，这张表变了要人看过再改（首选变了就是行为变了）。
  const catalog = (): RouteFacts[] => [
    route('solo', { poolName: '独享号' }),
    route('carpool', {
      poolName: '拼车号',
      poolRole: 'backup',
      windows: [win({ label: '5h', window: '5h', used: 0.1 }), win({ used: 0.4, resetsAt: at(20) })],
    }),
    route('gpt', { modelId: 'gpt-5.6-luna', modelName: 'GPT 5.6 luna', family: 'gpt', hostId: 'codex' }),
    route('shell', { modelId: 'kimi-k3', modelName: 'Kimi k3', family: 'kimi', hostId: 'api-shell' }),
  ];
  const firstChoice = (stage: StageKind, order: string[]) => {
    const r = chooseRoute(input(catalog(), { stage, order: order.map((id, i) => entry(id, i)) }));
    return r.kind === 'dispatch' ? r.routeId : r.kind;
  };

  it('每个阶段的首选', () => {
    const table = {
      triage: firstChoice('triage', ['shell', 'solo', 'carpool']),
      judge: firstChoice('judge', ['shell', 'solo']),
      spec: firstChoice('spec', ['solo', 'carpool']),
      plan: firstChoice('plan', ['solo', 'carpool']),
      execute: firstChoice('execute', ['solo', 'carpool', 'gpt']),
      ui: firstChoice('ui', ['gpt', 'solo']),
      review: firstChoice('review', ['gpt', 'solo']),
      research: firstChoice('research', ['shell', 'solo']),
    };
    expect(table).toEqual({
      triage: 'carpool', // 轻活，拼车号周额度快清零：提到接口外壳前面
      judge: 'shell',
      spec: 'carpool', // 轻活，同上
      plan: 'solo', // 重活，拼车号不接
      execute: 'solo',
      ui: 'solo', // GPT 不做 UI
      review: 'gpt',
      research: 'solo', // 接口外壳不会读仓库
    });
  });
});

describe('R3 没排序时不许按 id 字典序', () => {
  it('阶段没配顺序：派不出，提示人排', () => {
    const r = chooseRoute(input([route('aaa-cursor')], { configured: false }));
    expect(r.kind).toBe('none');
  });
});

describe('R4 同模型不同执行方式是两条路由', () => {
  it('Kimi 经 Mirasim 与经 Cursor 各算各的，避开一条不连累另一条', () => {
    const kimi = { modelId: 'kimi-k3', modelName: 'Kimi k3', family: 'kimi' };
    const viaMira = route('kimi-mirasim', { ...kimi, hostId: 'mirasim' });
    const viaCursor = route('kimi-cursor', { ...kimi, hostId: 'cursor-agent' });
    const r = chooseRoute(input([viaMira, viaCursor], { avoid: { routeIds: ['kimi-mirasim'] } }));
    expect(r).toMatchObject({ routeId: 'kimi-cursor' });
  });
});

describe('C1 并发按账号池计', () => {
  it('独享号满了不影响别的池', () => {
    const r = chooseRoute(
      input([route('solo', { blockers: ['no-slot'] }), route('relay', { hostId: 'mirasim' })]),
    );
    expect(r).toMatchObject({ routeId: 'relay' });
  });

  it('备池的上限按它自己池的在途数算', () => {
    const c = route('c', { poolRole: 'backup', inFlight: 1 });
    expect(chooseRoute(input([c], { stage: 'triage' }))).toMatchObject({ kind: 'dispatch', routeId: 'c' });
  });
});

describe('D2 探活失败的路由不选', () => {
  it('候选查询判不在线：不选，换下一条', () => {
    expect(chooseRoute(input([route('grok', { blockers: ['offline'] }), route('b')]))).toMatchObject({
      routeId: 'b',
    });
  });
});
