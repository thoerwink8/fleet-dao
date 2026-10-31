// 开单服务的线上协议（决定 0122，母单 #3739 第 1 片）：本机、法国指挥官、本机 Mirasim 三个入口都经它开单，过程记进操作记录（audit_log）。
// 两个口都只认机器通行证（请求头 X-Fleet-Node-Token，和 /api/nodes/claims 同一套钥匙），路径在 /api 下：
//   POST /api/nodes/issues  开单（查重、并单、幂等）；GET /api/nodes/events?after=<id>&limit=<n>  按编号往后读开单账本。
// 改这里之前必须知道：
// - 请求体全部 strict，多一个字段 400；正文缺节、缺陷缺「影响」回 422 并一次列全；强命中重复回 409 带候选，force / mergeInto 才绕得开。
// - idempotencyKey 由调用方给，同一个 key 对同一个仓只开一张（或只留一条并单评论）；重放回原来那张、created:false。
// - 账本不另建表：读的是 audit_log 里 target 以 `issue:` 或 `progress:` 开头的行（action: issue.open / issue.merge / issue.duplicate_refused，
//   以及下面 POST /api/nodes/notes 写的 progress.note / decision.handoff / report.daily / report.guards，决定 0122、母单 #3741 片 2a）。
import { z } from 'zod';

/** 在 /api 下的路径（和 LOCAL_CLAIMS_PATH 同一个写法）。 */
export const INTAKE_ISSUES_PATH = '/nodes/issues';
export const INTAKE_EVENTS_PATH = '/nodes/events';

/** 账本里的 action。 */
export const INTAKE_AUDIT = {
  open: 'issue.open',
  merge: 'issue.merge',
  duplicateRefused: 'issue.duplicate_refused',
} as const;

/** 账本行的 target 前缀：`issue:<owner>/<name>#<号>`。 */
export const INTAKE_TARGET_PREFIX = 'issue:';
/** 不挂单的过程记录的 target 前缀：`progress:<owner>/<name>`。读口（GET /api/nodes/events）和 issue: 一起读。 */
export const LEDGER_PROGRESS_TARGET_PREFIX = 'progress:';

/** 过程记录（POST /api/nodes/notes，#3741 片 2a）：路径在 /api 下。 */
export const LEDGER_NOTES_PATH = '/nodes/notes';
/** 过程记录的 kind，同时就是账本行的 action。 */
export const LEDGER_NOTE_KINDS = [
  'progress.note',
  'decision.handoff',
  'report.daily',
  'report.guards',
  // 创始人引导（#3764，决定 0123）：text 是原话（只进私有库，不进公开仓），meaning 是不带原话的意思，category 是判的类，issue 是挂的单
  'directive',
] as const;
export const LEDGER_NOTE_TEXT_MAX = 20_000;
/** 引导的类别（同 conventions 的 DIRECTIVE_KINDS；零安装区引不了包，两处各写一份，字面相同）。 */
export const LEDGER_DIRECTIVE_CATEGORIES = ['ai', 'product', 'task', 'once', 'ops', 'discuss'] as const;
export const LEDGER_DIRECTIVE_MEANING_MAX = 2_000;

export const INTAKE_KINDS = ['需求', '缺陷', '杂项'] as const;
export const INTAKE_DOMAINS = ['engine', 'api', 'mirasim'] as const;
export const INTAKE_NATURES = ['bug', 'perf', 'process'] as const;
export const INTAKE_MILESTONES = ['当前', '未排期'] as const;
export const INTAKE_SOURCE_KINDS = [
  'local-session',
  'harness-commander',
  'harness-chat',
  'mirasim',
  'engine',
  'api',
] as const;

export const INTAKE_REF_MAX = 200;
/** 幂等键：可见字符、不含空白，会写进单子正文的来源行，所以字符集收窄。 */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[\w.:-]{8,128}$/, '8 到 128 个字符，只许字母、数字、下划线、点、冒号、减号');

export const IntakeSourceSchema = z
  .object({
    kind: z.enum(INTAKE_SOURCE_KINDS),
    /** 会话号或消息号。 */
    ref: z.string().min(1).max(INTAKE_REF_MAX),
  })
  .strict();
export type IntakeSource = z.infer<typeof IntakeSourceSchema>;

