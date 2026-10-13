// 网关剩下的两条接口（#553 第 4 条，#795 补进群、用量）：门、进群记录、飞书用量。
// 飞书收缩（#2047 F1）后，收原话、撤回、补漏游标、意图卡、回执、拒收这几条已经删了：存储那半在 intent-store-contract.ts。
import {
  FEISHU_JOIN_REASON,
  FEISHU_MONTHLY_CALL_LIMIT,
  FEISHU_OUTSIDER_JOINED_TITLE,
  FEISHU_USAGE_ALERT_TITLE,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryIntentStore, type IntentStore } from '../src/intent-store.ts';
import { GATEWAY_PASS, type Harness, harness, T0 } from './harness.ts';

function call(
  h: Harness,
  path: string,
  init: { method?: string; body?: unknown; pass?: string | null } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.pass !== null) headers.authorization = `Bearer ${init.pass ?? GATEWAY_PASS}`;
  return h.cockpit.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const JOIN = {
  chatId: 'oc_team',
  openIdTails: ['nger'],
  at: T0.toISOString(),
  reason: FEISHU_JOIN_REASON,
};

describe('网关接口的门', () => {
  it('【故意造出的失败】没带通行证 401、通行证不对 401，什么都不存', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    expect((await call(h, '/api/feishu/intake/joins', { body: JOIN, pass: null })).status).toBe(401);
    expect(
      (await call(h, '/api/feishu/intake/joins', { body: JOIN, pass: 'wrong-pass-0123456789abcdef0123' }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(h, '/api/feishu/gateway/usage', {
          body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', calls: 1, at: T0.toISOString() },
          pass: null,
        })
      ).status,
    ).toBe(401);
    expect(intents.data.joins).toEqual([]);
    expect(intents.data.usage).toEqual([]);
  });

  it('【故意造出的失败】意图存储没接上：503 写明没存，不回 200', async () => {
    const h = harness({ intents: null });
    const res = await call(h, '/api/feishu/intake/joins', { body: JOIN });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'intents_not_wired' } });
    const usage = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', calls: 1, at: T0.toISOString() },
    });
    expect(usage.status).toBe(503);
  });

  it('【故意造出的失败】收缩前的几条接口都没了：收原话、撤回、补漏游标、意图卡、回执、拒收带着网关通行证来也一律被拒（4xx），没处写', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const gone: Array<[string, string]> = [
      ['POST', '/api/feishu/intake/messages'],
      ['POST', '/api/feishu/intake/recalls'],
      ['GET', '/api/feishu/intake/cursors'],
      ['GET', '/api/feishu/intent-cards?waitSeconds=0'],
      ['POST', '/api/feishu/intent-cards/acks'],
      ['POST', '/api/feishu/intake/rejections'],
    ];
    for (const [method, path] of gone) {
      const res = await call(h, path, { method, ...(method === 'POST' ? { body: {} } : {}) });
      expect({ path, rejected: res.status >= 400 && res.status < 500 }).toEqual({ path, rejected: true });
    }
    expect(intents.data.messages).toEqual([]);
  });
});

async function openAlerts(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request('/api/notifications?status=open', { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: { title: string; body: string }[] };
}

describe('进群、用量（#795）', () => {
  it('白名单外的人进群：记下尾号，驾驶舱提醒那一句', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const res = await call(h, '/api/feishu/intake/joins', { body: JOIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 1 });
    expect(intents.data.joins.map((row) => row.openIdTail)).toEqual(['nger']);
    const notes = await openAlerts(h);
    const joined = notes.items.filter((n) => n.title === FEISHU_OUTSIDER_JOINED_TITLE);
    expect(joined).toHaveLength(1);
    expect(joined[0]?.body).toContain('nger');
    expect(joined[0]?.body).toContain(FEISHU_JOIN_REASON);
  });

  it('【故意造出的失败】进群记录多带了字段：400 拒收，不存', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const bad = await call(h, '/api/feishu/intake/joins', { body: { ...JOIN, text: '原文不该来' } });
    expect(bad.status).toBe(400);
    expect(intents.data.joins).toEqual([]);
  });

  it('用量按北京月累计：81% 驾驶舱报警，下一个月分开算', async () => {
    expect(FEISHU_MONTHLY_CALL_LIMIT).toBe(10_000);
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const over = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', calls: 8100, at: T0.toISOString() },
    });
    expect(over.status).toBe(200);
    expect(await over.json()).toEqual({ month: '2026-09', calls: 8100, limit: 10_000, readable: true });
    const oct = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', calls: 5, at: '2026-09-30T16:00:00.000Z' },
    });
    expect(await oct.json()).toEqual({ month: '2026-10', calls: 5, limit: 10_000, readable: true });

    const notes = await openAlerts(h);
    const alerts = notes.items.filter((n) => n.title === FEISHU_USAGE_ALERT_TITLE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('8100/10000');
    expect(alerts[0]?.body).toContain('手机通知可能发不出去');
    expect(intents.data.usage).toEqual([
      { month: '2026-09', calls: 8100 },
      { month: '2026-10', calls: 5 },
    ]);
  });

  it('不到八成不报警', async () => {
    const h = harness();
    const res = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', calls: 100, at: T0.toISOString() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ month: '2026-09', calls: 100, readable: true });
    const notes = await openAlerts(h);
    expect(notes.items.some((n) => n.title === FEISHU_USAGE_ALERT_TITLE)).toBe(false);
  });

  it('同一份用量上报再来一次不加第二次（回应丢了重报）', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const body = {
      reportId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      calls: 8100,
      at: T0.toISOString(),
    };
    const first = await call(h, '/api/feishu/gateway/usage', { body });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ month: '2026-09', calls: 8100, readable: true });
    const again = await call(h, '/api/feishu/gateway/usage', { body: { ...body, calls: 8100 } });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ month: '2026-09', calls: 8100, readable: true });
    expect(intents.data.usage).toEqual([{ month: '2026-09', calls: 8100 }]);
    const notes = await openAlerts(h);
    expect(notes.items.filter((n) => n.title === FEISHU_USAGE_ALERT_TITLE)).toHaveLength(1);
  });

  it('【故意造出的失败】用量写不进库：500，不回 200、不报警', async () => {
    const memory = createMemoryIntentStore();
    const intents: IntentStore = {
      ...memory,
      addUsage: async () => {
        throw new Error('用量表写不了');
      },
    };
    const h = harness({ intents });
    const res = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', calls: 9000, at: T0.toISOString() },
    });
    expect(res.status).toBe(500);
    const notes = await openAlerts(h);
    expect(notes.items.some((n) => n.title === FEISHU_USAGE_ALERT_TITLE)).toBe(false);
  });
});
