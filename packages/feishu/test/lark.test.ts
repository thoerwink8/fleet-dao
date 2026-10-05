// 飞书 SDK 这一层：用真的 LarkChannel（webhook 传输，不连长连接），HTTP 换成假的。
// 原始事件从 SDK 的分发器进去，经它的去重、策略、排队到网关；网关往外发的每一步都是 SDK 真发的 HTTP 请求。
import type { Cache, HttpInstance } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/backend.ts';
import { createGateway, type Gateway } from '../src/gateway.ts';
import { createLark, type Lark, sdkDetail } from '../src/lark.ts';
import { FeishuError } from '../src/port.ts';
import { A, B, BOT, cardEvent, menuEvent, messageEvent, recallEvent, TEAM } from './events.ts';
import { type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { memoryLogger, TOKEN, until } from './harness.ts';

interface HttpCall {
  method: string;
  path: string;
  params: Record<string, unknown>;
  data: unknown;
  /** SDK 发请求时带的超时（毫秒）。 */
  timeout: number | undefined;
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

  type Opts = {
    url?: string;
    method?: string;
    data?: unknown;
    params?: Record<string, unknown>;
    timeout?: number;
  };
  async function handle(method: string, url: string, data: unknown, o: Opts = {}) {
    const path = new URL(url).pathname;
    const call = { method: method.toUpperCase(), path, params: o.params ?? {}, data, timeout: o.timeout };
    calls.push(call);
    const found = routes.find(([re]) => re.test(`${call.method} ${path}`));
    if (!found)
      throw Object.assign(new Error(`假开放平台没有 ${call.method} ${path}`), {
        response: { status: 404, data: { code: 404 } },
      });
    return found[1](call);
  }

  const http = {
    request: (o: Opts) => handle(o.method ?? 'GET', o.url ?? '', o.data, o),
    get: (url: string, o?: Opts) => handle('GET', url, o?.data, o),
    delete: (url: string, o?: Opts) => handle('DELETE', url, o?.data, o),
    head: (url: string, o?: Opts) => handle('HEAD', url, o?.data, o),
    options: (url: string, o?: Opts) => handle('OPTIONS', url, o?.data, o),
    post: (url: string, data?: unknown, o?: Opts) => handle('POST', url, data, o),
    put: (url: string, data?: unknown, o?: Opts) => handle('PUT', url, data, o),
    patch: (url: string, data?: unknown, o?: Opts) => handle('PATCH', url, data, o),
  } as unknown as HttpInstance;
  return { http, calls };
}

/** 一直不回：模拟飞书接口挂住。 */
const hang: Route = () => new Promise(() => {});

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

async function start(
  overrides: Record<string, Route> = {},
  log = memoryLogger([]),
  timeouts?: { reactMs?: number; callMs?: number },
): Promise<Stack> {
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
    ...(timeouts ? { timeouts } : {}),
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
  });
  lark.wire(gateway);
  await lark.connect();
  stack = { lark, gateway, backend, open };
  return stack;
}

const imCalls = (s: Stack) => s.open.calls.filter((c) => c.path.startsWith('/open-apis/im/'));

