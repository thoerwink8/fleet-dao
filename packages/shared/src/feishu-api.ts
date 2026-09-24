// 飞书网关（packages/feishu，跑在香港）⇄ 驾驶舱后端（packages/api）的接口约定：网关要、而驾驶舱接口（web-api.ts）还没有的那些。
// 走法和驾驶舱接口一样：经隧道调后端的 /api（路径都在 WEB_API_PREFIX 之下），带 `Authorization: Bearer <网关通行证>`；
// 代表某位创始人做的事（路由表里 acting=true）另带请求头 X-Fleet-Acting-Feishu: <飞书 open_id>，后端按 open_id 认创始人，
// 不是就 403，操作记录写 via=feishu。acting=false 的是网关自己的后台活（取盘面、取待推送、登记卡片），不代表任何人，后端只验通行证。
// 改这里之前：网关按这份解析后端的返回，后端按这份校验请求；字段增删两边一起改。只增不改。
import { z } from 'zod';
import {
  ProgressSchema,
  QuotaWindowKindSchema,
  ReadingKindSchema,
  TaskStateSchema,
  type WebRoutes,
} from './web-api.ts';

const Id = z.string().min(1).max(200);
const Time = z.iso.datetime({ offset: true });
/** 飞书的消息、会话编号（om_… / oc_…）。 */
const FeishuId = z.string().min(1).max(100);
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '格式是 HH:MM');

/**
 * 理解一句话（POST /feishu/messages）和按补充改理解（revise）后端要在这么久之内回：模型没理解完就先按原话给一版
 * （unsure=true），不许卡住。网关多等 1 秒还没回，就先发一张「正在理解」的卡、之后原地更新——确认卡必须 10 秒内到。
 */
export const FEISHU_UNDERSTAND_MS = 7_000;

/** 网关也调这几条驾驶舱接口（带网关通行证 + 代表哪位创始人），后端的门要放行网关进法。 */
export const FEISHU_GATEWAY_WEB_ROUTES = ['task', 'taskAction', 'answerAsk'] as const satisfies ReadonlyArray<
  keyof typeof WebRoutes
>;

export const FeishuRepoRefSchema = z.object({
  id: Id,
  /** owner/name */
  fullName: z.string().min(1).max(200),
});

// —— 卡片登记：网关发出的每条消息都登记，回复某张卡时靠它找回这张卡在说哪件事 ——

export const FeishuCardKindSchema = z.enum([
  'draft', // 「我理解为」确认卡
  'progress', // 进度卡
  'board', // 盘面卡（团队群置顶那张，或私聊里点菜单出的）
  'todo', // 我的待办
  'list', // 卡住的 / 等点头的 / 在干的 清单
  'answer', // 回答（追问的回答、闲聊）
  'decision', // 要人拍
  'alert', // 卡住报警
  'daily', // 日报
  'follow', // 关注的需求到了关键节点
  'ask', // AI 在任务里追问
]);

export const FeishuCardRefSchema = z.object({
  taskId: Id.optional(),
  askId: Id.optional(),
  draftId: Id.optional(),
  notificationId: Id.optional(),
  outboxId: Id.optional(),
});

export const FeishuCardRecordSchema = z.object({
  messageId: FeishuId,
  chatId: FeishuId,
  kind: FeishuCardKindSchema,
  ref: FeishuCardRefSchema,
  sentAt: Time,
});

/** PUT /feishu/cards/:messageId：同一条消息再登记就覆盖（例如草稿确认后补上 taskId）。 */
export const FeishuPutCardRequest = FeishuCardRecordSchema.omit({ messageId: true });