export const IntakeIssueRequestSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    kind: z.enum(INTAKE_KINDS),
    domain: z.enum(INTAKE_DOMAINS),
    nature: z.enum(INTAKE_NATURES),
    milestone: z.enum(INTAKE_MILESTONES),
    title: z.string().min(1).max(256),
    // 上限放宽到能进到后面的 issueBodyTooLong，那边回 422 并写明 GitHub 的上限
    body: z.string().min(1).max(200_000),
    /** 贴「本机做」。 */
    local: z.boolean(),
    source: IntakeSourceSchema,
    idempotencyKey: IdempotencyKeySchema,
    /** 强命中重复也照开。 */
    force: z.boolean().optional(),
    /** 不开新单，在这张单上留一条评论。 */
    mergeInto: z.number().int().positive().optional(),
  })
  .strict();
export type IntakeIssueRequest = z.infer<typeof IntakeIssueRequestSchema>;

export const IntakeIssueResponseSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string(),
    /** true = 这次新开了（或新留了并单评论）；false = 同一个 idempotencyKey 以前处理过，这次是重放。 */
    created: z.boolean(),
    /** 并进了已有的单（mergeInto）时是 true。 */
    merged: z.boolean().optional(),
  })
  .strict();
export type IntakeIssueResponse = z.infer<typeof IntakeIssueResponseSchema>;

/** 409 duplicate_suspected 的候选。 */
export const IntakeCandidateSchema = z
  .object({
    number: z.number().int(),
    title: z.string(),
    score: z.number(),
    why: z.string(),
  })
  .strict();
export type IntakeCandidate = z.infer<typeof IntakeCandidateSchema>;

/** 账本读口的 limit：默认 100、最多 500。 */
export const INTAKE_EVENTS_DEFAULT_LIMIT = 100;
export const INTAKE_EVENTS_MAX_LIMIT = 500;

export const IntakeEventsQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
    // 超过上限的不拒，按上限给（调用方要「尽量多」时不用自己知道上限）
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .default(INTAKE_EVENTS_DEFAULT_LIMIT)
      .transform((n) => Math.min(n, INTAKE_EVENTS_MAX_LIMIT)),
  })
  .strict();

export const IntakeEventSchema = z
  .object({
    id: z.number().int(),
    at: z.string(),
    actorKind: z.string(),
    actorId: z.string(),
    action: z.string(),
    target: z.string(),
    after: z.unknown(),
    ok: z.boolean(),
  })
  .strict();
export type IntakeEvent = z.infer<typeof IntakeEventSchema>;

export const IntakeEventsResponseSchema = z
  .object({
    events: z.array(IntakeEventSchema),
    /** 最后一条的 id；一条也没有就是请求的 after 原样。下次拿它当 after。 */
    next: z.number().int(),
  })
  .strict();
export type IntakeEventsResponse = z.infer<typeof IntakeEventsResponseSchema>;

export const LedgerNoteRequestSchema = z
  .object({
    kind: z.enum(LEDGER_NOTE_KINDS),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    /** 挂单：target 记成 issue:<repo>#<号>；不给就记成 progress:<repo>。 */
    issue: z.number().int().positive().optional(),
    text: z.string().min(1).max(LEDGER_NOTE_TEXT_MAX),
    source: IntakeSourceSchema,
    /** 同一个仓里同一个 key 只记一行；重放回原来那行、created:false。 */
    idempotencyKey: IdempotencyKeySchema,
    /** 只给 kind 是 directive 的用：不带原话的意思（必给）、类别（必给）、主人（会话目录名或「无主」）、他说话的时刻。 */
    meaning: z.string().min(1).max(LEDGER_DIRECTIVE_MEANING_MAX).optional(),
    category: z.enum(LEDGER_DIRECTIVE_CATEGORIES).optional(),
    owner: z.string().min(1).max(128).optional(),
    spokenAt: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.kind !== 'directive') {
      for (const k of ['meaning', 'category', 'owner', 'spokenAt'] as const)
        if (req[k] !== undefined)
          ctx.addIssue({ code: 'custom', path: [k], message: '只有 kind 是 directive 才许带' });
      return;
    }
    if (req.issue === undefined)
      ctx.addIssue({ code: 'custom', path: ['issue'], message: 'directive 要挂一张单' });
    if (req.meaning === undefined)
      ctx.addIssue({ code: 'custom', path: ['meaning'], message: 'directive 要给不带原话的意思' });
    if (req.category === undefined)
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'directive 要给类别' });
  });
export type LedgerNoteRequest = z.infer<typeof LedgerNoteRequestSchema>;

export const LedgerNoteResponseSchema = z
  .object({
    /** 账本行的编号（读口 GET /api/nodes/events 的 id）。 */
    id: z.number().int(),
    created: z.boolean(),
  })
  .strict();
export type LedgerNoteResponse = z.infer<typeof LedgerNoteResponseSchema>;
