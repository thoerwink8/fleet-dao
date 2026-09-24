// 真实形状的飞书事件：fixtures/ 里是长连接推来的原样（v2 结构，编号都是占位），改几个字段就是一条新事件。
// 解析走 SDK 自己的分发器和归一化（和生产同一套），再经 lark.ts 的转换交给网关。
import { readFileSync } from 'node:fs';
import { EventDispatcher, LoggerLevel, normalize, normalizeCardAction } from '@larksuiteoapi/node-sdk';
import { toAction, toInbound, toMenu } from '../src/lark.ts';
import type { InboundCardAction, InboundMenu, InboundMessage } from '../src/port.ts';

export const BOT = { openId: 'ou_bot', name: 'fleet' };
export const A = 'ou_founder_a';
export const B = 'ou_founder_b';
export const STRANGER = 'ou_stranger';
export const TEAM = 'oc_team';
export const TEST_GROUP = 'oc_test';

// biome-ignore lint/suspicious/noExplicitAny: 事件是 JSON，测试里按需改字段
export type Envelope = any;

export function fixture(name: string): Envelope {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${++seq}`;

export function messageEvent(o: {
  text: string;
  from?: string;
  chat?: 'p2p' | 'group';
  chatId?: string;
  /** 群里默认 @了机器人。 */
  mentionBot?: boolean;
  replyTo?: string;
  id?: string;
  senderType?: string;
}): Envelope {
  const group = o.chat === 'group';
  const e = fixture(group ? 'message-group-at' : 'message-p2p');
  const id = o.id ?? nextId('om_user');
  e.header.event_id = `evt_${id}`;
  e.event.sender.sender_id.open_id = o.from ?? A;
  if (o.senderType) e.event.sender.sender_type = o.senderType;
  const m = e.event.message;
  m.message_id = id;
  m.create_time = String(Date.now());
  if (o.chatId) m.chat_id = o.chatId;
  const mention = group && (o.mentionBot ?? true);
  m.content = JSON.stringify({ text: mention ? `@_user_1 ${o.text}` : o.text });
  if (!mention) delete m.mentions;
  if (o.replyTo) {
    m.parent_id = o.replyTo;
    m.root_id = o.replyTo;
  } else {
    delete m.parent_id;
    delete m.root_id;
  }
  return e;
}

export function cardEvent(o: {
  messageId: string;
  value: unknown;
  chatId?: string;
  from?: string;
  form?: Record<string, unknown>;
}): Envelope {
  const e = fixture(o.form ? 'card-form' : 'card-action');
  e.header.event_id = nextId('evt_card');
  e.event.operator.open_id = o.from ?? A;
  e.event.action.value = o.value;
  if (o.form) e.event.action.form_value = o.form;
  e.event.context.open_message_id = o.messageId;
  e.event.context.open_chat_id = o.chatId ?? TEAM;
  return e;
}

export function menuEvent(o: { key: string; from?: string; eventId?: string }): Envelope {
  const e = fixture('menu');
  e.header.event_id = o.eventId ?? nextId('evt_menu');
  e.event.event_key = o.key;
  e.event.operator.operator_id.open_id = o.from ?? A;
  return e;
}

const parser = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
  'im.message.receive_v1': async (d: unknown) => d,
  'card.action.trigger': async (d: unknown) => d,
  'application.bot.menu_v6': async (d: unknown) => d,
});

async function parse(envelope: Envelope): Promise<Envelope> {
  return parser.invoke(envelope, { needCheck: false });
}

export async function asMessage(envelope: Envelope): Promise<InboundMessage> {
  const msg = await normalize(await parse(envelope), {
    botIdentity: BOT,
    stripBotMentions: true,
    includeRaw: true,
  });
  return toInbound(msg, BOT.openId);
}

export async function asAction(envelope: Envelope): Promise<InboundCardAction> {
  const evt = normalizeCardAction(await parse(envelope), { includeRaw: true });
  if (!evt) throw new Error('SDK 认不出这条按钮事件');
  return toAction(evt);
}

export async function asMenu(envelope: Envelope): Promise<InboundMenu> {
  const menu = toMenu(await parse(envelope));
  if (!menu) throw new Error('认不出这条菜单事件');
  return menu;
}
