// 飞书官方 SDK（@larksuiteoapi/node-sdk）的 Channel：长连接收事件（服务器不开端口）、自带去重和按会话排队。
// 往飞书发东西只在这个文件里（test/static.test.ts 查着）：别处经 FeishuPort。
// 收法（#553 第 4 条）：允许的群里每条都收、不用 @（要飞书开发者后台给应用开「获取群组中所有消息」im:message.group_msg；
// 没开时飞书只推 @机器人 的和私聊），@所有人 的也收；谁的话存、谁的丢由网关判（gateway.ts），这里只挡别的群。
// Channel 没管的几处自己补：
// - 机器人菜单事件 application.bot.menu_v6、撤回事件 im.message.recalled_v1、进群事件
//   im.chat.member.user.added_v1：注册到 Channel 内部的事件分发器上（它没公开，升级 SDK 后 test/lark.test.ts 会报）；
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
  normalize,
  type RawMessageEvent,
} from '@larksuiteoapi/node-sdk';
import type { Logger } from './log.ts';
import {
  type Card,
  FeishuError,
  type FeishuErrorKind,
  type FeishuPort,
  type InboundCardAction,
  type InboundJoin,
  type InboundMenu,
  type InboundMessage,
  type InboundRecall,
  LATE_DELIVERY_MS,
  type OutMessage,
  type Sent,
  type Target,
} from './port.ts';
import { sleep } from './util.ts';

/** 表情回应要赶「2 秒内先回应」，给 3 秒；别的调用 10 秒。 */
export const FEISHU_TIMEOUTS = { reactMs: 3_000, callMs: 10_000 };

export interface InboundHandlers {
  onMessage(msg: InboundMessage): void;
  onRecall(evt: InboundRecall): void;
  onJoin(evt: InboundJoin): void;
  onCardAction(evt: InboundCardAction): void;
  onMenu(evt: InboundMenu): void;
  onReject(evt: { messageId: string; chatId: string; senderId: string; reason: string }): void;
}

export interface LarkOptions {
  appId: string;
  appSecret: string;
  /** 允许的群（团队群、测试群）；别的群里说什么一律不收。 */
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
const RECALL_EVENT = 'im.message.recalled_v1';
const MEMBER_EVENT = 'im.chat.member.user.added_v1';
/** 翻历史一页几条（飞书上限 50；补漏按顺序一页页翻，够用）。 */
export const HISTORY_PAGE_SIZE = 50;

export function createLark(opts: LarkOptions): Lark {
  const timeouts = { ...FEISHU_TIMEOUTS, ...opts.timeouts };
  const channel = createLarkChannel({
    appId: opts.appId,
    appSecret: opts.appSecret,
    transport: opts.transport ?? 'websocket',
    // 群里不要求 @：创始人的每句话都是意图的一部分；@所有人 的照收（只是存，机器人不回话）
    policy: { requireMention: false, dmMode: 'open', groupAllowlist: opts.groups, respondToMentionAll: true },
    safety: {
      // 不合并连发的消息：两个人在群里前后脚说话，合并会把前一个人的话算到后一个人头上。
      batch: { text: { delayMs: 0 } },
      // 默认 30 分钟前的消息静默丢掉；网关重启或断线期间的消息宁可晚回也不丢。
      staleMessageWindowMs: LATE_DELIVERY_MS,
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
      const res = await api(
        '加表情回应',
        () =>
          client.im.v1.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: emojiType } },
          }),
        // 回应只有赶在 2 秒内才有用：不重试。
        { retries: 0, timeoutMs: timeouts.reactMs },
      );
      return res.data?.reaction_id || undefined;
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

