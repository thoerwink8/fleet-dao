// 手工登记模型串的写口（#1357）。库里的插入和操作记录在 db 的测试里；这里钉状态码和没接上。
import { ManualModelError } from '@fleet-dao/db';
import { ManualModelResponse, WEB_API_PREFIX } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { ModelRosterPort } from '../src/model-roster.ts';
import { DEV_USER_ID, harness, write } from './harness.ts';

const PATH = `${WEB_API_PREFIX}/routing/channels/claude-sub/models`;

function port(over: Partial<ModelRosterPort> = {}): ModelRosterPort {
  return {
    read: async () => ({ missingFromCatalog: [], goneRoutes: [], failed: [], notYet: [], manual: [] }),
    register: async (input) => ({
      channelId: input.channelId,
      modelKey: input.modelKey.trim(),
      source: '手工',
      count: 1,
    }),
    revoke: async (input) => ({
      channelId: input.channelId,
      modelKey: input.modelKey.trim(),
      source: '手工',
      count: 0,
    }),
    ...over,
  };
}

describe('手工登记模型串', () => {
  it('POST 登记，DELETE 撤销', async () => {
    const seen: string[] = [];
    const h = harness({
      modelRoster: port({
        register: async (input) => {
          seen.push(`${input.actorKind}:${input.actorId}:${input.via}:${input.modelKey}`);
          return { channelId: input.channelId, modelKey: input.modelKey, source: '手工', count: 1 };
        },
      }),
    });
    const session = await h.login();
    const created = await h.cockpit.request(PATH, write('POST', session, { modelKey: 'claude-opus-5-5' }));
    expect(created.status).toBe(200);
    expect(ManualModelResponse.parse(await created.json())).toMatchObject({
      channelId: 'claude-sub',
      modelKey: 'claude-opus-5-5',
      source: '手工',
      count: 1,
    });
    expect(seen).toEqual([`user:${DEV_USER_ID}:cockpit:claude-opus-5-5`]);

    const removed = await h.cockpit.request(PATH, write('DELETE', session, { modelKey: 'claude-opus-5-5' }));
    expect(removed.status).toBe(200);
    expect(ManualModelResponse.parse(await removed.json()).count).toBe(0);
  });

  it('重复登记 409', async () => {
    const h = harness({
      modelRoster: port({
        register: async () => {
          throw new ManualModelError('already_registered', '这个模型串已经登记过');
        },
      }),
    });
    const session = await h.login();
    const res = await h.cockpit.request(PATH, write('POST', session, { modelKey: 'claude-opus-5-5' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'already_registered' } });
  });

  it('没接上登记口子：503，不当登记成了', async () => {
    const h = harness({
      modelRoster: { read: async () => ({ missingFromCatalog: [], goneRoutes: [], failed: [], notYet: [] }) },
    });
    const session = await h.login();
    const res = await h.cockpit.request(PATH, write('POST', session, { modelKey: 'claude-opus-5-5' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'model_roster_unavailable' } });
  });
});
