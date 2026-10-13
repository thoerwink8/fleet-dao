// 调后端的客户端：带通行证；超时、拒收、出错、形状不对分得清；只走 IntentRoutes 里剩下的两条。
import { FEISHU_JOIN_REASON, IntentRoutes, WEB_API_PREFIX } from '@fleet-dao/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Backend, BackendError, createBackend, describe as say } from '../src/backend.ts';
import { apiError, type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { TOKEN } from './harness.ts';

const JOIN = {
  chatId: 'oc_1',
  openIdTails: ['nder'],
  at: new Date().toISOString(),
  reason: FEISHU_JOIN_REASON,
};
const USAGE = {
  reportId: '11111111-1111-4111-8111-111111111111',
  calls: 0,
  at: new Date().toISOString(),
};

/** 客户端的每个方法各调一次（后端一律回 404，只看请求）。键是它走的路由。 */
const EVERY_CALL: Record<keyof typeof IntentRoutes, (b: Backend) => Promise<unknown>> = {
  intakeJoin: (b) => b.recordJoin(JOIN),
  usage: (b) => b.reportUsage(USAGE),
};

let fake: FakeBackend;
afterEach(async () => {
  await fake?.close();
});

async function client() {
  fake = await startFakeBackend();
  return createBackend({ baseUrl: fake.url, gatewayToken: TOKEN, timeoutMs: 300 });
}

async function error(p: Promise<unknown>): Promise<BackendError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof BackendError) return err;
    throw err;
  }
  throw new Error('应当出错，却成功了');
}

describe('后端客户端', () => {
  it('超时、4xx、5xx、回的形状不对：分成不同的错，4xx 带后端自己说的白话和 details', async () => {
    const b = await client();
    fake.on('POST', '/feishu/gateway/usage', 'hang');
    expect((await error(b.reportUsage(USAGE))).kind).toBe('timeout');

    fake.on(
      'POST',
      '/feishu/intake/joins',
      apiError(403, 'gateway_pass_invalid', '网关通行证不对', { hint: 'x' }),
    );
    const rejected = await error(b.recordJoin(JOIN));
    expect(rejected).toMatchObject({
      kind: 'rejected',
      status: 403,
      code: 'gateway_pass_invalid',
      said: '网关通行证不对',
      details: { hint: 'x' },
    });
    expect(say(rejected)).toBe('网关通行证不对');

    fake.on('POST', '/feishu/gateway/usage', { status: 502 });
    expect((await error(b.reportUsage(USAGE))).kind).toBe('server');

    fake.on('POST', '/feishu/intake/joins', { body: { recorded: 'nope' } });
    expect((await error(b.recordJoin(JOIN))).kind).toBe('bad_response');
  });

  it('连不上：unreachable；停机时撤回：aborted', async () => {
    const b = await client();
    await fake.close();
    expect((await error(b.reportUsage(USAGE))).kind).toBe('unreachable');
    fake = await startFakeBackend();
    const b2 = createBackend({ baseUrl: fake.url, gatewayToken: TOKEN });
    fake.on('POST', '/feishu/gateway/usage', 'hang');
    const stop = new AbortController();
    const p = error(b2.reportUsage(USAGE, { signal: stop.signal }));
    setTimeout(() => stop.abort(), 50);
    expect((await p).kind).toBe('aborted');
  });

  it('每条接口都带通行证、走路由表的方法和路径、一律不带「代表谁」（飞书收缩后网关只剩两条 acting=none 的后台活）', async () => {
    const b = await client();
    // 路由表里的每一条客户端都有方法调它（加了接口没接上，这里先红）。
    expect(Object.keys(EVERY_CALL).sort()).toEqual(Object.keys(IntentRoutes).sort());
    for (const [name, call] of Object.entries(EVERY_CALL)) {
      const before = fake.requests.length;
      await call(b).catch(() => undefined);
      expect({ name, sent: fake.requests.length - before }).toEqual({ name, sent: 1 });
      const req = fake.requests[before];
      const route = IntentRoutes[name as keyof typeof IntentRoutes];
      expect({ name, method: req?.method, path: req?.path }).toEqual({
        name,
        method: route.method,
        path: route.path,
      });
      expect({ name, auth: req?.headers.authorization }).toEqual({ name, auth: `Bearer ${TOKEN}` });
      expect({ name, acting: route.acting, header: req?.headers['x-fleet-acting-feishu'] }).toEqual({
        name,
        acting: 'none',
        header: undefined,
      });
    }
    expect(WEB_API_PREFIX).toBe('/api');
  });

  it('请求体先按约定校验：网关自己拼错了当场报错，不发出去', async () => {
    const b = await client();
    await expect(async () => b.recordJoin({ ...JOIN, openIdTails: [] })).rejects.toThrow('openIdTails');
    expect(fake.requests).toHaveLength(0);
  });
});
