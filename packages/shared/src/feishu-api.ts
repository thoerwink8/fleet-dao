// 飞书网关（packages/feishu，跑在香港）⇄ 驾驶舱后端（packages/api）共用的几样：路由的写法（FeishuRoute，IntentRoutes 按它写）、
// 代表谁（FeishuActing），和网关通行证能进的驾驶舱接口（FEISHU_GATEWAY_WEB_ROUTES）。
// 走法：经隧道调后端的 /api（路径都在 WEB_API_PREFIX 之下），一律带 `Authorization: Bearer <网关通行证>`。
// 网关现在只调 IntentRoutes（intent-api.ts）。旧的 FeishuRoutes 九条（随手记草稿、查进度、关注、盘面、待推送、回执、卡片登记）
// 随 #1022 在后端删了，网关这边随后也删了，这里不再有它们的路由和形状。
// 下面留着的四个形状只剩 db/schema/feishu.ts 的四张旧表拿来对齐列的取值；删表（人闸：删数据）时一起删。
import { z } from 'zod';
import type { WebRoutes } from './web-api.ts';

const Id = z.string().min(1).max(200);
const Time = z.iso.datetime({ offset: true });
/** 飞书的消息、会话编号（om_… / oc_…）。 */
const FeishuId = z.string().min(1).max(100);

/** required = 必须带 X-Fleet-Acting-Feishu（代表哪位创始人）；none = 网关自己的后台活，只验通行证。 */
export type FeishuActing = 'required' | 'none';

export interface FeishuRoute {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  acting: FeishuActing;
  request?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
}

/**
 * 网关通行证能进的驾驶舱接口（都代表某位创始人，acting=required），后端的门（api/src/session.ts）按它放行。
 * 网关已经不调它们了（旧卡上的按钮停用）；收窄通行证、删掉这份是 #553 PR-7 的事（碰鉴权）。
 */
export const FEISHU_GATEWAY_WEB_ROUTES = ['task', 'taskAction'] as const satisfies ReadonlyArray<
  keyof typeof WebRoutes
>;

// —— 只剩旧表在用的形状（db/schema/feishu.ts 按它们对齐取值），删表时一起删 ——

/** 卡片登记表（feishu_cards.kind）的取值。 */
export const FeishuCardKindSchema = z.enum([
  'draft', // 「我理解为」确认卡
  'progress', // 进度卡
  'board', // 团队群置顶的盘面卡
  'list', // 私聊里点菜单或按钮出的清单、挑选卡
  'answer', // 回答（追问的回答、闲聊）
  'decision', // 要人拍
  'alert', // 卡住报警
  'daily', // 日报
  'follow', // 关注的需求到了关键节点
  'ask', // AI 在任务里追问
]);

const FeishuRepoRefSchema = z.object({
  id: Id,
  /** owner/name */
  fullName: z.string().min(1).max(200),
});

/** 随手记草稿表（feishu_drafts.status）的取值从这里来。 */
export const FeishuDraftSchema = z.object({
  id: Id,
  revision: z.number().int().min(1),
  status: z.enum(['open', 'confirmed']),
  rawText: z.string(),
  understanding: z.string().min(1).max(1000),
  unsure: z.boolean(),
  repo: FeishuRepoRefSchema.nullable(),
  repoOptions: z.array(FeishuRepoRefSchema).max(20),
  proposedBy: z.string(),
  cardMessageId: FeishuId.optional(),
  task: z
    .object({
      taskId: Id,
      repo: z.string(),
      issueNumber: z.number().int().positive(),
    })
    .optional(),
  confirmedBy: z.string().optional(),
  updatedAt: Time,
});

/** 草稿表的会话种类（feishu_drafts.chat_type）从这里来。 */
export const FeishuMessageRequest = z.object({
  sourceMessageId: FeishuId,
  text: z.string().min(1).max(4000),
  chatType: z.enum(['p2p', 'group']),
  replyToMessageId: FeishuId.optional(),
});

/** 推送送达表（feishu_outbox）的回执状态从这里来。 */
export const FeishuOutboxAckSchema = z.object({
  itemId: Id,
  revision: z.number().int().min(1),
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('sent'), messageId: FeishuId, chatId: FeishuId, sentAt: Time }),
    z.object({ status: z.literal('updated'), messageId: FeishuId }),
    z.object({ status: z.literal('deferred'), until: Time, reason: z.literal('quiet_hours') }),
    z.object({
      status: z.literal('dropped'),
      reason: z.enum(['kind_not_allowed', 'not_founder', 'already_done', 'over_budget']),
    }),
    z.object({ status: z.literal('failed'), error: z.string().max(500), retryAfter: Time }),
  ]),
});
