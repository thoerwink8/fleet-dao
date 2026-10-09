// 调后端的客户端：带通行证；代表谁跟着路由表的 acting 走；超时、拒收、出错、形状不对分得清。
import { FEISHU_JOIN_REASON, FEISHU_REJECTION_REASON, IntentRoutes, WEB_API_PREFIX } from '@fleet-dao/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTING_HEADER,
  type Backend,
  BackendError,
  createBackend,
  type IntakeMessage,
  describe as say,
} from '../src/backend.ts';
import { apiError, type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { TOKEN } from './harness.ts';

const A = { openId: 'ou_founder_a' };

const MESSAGE: IntakeMessage = {
  messageId: 'om_1',
  chatId: 'oc_1',
  chatKind: 'p2p',
  sentAt: new Date().toISOString(),
  source: 'event',
  msgType: 'text',
  text: '给登录页加验证码',
  rawContent: JSON.stringify({ text: '给登录页加验证码' }),
  atBot: false,
  newSegment: false,
};

/** 客户端的每个方法各调一次（后端一律回 404，只看请求）。键是它走的路由。 */
const EVERY_CALL: Record<keyof typeof IntentRoutes, (b: Backend) => Promise<unknown>> = {
  intakeMessage: (b) => b.intake(A, MESSAGE),
  intakeRecall: (b) =>
    b.intakeRecall({
      messageId: 'om_1',
      chatId: 'oc_1',
      recalledAt: new Date().toISOString(),
      source: 'event',
    }),
  cursors: (b) => b.intakeCursors('oc_1'),
  cards: (b) => b.intentCards(0),
  ackCards: (b) =>
    b.ackIntentCards([{ intentId: 'i1', cardRev: 1, result: { status: 'updated', messageId: 'om_1' } }]),
  intakeRejection: (b) =>
    b.recordRejection({
      chatId: 'oc_1',
      openIdTail: 'nder',
      at: new Date().toISOString(),
      reason: FEISHU_REJECTION_REASON,
    }),
  intakeJoin: (b) =>
    b.recordJoin({
      chatId: 'oc_1',
      openIdTails: ['nder'],
      at: new Date().toISOString(),
      reason: FEISHU_JOIN_REASON,
    }),
  usage: (b) =>
    b.reportUsage({
      reportId: '11111111-1111-4111-8111-111111111111',
      calls: 0,
      at: new Date().toISOString(),
    }),
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
  it('代表某位创始人的调用带上他的 open_id；网关自己的后台活不带；都带通行证', async () => {
    const b = await client();
    fake.on('POST', '/feishu/intake/messages', { body: { status: 'stored', intentSeq: 1 } });
    fake.on('GET', '/feishu/intake/cursors', { status: 500 });
    await b.intake(A, MESSAGE);
    await b.intakeCursors().catch(() => undefined);
    const [intake, cursors] = fake.requests;
    expect(intake?.path).toBe('/feishu/intake/messages');
    expect(intake?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(intake?.headers[ACTING_HEADER.toLowerCase()]).toBe('ou_founder_a');
    expect(cursors?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(cursors?.headers[ACTING_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('超时、4xx、5xx、回的形状不对：分成不同的错，4xx 带后端自己说的白话和 details', async () => {
    const b = await client();
    fake.on('GET', '/feishu/intake/cursors', 'hang');
    expect((await error(b.intakeCursors())).kind).toBe('timeout');

    fake.on(
      'POST',
      '/feishu/intake/messages',
      apiError(403, 'not_founder', '这个飞书账号不是创始人', { openId: 'x' }),
    );
    const rejected = await error(b.intake(A, MESSAGE));
    expect(rejected).toMatchObject({
      kind: 'rejected',
      status: 403,
      code: 'not_founder',
      said: '这个飞书账号不是创始人',
      details: { openId: 'x' },
    });
    expect(say(rejected)).toBe('这个飞书账号不是创始人');

    fake.on('GET', '/feishu/intent-cards', { status: 502 });
    expect((await error(b.intentCards(0))).kind).toBe('server');

    fake.on('POST', '/feishu/intake/recalls', { body: { status: 'nope' } });
    const bad = await error(
      b.intakeRecall({
        messageId: 'om_1',
        chatId: 'oc_1',
        recalledAt: new Date().toISOString(),
        source: 'event',
      }),
    );
    expect(bad.kind).toBe('bad_response');
  });

  it('连不上：unreachable；停机时撤回：aborted', async () => {
    const b = await client();
    await fake.close();
    expect((await error(b.intakeCursors())).kind).toBe('unreachable');
    fake = await startFakeBackend();
    const b2 = createBackend({ baseUrl: fake.url, gatewayToken: TOKEN });
    fake.on('GET', '/feishu/intent-cards', 'hang');
    const stop = new AbortController();
    const p = error(b2.intentCards(25, stop.signal));
    setTimeout(() => stop.abort(), 50);
    expect((await p).kind).toBe('aborted');
  });

  it('每条接口都按路由表的 acting 带或不带「代表谁」：required 带说话的人，none 一律不带；都带通行证；只走 IntentRoutes', async () => {
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
      const acting = req?.headers[ACTING_HEADER.toLowerCase()];
      expect({ name, acting }).toEqual({ name, acting: route.acting === 'required' ? A.openId : undefined });
    }
    expect(WEB_API_PREFIX).toBe('/api');
  });

  it('请求体先按约定校验：网关自己拼错了当场报错，不发出去', async () => {
    const b = await client();
    await expect(async () => b.intake(A, { ...MESSAGE, messageId: '' })).rejects.toThrow('messageId');
    expect(fake.requests).toHaveLength(0);
  });
});
