// 网关的真客户端（packages/feishu 的 createBackend，香港跑的同一份）对着真后端剩下的两条网关接口走一遍
// （进群记录、飞书用量；飞书收缩后 #2047 F1，收原话、撤回、补漏游标、意图卡、回执、拒收那几条已经删了）：
// 两边各按 shared 的 intent-api.ts 解析，对不上当场红。没存成、读不了库都要在客户端变成抛出来的错，不能变成「好了」。

import { BackendError, createBackend } from '@fleet-dao/feishu';
import { FEISHU_JOIN_REASON } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryIntentStore, type IntentStore } from '../src/intent-store.ts';
import { GATEWAY_PASS, type Harness, harness, T0 } from './harness.ts';

function gatewayClient(h: Harness) {
  const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    h.cockpit.request(input, init)) as typeof fetch;
  return createBackend({ baseUrl: 'http://fleet-api.test', gatewayToken: GATEWAY_PASS, fetch: doFetch });
}

const JOIN = { chatId: 'oc_team', openIdTails: ['nger'], at: T0.toISOString(), reason: FEISHU_JOIN_REASON };
const REPORT_ID = '11111111-1111-4111-8111-111111111111';

describe('网关客户端 ⇄ 后端剩下的两条网关接口', () => {
  it('进群记录：两边按同一份约定对得上，回记了几条', async () => {
    const gw = gatewayClient(harness());
    expect(await gw.recordJoin(JOIN)).toEqual({ recorded: 1 });
  });

  it('飞书用量：累加、同一个 reportId 重报不加第二次；回的是这个月的累计和上限', async () => {
    const gw = gatewayClient(harness());
    const first = await gw.reportUsage({ reportId: REPORT_ID, calls: 5, at: T0.toISOString() });
    expect(first).toMatchObject({ calls: 5, limit: 10_000, readable: true });
    const again = await gw.reportUsage({ reportId: REPORT_ID, calls: 5, at: T0.toISOString() });
    expect(again.calls).toBe(5);
    const next = await gw.reportUsage({
      reportId: '22222222-2222-4222-8222-222222222222',
      calls: 3,
      at: T0.toISOString(),
    });
    expect(next.calls).toBe(8);
  });

  it('【故意造出的失败】后端存不进：客户端抛 server（5xx），不是「好了」', async () => {
    const memory = createMemoryIntentStore();
    const broken: IntentStore = {
      ...memory,
      recordJoins: async () => {
        throw new Error('库连不上');
      },
      addUsage: async () => {
        throw new Error('connection refused');
      },
    };
    const gw = gatewayClient(harness({ intents: broken }));
    await expect(gw.recordJoin(JOIN)).rejects.toMatchObject({ kind: 'server', status: 500 });
    await expect(
      gw.reportUsage({ reportId: REPORT_ID, calls: 1, at: T0.toISOString() }),
    ).rejects.toMatchObject({ kind: 'server', status: 500 });
  });

  it('【故意造出的失败】这台没接意图表：503 intents_not_wired，客户端抛 server，不当成存下了', async () => {
    const notWired = gatewayClient(harness({ intents: null }));
    const err = await notWired.recordJoin(JOIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toMatchObject({ kind: 'server', status: 503, code: 'intents_not_wired' });
  });

  it('【故意造出的失败】网关通行证不对：401 拒收，不记', async () => {
    const h = harness();
    const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      h.cockpit.request(input, init)) as typeof fetch;
    const wrong = createBackend({
      baseUrl: 'http://fleet-api.test',
      gatewayToken: 'not-the-gateway-pass-0123456789abcdef',
      fetch: doFetch,
    });
    await expect(wrong.recordJoin(JOIN)).rejects.toMatchObject({ kind: 'rejected', status: 401 });
  });
});
