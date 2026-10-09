// 没有差集时页面要写出两边各几个。个数在差集函数里算，不另查库。
import { describe, expect, it } from 'vitest';
import { diffChannelModels } from '../src/queries/channel-models.ts';

const at = new Date('2026-10-08T00:00:00.000Z');

function model(modelKey: string) {
  return { modelKey, firstSeenAt: at, lastSeenAt: at };
}

describe('diffChannelModels 两边的个数', () => {
  it('读成且没有差集：渠道模型串几个、目录里比过的模型几个（已下架的不算）', () => {
    const diff = diffChannelModels([
      {
        channelId: 'xai',
        channelName: 'Grok 订阅',
        read: { ok: true },
        models: [model('grok-4.7'), model('grok-new')],
        routes: [
          {
            routeId: 'rt-1',
            modelId: 'grok-a',
            upstreamModel: 'grok-4.7',
            upstreamAliases: [],
            goneAt: null,
          },
          {
            routeId: 'rt-2',
            modelId: 'grok-a',
            upstreamModel: 'grok-new',
            upstreamAliases: ['alias'],
            goneAt: null,
          },
          {
            routeId: 'rt-old',
            modelId: 'gone',
            upstreamModel: 'old',
            upstreamAliases: [],
            goneAt: at,
          },
        ],
      },
      {
        channelId: 'cursor',
        channelName: 'Cursor 订阅',
        read: { ok: true },
        models: [model('composer-2.5')],
        routes: [
          {
            routeId: 'rt-c',
            modelId: 'cursor-auto',
            upstreamModel: 'composer-2.5',
            upstreamAliases: [],
            goneAt: null,
          },
        ],
      },
    ]);
    expect(diff.missingFromCatalog).toEqual([]);
    expect(diff.goneRoutes).toEqual([]);
    expect(diff.channelModelCount).toBe(3);
    expect(diff.catalogCount).toBe(2);
  });

  it('没读成、还没读、手工 0 个：不把它们算进两边的个数', () => {
    const diff = diffChannelModels([
      {
        channelId: 'xai',
        channelName: 'Grok',
        read: { ok: false, code: 'no_credentials', message: '没有登录' },
        models: [model('grok-4.7')],
        routes: [
          {
            routeId: 'rt-1',
            modelId: 'grok',
            upstreamModel: 'grok-4.7',
            upstreamAliases: [],
            goneAt: null,
          },
        ],
      },
      {
        channelId: 'cursor',
        channelName: 'Cursor',
        read: null,
        models: [model('composer')],
        routes: [
          {
            routeId: 'rt-c',
            modelId: 'cursor',
            upstreamModel: 'composer',
            upstreamAliases: [],
            goneAt: null,
          },
        ],
      },
      {
        channelId: 'claude-sub',
        channelName: 'Claude',
        read: { ok: true },
        manualCount: 0,
        models: [],
        routes: [
          {
            routeId: 'rt-s',
            modelId: 'sonnet',
            upstreamModel: 'claude-sonnet',
            upstreamAliases: [],
            goneAt: null,
          },
        ],
      },
    ]);
    expect(diff.channelModelCount).toBe(0);
    expect(diff.catalogCount).toBe(0);
    expect(diff.failed).toHaveLength(1);
    expect(diff.notYet).toHaveLength(1);
    expect(diff.manual).toEqual([{ channelId: 'claude-sub', channelName: 'Claude', count: 0 }]);
  });
});
