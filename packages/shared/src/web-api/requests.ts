// 驾驶舱「提需求」的接口约定（#2049，母单 #2047 第 A 片；方案 specs/2047-提需求/方案.md 第一、二、三节）。
// 需求（requests）、消息（request_messages）、每人对需求的置顶和读到哪（request_user_state）。
// 改这里之前必须知道：
// - 身份只认登录会话：请求体里没有、也不收「谁说的、谁发起、谁拍板」的字段；带了也被剥掉（zod 默认丢掉多余字段）。
// - 状态只有四个（讨论中、待拍板、已结案·做、已结案·不做）。「在做 / 已合并 / 已上线」是单子的状态（issueRefs[].state），由 B 片从 GitHub 接。
// - 详情里的 actions 对每个动作写「能不能做 + 为什么不能」：页面靠它决定菜单里出现哪些项，不靠自己猜。
// - 能不能做的判法只有一份：request-rules.ts（后端和定时任务都调它）。
import { z } from 'zod';

export const REQUEST_STATUSES = ['discussing', 'pending_decision', 'closed_do', 'closed_drop'] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

/** 人、指挥官、系统、引擎提问、别家挑错。 */
export const REQUEST_MESSAGE_KINDS = ['human', 'commander', 'system', 'engine_ask', 'review'] as const;
export const RequestMessageKindSchema = z.enum(REQUEST_MESSAGE_KINDS);
export type RequestMessageKind = z.infer<typeof RequestMessageKindSchema>;

export const REQUEST_CHANNELS = ['web', 'mobile'] as const;
export const RequestChannelSchema = z.enum(REQUEST_CHANNELS);
export type RequestChannel = z.infer<typeof RequestChannelSchema>;

/** 引擎提问的答复：待答、已写回、写回失败。 */
export const REQUEST_ANSWER_STATES = ['pending', 'written', 'failed'] as const;
export const RequestAnswerStateSchema = z.enum(REQUEST_ANSWER_STATES);
export type RequestAnswerState = z.infer<typeof RequestAnswerStateSchema>;

/** 开出的单现在怎样：开着、已合并、已上线、关掉了。B 片从 GitHub 和引擎任务表接；上线或关掉满 3 天自动归档。 */
export const REQUEST_ISSUE_STATES = ['open', 'merged', 'deployed', 'closed'] as const;
export const RequestIssueStateSchema = z.enum(REQUEST_ISSUE_STATES);
export type RequestIssueState = z.infer<typeof RequestIssueStateSchema>;

/** 删了满这么多天由定时任务连消息一起硬删。 */
export const REQUEST_PURGE_AFTER_DAYS = 30;
/** 已结案·做的需求，单子上线或关掉满这么多天自动归档。 */
export const REQUEST_ARCHIVE_AFTER_SETTLED_DAYS = 3;
/** 讨论中这么多天没动静，列表和详情标「搁置 N 天」。 */
export const REQUEST_IDLE_DAYS = 14;

/**
 * 草稿的栏。原话不在这里：原话是消息，开单时由系统按时间拼。
 * 方案第五节：指挥官的补丁也只能改这几栏。
 */
export const REQUEST_DRAFT_FIELDS = [
  'title',
  'kind',
  'scene',
  'modules',
  'want',
  'done',
  'notDo',
  'size',
  'needsHuman',
] as const;
export type RequestDraftField = (typeof REQUEST_DRAFT_FIELDS)[number];

const Text = (max: number) => z.string().max(max);

export const RequestDraftSchema = z.object({
  title: z.string().trim().min(1).max(100),
  kind: Text(40).optional(),
  scene: Text(5000).optional(),
  modules: Text(3000).optional(),
  want: Text(5000).optional(),
  done: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  notDo: Text(3000).optional(),
  size: Text(200).optional(),
  /** 要不要人拍：要的话写为什么（碰发布、花钱、删数据、改标准）。 */
  needsHuman: Text(300).optional(),
});
export type RequestDraft = z.infer<typeof RequestDraftSchema>;

/** 改草稿：只给要改的栏，至少一栏。 */
export const RequestDraftPatchSchema = RequestDraftSchema.partial().refine(
  (p) => Object.keys(p).length > 0,
  '一栏都没改',
);
export type RequestDraftPatch = z.infer<typeof RequestDraftPatchSchema>;

