// 飞书官方 SDK（@larksuiteoapi/node-sdk）的 Channel：长连接收事件（服务器不开端口）、自带去重和按会话排队。
// 往飞书发东西只在这个文件里（test/static.test.ts 查着）：别处经 FeishuPort。
// 飞书收缩后（#2047 提需求 F1）不收群聊、私聊的话，也没有机器人菜单、撤回事件：这里只接进群事件和旧卡上的按钮回传。
// Channel 没管的几处自己补：
// - 进群事件 im.chat.member.user.added_v1：注册到 Channel 内部的事件分发器上（它没公开，升级 SDK 后 test/lark.test.ts 会报）；
// - 发消息带 uuid（同一件事重试不重复发）：Channel.send 不带，改用它公开的 rawClient；
// - 超时：SDK 默认的 HTTP 实例不设超时（实读为 0），飞书接口一挂住，报警这些串行的活就全停、也不报警。
//   每次调用自己限时（10 秒），超时记错误；HTTP 实例上也带同样的上限，挂住的连接会被收掉。
import {
  type Cache,
  type CardActionEvent,
  createLarkChannel,
  defaultHttpInstance,
  type EventDispatcher,
  type HttpInstance,
  type LarkChannel,
  LoggerLevel,
} from '@larksuiteoapi/node-sdk';
import type { Logger } from './log.ts';
import {
  type Card,
  FeishuError,
  type FeishuErrorKind,
  type FeishuPort,
  type InboundCardAction,
  type InboundJoin,
  type OutMessage,
  type Sent,
  type Target,
} from './port.ts';
import { noteFeishuDispatched } from './usage-meter.ts';
import { sleep } from './util.ts';

/** 每次飞书调用的限时。 */
export const FEISHU_TIMEOUTS = { callMs: 10_000 };

export interface InboundHandlers {
  onJoin(evt: InboundJoin): void;
  onCardAction(evt: InboundCardAction): void;
}

export interface LarkOptions {
  appId: string;
  appSecret: string;
  /** 允许的群（团队群、测试群）。 */
  groups: string[];
  log: Logger;
  timeouts?: Partial<typeof FEISHU_TIMEOUTS>;
  /** 测试用：换掉 SDK 的 HTTP 实例、缓存，走 webhook 传输（不连长连接）。 */
  httpInstance?: HttpInstance;
  cache?: Cache;
  transport?: 'websocket' | 'webhook';
}

export interface Lark {
  port: FeishuPort;
  /** 接上事件（在 connect 之前调）。 */
  wire(handlers: InboundHandlers): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 测试用：把一份原始事件（和长连接推来的同形）交给 SDK 的分发器。 */
  dispatch(raw: unknown): Promise<unknown>;
  channel: LarkChannel;
}

const MEMBER_EVENT = 'im.chat.member.user.added_v1';

