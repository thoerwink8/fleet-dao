// 调后端的客户端：带通行证；代表谁跟着路由表的 acting 走；超时、拒收、出错、形状不对分得清。
import { FEISHU_GATEWAY_WEB_ROUTES, FeishuRoutes, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTING_HEADER, type Backend, BackendError, createBackend, describe as say } from '../src/backend.ts';
import { apiError, type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { TOKEN } from './harness.ts';

const A = { openId: 'ou_founder_a' };
const card = {
  messageId: 'om_1',
  chatId: 'oc_1',
  kind: 'list',
  ref: {},
  sentAt: new Date().toISOString(),
} as const;

/** 客户端的每个方法各调一次（后端一律回 503，只看请求）。键是它走的路由。 */
const EVERY_CALL: Record<string, (b: Backend) => Promise<unknown>> = {
  message: (b) =>
    b.understand(A, { sourceMessageId: 'om_1', text: 'x', chatType: 'p2p', replyToMessageId: 'om_0' }),
  reviseDraft: (b) => b.reviseDraft(A, 'd1', { requestId: 'r1', note: '改' }),
  confirmDraft: (b) => b.confirmDraft(A, 'd1', { revision: 1 }),
  findTasks: (b) => b.findTasks(A, 12),
  follow: (b) => b.follow(A, 't1', true),
  board: (b) => b.board(),
  outbox: (b) => b.outbox(0),
  ackOutbox: (b) =>
    b.ackOutbox([{ itemId: 'i1', revision: 1, result: { status: 'updated', messageId: 'om_1' } }]),
  putCard: (b) => b.putCard(card),
  task: (b) => b.task(A, 't1'),
  taskAction: (b) => b.stopTask(A, 't1', '叫停'),
  answerAsk: (b) => b.answerAsk(A, 'a1', '批准'),
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
    fake.on('POST', '/feishu/follows', { body: { taskId: 't1', following: true } });
    fake.on('GET', '/feishu/board', { status: 500 });
    await b.follow({ openId: 'ou_founder_a' }, 't1', true);
    await b.board().catch(() => undefined);
    const [follow, board] = fake.requests;
    expect(follow?.path).toBe('/feishu/follows');
    expect(follow?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(follow?.headers[ACTING_HEADER.toLowerCase()]).toBe('ou_founder_a');
    expect(board?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(board?.headers[ACTING_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('超时、4xx、5xx、回的形状不对：分成不同的错，4xx 带后端自己说的白话和 details', async () => {
    const b = await client();
    fake.on('GET', '/feishu/board', 'hang');
    expect((await error(b.board())).kind).toBe('timeout');

    fake.on(
      'POST',
      '/feishu/drafts/:id/confirm',
      apiError(409, 'draft_changed', '草稿刚被改过', { draft: 'x' }),
    );
    const rejected = await error(b.confirmDraft({ openId: 'ou_a' }, 'd1', { revision: 1 }));
    expect(rejected).toMatchObject({
      kind: 'rejected',
      status: 409,
      code: 'draft_changed',
      said: '草稿刚被改过',
      details: { draft: 'x' },
    });
    expect(say(rejected)).toBe('草稿刚被改过');

    fake.on('GET', '/feishu/outbox', { status: 502 });
    expect((await error(b.outbox(0))).kind).toBe('server');

    fake.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: { id: 'd1' } } });
    const bad = await error(
      b.understand({ openId: 'ou_a' }, { sourceMessageId: 'om_1', text: 'x', chatType: 'p2p' }),
    );
    expect(bad.kind).toBe('bad_response');
  });

  it('连不上：unreachable；停机时撤回：aborted', async () => {
    const b = await client();
    await fake.close();
    expect((await error(b.board())).kind).toBe('unreachable');
    fake = await startFakeBackend();
    const b2 = createBackend({ baseUrl: fake.url, gatewayToken: TOKEN });
    fake.on('GET', '/feishu/outbox', 'hang');
    const stop = new AbortController();
    const p = error(b2.outbox(25, stop.signal));
    setTimeout(() => stop.abort(), 50);
    expect((await p).kind).toBe('aborted');
  });

  it('每条接口都按路由表的 acting 带或不带「代表谁」：required 带点按钮 / 说话的人，none 一律不带；都带通行证', async () => {
    const b = await client();
    const table: Record<string, { method: string; path: string; acting: string }> = {
      ...FeishuRoutes,
      ...Object.fromEntries(
        FEISHU_GATEWAY_WEB_ROUTES.map((k) => [k, { ...WebRoutes[k], acting: 'required' }]),
      ),
    };
    // 路由表里的每一条客户端都有方法调它（加了接口没接上，这里先红）。
    expect(Object.keys(EVERY_CALL).sort()).toEqual(Object.keys(table).sort());
    for (const [name, call] of Object.entries(EVERY_CALL)) {
      const before = fake.requests.length;
      await call(b).catch(() => undefined);
      const req = fake.requests[before];
      const route = table[name];
      const pattern = new RegExp(`^${route?.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
      expect({ name, method: req?.method, path: pattern.test(req?.path ?? '') }).toEqual({
        name,
        method: route?.method,
        path: true,
      });
      expect({ name, auth: req?.headers.authorization }).toEqual({ name, auth: `Bearer ${TOKEN}` });
      const acting = req?.headers[ACTING_HEADER.toLowerCase()];
      expect({ name, acting }).toEqual({ name, acting: route?.acting === 'required' ? A.openId : undefined });
    }
    expect(WEB_API_PREFIX).toBe('/api');
  });

  it('路径里的编号会转义', async () => {
    const b = await client();
    await b.putCard({ ...card, messageId: 'om_a/b' }).catch(() => undefined);
    expect(fake.requests[0]?.path).toBe('/feishu/cards/om_a%2Fb');
  });

  it('请求体先按约定校验：网关自己拼错了当场报错，不发出去', async () => {
    const b = await client();
    await expect(b.reviseDraft({ openId: 'ou_a' }, 'd1', { requestId: 'r1' })).rejects.toThrow(
      '补充说明和仓至少给一个',
    );
    expect(fake.requests).toHaveLength(0);
  });
});