/** 菜单和按钮上的每个动作。send、editDraft 不走动作接口，只在这里写能不能。 */
export const REQUEST_ACTIONS = [
  'send',
  'editDraft',
  'rename',
  'submit',
  'confirm',
  'approve',
  'reject',
  'rediscuss',
  'withdraw',
  'drop',
  'archive',
  'unarchive',
  'delete',
  'restore',
  'pin',
  'unpin',
] as const;
export const RequestActionSchema = z.enum(REQUEST_ACTIONS);
export type RequestAction = z.infer<typeof RequestActionSchema>;

export const RequestVerdictSchema = z.object({
  allowed: z.boolean(),
  /** 不能做时写为什么（中文，页面原样显示）。 */
  why: z.string().optional(),
});
export type RequestVerdict = z.infer<typeof RequestVerdictSchema>;

export const RequestActionsSchema = z.object(
  Object.fromEntries(REQUEST_ACTIONS.map((a) => [a, RequestVerdictSchema])) as Record<
    RequestAction,
    typeof RequestVerdictSchema
  >,
);
export type RequestActions = z.infer<typeof RequestActionsSchema>;

export const RequestPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
});
export type RequestPerson = z.infer<typeof RequestPersonSchema>;

export const RequestIssueRefSchema = z.object({
  /** owner/name */
  repo: z.string(),
  number: z.number().int().positive(),
  state: RequestIssueStateSchema,
  /** 进这个状态的时刻（ISO）。 */
  stateAt: z.string(),
});
export type RequestIssueRef = z.infer<typeof RequestIssueRefSchema>;

/** 等我的：等我拍板、引擎在问我（我发起的）、有我没读的新消息。 */
export const RequestWaitingSchema = z.enum(['decide', 'engine_ask', 'unread']);
export type RequestWaiting = z.infer<typeof RequestWaitingSchema>;

export const RequestRowSchema = z.object({
  seq: z.number().int().positive(),
  title: z.string(),
  status: RequestStatusSchema,
  repo: z.object({ id: z.string(), slug: z.string() }),
  initiator: RequestPersonSchema,
  /** 说过话的人（不含发起人），按第一次说话先后。 */
  participants: z.array(RequestPersonSchema),
  lastMessage: z
    .object({
      kind: RequestMessageKindSchema,
      authorName: z.string().optional(),
      preview: z.string(),
      at: z.string(),
    })
    .optional(),
  lastActivityAt: z.string(),
  /** 我置顶了没有（每人各自）。 */
  pinned: z.boolean(),
  /** 我没读的条数（我自己说的不算）。 */
  unread: z.number().int().nonnegative(),
  /** 在等我做什么；不等我是 null。 */
  waitingOnMe: RequestWaitingSchema.nullable(),
  /** 讨论中多少天没动静（满 14 天才给，不满是 null）。 */
  idleDays: z.number().int().nonnegative().nullable(),
  issueRefs: z.array(RequestIssueRefSchema),
  continuesSeq: z.number().int().positive().optional(),
  archivedAt: z.string().optional(),
  deletedAt: z.string().optional(),
  /** 删了的：几点会被彻底删掉。 */
  purgeAt: z.string().optional(),
});
export type RequestRow = z.infer<typeof RequestRowSchema>;

export const RequestMessageSchema = z.object({
  id: z.number().int().positive(),
  kind: RequestMessageKindSchema,
  /** 人说的才有；指挥官、系统、引擎没有。 */
  author: RequestPersonSchema.optional(),
  channel: RequestChannelSchema.optional(),
  body: z.string(),
  /** @ 了谁（用户编号）。 */
  mentions: z.array(z.string()),
  draftPatch: z.record(z.string(), z.unknown()).optional(),
  githubCommentRef: z.string().optional(),
  answerState: RequestAnswerStateSchema.optional(),
  createdAt: z.string(),
});
export type RequestMessage = z.infer<typeof RequestMessageSchema>;

