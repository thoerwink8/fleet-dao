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
  /** 谁在处理：PR #号、建静默的人、创始人；没人是空（认领账整张删掉，不再有「机器/工人」）。 */
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

// —— 「要你拍」的选项和答案（#1915）——
// 要人拍的事给几个选项（每项一句话，其中一项标推荐并写理由，并带上选了以后系统执行的动作），外加一个自己输入的框。
// 创始人点一个或自己写：系统按动作执行，结果写回这张卡，成功才转已处理。自己写的、以及没有具体动作的，交给指挥官，
// 卡上写 HANDED_TO_COMMANDER。补不出选项的，页面写明 NO_OPTIONS_TEXT，不静默退回单纯确认。

/** 补不出选项的「要你拍」：页面和通知里照这句写，让人直接回复。 */
export const NO_OPTIONS_TEXT = '没有选项，请直接回复';

/** 自己写的、以及没有具体动作的选项，交给指挥官之后写在卡上的那句。 */
export const HANDED_TO_COMMANDER = '已转给指挥官';

/** 选了「删掉」工作树：后端提不了权，交给引擎（execution.queued），卡上先写这句。 */
export const WORKTREE_DELETE_QUEUED =
  '已交给引擎：下一轮每小时对账删掉这棵树，删成了这条转已处理，删不掉写原因';

/**
 * 选了这项系统做什么。旧数据、补不出具体动作的不带 action，读的时候按 note-only（交给指挥官），不报错。
 * delete-worktree 删一棵工作树；keep 留着（处理掉这条，对账不再报）；pause-pool / resume-pool 整池暂停开关；
 * recheck 再查一遍（GitHub App 要带 repo = owner/name，飞书推送不带）；drop-repo 把仓移出受管列表；note-only 只留言。
 */
export const DecisionActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delete-worktree'), path: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('keep') }),
  z.object({ kind: z.literal('pause-pool'), poolId: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('resume-pool'), poolId: z.string().min(1).max(80) }),
  z.object({
    kind: z.literal('recheck'),
    what: z.enum(['github-app', 'feishu-push']),
    /** 重查 GitHub App 时是 owner/name；重查飞书推送没有。 */
    repo: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('drop-repo'),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
  }),
  z.object({ kind: z.literal('note-only') }),
]);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

/** 读不出来（没写、写坏了）一律按只留言，不让一张老卡把列表接口打垮。 */
export function readDecisionAction(option: { action?: unknown } | null | undefined): DecisionAction {
  if (!option || option.action === undefined) return { kind: 'note-only' };
  const parsed = DecisionActionSchema.safeParse(option.action);
  return parsed.success ? parsed.data : { kind: 'note-only' };
}

