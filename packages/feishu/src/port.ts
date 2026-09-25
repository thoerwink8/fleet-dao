// 网关和飞书之间的接口：进来的三种事件（消息、卡片按钮、机器人菜单）与出去的五个动作。
// 真实现在 lark.ts（官方 SDK 的 Channel），测试用假的。往飞书发东西只能经 FeishuPort，别处不许直接调 SDK。

export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  /** 归一化后的文字（@机器人 已去掉，@别人 写成 @名字）。 */
  text: string;
  mentionedBot: boolean;
  /** 回复的是哪条消息（飞书的 parent_id）。 */
  replyToMessageId?: string | undefined;
  /** 毫秒时间戳（飞书的 create_time）。 */
  createTime: number;
  /** 机器人发的（包括自己）：不理。 */
  fromBot: boolean;
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

/** 飞书只能改 14 天内发出的消息（更新卡片接口，错误码 230031）。 */
export const CARD_EDITABLE_MS = 14 * 24 * 60 * 60 * 1000;

export type Card = Record<string, unknown>;
export type OutMessage = { card: Card } | { text: string };
export type Target = { chatId: string } | { openId: string };

export interface Sent {
  messageId: string;
  /** 私聊按 open_id 发时，飞书回的会话编号。 */
  chatId: string;
}

export interface FeishuPort {
  /** 给消息加一个表情回应。 */
  react(messageId: string, emojiType: string): Promise<void>;
  /** uuid 相同的请求飞书 1 小时内只发一条：重试不会重复。拿到 message_id 才算发出。 */
  send(to: Target, message: OutMessage, opts: { uuid: string }): Promise<Sent>;
  reply(messageId: string, message: OutMessage, opts: { uuid: string }): Promise<Sent>;
  /** 原地更新卡片（只能改 14 天内发出的）。 */
  updateCard(messageId: string, card: Card): Promise<void>;
  /** 群置顶。 */
  pin(chatId: string, messageId: string): Promise<void>;
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