export const RequestDetailResponse = z.object({
  asOf: z.string(),
  request: RequestRowSchema.extend({
    draft: RequestDraftSchema,
    draftVersion: z.number().int().positive(),
    /** 人改过的栏：指挥官不能直接改，只能出「建议改」。 */
    humanEdited: z.array(z.enum(REQUEST_DRAFT_FIELDS)),
    /** 发起人发起的要不要拍板（按 users 表现判）。 */
    needsDecision: z.boolean(),
    /** 拍板人：提交拍板或确定之后才有。 */
    decider: RequestPersonSchema.optional(),
    closedAt: z.string().optional(),
    /** 放下、不做的理由。 */
    closeReason: z.string().optional(),
    modelChoice: z.string().optional(),
    createdAt: z.string(),
    /** 「接着这条提」开出来的新需求号。 */
    continuedBy: z.array(z.number().int().positive()),
  }),
  messages: z.array(RequestMessageSchema),
  /** 我读到哪一条（消息编号）；一条都没读过是 null。 */
  lastReadMessageId: z.number().int().positive().nullable(),
  actions: RequestActionsSchema,
});
export type RequestDetailResponse = z.infer<typeof RequestDetailResponse>;

export const CreateRequestRequest = z.object({
  /** 只能是 repos 表里已导入的项目。 */
  repoId: z.uuid(),
  /** 先说一句：第一条原话。 */
  body: z.string().trim().min(1).max(20_000),
  channel: RequestChannelSchema.default('web'),
  /** 不给就取第一句话的开头。 */
  title: z.string().trim().min(1).max(100).optional(),
  /** 「接着这条提」：原来那条的需求号（必须已结案）。 */
  continuesSeq: z.number().int().positive().optional(),
});

export const SendRequestMessageRequest = z.object({
  body: z.string().trim().min(1).max(20_000),
  channel: RequestChannelSchema.default('web'),
  mentions: z.array(z.uuid()).max(10).default([]),
});

export const UpdateRequestDraftRequest = z.object({
  /** 看到的草稿版本：别人先改了回 409。 */
  baseVersion: z.number().int().positive(),
  patch: RequestDraftPatchSchema,
});

const Reason = z.string().trim().min(1).max(500);
const Version = z.number().int().positive();

export const RequestActionRequest = z.discriminatedUnion('action', [
  /** 提交拍板、确定开单、同意做：带看到的草稿版本，只认这一版。 */
  z.object({ action: z.literal('submit'), draftVersion: Version }),
  z.object({ action: z.literal('confirm'), draftVersion: Version }),
  z.object({ action: z.literal('approve'), draftVersion: Version }),
  /** 不做、放下：要写理由。 */
  z.object({ action: z.literal('reject'), reason: Reason }),
  z.object({ action: z.literal('drop'), reason: Reason }),
  z.object({ action: z.literal('rediscuss'), note: Reason.optional() }),
  z.object({ action: z.literal('withdraw') }),
  z.object({ action: z.literal('archive') }),
  z.object({ action: z.literal('unarchive') }),
  z.object({ action: z.literal('delete') }),
  z.object({ action: z.literal('restore') }),
  z.object({ action: z.literal('pin') }),
  z.object({ action: z.literal('unpin') }),
  z.object({ action: z.literal('rename'), title: z.string().trim().min(1).max(100) }),
]);
export type RequestActionRequest = z.infer<typeof RequestActionRequest>;

export const MarkRequestReadRequest = z.object({ messageId: z.number().int().positive() });
export const MarkRequestReadResponse = z.object({
  lastReadMessageId: z.number().int().positive().nullable(),
});

export const REQUEST_VIEWS = ['active', 'archived', 'deleted'] as const;
export const REQUEST_FILTERS = ['todo', 'all', 'mine'] as const;

export const RequestListQuery = z.object({
  /** 进行中（默认）/ 已归档 / 最近删除。 */
  view: z.enum(REQUEST_VIEWS).default('active'),
  /** 等我的 / 全部（默认）/ 我发起的。 */
  filter: z.enum(REQUEST_FILTERS).default('all'),
  /** 按标题、原话、单号（#12）搜。 */
  q: z.string().trim().max(100).optional(),
});

export const RequestListResponse = z.object({
  asOf: z.string(),
  view: z.enum(REQUEST_VIEWS),
  filter: z.enum(REQUEST_FILTERS),
  /** 这个视图下三个筛选各几条（不看搜索词），外加已归档、最近删除各几条（入口上的数）。 */
  counts: z.object({
    todo: z.number().int().nonnegative(),
    all: z.number().int().nonnegative(),
    mine: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
  items: z.array(RequestRowSchema),
  /** 这台后端没接上需求表：写原因，不拿空列表冒充「没有需求」。 */
  unavailable: z.string().optional(),
});
export type RequestListResponse = z.infer<typeof RequestListResponse>;
