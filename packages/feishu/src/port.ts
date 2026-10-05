// 网关和飞书之间的接口：进来的四种事件（消息、撤回、卡片按钮、机器人菜单）与出去的五个动作。
// 真实现在 lark.ts（官方 SDK 的 Channel），测试用假的。往飞书发东西只能经 FeishuPort，别处不许直接调 SDK。

/** 这条消息 @了谁（飞书事件里的 mentions）。 */
export interface InboundMention {
  name?: string | undefined;
  openId?: string | undefined;
  isBot: boolean;
}

export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  /** 归一化后的文字（SDK 做的：@机器人 已去掉，@别人 写成 @名字，富文本取文字）。 */
  text: string;
  /** 飞书的消息类型（text、post、image、file、audio、merge_forward……），认不出的也原样带着。 */
  msgType: string;
  /** 飞书给的原始 content（JSON 字符串），一个字没动：留底对账、判同一条消息内容变没变。 */
  rawContent: string;
  mentionedBot: boolean;
  mentions: InboundMention[];
  /** 回复的是哪条消息（飞书的 parent_id）。 */
  replyToMessageId?: string | undefined;
  /** 回复链、话题的根消息（飞书的 root_id）。 */
  rootId?: string | undefined;
  /** 飞书话题（thread_id）：同一个话题算同一段意图。 */
  threadId?: string | undefined;
  /** 毫秒时间戳（飞书的 create_time）；事件里没带是 0。 */
  createTime: number;
  /** 改过的时刻（飞书的 update_time，只补漏翻历史时才有：SDK 没有「消息被改」的事件）；没改过是 undefined。 */
  editedAt?: number | undefined;
  /** 机器人发的（包括自己）：不理。 */
  fromBot: boolean;
}

/** 飞书的撤回事件（im.message.recalled_v1）：不带是谁撤的、不带会话种类。 */
export interface InboundRecall {
  messageId: string;
  chatId: string;
  /** 毫秒时间戳（飞书的 recall_time）。 */
  recalledAt: number;
}

export interface InboundCardAction {
  /** 卡片所在的消息。 */
  messageId: string;
  chatId: string;
  operatorId: string;
  /** 按钮上的回传值（我们自己在 cards.ts 里写进去的）。 */
  value: unknown;
  /** 表单容器提交时各输入项的值。 */
  formValue?: Record<string, unknown> | undefined;
}

export interface InboundMenu {
  /** 飞书事件编号，重投时相同。 */
  eventId?: string | undefined;
  operatorId: string;
  /** 开发者后台给菜单配的 event_key。 */
  key: string;
}

/** 晚推来的消息多晚以内照收（lark.ts 给 SDK 的 staleMessageWindowMs）；更早的只能靠补漏翻历史。 */
export const LATE_DELIVERY_MS = 6 * 60 * 60 * 1000;

export type Card = Record<string, unknown>;
export type OutMessage = { card: Card } | { text: string };
export type Target = { chatId: string } | { openId: string };

export interface Sent {
  messageId: string;
  /** 私聊按 open_id 发时，飞书回的会话编号。 */
  chatId: string;
}

export interface FeishuPort {
  /** 给消息加一个表情回应；返回飞书给的 reaction_id（撤掉这个表情要用），飞书没给是 undefined。 */
  react(messageId: string, emojiType: string): Promise<string | undefined>;
  /** uuid 相同的请求飞书 1 小时内只发一条：重试不会重复。拿到 message_id 才算发出。 */
  send(to: Target, message: OutMessage, opts: { uuid: string }): Promise<Sent>;
  reply(messageId: string, message: OutMessage, opts: { uuid: string }): Promise<Sent>;
  /** 原地更新卡片（只能改 14 天内发出的）。 */
  updateCard(messageId: string, card: Card): Promise<void>;
  /** 群置顶。 */
  pin(chatId: string, messageId: string): Promise<void>;
  /** 撤掉自己加过的表情（补漏把「没记成」换成正常）。 */
  unreact(messageId: string, reactionId: string): Promise<void>;
  /** 翻一个会话的历史消息（补漏用）：按发出时刻从早到晚，只回 sinceMs 之后的。 */
  history(req: HistoryRequest): Promise<HistoryPage>;
}

/** 翻历史：容器是会话，或（在话题里的）话题。 */
export interface HistoryRequest {
  /** 会话编号，或要翻的话题编号（container:'thread' 时）。 */
  containerId: string;
  /** chat = 按会话翻（话题里的回复也在里面）；thread = 只翻这一个话题（飞书按会话翻只给话题的根消息）。 */
  container: 'chat' | 'thread';
  /** 这个会话是私聊还是群：历史接口回的行里没有会话种类（飞书的事件里有），由调用方给。 */
  chatKind: InboundMessage['chatType'];
  /** 从这个时刻（毫秒，含）往后翻。 */
  sinceMs: number;
  /** 一页几条。 */
  pageSize?: number;
  /** 翻下一页的凭据（上一页给的）。 */
  pageToken?: string;
}

/** 一页历史：认得出的一条一条（认不出的跳过并计数），按时间从早到晚。 */
export interface HistoryPage {
  messages: InboundMessage[];
  /** 还有更早/更新的没翻完，用这个再翻一页。 */
  nextPageToken?: string | undefined;
  /** 飞书回的行里认不出的（缺编号、缺发出时刻、缺原始内容）：不悄悄少算，报出来。 */
  unrecognized: number;
}

/**
 * too_old = 卡片发出超过 14 天不能再改（230031）；rate_limited = 限频（230020 或 HTTP 429）；
 * format = 卡片内容飞书不认（例如 200861：JSON 2.0 里用了不支持的组件）；permission = 没权限；
 * timeout = 飞书在限时内没回应（不重试，报出来）；unavailable = 连不上或飞书 5xx；unknown = 其余，带原始错误码。
 */
export type FeishuErrorKind =
  | 'too_old'
  | 'rate_limited'
  | 'format'
  | 'permission'
  | 'timeout'
  | 'unavailable'
  | 'unknown';

export class FeishuError extends Error {
  readonly kind: FeishuErrorKind;
  readonly code: number | undefined;
  constructor(
    kind: FeishuErrorKind,
    message: string,
    opts: { code?: number | undefined; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'FeishuError';
    this.kind = kind;
    this.code = opts.code;
  }
}

export function feishuErrorKind(err: unknown): FeishuErrorKind {
  return err instanceof FeishuError ? err.kind : 'unknown';
}