describe('飞书 SDK 这一层', () => {
  it('私聊一句话：经 SDK 分发、去重、排队到网关；原话原样转后端、表情回应是真发的请求；同一条消息重投只处理一次', async () => {
    const s = await start();
    s.backend.on('POST', '/feishu/intake/messages', { body: { status: 'stored', intentSeq: 1 } });
    const event = messageEvent({ text: '给登录页加手机验证码', id: 'om_user_dup' });
    await s.lark.dispatch(event);
    await s.lark.dispatch(event);
    await until(() => imCalls(s).length >= 1);
    await s.gateway.idle();

    // 只加了一个「收到」表情：不再回「我理解为」那张卡
    const [react, ...rest] = imCalls(s);
    expect(react).toMatchObject({
      method: 'POST',
      path: '/open-apis/im/v1/messages/om_user_dup/reactions',
      data: { reaction_type: { emoji_type: 'Get' } },
    });
    expect(rest).toEqual([]);
    // 重投两次，后端只收到一次
    const sent = s.backend.calls('POST', '/feishu/intake/messages');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      messageId: 'om_user_dup',
      chatKind: 'p2p',
      source: 'event',
      text: '给登录页加手机验证码',
    });
  });

  it('群里：不 @ 也收；别的群、机器人自己发的被拦下（计数，不回话）；两个人前后脚说话不会被并成一条', async () => {
    const s = await start();
    s.backend.on('POST', '/feishu/intake/messages', { body: { status: 'stored', intentSeq: 1 } });
    await s.lark.dispatch(messageEvent({ text: '随便聊聊', chat: 'group', chatId: TEAM, mentionBot: false }));
    await s.lark.dispatch(
      messageEvent({ text: '给登录页加验证码', chat: 'group', chatId: 'oc_other_group' }),
    );
    await s.lark.dispatch(messageEvent({ text: '甲的需求', chat: 'group', chatId: TEAM, from: A }));
    await s.lark.dispatch(messageEvent({ text: '乙的需求', chat: 'group', chatId: TEAM, from: B }));
    await until(() => s.backend.calls('POST', '/feishu/intake/messages').length === 3);
    await s.gateway.idle();
    expect(
      s.backend
        .calls('POST', '/feishu/intake/messages')
        .map((r) => [r.headers['x-fleet-acting-feishu'], (r.body as { text: string }).text]),
    ).toEqual([
      [A, '随便聊聊'],
      [A, '甲的需求'],
      [B, '乙的需求'],
    ]);
    // 只有别的群那条被 SDK 的策略拦下：允许的群里不 @ 也收
    expect(s.gateway.stats).toMatchObject({ rejected_group_not_allowed: 1 });
    expect(s.gateway.stats.rejected_no_mention ?? 0).toBe(0);
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

  it('卡片表单提交：输入框的值（form_value）能取到；但旧卡的按钮已停用，只回一句「已停用」，不调后端', async () => {
    const s = await start();
    await s.lark.dispatch(
      cardEvent({
        messageId: 'om_card_1',
        value: { a: 'draft.revise', d: 'draft-1', r: 1, _n: 'n1' },
        form: { note: '只做网页版', repo: 'repo-api' },
      }),
    );
    await until(() => imCalls(s).length >= 1);
    await s.gateway.idle();
    // 一个后端请求都没有：旧按钮不办事了
    expect(s.backend.requests).toHaveLength(0);
    const [reply] = imCalls(s);
    expect(reply).toMatchObject({
      method: 'POST',
      path: '/open-apis/im/v1/messages/om_card_1/reply',
      data: { msg_type: 'text' },
    });
    const sent = reply?.data as { content: string };
    const said = JSON.parse(sent.content) as { text: string };
    expect(said.text).toContain('已经停用');
    expect(s.gateway.stats).toMatchObject({ disabled_button: 1 });
  });

  it('撤回事件：经 SDK 的分发器进来，转给后端', async () => {
    const s = await start();
    s.backend.on('POST', '/feishu/intake/messages', { body: { status: 'stored', intentSeq: 1 } });
    s.backend.on('POST', '/feishu/intake/recalls', { body: { status: 'recalled', intentSeq: 1 } });
    // 先在允许的群里说一句，网关才认得这个会话（撤回事件不带会话种类）
    await s.lark.dispatch(messageEvent({ text: '给登录页加验证码', chat: 'group', chatId: TEAM }));
    await until(() => s.backend.calls('POST', '/feishu/intake/messages').length === 1);
    await s.lark.dispatch(recallEvent({ messageId: 'om_user_dup', chatId: TEAM }));
    await until(() => s.backend.calls('POST', '/feishu/intake/recalls').length === 1);
    expect(s.backend.calls('POST', '/feishu/intake/recalls')[0]?.body).toMatchObject({
      messageId: 'om_user_dup',
      chatId: TEAM,
      source: 'event',
    });
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

  it('飞书接口挂住：表情回应 3 秒、其余 10 秒就算超时（这里按比例缩短），不重试，记错误；每个请求也带着超时，挂住的连接会被收掉', async () => {
    const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const s = await start(
      {
        'POST /open-apis/im/v1/messages/om_slow/reactions': hang,
        'POST /open-apis/im/v1/messages': hang,
      },
      memoryLogger(lines as never),
      { reactMs: 60, callMs: 120 },
    );
    const t0 = Date.now();
    await expect(s.lark.port.react('om_slow', 'Get')).rejects.toMatchObject({ kind: 'timeout' });
    const reactMs = Date.now() - t0;
    expect(reactMs).toBeGreaterThanOrEqual(55);
    expect(reactMs).toBeLessThan(1_000);
    const t1 = Date.now();
    await expect(s.lark.port.send({ chatId: TEAM }, { text: 'x' }, { uuid: 'u1' })).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(Date.now() - t1).toBeLessThan(1_000);
    // 超时不重试：各只发了一次。
    expect(imCalls(s).map((c) => c.path)).toEqual([
      '/open-apis/im/v1/messages/om_slow/reactions',
      '/open-apis/im/v1/messages',
    ]);
    expect(s.open.calls.every((c) => c.timeout === 120)).toBe(true);
    expect(
      lines.filter((l) => l.level === 'error' && l.message === '飞书接口超时').map((l) => l.fields),
    ).toEqual([
      { what: '加表情回应', ms: 60 },
      { what: '发消息', ms: 120 },
    ]);
  });

  it('SDK 报错的日志里没有请求体（发出去的卡片里有创始人的原话），只留定位要的几项', async () => {
    const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const secret = '创始人原话：下周融资的事先别告诉投资人';
    const s = await start(
      {
        'POST /open-apis/im/v1/messages': (c) => {
          throw Object.assign(new Error('Request failed with status code 400'), {
            config: {
              method: 'post',
              url: 'https://open.feishu.cn/open-apis/im/v1/messages',
              data: JSON.stringify(c.data),
            },
            request: { method: 'POST', path: '/open-apis/im/v1/messages' },
            response: {
              status: 400,
              statusText: 'Bad Request',
              data: { code: 230001, msg: 'invalid content', log_id: 'L1' },
            },
          });
        },
      },
      memoryLogger(lines as never),
    );
    await s.lark.port.send({ chatId: TEAM }, { text: secret }, { uuid: 'u2' }).catch(() => undefined);
    const sdk = lines.filter((l) => l.message === '飞书 SDK');
    expect(sdk.length).toBeGreaterThan(0);
    const logged = JSON.stringify(sdk);
    expect(logged).not.toContain('下周融资');
    expect(logged).toContain('230001');
    expect(logged).toContain('/open-apis/im/v1/messages');
    expect(
      sdkDetail([{ config: { data: secret, url: '/x' }, response: { data: { code: 1, msg: 'bad' } } }]),
    ).toBe('url=/x code=1 msg=bad');
  });
});