/** 按种类列出登记过的卡，新的在前。网关靠 kind=board 找团队群里那张盘面卡。 */
export const FeishuCardsQuery = z.object({
  kind: FeishuCardKindSchema,
  chatId: FeishuId.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export const FeishuCardsResponse = z.object({ items: z.array(FeishuCardRecordSchema) });

export const FeishuOkResponse = z.object({ ok: z.literal(true) });

// —— 随手记任务：一句话 → 「我理解为」草稿 → 确认才开成任务 ——

export const FeishuDraftSchema = z.object({
  id: Id,
  /** 每改一次加 1。确认时带上卡片上看到的那一版，防止确认了别人刚改过、自己没看到的内容。 */
  revision: z.number().int().min(1),
  status: z.enum(['open', 'confirmed']),
  /** 创始人的原话。 */
  rawText: z.string(),
  /** 「我理解为」——三行以内的白话。 */
  understanding: z.string().min(1).max(1000),
  /** 拿不准：卡片上提示「确认前看一眼」。 */
  unsure: z.boolean(),
  /** 放在哪个仓；null = 没判出来，确认时必须选一个。 */
  repo: FeishuRepoRefSchema.nullable(),
  /** 可选的仓（卡片上的下拉框）。 */
  repoOptions: z.array(FeishuRepoRefSchema).max(20),
  /** 提出人的显示名。 */
  proposedBy: z.string(),
  /** 网关登记过的确认卡；有就原地更新，不再发第二张（同一条消息被重投时靠它）。 */
  cardMessageId: FeishuId.optional(),
  /** 确认后才有。 */
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

/** 用户回复了某张卡：这张卡是什么、在说哪件事（网关从卡片登记里查到的）。 */
export const FeishuReplyContextSchema = z.object({
  kind: FeishuCardKindSchema,
  ref: FeishuCardRefSchema,
});

/**
 * POST /feishu/messages：一句话交给后端理解（开新任务、问问题、闲聊由后端判）。
 * 要在 FEISHU_UNDERSTAND_MS 之内回。
 */
export const FeishuMessageRequest = z.object({
  /** 飞书消息编号，也是幂等键：同一条消息再来（网关重试、飞书重投），返回同一个结果，不开第二个草稿。 */
  sourceMessageId: FeishuId,
  text: z.string().min(1).max(4000),
  chatType: z.enum(['p2p', 'group']),
  /** 回复某张卡时带上：带着这张卡的来历回答。 */
  replyTo: FeishuReplyContextSchema.optional(),
});

export const FeishuMessageResponse = z.discriminatedUnion('kind', [
  /** 当成新任务：网关回一张「我理解为」确认卡。 */
  z.object({ kind: z.literal('draft'), draft: FeishuDraftSchema }),
  /** 问题或闲聊：网关直接回这段话。 */
  z.object({ kind: z.literal('answer'), text: z.string().min(1).max(4000), taskId: Id.optional() }),
]);

/**
 * POST /feishu/drafts/:draftId/revise：「改一下」——按补充重新理解，或只换个仓。要在 FEISHU_UNDERSTAND_MS 之内回。
 * 草稿已确认时 409（code=draft_confirmed），网关改按追问处理。
 */
export const FeishuReviseDraftRequest = z
  .object({
    /** 幂等键：同一个编号再来只改一次（网关超时重试用）。 */
    requestId: z.string().min(1).max(100),
    note: z.string().max(2000).optional(),
    repoId: Id.optional(),
  })
  .refine((v) => (v.note?.trim() ?? '') !== '' || v.repoId !== undefined, {
    message: '补充说明和仓至少给一个',
  });
export const FeishuReviseDraftResponse = z.object({ draft: FeishuDraftSchema });

/**
 * POST /feishu/drafts/:draftId/confirm：点确认就开成任务（经机器人写 GitHub，记下提出人和确认人）。
 * 幂等：已经确认过的再确认，返回同一个任务、alreadyConfirmed=true，不开第二个。
 * revision 对不上（草稿刚被改过）返回 409，code=draft_changed，错误体 details 是 FeishuDraftConflictDetails。
 */
export const FeishuConfirmDraftRequest = z.object({
  revision: z.number().int().min(1),
  /** 卡片上另选了仓。 */
  repoId: Id.optional(),
});
export const FeishuConfirmDraftResponse = z.object({
  draft: FeishuDraftSchema,
  alreadyConfirmed: z.boolean(),
});
export const FeishuDraftConflictDetails = z.object({ draft: FeishuDraftSchema });

// —— 查进度：「进度 12」——

/** GET /feishu/tasks?issue=12：按 issue 号找需求（几个仓可能都有 12 号）。详情再调驾驶舱接口 GET /tasks/:taskId。 */
export const FeishuTaskLookupQuery = z.object({ issue: z.coerce.number().int().positive() });
export const FeishuTaskLookupResponse = z.object({
  matches: z
    .array(
      z.object({
        taskId: Id,
        repo: z.string(),
        issueNumber: z.number().int().positive(),
        title: z.string(),
        state: TaskStateSchema,
      }),
    )
    .max(20),
});

// —— 关注 ——

/** POST /feishu/follows：关注后，这个需求到关键节点（方案好了、PR 开了、合并了、卡住了）私聊推给关注的人。幂等。 */
export const FeishuFollowRequest = z.object({ taskId: Id, follow: z.boolean() });
export const FeishuFollowResponse = z.object({ taskId: Id, following: z.boolean() });

// —— 盘面快照（GET /feishu/board，acting=false）：置顶盘面卡、菜单「盘面」「我的待办」「查进度」都用它，网关缓存在本地 ——

export const FeishuBoardSnapshotSchema = z.object({
  asOf: Time,
  counts: z.object({
    /** 正在干的需求。 */
    running: z.number().int().min(0),
    stalled: z.number().int().min(0),
    /** 等创始人点头或回答的（要人拍 + AI 追问）。 */
    waitingForYou: z.number().int().min(0),
    /** 今天（北京时间）合并的 PR。 */
    mergedToday: z.number().int().min(0),
  }),
  /** 卡住的，最久的在前。 */
  stalled: z
    .array(
      z.object({
        taskId: Id,
        repo: z.string(),
        issueNumber: z.number().int().positive(),
        title: z.string(),
        since: Time.optional(),
        /** 一句白话：卡在哪。 */
        why: z.string().optional(),
      }),
    )
    .max(20),
  /** 等创始人的，最早的在前。 */
  waiting: z
    .array(
      z.object({
        kind: z.enum(['decision', 'ask']),
        askId: Id.optional(),
        notificationId: Id.optional(),
        taskId: Id.optional(),
        repo: z.string().optional(),
        issueNumber: z.number().int().positive().optional(),
        title: z.string(),
        since: Time,
      }),
    )
    .max(20),
  /** 在干的需求（「查进度」菜单列这些）。 */
  active: z
    .array(
      z.object({
        taskId: Id,
        repo: z.string(),
        issueNumber: z.number().int().positive(),
        title: z.string(),
        state: TaskStateSchema,
        progress: ProgressSchema,
        /** 例如「Opus 5.5 正在写登录页」。 */
        activity: z.string().optional(),
      }),
    )
    .max(30),
  /** 快清零还剩不少、或快用完的额度，最该看的在前。 */
  quota: z
    .array(
      z.object({
        poolName: z.string(),
        window: QuotaWindowKindSchema,
        /** 剩余比例 0–1。 */
        remaining: z.number().min(0).max(1).optional(),
        resetsAt: Time.optional(),
        reading: ReadingKindSchema,
      }),
    )
    .max(10),
});

// —— 待推送（GET /feishu/outbox，acting=false）：只有三类（要人拍、卡住报警、日报）+ 关注 + AI 追问 ——

export const FeishuOutboxKindSchema = z.enum(['decision', 'alert', 'daily', 'follow', 'ask']);

/**
 * 一件事一个编号，状态或内容每变一次 revision 加 1。网关只发一张卡，之后按 revision 原地更新，不重发。
 * 「待推送」= 当前 revision 还没收到 sent / updated / dropped 回执、也不在 deferred 或 failed 的等待期内。
 */
export const FeishuOutboxItemSchema = z.object({
  /** 例如 notification:88、ask:31、follow:task-12:<open_id>、daily:2026-09-25。 */
  id: Id,
  revision: z.number().int().min(1),
  kind: FeishuOutboxKindSchema,
  /** team = 团队群；user = 私聊某位创始人（关注推送）。 */
  to: z.discriminatedUnion('type', [
    z.object({ type: z.literal('team') }),
    z.object({ type: z.literal('user'), openId: FeishuId }),
  ]),
  title: z.string().min(1).max(100),
  /** 正文，一行一句白话。 */
  lines: z.array(z.string().max(500)).max(10),
  /** done = 已处理或已过去：卡片变灰、收起操作按钮。 */
  status: z.enum(['open', 'done']),
  /** done 时的一句结论，例如「已批准 · 甲 · 09-25 14:02」。 */
  doneText: z.string().max(200).optional(),
  taskId: Id.optional(),
  repo: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  /** decision / ask：回答选项，第一个是主按钮；点了就调驾驶舱接口 POST /asks/:askId/answer。要人拍的事也按追问建（选项如 批准 / 拒绝）。 */
  askId: Id.optional(),
  options: z.array(z.string().min(1).max(40)).max(4).optional(),
  notificationId: Id.optional(),
  /** 驾驶舱里的站内路径（以 / 开头），「打开驾驶舱」跳这里。 */
  link: z.string().startsWith('/').max(500).optional(),
  createdAt: Time,
  /** 这件事上次送到的卡（按网关回执记的）；有就原地更新。 */
  delivered: z
    .object({
      messageId: FeishuId,
      chatId: FeishuId,
      sentAt: Time,
      revision: z.number().int().min(1),
    })
    .optional(),
});

/** 长轮询：有待推送就马上回，没有就最多等 waitSeconds 秒再回空的。 */
export const FeishuOutboxQuery = z.object({
  waitSeconds: z.coerce.number().int().min(0).max(25).default(25),
});
export const FeishuOutboxResponse = z.object({
  items: z.array(FeishuOutboxItemSchema).max(100),
  /** 驾驶舱设置 notify.quietHours（北京时间）；null = 不设。免打扰由网关执行：这段时间不发新卡，原地更新照常。 */
  quietHours: z.object({ start: HHMM, end: HHMM }).nullable(),
  asOf: Time,
});

/** 回执。送达只认飞书返回的 message_id，所以 sent / updated 必带它。 */
export const FeishuOutboxAckSchema = z.object({
  itemId: Id,
  revision: z.number().int().min(1),
  result: z.discriminatedUnion('status', [
    /** 新发了一张卡（第一次发，或旧卡已过 14 天不能再改）。 */
    z.object({ status: z.literal('sent'), messageId: FeishuId, chatId: FeishuId, sentAt: Time }),
    z.object({ status: z.literal('updated'), messageId: FeishuId }),
    /** 免打扰：until 之前别再给。 */
    z.object({ status: z.literal('deferred'), until: Time, reason: z.literal('quiet_hours') }),
    /**
     * 不发了：kind_not_allowed = 不在可推的种类里；not_founder = 私聊对象不是创始人；
     * already_done = 还没发过卡就已处理完（只进日报）；over_budget = 今天求人的卡超预算（驾驶舱里照样有）。
     */
    z.object({
      status: z.literal('dropped'),
      reason: z.enum(['kind_not_allowed', 'not_founder', 'already_done', 'over_budget']),
    }),
    /** 飞书那边没发成：retryAfter 之后再给。 */
    z.object({ status: z.literal('failed'), error: z.string().max(500), retryAfter: Time }),
  ]),
});
export const FeishuOutboxAckRequest = z.object({ acks: z.array(FeishuOutboxAckSchema).min(1).max(100) });

// —— 路由表（路径都在 WEB_API_PREFIX 之下，:xxx 是路径参数）——

export const FeishuRoutes = {
  message: {
    method: 'POST',
    path: '/feishu/messages',
    acting: true,
    request: FeishuMessageRequest,
    response: FeishuMessageResponse,
  },
  reviseDraft: {
    method: 'POST',
    path: '/feishu/drafts/:draftId/revise',
    acting: true,
    request: FeishuReviseDraftRequest,
    response: FeishuReviseDraftResponse,
  },
  confirmDraft: {
    method: 'POST',
    path: '/feishu/drafts/:draftId/confirm',
    acting: true,
    request: FeishuConfirmDraftRequest,
    response: FeishuConfirmDraftResponse,
  },
  findTasks: {
    method: 'GET',
    path: '/feishu/tasks',
    acting: true,
    query: FeishuTaskLookupQuery,
    response: FeishuTaskLookupResponse,
  },
  follow: {
    method: 'POST',
    path: '/feishu/follows',
    acting: true,
    request: FeishuFollowRequest,
    response: FeishuFollowResponse,
  },
  board: { method: 'GET', path: '/feishu/board', acting: false, response: FeishuBoardSnapshotSchema },
  outbox: {
    method: 'GET',
    path: '/feishu/outbox',
    acting: false,
    query: FeishuOutboxQuery,
    response: FeishuOutboxResponse,
  },
  ackOutbox: {
    method: 'POST',
    path: '/feishu/outbox/acks',
    acting: false,
    request: FeishuOutboxAckRequest,
    response: FeishuOkResponse,
  },
  putCard: {
    method: 'PUT',
    path: '/feishu/cards/:messageId',
    acting: false,
    request: FeishuPutCardRequest,
    response: FeishuOkResponse,
  },
  /** 没登记过返回 404。 */
  getCard: {
    method: 'GET',
    path: '/feishu/cards/:messageId',
    acting: false,
    response: FeishuCardRecordSchema,
  },
  listCards: {
    method: 'GET',
    path: '/feishu/cards',
    acting: false,
    query: FeishuCardsQuery,
    response: FeishuCardsResponse,
  },
} as const;