export function createLark(opts: LarkOptions): Lark {
  const timeouts = { ...FEISHU_TIMEOUTS, ...opts.timeouts };
  const channel = createLarkChannel({
    appId: opts.appId,
    appSecret: opts.appSecret,
    transport: opts.transport ?? 'websocket',
    policy: { requireMention: false, dmMode: 'open', groupAllowlist: opts.groups, respondToMentionAll: true },
    // 卡片表单的输入值（form_value）SDK 的归一化里没有，要从原始事件里取。
    includeRawEvent: true,
    loggerLevel: LoggerLevel.warn,
    logger: sdkLogger(opts.log),
    source: 'fleet-dao',
    handshakeTimeoutMs: 15_000,
    httpInstance: withTimeout(
      opts.httpInstance ?? (defaultHttpInstance as unknown as HttpInstance),
      timeouts.callMs,
    ),
    ...(opts.cache ? { cache: opts.cache } : {}),
  });
  const dispatcher = (channel as unknown as { dispatcher?: EventDispatcher }).dispatcher;
  if (!dispatcher || typeof dispatcher.register !== 'function' || typeof dispatcher.invoke !== 'function') {
    throw new Error(
      '飞书 SDK 变了：LarkChannel 里找不到事件分发器，进群事件接不上。先别升级 SDK，或改 lark.ts',
    );
  }
  const client = channel.rawClient;
  let joinUnrecognized = 0;

  /** 调一次飞书：限时；超时不重试（报出来，由调用方决定下一步）；连不上、限频有界重试。 */
  async function api<T extends { code?: number | undefined; msg?: string | undefined }>(
    what: string,
    call: () => Promise<T>,
    o: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = o.retries ?? 2;
    const timeoutMs = o.timeoutMs ?? timeouts.callMs;
    for (let attempt = 0; ; attempt++) {
      // 交给 HTTP 的这一下就算一次：失败、超时飞书也可能已经计了，等成功再记会把用量算少。
      noteFeishuDispatched();
      let err: FeishuError;
      try {
        const res = await within(timeoutMs, what, call());
        if (res.code === undefined || res.code === 0) return res;
        err = new FeishuError(
          kindOf(res.code, undefined),
          `${what}：飞书返回 ${res.code} ${res.msg ?? ''}`.trim(),
          {
            code: res.code,
          },
        );
      } catch (raw) {
        err = raw instanceof FeishuError ? raw : toFeishuError(what, raw);
      }
      if (err.kind === 'timeout') {
        opts.log.error('飞书接口超时', { what, ms: timeoutMs });
        throw err;
      }
      const retryable = err.kind === 'unavailable' || err.kind === 'rate_limited';
      if (!retryable || attempt >= retries) throw err;
      await sleep(err.kind === 'rate_limited' ? 1_000 * (attempt + 1) : 300 * (attempt + 1));
    }
  }

  function content(message: OutMessage): { msg_type: string; content: string } {
    return 'card' in message
      ? { msg_type: 'interactive', content: JSON.stringify(message.card) }
      : { msg_type: 'text', content: JSON.stringify({ text: message.text }) };
  }

  function sentOf(
    what: string,
    data: { message_id?: string | undefined; chat_id?: string | undefined } | undefined,
  ): Sent {
    // 送达只认飞书回的 message_id：没有就算没发出去。
    if (!data?.message_id) throw new FeishuError('unknown', `${what}：飞书没回 message_id`);
    return { messageId: data.message_id, chatId: data.chat_id ?? '' };
  }

  const port: FeishuPort = {
    async send(to: Target, message, { uuid }) {
      const receive =
        'chatId' in to
          ? { id: to.chatId, type: 'chat_id' as const }
          : { id: to.openId, type: 'open_id' as const };
      const res = await api('发消息', () =>
        client.im.v1.message.create({
          params: { receive_id_type: receive.type },
          data: { receive_id: receive.id, ...content(message), uuid },
        }),
      );
      const sent = sentOf('发消息', res.data);
      return { messageId: sent.messageId, chatId: sent.chatId || ('chatId' in to ? to.chatId : '') };
    },

    async reply(messageId, message, { uuid }) {
      const res = await api('回复消息', () =>
        client.im.v1.message.reply({ path: { message_id: messageId }, data: { ...content(message), uuid } }),
      );
      return sentOf('回复消息', res.data);
    },

    async updateCard(messageId, card: Card) {
      await api(
        '更新卡片',
        () =>
          client.im.v1.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(card) },
          }),
        { retries: 1 },
      );
    },
  };

  return {
    port,
    channel,

    wire(handlers) {
      channel.on('cardAction', (evt) => handlers.onCardAction(toAction(evt)));
      channel.on('error', (err) =>
        opts.log.error('飞书 SDK 处理入站事件出错', { code: err.code, error: err.message }),
      );
      channel.on('reconnecting', () => opts.log.warn('飞书长连接断了，正在重连'));
      channel.on('reconnected', () => opts.log.info('飞书长连接重连上了'));
      dispatcher.register({
        [MEMBER_EVENT]: (data: unknown) => {
          const join = toJoin(data);
          if (join) handlers.onJoin(join);
          else {
            // 认不出就记错误，不当没人进。不把整条事件打进日志：里面可能有人名。
            joinUnrecognized += 1;
            const chatId =
              data && typeof data === 'object' && typeof (data as { chat_id?: unknown }).chat_id === 'string'
                ? (data as { chat_id: string }).chat_id
                : null;
            opts.log.error('进群事件认不出，不当没人进', { count: joinUnrecognized, chatId });
          }
          return undefined;
        },
      });
    },

    connect: () => channel.connect(),
    disconnect: () => channel.disconnect(),
    dispatch: (raw) => dispatcher.invoke(raw, { needCheck: false }),
  };
}

/**
 * 进群事件（SDK 把 header 和 event 摊平）：会话、时刻、每个进来的人的 open_id 都得有。
 * 少一样、或其中一个人没有 open_id，整条认不出（null），不拿认得出的那几个凑合。
 */
export function toJoin(data: unknown): InboundJoin | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { event_id?: unknown; chat_id?: unknown; create_time?: unknown; users?: unknown };
  if (typeof d.chat_id !== 'string' || d.chat_id.length === 0) return null;
  const at =
    typeof d.create_time === 'string' || typeof d.create_time === 'number'
      ? Number(d.create_time)
      : Number.NaN;
  if (!Number.isFinite(at) || at <= 0) return null;
  if (!Array.isArray(d.users) || d.users.length === 0) return null;
  const openIds: string[] = [];
  for (const user of d.users) {
    if (!user || typeof user !== 'object') return null;
    const u = user as { user_id?: unknown; open_id?: unknown };
    let openId: string | null = null;
    if (typeof u.open_id === 'string' && u.open_id.length > 0) openId = u.open_id;
    else if (u.user_id && typeof u.user_id === 'object') {
      const nested = (u.user_id as { open_id?: unknown }).open_id;
      if (typeof nested === 'string' && nested.length > 0) openId = nested;
    }
    if (!openId) return null;
    openIds.push(openId);
  }
  const eventId = typeof d.event_id === 'string' && d.event_id.length > 0 ? d.event_id : undefined;
  return { ...(eventId ? { eventId } : {}), chatId: d.chat_id, at, openIds };
}