    async unreact(messageId, reactionId) {
      await api('撤表情回应', () =>
        client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } }),
      );
    },

    async history(req) {
      const res = await api('翻会话历史', () =>
        client.im.v1.message.list({
          params: {
            container_id_type: req.container === 'thread' ? 'thread' : 'chat',
            container_id: req.containerId,
            // 只要这个时刻之后的（含）：飞书按毫秒时间戳过滤
            start_time: String(Math.floor(req.sinceMs / 1000)),
            sort_type: 'ByCreateTimeAsc',
            page_size: req.pageSize ?? HISTORY_PAGE_SIZE,
            ...(req.pageToken ? { page_token: req.pageToken } : {}),
          },
        }),
      );
      const items = res.data?.items ?? [];
      const messages: InboundMessage[] = [];
      let unrecognized = 0;
      for (const item of items) {
        const msg = await toHistoryInbound(item, req.chatKind, channel.botIdentity?.openId);
        if (msg) messages.push(msg);
        else {
          unrecognized += 1;
          opts.log.warn('历史里有认不出的一行，跳过（缺编号、会话、发出时刻或原始内容）', {
            messageId: item.message_id ?? null,
            chatId: item.chat_id ?? null,
          });
        }
      }
      const hasMore = res.data?.has_more === true && !!res.data?.page_token;
      return {
        messages,
        ...(hasMore ? { nextPageToken: res.data?.page_token } : {}),
        unrecognized,
      };
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
        [RECALL_EVENT]: (data: unknown) => {
          const recall = toRecall(data);
          if (recall) handlers.onRecall(recall);
          else {
            // 撤回事件里没有原话：整条记下来也不漏什么
            opts.log.warn('撤回事件认不出，丢了（补漏时历史接口会再标一次撤回）', {
              data: JSON.stringify(data).slice(0, 300),
            });
          }
          return undefined;
        },
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

export function toInbound(msg: NormalizedMessage, botOpenId: string | undefined): InboundMessage {
  // includeRawEvent 开着：raw 是 SDK 解出来的事件（header、event 两层摊平），原始 content 在 raw.message.content
  const raw = msg.raw as { sender?: { sender_type?: string }; message?: { content?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  const content = raw?.message?.content;
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    text: msg.content,
    msgType: msg.rawContentType,
    rawContent: typeof content === 'string' ? content : '',
    mentionedBot: msg.mentionedBot,
    mentions: msg.mentions.map((m) => ({ name: m.name, openId: m.openId, isBot: m.isBot === true })),
    replyToMessageId: msg.replyToMessageId,
    rootId: msg.rootId,
    threadId: msg.threadId,
    createTime: msg.createTime,
    fromBot:
      (senderType !== undefined && senderType !== 'user') || (!!botOpenId && msg.senderId === botOpenId),
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

/** 撤回事件：编号、会话、撤回时刻都得有，少一样就是认不出（null）。 */
export function toRecall(data: unknown): InboundRecall | null {
  const d = data as { message_id?: unknown; chat_id?: unknown; recall_time?: unknown } | null;
  if (!d || typeof d.message_id !== 'string' || !d.message_id || typeof d.chat_id !== 'string' || !d.chat_id)
    return null;
  const at = typeof d.recall_time === 'string' ? Number(d.recall_time) : Number.NaN;
  if (!Number.isFinite(at) || at <= 0) return null;
  return { messageId: d.message_id, chatId: d.chat_id, recalledAt: at };
}

/** 飞书「获取会话历史消息」回的一行（只列用得上的；这是别人的接口，字段可缺）。 */
export interface HistoryItem {
  message_id?: string | undefined;
  chat_id?: string | undefined;
  msg_type?: string | undefined;
  create_time?: string | number | undefined;
  update_time?: string | number | undefined;
  root_id?: string | undefined;
  parent_id?: string | undefined;
  thread_id?: string | undefined;
  body?: { content?: string | undefined } | undefined;
  sender?: { id?: string | undefined; sender_type?: string | undefined } | undefined;
  mentions?: Array<{ id?: string | undefined; name?: string | undefined }> | undefined;
}

/**
 * 翻历史翻出来的一行 → 一份和事件同形的「原始事件」：飞书的「获取会话历史消息」给的字段比事件少
 * （没有 chat_type、没有 mentions 的 key、没有归一化后的文字），这里按它给的拼回去，
 * 再走 SDK 的 normalize + toInbound——两条路（事件、补漏）存下的原话就一个样。
 */
function historyEvent(item: HistoryItem, chatKind: InboundMessage['chatType']): unknown {
  const mentions = (item.mentions ?? []).map((m, i) => ({
    // 历史接口给的是「这条消息 @了谁」：只用来算「@了机器人没有」、把 @ 写成 @名字，key 怎么排不影响
    key: `@_user_${i + 1}`,
    id: { open_id: m.id ?? '', user_id: '', union_id: '' },
    name: m.name ?? '',
  }));
  return {
    header: { event_type: 'im.message.receive_v1', event_id: `history:${item.message_id ?? ''}` },
    event: {
      sender: {
        sender_id: { open_id: item.sender?.id ?? '', user_id: '', union_id: '' },
        sender_type: item.sender?.sender_type ?? 'user',
      },
      message: {
        message_id: item.message_id,
        chat_id: item.chat_id,
        chat_type: chatKind,
        message_type: item.msg_type,
        content: item.body?.content,
        create_time: String(item.create_time ?? ''),
        update_time: String(item.update_time ?? ''),
        root_id: item.root_id,
        parent_id: item.parent_id,
        thread_id: item.thread_id,
        mentions,
      },
    },
  };
}

/**
 * 一行历史 → InboundMessage（走和事件同一套归一化）。缺编号、会话、类型、发出时刻、原始内容的，
 * 认不出（null），由调用方计数——不悄悄少算，也不拿空串顶。
 */
export async function toHistoryInbound(
  item: HistoryItem,
  chatKind: InboundMessage['chatType'],
  botOpenId: string | undefined,
): Promise<InboundMessage | null> {
  const at = Number(item.create_time);
  if (!item.message_id || !item.chat_id || !item.msg_type || !Number.isFinite(at) || at <= 0) return null;
  if (typeof item.body?.content !== 'string' || !item.body.content) return null;
  const msg = await normalize(historyEvent(item, chatKind) as RawMessageEvent, {
    botIdentity: { openId: botOpenId ?? '', name: '' },
    stripBotMentions: true,
    includeRaw: true,
  });
  const inbound = toInbound(msg, botOpenId);
  const updated = Number(item.update_time);
  return Number.isFinite(updated) && updated > at ? { ...inbound, editedAt: updated } : inbound;
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
