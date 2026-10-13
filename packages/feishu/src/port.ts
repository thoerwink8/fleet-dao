// 网关和飞书之间的接口：进来的两种事件（进群、旧卡上的按钮）与出去的三个动作。
// 飞书收缩后（#2047 提需求 F1）不再收群聊、私聊的话，也没有机器人菜单。
// 真实现在 lark.ts（官方 SDK 的 Channel），测试用假的。往飞书发东西只能经 FeishuPort，别处不许直接调 SDK。

/** 有人进群（im.chat.member.user.added_v1）：会话、进群时刻、进来的人的 open_id。 */
export interface InboundJoin {
  /** 飞书事件编号；重投时相同。事件里没有就是 undefined。 */
  eventId?: string | undefined;
  chatId: string;
  /** 毫秒时间戳（飞书的 create_time）。 */
  at: number;
  openIds: string[];
}

export interface InboundCardAction {
  /** 卡片所在的消息。 */
  messageId: string;
  chatId: string;
  operatorId: string;
  /** 按钮上的回传值（旧卡上的，我们自己在 cards.ts 里写进去的）。 */
  value: unknown;
  /** 表单容器提交时各输入项的值。 */
  formValue?: Record<string, unknown> | undefined;
}

export type Card = Record<string, unknown>;
export type OutMessage = { card: Card } | { text: string };
export type Target = { chatId: string } | { openId: string };

export interface Sent {
  messageId: string;
  /** 私聊按 open_id 发时，飞书回的会话编号。 */
  chatId: string;
}

export interface FeishuPort {
  /** uuid 相同的请求飞书 1 小时内只发一条：重试不会重复。拿到 message_id 才算发出。 */
  send(to: Target, message: OutMessage, opts: { uuid: string }): Promise<Sent>;
  reply(messageId: string, message: OutMessage, opts: { uuid: string }): Promise<Sent>;
  /** 原地更新卡片（只能改 14 天内发出的）。 */
  updateCard(messageId: string, card: Card): Promise<void>;
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