export const DecisionOptionSchema = z.object({
  /** 选项编号：同一条通知里不重，答案按它认。 */
  id: z.string().min(1).max(40),
  /** 按钮上的字。 */
  label: z.string().min(1).max(60),
  /** 一句话说清选它会怎样。 */
  detail: z.string().min(1).max(300),
  /** 推荐理由：有它就是推荐的那一项（一条通知恰好一项）。 */
  recommended: z.string().min(1).max(300).optional(),
  /**
   * 选了这项，执行成功也不转已处理（#1931）：这条开着本身还在起作用（先看看还没看完、这个池还要留着停）。
   * 执行结果照样写上卡。只有真要了结的那项才不带它。
   */
  keepsOpen: z.literal(true).optional(),
  /** 选了以后系统执行的动作。老数据没有：按 note-only 读。 */
  action: DecisionActionSchema.optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/**
 * 系统没有对应动作时的两个选项（恰好一项推荐）。recommendedId 不要用 hold（第二项占用了）。
 * 工作流挂起这类补不出具体动作的「要你拍」用它，满足「decision 至少两项」。
 */
export function noteOnlyOptions(recommendedId = 'note'): DecisionOption[] {
  return [
    {
      id: recommendedId,
      label: '记下，交给指挥官',
      detail: '答案交给指挥官；交出去了这条才转已处理',
      recommended: '系统没有对应的自动动作，交给指挥官',
      action: { kind: 'note-only' },
    },
    {
      id: 'hold',
      label: '先留着',
      detail: '这条留着，答案仍交给指挥官',
      keepsOpen: true,
      action: { kind: 'note-only' },
    },
  ];
}

/**
 * 这个回答会不会把通知转已处理：点的选项看它带不带 keepsOpen；自己输入的，只要这条有任何一项要留着就留着
 * （写的是什么系统读不懂，不能替人把开着就起作用的提醒处理掉），没有这种选项（含没选项的老通知）就转已处理。
 */
export function answerResolves(
  options: readonly DecisionOption[] | null | undefined,
  optionId: string | undefined,
): boolean {
  if (optionId !== undefined) return !options?.find((o) => o.id === optionId)?.keepsOpen;
  return !options?.some((o) => o.keepsOpen);
}

/** 选项合不合规矩：至少两项、编号不重、恰好一项推荐。合规回 null，不合回一句为什么。 */
export function decisionOptionsProblem(options: readonly DecisionOption[]): string | null {
  if (options.length < 2) return `选项只有 ${options.length} 个：要你拍的事至少给两个选项`;
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) return '选项编号有重的';
  const recommended = options.filter((o) => o.recommended !== undefined).length;
  if (recommended !== 1) return `推荐的选项有 ${recommended} 个：要恰好一个，并写理由`;
  return null;
}

export const DecisionOptionsSchema = z.array(DecisionOptionSchema).superRefine((options, ctx) => {
  const problem = decisionOptionsProblem(options);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/**
 * 选完以后系统执行的结果，存在答案里（answer.execution，再拍一次连答案一起换掉）。失败时 text 是原因，通知不转已处理。
 * queued：这一步不在驾驶舱后端做（删工作树要引擎经 sudo 删，后端进程不许提权），已经交给引擎，做完引擎把结果写回来。
 */
export const DecisionExecutionSchema = z.object({
  ok: z.boolean(),
  text: z.string().min(1).max(500),
  at: Time,
  queued: z.literal(true).optional(),
});
export type DecisionExecution = z.infer<typeof DecisionExecutionSchema>;

/** 创始人拍了什么：点了哪个选项（optionId）或自己写的原文（没有 optionId），连同时刻和谁；系统照着做的结果。 */
export const DecisionAnswerSchema = z.object({
  /** 点的那个选项；自己输入的没有这一项。 */
  optionId: z.string().optional(),
  /** 点选项时是那一项的字；自己输入时是原文。 */
  text: z.string().min(1),
  at: Time,
  /** 谁拍的（用户编号）。 */
  by: z.string(),
  /** 照着做的结果；刚存下还没做、老数据没有。 */
  execution: DecisionExecutionSchema.optional(),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

/** 回答一条「要你拍」：点一个选项（optionId）或自己输入（text），二选一。 */
export const AnswerNotificationRequest = z
  .object({
    optionId: z.string().min(1).max(40).optional(),
    text: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((b) => (b.optionId === undefined) !== (b.text === undefined), {
    message: '点一个选项或自己输入一段话，二选一',
  });

/** 答案交给指挥官那一步（进度单留言、任务单留言）：成了给评论地址，没成写为什么——不拿没报错冒充记上了。 */
export const DecisionHandoffResultSchema = z.union([
  z.object({ ok: z.literal(true), url: z.string() }),
  z.object({ ok: z.literal(false), why: z.string() }),
]);

export const AnswerNotificationResponse = z.object({
  ok: z.literal(true),
  /** 答案连同照着做的结果（answer.execution）。 */
  answer: DecisionAnswerSchema,
  /** 交给指挥官那一步：自己写的、没有具体动作的选项才有；点了系统自己做的选项没有这一项。 */
  handoff: z
    .object({
      /** 进度单 #1055 那一条。 */
      progress: DecisionHandoffResultSchema,
      /** 通知挂了任务的，任务那张单上的留言；没挂任务没有这一项。 */
      task: DecisionHandoffResultSchema.optional(),
    })
    .optional(),
});

export const NotificationSchema = z.object({
  id: Id,
  level: NotificationLevelSchema,
  title: z.string(),
  body: z.string(),
  /** 「要你拍」的选项（#1915）；老通知、补不出选项的没有，页面写 NO_OPTIONS_TEXT 并给输入框。 */
  options: z.array(DecisionOptionSchema).optional(),
  /** 拍过了：选了什么、什么时候、谁，系统照着做的结果（answer.execution）。 */
  answer: DecisionAnswerSchema.optional(),
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
  via: z.enum(['cockpit', 'feishu', 'github', 'engine', 'agent', 'ops']),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const AuditQuery = PageQuery.extend({ target: z.string().max(200).optional() });
export const AuditResponse = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: Cursor.optional(),
});
