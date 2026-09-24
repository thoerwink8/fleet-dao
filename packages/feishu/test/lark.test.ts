// 飞书 SDK 这一层：用真的 LarkChannel（webhook 传输，不连长连接），HTTP 换成假的。
// 原始事件从 SDK 的分发器进去，经它的去重、策略、排队到网关；网关往外发的每一步都是 SDK 真发的 HTTP 请求。
import type { Cache, HttpInstance } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/backend.ts';
import { createGateway, type Gateway } from '../src/gateway.ts';
import { createLark, type Lark } from '../src/lark.ts';
import { FeishuError } from '../src/port.ts';
import { A, B, BOT, cardEvent, menuEvent, messageEvent, TEAM } from './events.ts';
import { type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { draft, memoryLogger, TOKEN, until } from './harness.ts';

interface HttpCall {
  method: string;
  path: string;
  params: Record<string, unknown>;
  data: unknown;
}

type Route = (call: HttpCall) => unknown;

/** 假的飞书开放平台：按「方法 路径」回 JSON，记下每个请求。 */
function fakeOpenPlatform(overrides: Record<string, Route> = {}) {
  const calls: HttpCall[] = [];
  let seq = 0;
  const routes: Array<[RegExp, Route]> = [
    [
      /^POST \/open-apis\/auth\/v3\/tenant_access_token\/internal$/,
      () => ({ code: 0, tenant_access_token: 't-fake', expire: 7200 }),
    ],
    [
      /^GET \/open-apis\/bot\/v3\/info$/,
      () => ({ code: 0, bot: { open_id: BOT.openId, app_name: BOT.name } }),
    ],
    [
      /^POST \/open-apis\/im\/v1\/messages\/[^/]+\/reactions$/,
      () => ({ code: 0, data: { reaction_id: 'r1' } }),
    ],
    [
      /^POST \/open-apis\/im\/v1\/messages\/[^/]+\/reply$/,
      () => ({ code: 0, data: { message_id: `om_bot_${++seq}`, chat_id: TEAM } }),
    ],
    [
      /^POST \/open-apis\/im\/v1\/messages$/,
      (c) => ({
        code: 0,
        data: {
          message_id: `om_bot_${++seq}`,
          chat_id: `oc_for_${(c.data as { receive_id: string }).receive_id}`,
        },
      }),
    ],
    [/^PATCH \/open-apis\/im\/v1\/messages\/[^/]+$/, () => ({ code: 0 })],
    [/^POST \/open-apis\/im\/v1\/chats\/[^/]+\/top_notice\/put_top_notice$/, () => ({ code: 0 })],
  ];
  for (const [key, route] of Object.entries(overrides)) routes.unshift([new RegExp(`^${key}$`), route]);

  async function handle(method: string, url: string, data: unknown, params: Record<string, unknown> = {}) {
    const path = new URL(url).pathname;
    const call = { method: method.toUpperCase(), path, params, data };
    calls.push(call);
    const found = routes.find(([re]) => re.test(`${call.method} ${path}`));
    if (!found)
      throw Object.assign(new Error(`假开放平台没有 ${call.method} ${path}`), {
        response: { status: 404, data: { code: 404 } },
      });
    return found[1](call);
  }

  type Opts = { url?: string; method?: string; data?: unknown; params?: Record<string, unknown> };
  const http = {
    request: (o: Opts) => handle(o.method ?? 'GET', o.url ?? '', o.data, o.params),
    get: (url: string, o?: Opts) => handle('GET', url, o?.data, o?.params),
    delete: (url: string, o?: Opts) => handle('DELETE', url, o?.data, o?.params),
    head: (url: string, o?: Opts) => handle('HEAD', url, o?.data, o?.params),
    options: (url: string, o?: Opts) => handle('OPTIONS', url, o?.data, o?.params),
    post: (url: string, data?: unknown, o?: Opts) => handle('POST', url, data, o?.params),
    put: (url: string, data?: unknown, o?: Opts) => handle('PUT', url, data, o?.params),
    patch: (url: string, data?: unknown, o?: Opts) => handle('PATCH', url, data, o?.params),
  } as unknown as HttpInstance;
  return { http, calls };
}

/** 每个测试一份缓存：SDK 默认的缓存是进程级共用的，去重记录会串到别的测试里。 */
function memoryCache(): Cache {
  const m = new Map<string, unknown>();
  const k = (key: unknown, ns?: string) => `${ns ?? ''}:${String(key)}`;
  return {
    set: async (key, value, _expire, opts) => {
      m.set(k(key, opts?.namespace), value);
      return true;
    },
    get: async (key, opts) => m.get(k(key, opts?.namespace)),
  };
}

interface Stack {
  lark: Lark;
  gateway: Gateway;
  backend: FakeBackend;
  open: ReturnType<typeof fakeOpenPlatform>;
}

let stack: Stack | undefined;
afterEach(async () => {
  if (!stack) return;
  await stack.lark.disconnect();
  await stack.gateway.stop(1_000);
  await stack.backend.close();
  stack = undefined;
});

async function start(overrides: Record<string, Route> = {}, log = memoryLogger([])): Promise<Stack> {
  const backend = await startFakeBackend();
  const open = fakeOpenPlatform(overrides);
  const lark = createLark({
    appId: 'cli_placeholder',
    appSecret: 'secret-placeholder',
    groups: [TEAM],
    log,
    transport: 'webhook',
    httpInstance: open.http,
    cache: memoryCache(),
  });
  const gateway = createGateway({
    feishu: lark.port,
    backend: createBackend({ baseUrl: backend.url, gatewayToken: TOKEN }),
    log,
    founders: [
      { openId: A, name: '甲' },
      { openId: B, name: '乙' },
    ],
    teamChatId: TEAM,
    publicUrl: 'https://cockpit.example.test',
    ackEmoji: 'Get',
    askBudgetPerDay: 10,
    boardRefreshMs: 60_000,
  });
  lark.wire(gateway);
  await lark.connect();
  stack = { lark, gateway, backend, open };
  return stack;
}

const imCalls = (s: Stack) => s.open.calls.filter((c) => c.path.startsWith('/open-apis/im/'));

describe('飞书 SDK 这一层', () => {
  it('私聊一句话：经 SDK 分发、去重、排队到网关；表情回应和确认卡都是真发的请求，带 uuid；同一条消息重投只处理一次', async () => {
    const s = await start();
    s.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    const event = messageEvent({ text: '给登录页加手机验证码', id: 'om_user_dup' });
    await s.lark.dispatch(event);
    await s.lark.dispatch(event);
    await until(() => imCalls(s).length >= 2);
    await s.gateway.idle();

    const [react, reply, ...rest] = imCalls(s);
    expect(react).toMatchObject({
      method: 'POST',
      path: '/open-apis/im/v1/messages/om_user_dup/reactions',
      data: { reaction_type: { emoji_type: 'Get' } },
    });
    expect(reply?.path).toBe('/open-apis/im/v1/messages/om_user_dup/reply');
    const body = reply?.data as { msg_type: string; content: string; uuid: string };
    expect(body.msg_type).toBe('interactive');
    expect(body.uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(body.content)).toMatchObject({ schema: '2.0', config: { update_multi: true } });
    expect(rest).toEqual([]);
    expect(s.backend.calls('POST', '/feishu/messages')).toHaveLength(1);
  });

  it('群里：没 @我 的、别的群的，被 SDK 的策略拦下（计数，不回话）；两个人前后脚说话不会被并成一条', async () => {
    const s = await start();
    s.backend.on('POST', '/feishu/messages', { body: { kind: 'answer', text: '好' } });
    await s.lark.dispatch(messageEvent({ text: '随便聊聊', chat: 'group', chatId: TEAM, mentionBot: false }));
    await s.lark.dispatch(
      messageEvent({ text: '给登录页加验证码', chat: 'group', chatId: 'oc_other_group' }),
    );
    await s.lark.dispatch(messageEvent({ text: '甲的需求', chat: 'group', chatId: TEAM, from: A }));
    await s.lark.dispatch(messageEvent({ text: '乙的需求', chat: 'group', chatId: TEAM, from: B }));
    await until(() => s.backend.calls('POST', '/feishu/messages').length === 2);
    await s.gateway.idle();
    const asked = s.backend
      .calls('POST', '/feishu/messages')
      .map((r) => [r.headers['x-fleet-acting-feishu'], (r.body as { text: string }).text]);
    expect(asked).toEqual([
      [A, '甲的需求'],
      [B, '乙的需求'],
    ]);
    expect(s.gateway.stats).toMatchObject({ rejected_no_mention: 1, rejected_group_not_allowed: 1 });
  });

  it('机器人菜单：从 SDK 的分发器进来（Channel 自己不管这个事件），回到点菜单的人的私聊', async () => {
    const s = await start();
    await s.lark.dispatch(menuEvent({ key: 'new_task', from: B }));
    await until(() => imCalls(s).length === 1);
    await s.gateway.idle();
    const [send] = imCalls(s);
    expect(send).toMatchObject({
      method: 'POST',
      path: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'open_id' },
      data: { receive_id: B, msg_type: 'text' },
    });
  });

  it('认不出的菜单事件（缺点菜单的人）：明确记一条日志，不装作处理了', async () => {
    const lines: Array<{ message: string }> = [];
    const s = await start({}, memoryLogger(lines as never));
    const broken = menuEvent({ key: 'board' });
    delete broken.event.operator;
    await s.lark.dispatch(broken);
    expect(lines.some((l) => l.message === '机器人菜单事件认不出，丢了')).toBe(true);
    expect(imCalls(s)).toHaveLength(0);
  });

  it('卡片表单提交：输入框的值（form_value）SDK 的归一化里没有，从原始事件取到', async () => {
    const s = await start();
    s.backend.on('POST', '/feishu/drafts/:draftId/revise', { body: { draft: draft({ revision: 2 }) } });
    await s.lark.dispatch(
      cardEvent({
        messageId: 'om_card_1',
        value: { a: 'draft.revise', d: 'draft-1', r: 1, n: 'n1' },
        form: { note: '只做网页版', repo: 'repo-api' },
      }),
    );
    await until(() => s.backend.calls('POST', '/feishu/drafts/draft-1/revise').length === 1);
    await s.gateway.idle();
    expect(s.backend.calls('POST', '/feishu/drafts/draft-1/revise')[0]?.body).toMatchObject({
      note: '只做网页版',
      repoId: 'repo-api',
    });
    const patches = imCalls(s).filter((c) => c.method === 'PATCH');
    expect(patches.map((p) => p.path)).toEqual([
      '/open-apis/im/v1/messages/om_card_1',
      '/open-apis/im/v1/messages/om_card_1',
    ]);
  });

  it('飞书的错误归类：230031 = 卡片超 14 天改不了；没回 message_id 算没发出去；连不上重试三次再报', async () => {
    let flaky = 0;
    const s = await start({
      'PATCH /open-apis/im/v1/messages/om_old': () => ({ code: 230031, msg: 'card can not be updated' }),
      'POST /open-apis/im/v1/messages': () => ({ code: 0, data: {} }),
      'POST /open-apis/im/v1/chats/oc_team/top_notice/put_top_notice': () => {
        flaky += 1;
        throw new Error('socket hang up');
      },
    });
    await expect(s.lark.port.updateCard('om_old', {})).rejects.toMatchObject({
      kind: 'too_old',
      code: 230031,
    });
    await expect(s.lark.port.send({ chatId: TEAM }, { text: 'x' }, { uuid: 'u1' })).rejects.toThrow(
      '没回 message_id',
    );
    const err = await s.lark.port.pin(TEAM, 'om_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeishuError);
    expect((err as FeishuError).kind).toBe('unavailable');
    expect(flaky).toBe(3);
  });
});
