// 真实形状的飞书事件：fixtures/ 里是长连接推来的原样（v2 结构，编号都是占位），改几个字段就是一条新事件。
// 解析走 SDK 自己的分发器和归一化（和生产同一套），再经 lark.ts 的转换交给网关。
import { readFileSync } from 'node:fs';
import { EventDispatcher, LoggerLevel, normalizeCardAction } from '@larksuiteoapi/node-sdk';
import { toAction } from '../src/lark.ts';
import type { InboundCardAction } from '../src/port.ts';

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

/** 一条群聊或私聊消息的事件。网关已经不收话了：只用来钉「收到也什么都不做」。 */
export function messageEvent(o: {
  text: string;
  from?: string;
  chat?: 'p2p' | 'group';
  chatId?: string;
  id?: string;
}): Envelope {
  const group = o.chat === 'group';
  const e = fixture(group ? 'message-group-at' : 'message-p2p');
  const id = o.id ?? nextId('om_user');
  e.header.event_id = `evt_${id}`;
  e.event.sender.sender_id.open_id = o.from ?? A;
  const m = e.event.message;
  m.message_id = id;
  m.create_time = String(Date.now());
  if (o.chatId) m.chat_id = o.chatId;
  m.content = JSON.stringify({ text: `${group ? '@_user_1 ' : ''}${o.text}` });
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

const parser = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
  'card.action.trigger': async (d: unknown) => d,
});

export async function asAction(envelope: Envelope): Promise<InboundCardAction> {
  const evt = normalizeCardAction(await parser.invoke(envelope, { needCheck: false }), { includeRaw: true });
  if (!evt) throw new Error('SDK 认不出这条按钮事件');
  return toAction(evt);
}
