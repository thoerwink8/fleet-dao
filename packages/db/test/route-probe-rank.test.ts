// 用途顺序里开着的名次（#1424）：纯函数，不连库。关着的不占名次；一条路由取各用途里最靠前的。
import { describe, expect, it } from 'vitest';
import { bestOpenRanks, type OpenRankRow } from '../src/queries/probe.ts';

const NOW = new Date('2026-10-09T08:00:00.000Z');

function row(over: Partial<OpenRankRow> & Pick<OpenRankRow, 'purpose' | 'routeId'>): OpenRankRow {
  return {
    modelPosition: 0,
    routePosition: 0,
    catalogEnabled: true,
    channelEnabled: true,
    retiredAt: null,
    ...over,
  };
}

describe('bestOpenRanks', () => {
  it('按模型先后再路由先后编号，关着的跳过，多个用途取最小名次', () => {
    const ranks = bestOpenRanks(
      [
        row({ purpose: 'execute', routeId: 'closed', routePosition: 0, catalogEnabled: false }),
        row({ purpose: 'execute', routeId: 'car', routePosition: 1 }),
        row({ purpose: 'execute', modelPosition: 1, routeId: 'channel-off', channelEnabled: false }),
        row({ purpose: 'execute', modelPosition: 1, routePosition: 1, routeId: 'k3' }),
        row({
          purpose: 'execute',
          modelPosition: 2,
          routeId: 'retired',
          retiredAt: new Date('2020-01-01T00:00:00Z'),
        }),
        row({ purpose: 'execute', modelPosition: 2, routePosition: 1, routeId: 'grok' }),
        row({ purpose: 'review', routeId: 'grok' }),
        row({ purpose: 'review', modelPosition: 1, routeId: 'car' }),
      ],
      NOW,
    );
    expect(ranks.get('car')).toBe(1);
    expect(ranks.get('k3')).toBe(2);
    expect(ranks.get('grok')).toBe(1);
    expect(ranks.has('closed')).toBe(false);
    expect(ranks.has('channel-off')).toBe(false);
    expect(ranks.has('retired')).toBe(false);
  });

  it('下架时刻就是现在：不算开着，不占名次', () => {
    const ranks = bestOpenRanks([row({ purpose: 'execute', routeId: 'gone', retiredAt: NOW })], NOW);
    expect(ranks.has('gone')).toBe(false);
  });
});
