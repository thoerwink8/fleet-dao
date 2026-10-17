import { describe, expect, it } from 'vitest';
import { chooseRoute } from '../../src/routing/index.ts';
import { sharePick } from '../../src/routing/share.ts';
import { entry, input, route } from './helpers.ts';

const grok = (id: string, over: Parameters<typeof route>[1] = {}) =>
  route(id, { modelId: 'grok-4.7', modelName: 'Grok 4.7', poolName: id, ...over });

function banded(routes: ReturnType<typeof route>[], weights: number[], band = 0) {
  return input(routes, {
    order: routes.map((r, i) => entry(r.routeId, i, { shareBand: band, shareWeight: weights[i] ?? 1 })),
  });
}

function picked(routes: ReturnType<typeof route>[], weights: number[], draw: number, weighted = false) {
  const base = banded(routes, weights);
  const result = chooseRoute(
    weighted
      ? input(routes, {
          ...base,
          policy: { allocate: { mode: 'weighted' } },
          draw,
        })
      : { ...base, draw },
  );
  if (result.kind !== 'dispatch') throw new Error(result.reason);
  return result;
}

describe('同一档按权重分', () => {
  it('权重一样不总取第一条', () => {
    expect(sharePick([1, 1], 0.6)).toBe(1);
    const routes = [grok('sub'), grok('cursor')];
    const counts: [number, number] = [0, 0];
    for (let i = 0; i < 100; i += 1) {
      const draw = i / 100;
      counts[picked(routes, [1, 1], draw).routeId === 'sub' ? 0 : 1] += 1;
      counts[picked(routes, [1, 1], draw, true).routeId === 'sub' ? 0 : 1] += 1;
    }
    expect(counts[0]).toBe(100);
    expect(counts[1]).toBe(100);
  });

  it('权重 2:1', () => {
    const routes = [grok('sub'), grok('cursor')];
    expect(picked(routes, [2, 1], 0.1).routeId).toBe('sub');
    expect(picked(routes, [2, 1], 0.8).routeId).toBe('cursor');
    expect(picked(routes, [2, 1], 0.8, true).why).toContain('同一档按权重分');
  });

  it('同一个种子两次一样', () => {
    const routes = [grok('sub'), grok('cursor')];
    const once = chooseRoute({ ...banded(routes, [1, 1]), allocateSeed: 'task-1:manual:1' });
    const twice = chooseRoute({ ...banded(routes, [1, 1]), allocateSeed: 'task-1:manual:1' });
    expect(once).toMatchObject({ kind: 'dispatch', routeId: twice.kind === 'dispatch' ? twice.routeId : '' });
    if (once.kind === 'dispatch') expect(once.why).toContain('种子 task-1:manual:1');
  });

  it('一条派不出去，另一条接住', () => {
    const cases = [
      grok('cursor', { quota: 'exhausted', blockers: ['quota-exhausted'] }),
      grok('cursor', { blockers: ['offline'] }),
      grok('cursor', { breaker: { state: 'open', admit: 'none', reason: '熔断' } }),
    ];
    for (const other of cases) {
      const routes = [grok('sub'), other];
      expect(picked(routes, [1, 1], 0.9).routeId).toBe('sub');
      expect(picked(routes, [1, 1], 0.9, true).routeId).toBe('sub');
    }
    const off = banded([grok('sub'), grok('cursor')], [1, 1]);
    off.order[1] = entry('cursor', 1, { shareBand: 0, shareWeight: 1, enabled: false });
    const result = chooseRoute({ ...off, draw: 0.9 });
    expect(result).toMatchObject({ kind: 'dispatch', routeId: 'sub' });
  });

  it('不是同一档、或钉住了，仍取第一条', () => {
    const a = grok('sub');
    const b = grok('cursor');
    const otherModel = input([a, route('other', { modelId: 'opus-5.5', modelName: 'Opus' })], {
      order: [
        entry('sub', 0, { shareBand: 0, shareWeight: 1 }),
        entry('other', 1, { shareBand: 0, shareWeight: 1 }),
      ],
      draw: 0.9,
    });
    expect(chooseRoute(otherModel)).toMatchObject({ kind: 'dispatch', routeId: 'sub' });
    expect(chooseRoute({ ...input([a, b]), draw: 0.9 })).toMatchObject({ kind: 'dispatch', routeId: 'sub' });
    const pinned = input([a, b], {
      order: [
        entry('sub', 0, { shareBand: 0, shareWeight: 1, pinned: true }),
        entry('cursor', 1, { shareBand: 0, shareWeight: 1 }),
      ],
      draw: 0.9,
    });
    const pinnedResult = chooseRoute(pinned);
    expect(pinnedResult).toMatchObject({ kind: 'dispatch', routeId: 'sub' });
    if (pinnedResult.kind === 'dispatch') expect(pinnedResult.why).not.toContain('同一档按权重分');
  });

  it('别的模型排在前面时不抢', () => {
    const ahead = route('opus', { modelId: 'opus-5.5', modelName: 'Opus', poolName: 'opus' });
    const peers = [grok('sub'), grok('cursor')];
    const result = chooseRoute(
      input([ahead, ...peers], {
        order: [
          entry('opus', 0),
          entry('sub', 1, { shareBand: 0, shareWeight: 1 }),
          entry('cursor', 2, { shareBand: 0, shareWeight: 1 }),
        ],
        draw: 0.9,
      }),
    );
    expect(result).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
  });
});
