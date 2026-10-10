// 驾驶舱接口约定（web-api）：通知与操作记录。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { ActorSchema, PageQuery } from './common.ts';
import { Cursor, Id, Time } from './internal.ts';

// —— 通知 ——

/** 三级：要人拍 / 卡住报警 / 日报。 */
export const NotificationLevelSchema = z.enum(['decision', 'alert', 'daily']);

/**
 * 提醒的处理状态（design 15.3「谁在处理」）：读时从认领、PR 镜像、发布记录现算（@fleet-dao/core 的 alertHandling），
 * 不另存。判法和这几个名字在 core 里用的是同一份。
 */
export const ALERT_STAGES = [
  'resolved',
  'silenced',
  'waiting_founder',
  'unclaimed',
  'pr_open',
  'merged',
  'deployed',
] as const;

/** 提醒挂的单、修它的 PR 在哪个仓：链接由驾驶舱按品牌拼，后端不发网址。 */
const AlertRepoSchema = z.object({ owner: z.string(), name: z.string() });

export const AlertHandlingSchema = z.object({
  stage: z.enum(ALERT_STAGES),
  /** 阶段说成人话：没人在修、有人在修、PR 开着、合进主线、等发布…… */
  stageText: z.string(),
  /** 进这个阶段的时刻：「多久了」从它算。 */
  since: Time,
  /** 谁在处理：PR #号、建静默的人、创始人；没人是空（认领账 2026-10-03 起整张删掉，不再有「机器/工人」）。 */
  who: z.string().optional(),
  /** 跟进单：提醒挂的任务的单，或者 alert_work 表里挂的单（原来「提醒派单」自动开、`alert claim` 手动挂，#445 起这两条写路都删了，只留历史挂的）。 */
  work: z.object({ repo: AlertRepoSchema, issueNumber: z.number().int().positive() }).optional(),
  /** 带动这个阶段的 PR。 */
  pr: z
    .object({
      repo: AlertRepoSchema,
      number: z.number().int().positive(),
      state: z.enum(['open', 'closed', 'merged']),
    })
    .optional(),
  silence: z.object({ by: z.string(), comment: z.string(), endsAt: Time }).optional(),
  /** 合了以后才有：发布了没有；判不了写为什么。 */
  deploy: z
    .object({ state: z.enum(['deployed', 'not_yet', 'unknown']), why: z.string().optional() })
    .optional(),
  /** 给人看的一行：「PR #350 在处理 · owner/仓#342 · PR #350 开着 · 35 分钟」。 */
  line: z.string(),
  /** 没查成的，一条一句。 */
  problems: z.array(z.string()),
});

export const NotificationSchema = z.object({
  id: Id,
  level: NotificationLevelSchema,
  title: z.string(),
  body: z.string(),
  /** 点开直达驾驶舱对应页的站内路径。 */
  link: z.string().optional(),
  taskId: Id.optional(),
  /**
   * 去重键（「同一件事一条」的认法，如 quota-read:<池>、probe-iq:<路由>）。页面据此把提醒对到具体的池、路由上（#1748）。
   * 老数据（镜像里没存过的）没有。
   */
  dedupeKey: z.string().optional(),
  createdAt: Time,
  resolvedAt: Time.optional(),
  resolvedBy: z.string().optional(),
  deliveries: z.array(
    z.object({
      channel: z.string(),
      /** 没拿到消息编号就算没送到。 */
      delivered: z.boolean(),
      attempts: z.number().int().min(0),
      error: z.string().optional(),
      lastAttemptAt: Time.optional(),
    }),
  ),
  /** 谁在处理、修到哪（现算）；这一页没算成时整页的 handlingProblem 写为什么。 */
  handling: AlertHandlingSchema.optional(),
});

export const NotificationsQuery = PageQuery.extend({
  status: z.enum(['open', 'all']).default('open'),
});
export const NotificationsResponse = z.object({
  items: z.array(NotificationSchema),
  nextCursor: Cursor.optional(),
  /**
   * 各级别的真实总条数（同 status 口径，不受 limit 截断）。
   * 「待处理」＝要你拍 + 卡住报警；日报只是看一眼，不算进待处理。铃铛、侧栏角标、通知中心都读这里。
   */
  counts: z.object({
    decision: z.number().int().min(0),
    alert: z.number().int().min(0),
    daily: z.number().int().min(0),
  }),
  /** 这一页「谁在处理」没算成：为什么（没接上、读不到库）。算成了没有这一项。 */
  handlingProblem: z.string().optional(),
});
export const ResolveNotificationResponse = z.object({ ok: z.literal(true) });

// —— 操作记录 ——

/**
 * 只追加，不改旧记录；先记后做：动作执行之前先写一条（写不进就不做），这一条的 ok=true 表示「已记录并发起」。
 * 发起之后没做成（例如工作流已结束），再追加一条同 action、同 target、ok=false、带 error 的记录。
 */
export const AuditEntrySchema = z.object({
  id: Id,
  at: Time,
  actor: ActorSchema,
  /** 例如 stage_policy.update、task.pause、login。 */
  action: z.string(),
  /** 例如 stage:execute、task:12、channel:cursor。 */
  target: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().optional(),
  via: z.enum(['cockpit', 'feishu', 'github', 'engine', 'agent']),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const AuditQuery = PageQuery.extend({ target: z.string().max(200).optional() });
export const AuditResponse = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: Cursor.optional(),
});