export function toAction(evt: CardActionEvent): InboundCardAction {
  const raw = evt.raw as { action?: { form_value?: unknown } } | undefined;
  const form = raw?.action?.form_value;
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    operatorId: evt.operator.openId,
    value: evt.action.value,
    formValue: form && typeof form === 'object' ? (form as Record<string, unknown>) : undefined,
  };
}

/** 给 SDK 的每个请求带上超时（请求自己设了的不改）：挂住的连接到点就被收掉。 */
function withTimeout(base: HttpInstance, ms: number): HttpInstance {
  type Opts = Parameters<HttpInstance['request']>[0];
  const t = (o?: Opts): Opts => ({ ...o, timeout: o?.timeout || ms });
  return {
    request: (o) => base.request(t(o)),
    get: (url, o) => base.get(url, t(o)),
    delete: (url, o) => base.delete(url, t(o)),
    head: (url, o) => base.head(url, t(o)),
    options: (url, o) => base.options(url, t(o)),
    post: (url, data, o) => base.post(url, data, t(o)),
    put: (url, data, o) => base.put(url, data, t(o)),
    patch: (url, data, o) => base.patch(url, data, t(o)),
  };
}

/** 限时：到点就当超时报出来，不等飞书。 */
function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FeishuError('timeout', `${what}：飞书 ${ms} 毫秒没回应`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * 飞书错误码 → 下一步怎么办。只收有出处的：230031 超 14 天不能改卡、230020 限频（docs/reference/feishu.md 第四节）、
 * 200861 卡片里有 JSON 2.0 不支持的组件（同上，windsurf-dao#1052）；230027 缺必要的权限、230002 机器人不在群里
 * （「获取会话历史消息」接口的错误码表，2026-10-04 查）、99991672 应用没开这项权限（服务端通用错误码）；其余归 unknown，
 * 原码写进日志。
 */
function kindOf(code: number | undefined, status: number | undefined): FeishuErrorKind {
  if (code === 230031) return 'too_old';
  if (code === 230020 || status === 429) return 'rate_limited';
  if (code === 200861) return 'format';
  if (code === 230027 || code === 230002 || code === 99991672) return 'permission';
  if (status === 401 || status === 403) return 'permission';
  if (status !== undefined && status >= 500) return 'unavailable';
  return 'unknown';
}

function toFeishuError(what: string, raw: unknown): FeishuError {
  const e = raw as {
    response?: { status?: number; data?: { code?: number; msg?: string } };
    code?: string;
    message?: string;
  };
  const status = e?.response?.status;
  const code = e?.response?.data?.code;
  if (status === undefined) {
    // 没拿到 HTTP 回应：HTTP 实例上的超时到了，或者网络不通。
    const timedOut =
      e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || /timeout/i.test(e?.message ?? '');
    return new FeishuError(
      timedOut ? 'timeout' : 'unavailable',
      `${what}：${timedOut ? '飞书没及时回应' : '连不上飞书'}（${e?.code ?? e?.message ?? String(raw)}）`,
      { cause: raw },
    );
  }
  const msg = e.response?.data?.msg ?? '';
  return new FeishuError(
    kindOf(code, status),
    `${what}：HTTP ${status}${code ? ` 飞书码 ${code}` : ''} ${msg}`.trim(),
    {
      code,
      cause: raw,
    },
  );
}

/**
 * SDK 自己的日志转进我们的 JSON 日志（只收 warn 以上）。SDK 报错时会把请求体（发出去的卡片，里面有创始人的原话）
 * 和整个回应一起打出来：这里只按白名单留定位问题要的几项，请求体一律不要。
 */
export function sdkDetail(args: unknown[]): string {
  const parts: string[] = [];
  const pick = (o: unknown, keys: string[]): string[] => {
    if (!o || typeof o !== 'object') return [];
    const r = o as Record<string, unknown>;
    return keys.flatMap((k) =>
      typeof r[k] === 'string' || typeof r[k] === 'number' ? [`${k}=${String(r[k]).slice(0, 200)}`] : [],
    );
  };
  const visit = (a: unknown): void => {
    if (typeof a === 'string') parts.push(a.slice(0, 300));
    else if (Array.isArray(a)) a.forEach(visit);
    else if (a && typeof a === 'object') {
      const o = a as Record<string, unknown>;
      const response = o.response as Record<string, unknown> | undefined;
      const fields = [
        ...pick(o, ['message', 'code', 'msg', 'log_id', 'status']),
        ...pick(o.config, ['method', 'url']),
        ...pick(o.request, ['method', 'path']),
        ...pick(response, ['status', 'statusText']),
        ...pick(response?.data, ['code', 'msg', 'log_id']),
      ];
      if (fields.length > 0) parts.push(fields.join(' '));
    }
  };
  args.forEach(visit);
  return parts.join(' | ').slice(0, 1000);
}

function sdkLogger(log: Logger) {
  return {
    error: (...args: unknown[]) => log.error('飞书 SDK', { detail: sdkDetail(args) }),
    warn: (...args: unknown[]) => log.warn('飞书 SDK', { detail: sdkDetail(args) }),
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
}
