// 调后端的客户端：带通行证；代表谁只在代表人的调用上带；超时、拒收、出错、形状不对分得清。
import { afterEach, describe, expect, it } from 'vitest';
import { ACTING_HEADER, BackendError, createBackend, describe as say } from '../src/backend.ts';
import { apiError, type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { TOKEN } from './harness.ts';

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

  it('卡片登记查不到（404）是 null，不是出错；路径里的编号会转义', async () => {
    const b = await client();
    expect(await b.getCard('om_a/b')).toBeNull();
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
