// 飞书官方 SDK（@larksuiteoapi/node-sdk）的 Channel：长连接收事件（服务器不开端口）、自带去重和按会话排队。
// 往飞书发东西只在这个文件里（test/static.test.ts 查着）：别处经 FeishuPort。
// Channel 没管的几处自己补：
// - 机器人菜单事件 application.bot.menu_v6：注册到 Channel 内部的事件分发器上（它没公开，升级 SDK 后 test/lark.test.ts 会报）；
// - 发消息带 uuid（同一件事重试不重复发）：Channel.send 不带，改用它公开的 rawClient；
// - 超时：SDK 默认的 HTTP 实例不设超时（实读为 0），飞书接口一挂住，推送和盘面这些串行的活就全停、也不报警。
//   每次调用自己限时（表情回应 3 秒，其余 10 秒），超时记错误；HTTP 实例上也带同样的上限，挂住的连接会被收掉。
import {
  type Cache,
  type CardActionEvent,
  createLarkChannel,
  defaultHttpInstance,
  type EventDispatcher,
  type HttpInstance,
  type LarkChannel,
  LoggerLevel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import type { Logger } from './log.ts';
import {
  type Card,
  FeishuError,
  type FeishuErrorKind,
  type FeishuPort,
  type InboundCardAction,
  type InboundMenu,
  type InboundMessage,
  type OutMessage,
  type Sent,
  type Target,
} from './port.ts';
import { sleep } from './util.ts';

/** 表情回应要赶「2 秒内先回应」，给 3 秒；别的调用 10 秒。 */
export const FEISHU_TIMEOUTS = { reactMs: 3_000, callMs: 10_000 };

export interface InboundHandlers {
  onMessage(msg: InboundMessage): void;
  onCardAction(evt: InboundCardAction): void;
  onMenu(evt: InboundMenu): void;
  onReject(evt: { messageId: string; chatId: string; senderId: string; reason: string }): void;
}

export interface LarkOptions {
  appId: string;
  appSecret: string;
  /** 允许的群（团队群、测试群）；别的群里 @我 一律不理。 */
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

const MENU_EVENT = 'application.bot.menu_v6';

export function createLark(opts: LarkOptions): Lark {
  const timeouts = { ...FEISHU_TIMEOUTS, ...opts.timeouts };
  const channel = createLarkChannel({
    appId: opts.appId,
    appSecret: opts.appSecret,
    transport: opts.transport ?? 'websocket',
    policy: { requireMention: true, dmMode: 'open', groupAllowlist: opts.groups, respondToMentionAll: false },
    safety: {
      // 不合并连发的消息：两个人在群里前后脚说话，合并会把前一个人的话算到后一个人头上。
      batch: { text: { delayMs: 0 } },
      // 默认 30 分钟前的消息静默丢掉；网关重启或断线期间的消息宁可晚回也不丢。
      staleMessageWindowMs: 6 * 60 * 60 * 1000,
    },
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
      '飞书 SDK 变了：LarkChannel 里找不到事件分发器，机器人菜单接不上。先别升级 SDK，或改 lark.ts',
    );
  }
  const client = channel.rawClient;

  /** 调一次飞书：限时；超时不重试（报出来，由调用方决定下一步）；连不上、限频有界重试。 */
  async function api<T extends { code?: number | undefined; msg?: string | undefined }>(
    what: string,
    call: () => Promise<T>,
    o: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = o.retries ?? 2;
    const timeoutMs = o.timeoutMs ?? timeouts.callMs;
    for (let attempt = 0; ; attempt++) {
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
    async react(messageId, emojiType) {
      await api(
        '加表情回应',
        () =>
          client.im.v1.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: emojiType } },
          }),
        // 回应只有赶在 2 秒内才有用：不重试。
        { retries: 0, timeoutMs: timeouts.reactMs },
      );
    },

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

    async pin(chatId, messageId) {
      await api('群置顶', () =>
        client.im.v1.chatTopNotice.putTopNotice({
          path: { chat_id: chatId },
          data: { chat_top_notice: [{ action_type: '1', message_id: messageId }] },
        }),
      );
    },
  };

  return {
    port,
    channel,

    wire(handlers) {
      channel.on('message', (msg) => handlers.onMessage(toInbound(msg, channel.botIdentity?.openId)));
      channel.on('cardAction', (evt) => handlers.onCardAction(toAction(evt)));
      channel.on('reject', (evt) => handlers.onReject(evt));
      channel.on('error', (err) =>
        opts.log.error('飞书 SDK 处理入站事件出错', { code: err.code, error: err.message }),
      );
      channel.on('reconnecting', () => opts.log.warn('飞书长连接断了，正在重连'));
      channel.on('reconnected', () => opts.log.info('飞书长连接重连上了'));
      dispatcher.register({
        [MENU_EVENT]: (data: unknown) => {
          const menu = toMenu(data);
          if (menu) handlers.onMenu(menu);
          else opts.log.warn('机器人菜单事件认不出，丢了', { data: JSON.stringify(data).slice(0, 300) });
          // 立刻返回：长连接等这个返回值才回飞书。
          return undefined;
        },
      });
    },

    connect: () => channel.connect(),
    disconnect: () => channel.disconnect(),
    dispatch: (raw) => dispatcher.invoke(raw, { needCheck: false }),
  };
}

export function toInbound(msg: NormalizedMessage, botOpenId: string | undefined): InboundMessage {
  const raw = msg.raw as { sender?: { sender_type?: string } } | undefined;
  const senderType = raw?.sender?.sender_type;
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    text: msg.content,
    mentionedBot: msg.mentionedBot,
    replyToMessageId: msg.replyToMessageId,
    createTime: msg.createTime,
    fromBot:
      (senderType !== undefined && senderType !== 'user') || (!!botOpenId && msg.senderId === botOpenId),
  };
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

export function toMenu(data: unknown): InboundMenu | null {
  const d = data as {
    event_id?: unknown;
    event_key?: unknown;
    operator?: { operator_id?: { open_id?: unknown } };
  } | null;
  const openId = d?.operator?.operator_id?.open_id;
  if (!d || typeof d.event_key !== 'string' || typeof openId !== 'string') return null;
  return {
    eventId: typeof d.event_id === 'string' ? d.event_id : undefined,
    operatorId: openId,
    key: d.event_key,
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
 * 200861 卡片里有 JSON 2.0 不支持的组件（同上，windsurf-dao#1052）；其余归 unknown，原码写进日志。
 */
function kindOf(code: number | undefined, status: number | undefined): FeishuErrorKind {
  if (code === 230031) return 'too_old';
  if (code === 230020 || status === 429) return 'rate_limited';
  if (code === 200861) return 'format';
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
