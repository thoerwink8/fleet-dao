// 内存里的 Store：测试和本地开发用，也是 ports.ts 语义的参照实现。数据按 Postgres 的表来摆（packages/db 的 schema），
// 行为照库的约束来（比较后再改、和操作记录同一「事务」、同一会话同一句追问只一条、ok=false 的操作记录必须带原因……），
// 和 pg-store.ts 过同一套契约测试（test/store-contract.ts）。onChange 模拟数据库的 NOTIFY fleet_changes。
import type {
  Ban,
  Channel,
  Model,
  Pool,
  ProgressKind,
  RealtimeTable,
  Repo,
  Route,
  ScheduleOutcome,
  SessionRun,
  StageKind,
  StagePolicy,
  Step,
  Subtask,
  Task,
} from '@fleet-dao/shared';
import {
  feishuMessageKey,
  feishuReviseKey,
  messagePayload,
  parseMessageRecord,
  reviseFingerprint,
  revisePayload,
  reviseReplay,
  UNDERSTANDING_MAX,
  withNote,
} from './feishu-records.ts';
import { isSerial, isUuid, parseCursor } from './ids.ts';
import {
  type AgentSession,
  type AskRecord,
  type AuditRecord,
  type CommandClaim,
  type DraftRecord,
  type FeishuAckReport,
  type FeishuCardRecord,
  type FeishuChatType,
  type FeishuMessageRecord,
  type FeishuOutboxAck,
  type FeishuOutboxState,
  type FeishuTaskInfo,
  type GitHubDelivery,
  type JobRecord,
  type NewAuditEntry,
  type NotificationRecord,
  type Page,
  type PageRequest,
  type PullRequestRecord,
  type QuotaWindowRecord,
  REPO_NOT_MANAGED,
  type RunPlan,
  type SettingRecord,
  type StagePolicyValue,
  type Store,
  type TestRunRecord,
  type TimelineRecord,
  type User,
} from './ports.ts';

export interface ProgressRecord {
  id: string;
  runId: string;
  at: string;
  kind: ProgressKind;
  payload: unknown;
}

export interface StateChangeRecord {
  id: string;
  entity: 'task' | 'subtask';
  entityId: string;
  taskId: string;
  from?: string | undefined;
  to: string;
  at: string;
}

export interface JobRegistration {
  id: string;
  name: string;
  schedule: string;
  expectEveryMinutes: number;
}

export interface ScheduleRunRecord {
  job: string;
  startedAt: string;
  endedAt?: string | undefined;
  outcome?: ScheduleOutcome | undefined;
  scanned?: number | undefined;
  found?: number | undefined;
  why?: string | undefined;
}

export interface SpecRecord {
  taskId: string;
  summary: string;
  resultSummary?: string | undefined;
  mergedAt?: string | undefined;
}

interface IdempotencyRecord {
  action: string;
  target?: string | undefined;
  claimedAt: string;
  completedAt?: string | undefined;
  result?: unknown;
}

/** feishu_drafts 的一行（草稿的确认卡编号不在表里，按卡片登记现查）。 */
export interface FeishuDraftRow {
  id: string;
  revision: number;
  status: 'open' | 'confirmed';
  sourceMessageId: string;
  chatType: FeishuChatType;
  rawText: string;
  understanding: string;
  unsure: boolean;
  repoId?: string | undefined;
  proposedBy: string;
  createdAt: string;
  updatedAt: string;
  confirmedBy?: string | undefined;
  confirmedAt?: string | undefined;
  taskId?: string | undefined;
  openAttempts: number;
  openError?: string | undefined;
  openTriedAt?: string | undefined;
}

export interface FeishuFollowRow {
  taskId: string;
  userId: string;
  following: boolean;
  updatedAt: string;
}

/** feishu_outbox 的一行：推送的送达状态。 */
export interface FeishuOutboxRow {
  id: string;
  revision: number;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  ackRevision?: number | undefined;
  ackStatus?: FeishuOutboxAck['result']['status'] | undefined;
  ackReason?: string | undefined;
  ackedAt?: string | undefined;
  holdUntil?: string | undefined;
  failures: number;
  deliveredMessageId?: string | undefined;
  deliveredChatId?: string | undefined;
  deliveredAt?: string | undefined;
  deliveredRevision?: number | undefined;
}

export type FeishuCardRow = FeishuCardRecord & { updatedAt: string };

const OUTBOX_TIME_KEYS: ReadonlySet<string> = new Set(['deliveredAt', 'holdUntil']);

/** 按 next 改这一行会不会改动什么（时刻按毫秒比，和库版一样）。 */
function changesOutboxRow(row: FeishuOutboxRow, next: Partial<FeishuOutboxRow>): boolean {
  return Object.entries(next).some(([key, value]) => {
    const before: unknown = row[key as keyof FeishuOutboxRow];
    return OUTBOX_TIME_KEYS.has(key) && typeof value === 'string' && typeof before === 'string'
      ? Date.parse(value) !== Date.parse(before)
      : value !== before;
  });
}
/** repos 表的一行：多一个自动派活开关（打开的时刻，不填 = 关着）。列仓的接口不带它。 */
export type RepoRecord = Repo & { autoDispatchSince?: string | undefined };

/** 和库里的表一一对应（去掉了库自己算的列）。 */
export interface MemoryData {
  users: User[];
  repos: RepoRecord[];
  tasks: Task[];
  subtasks: Subtask[];
  runs: SessionRun[];
  /** 会话进度：fleet plan 的步骤清单、测试结果都在这里（最近一条 plan 就是现行清单，kind=test 就是测试记录）。 */
  progress: ProgressRecord[];
  asks: AskRecord[];
  /** 需求和子任务的状态变化（库里由触发器写）；建库时没给的，按建单时刻补一条初始状态。 */
  stateChanges: StateChangeRecord[];
  channels: Channel[];
  pools: Pool[];
  models: Model[];
  routes: Route[];
  stagePolicies: StagePolicy[];
  bans: Ban[];
  /** 按（池, 原名 label）一行，和库的主键一样。 */
  quotaWindows: QuotaWindowRecord[];
  jobs: JobRegistration[];
  scheduleRuns: ScheduleRunRecord[];
  notifications: NotificationRecord[];
  audit: AuditRecord[];
  settings: SettingRecord[];
  pullRequests: PullRequestRecord[];
  specs: SpecRecord[];
  idempotency: Map<string, IdempotencyRecord>;
  feishuDrafts: FeishuDraftRow[];
  feishuFollows: FeishuFollowRow[];
  feishuOutbox: FeishuOutboxRow[];
  feishuCards: FeishuCardRow[];
  /** 收到的 GitHub 事件（github_events），按投递编号。 */
  githubEvents: Map<string, GitHubDelivery>;
}

export function emptyData(): MemoryData {
  return {
    users: [],
    repos: [],
    tasks: [],
    subtasks: [],
    runs: [],
    progress: [],
    asks: [],
    stateChanges: [],
    channels: [],
    pools: [],
    models: [],
    routes: [],
    stagePolicies: [],
    bans: [],
    quotaWindows: [],
    jobs: [],
    scheduleRuns: [],
    notifications: [],
    audit: [],
    settings: [],
    pullRequests: [],
    specs: [],
    idempotency: new Map(),
    feishuDrafts: [],
    feishuFollows: [],
    feishuOutbox: [],
    feishuCards: [],
    githubEvents: new Map(),
  };
}

export interface MemoryStoreOptions {
  now?: () => Date;
  onChange?: (table: RealtimeTable, id: string) => void;
}

const TERMINAL_TASK_STATES: readonly string[] = ['done', 'stopped', 'failed'];
const STAGE_ORDER: readonly StageKind[] = [
  'triage',
  'spec',
  'plan',
  'execute',
  'ui',
  'review',
  'research',
  'judge',
];
/** 时间线默认不放量大的动作流（和 packages/db 的 DEFAULT_TIMELINE_PROGRESS_KINDS 一致）。 */
const QUIET_PROGRESS_KINDS: readonly ProgressKind[] = ['tool', 'file'];
const RECENT_TERMINAL_MS = 7 * 24 * 60 * 60_000;

/** 自增编号补零：按字面比较就是按数值比较（和库里时间线事件编号的写法一致）。 */
const seq15 = (n: string | number): string => String(n).padStart(15, '0');

const repoOnly = ({ autoDispatchSince: _switch, ...repo }: RepoRecord): Repo => repo;

/** 给出去的是副本：调用方改了不影响库里的。对象版本按对象排（和库版一样）。 */
const copyDelivery = (e: GitHubDelivery): GitHubDelivery => ({
  ...e,
  versions: e.versions
    .map((v) => ({ ...v }))
    .sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0)),
});

/** 同一时刻不同写法（秒 / 毫秒）算同一个。 */
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/** 上次出错的、在等着的、处理中但占用早于 staleBefore 的（那一次多半死了），可以接过来重做。时刻都是 toISOString 的写法，按字面比就是按先后比。 */
const reclaimable = (e: GitHubDelivery, staleBefore: string) =>
  e.status === 'failed' || e.status === 'waiting' || (e.status === 'processing' && e.claimedAt < staleBefore);

/** 接过来重做：次数加一；从等着接回来的不加（等上一轮不占自动重放的次数）。 */
const reclaimedAttempts = (e: GitHubDelivery) => e.attempts + (e.status === 'waiting' ? 0 : 1);

function sameValue(a: StagePolicyValue, b: StagePolicyValue): boolean {
  return (
    a.pinned === b.pinned &&
    a.routeIds.length === b.routeIds.length &&
    a.routeIds.every((id, i) => id === b.routeIds[i])
  );
}

function byAtThenId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  return a.at.localeCompare(b.at) || compareIds(a.id, b.id);
}

/** 纯数字的编号按数值比，其余按字面比。 */
function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 按 (at, id) 倒序翻页；游标就是上一页最后一条的 `at|id`，看不懂就抛 InvalidCursorError（和库版同一个判法）。 */
function paginate<T extends { at: string; id: string }>(
  items: T[],
  page: PageRequest,
  idOk?: (id: string) => boolean,
): Page<T> {
  const cursor = parseCursor(page.cursor, idOk);
  const sorted = [...items].sort((a, b) => byAtThenId(b, a));
  let start = 0;
  if (cursor) {
    start = sorted.findIndex((x) => byAtThenId(x, cursor) < 0);
    if (start === -1) start = sorted.length;
  }
  const slice = sorted.slice(start, start + page.limit);
  const last = slice.at(-1);
  return {
    items: slice,
    nextCursor: last && start + page.limit < sorted.length ? `${last.at}|${last.id}` : undefined,
  };
}

export function createMemoryStore(
  seed: Partial<MemoryData> = {},
  options: MemoryStoreOptions = {},
): Store & { data: MemoryData } {
  const data: MemoryData = { ...emptyData(), ...seed };
  const now = options.now ?? (() => new Date());
  const changed = (table: RealtimeTable, id: string) => options.onChange?.(table, id);
  let seq = 0;
  for (const list of [data.progress, data.audit, data.stateChanges]) {
    for (const item of list) if (/^\d+$/.test(item.id)) seq = Math.max(seq, Number(item.id));
  }
  const nextId = () => String(++seq);

  // 库里建需求 / 子任务时触发器会记一条初始状态；种子数据没给的照样补上。
  for (const t of data.tasks) {
    if (!data.stateChanges.some((c) => c.entityId === t.id)) {
      data.stateChanges.push({
        id: nextId(),
        entity: 'task',
        entityId: t.id,
        taskId: t.id,
        to: t.state,
        at: t.createdAt,
      });
    }
  }
  for (const s of data.subtasks) {
    if (!data.stateChanges.some((c) => c.entityId === s.id)) {
      const at = data.tasks.find((t) => t.id === s.taskId)?.createdAt ?? now().toISOString();
      data.stateChanges.push({
        id: nextId(),
        entity: 'subtask',
        entityId: s.id,
        taskId: s.taskId,
        to: s.state,
        at,
      });
    }
  }

  /** 库里的约束：ok=false 必须写原因。违反就整笔不做（模拟事务回滚），所以调用方要先校验再改数据。 */
  function checkAudit(entry: NewAuditEntry): void {
    if (!entry.ok && !entry.error)
      throw new Error('audit_log_failure_has_error：ok=false 的操作记录必须带 error');
  }

  function audit(entry: NewAuditEntry): string {
    checkAudit(entry);
    const id = nextId();
    data.audit.push({
      id,
      at: now().toISOString(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      before: entry.before,
      after: entry.after,
      reason: entry.reason,
      via: entry.via,
      ok: entry.ok,
      error: entry.error,
    });
    changed('audit_log', id);
    return id;
  }

  function progress(runId: string, kind: ProgressKind, payload: unknown): void {
    if (!data.runs.some((r) => r.id === runId))
      throw new Error(`progress_events_run_id_fk：没有会话 ${runId}`);
    if (kind === 'plan' && !Array.isArray((payload as { steps?: unknown } | null)?.steps)) {
      throw new Error('progress_events_plan_has_steps：plan 的载荷必须是 { steps: [...] }');
    }
    const id = nextId();
    data.progress.push({ id, runId, at: now().toISOString(), kind, payload });
    changed('progress_events', id);
  }

  function latestProgress(runId: string, kind: ProgressKind): ProgressRecord | undefined {
    return data.progress
      .filter((p) => p.runId === runId && p.kind === kind)
      .sort(byAtThenId)
      .at(-1);
  }

  function planOf(record: ProgressRecord): RunPlan {
    const raw = (record.payload as { steps?: unknown }).steps;
    const steps: Step[] = (Array.isArray(raw) ? raw : [])
      .filter(
        (s): s is { title: string; state: Step['state'] } =>
          typeof s === 'object' && s !== null && typeof s.title === 'string' && typeof s.state === 'string',
      )
      .map((s, index) => ({ index, title: s.title, state: s.state }));
    return { steps, updatedAt: record.at };
  }

  const commandKey = (runId: string, key: string) => `fleet:${runId}:${key}`;
  /** 占用凭据就是这次占用的时刻（和库里的 claimed_at 一样）：接管会把它改新，旧凭据就对不上了。 */
  const heldBy = (record: IdempotencyRecord | undefined, token: string): record is IdempotencyRecord =>
    !!record && record.completedAt === undefined && record.claimedAt === token;

  // —— 飞书用的小工具（照库的约束来）——

  function needUser(id: string, constraint: string): void {
    if (!data.users.some((u) => u.id === id)) throw new Error(`${constraint}：没有用户 ${id}`);
  }
  function needRepo(id: string, constraint: string): void {
    if (!data.repos.some((r) => r.id === id)) throw new Error(`${constraint}：没有仓 ${id}`);
  }
  function checkUnderstanding(text: string): void {
    if (text.length < 1 || text.length > UNDERSTANDING_MAX) {
      throw new Error('feishu_drafts_understanding_length：「我理解为」要 1–1000 字');
    }
  }
  function latestCard(pick: (c: FeishuCardRow) => boolean): FeishuCardRow | undefined {
    return data.feishuCards
      .filter(pick)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || compareIds(a.messageId, b.messageId))
      .at(-1);
  }
  function cardOut(c: FeishuCardRow): FeishuCardRecord {
    return { messageId: c.messageId, chatId: c.chatId, kind: c.kind, ref: { ...c.ref }, sentAt: c.sentAt };
  }
  function draftOut(row: FeishuDraftRow): DraftRecord {
    return {
      id: row.id,
      revision: row.revision,
      status: row.status,
      sourceMessageId: row.sourceMessageId,
      chatType: row.chatType,
      rawText: row.rawText,
      understanding: row.understanding,
      unsure: row.unsure,
      repoId: row.repoId,
      proposedBy: row.proposedBy,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt,
      taskId: row.taskId,
      cardMessageId: latestCard((c) => c.kind === 'draft' && c.ref.draftId === row.id)?.messageId,
      opening: { attempts: row.openAttempts, error: row.openError, triedAt: row.openTriedAt },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  function messageOut(sourceMessageId: string, rec: IdempotencyRecord): FeishuMessageRecord {
    if (rec.action !== 'feishu.message') {
      throw new Error(`飞书消息 ${sourceMessageId} 的幂等键被别的命令（${rec.action}）占着`);
    }
    return parseMessageRecord(sourceMessageId, rec.result, rec.completedAt ?? rec.claimedAt);
  }
  function taskInfo(taskId: string): FeishuTaskInfo | undefined {
    const task = data.tasks.find((t) => t.id === taskId);
    const repo = task ? data.repos.find((r) => r.id === task.repoId) : undefined;
    if (!task || !repo) return undefined;
    return {
      id: task.id,
      title: task.title,
      issueNumber: task.issueNumber,
      state: task.state,
      repo: `${repo.owner}/${repo.name}`,
    };
  }
  function outboxStateOut(row: FeishuOutboxRow): FeishuOutboxState {
    const fallback =
      row.deliveredMessageId === undefined ? latestCard((c) => c.ref.outboxId === row.id) : undefined;
    return {
      id: row.id,
      revision: row.revision,
      createdAt: row.createdAt,
      ack:
        row.ackRevision === undefined || row.ackStatus === undefined
          ? undefined
          : {
              revision: row.ackRevision,
              status: row.ackStatus,
              reason: row.ackReason,
              holdUntil: row.holdUntil,
            },
      delivered:
        row.deliveredMessageId !== undefined &&
        row.deliveredChatId !== undefined &&
        row.deliveredAt !== undefined
          ? {
              messageId: row.deliveredMessageId,
              chatId: row.deliveredChatId,
              sentAt: row.deliveredAt,
              revision: row.deliveredRevision,
            }
          : fallback
            ? { messageId: fallback.messageId, chatId: fallback.chatId, sentAt: fallback.sentAt }
            : undefined,
    };
  }
  /**
   * 通知类推送的回执同时记进这条通知的送达记录（去处 team），驾驶舱「通知」页看得到。
   * 只记真试过的（发了、改了、没发成）：推迟和「不发了」不是没送成，原因记在推送本身（ackReason）。
   */
  function mirrorDelivery(ack: FeishuOutboxAck, at: string): void {
    const r = ack.result;
    if (r.status === 'deferred' || r.status === 'dropped') return;
    if (!ack.itemId.startsWith('notification:')) return;
    const n = data.notifications.find((x) => x.id === ack.itemId.slice('notification:'.length));
    if (!n) return;
    let d = n.deliveries.find((x) => x.channel === 'feishu' && x.target === 'team');
    if (!d) {
      d = { channel: 'feishu', target: 'team', attempts: 0 };
      n.deliveries.push(d);
    }
    d.lastAttemptAt = at;
    d.attempts += 1;
    if (r.status === 'failed') {
      d.error = r.error;
    } else {
      d.messageId = r.messageId;
      d.error = undefined;
    }
  }

  return {
    data,

    // —— 人 ——
    async getUser(id) {
      return data.users.find((u) => u.id === id) ?? null;
    },
    async findUserByFeishu({ openId, unionId }) {
      return (
        data.users.find((u) => u.feishuOpenId === openId || (!!unionId && u.feishuUnionId === unionId)) ??
        null
      );
    },
    async listUsers() {
      return data.users;
    },

    // —— 看板 ——
    async listRepos() {
      return [...data.repos]
        .sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name))
        .map(repoOnly);
    },
    async getRepo(id) {
      const repo = data.repos.find((r) => r.id === id);
      return repo ? repoOnly(repo) : null;
    },
    async listBoardTasks(repoId) {
      const cutoff = now().getTime() - RECENT_TERMINAL_MS;
      return data.tasks
        .filter((t) => t.repoId === repoId)
        .filter((t) => {
          if (!TERMINAL_TASK_STATES.includes(t.state)) return true;
          const since = data.stateChanges
            .filter((c) => c.entityId === t.id)
            .sort(byAtThenId)
            .at(-1)?.at;
          return Date.parse(since ?? t.createdAt) >= cutoff;
        })
        .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    },
    async getTask(id) {
      return data.tasks.find((t) => t.id === id) ?? null;
    },
    async listSubtasks(taskIds) {
      return data.subtasks
        .filter((s) => taskIds.includes(s.taskId))
        .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.index - b.index);
    },
    async listRuns({ taskIds, active }) {
      return data.runs
        .filter(
          (r) =>
            (!taskIds || (r.taskId !== undefined && taskIds.includes(r.taskId))) &&
            (!active || r.endedAt === undefined),
        )
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    },
    async getRun(id) {
      return data.runs.find((r) => r.id === id) ?? null;
    },
    async getPlans(runIds) {
      const out = new Map<string, RunPlan>();
      for (const id of runIds) {
        const latest = latestProgress(id, 'plan');
        if (latest) out.set(id, planOf(latest));
      }
      return out;
    },
    async lastSay(runId) {
      const say = latestProgress(runId, 'say');
      const text = (say?.payload as { text?: unknown } | undefined)?.text;
      return say && typeof text === 'string' ? { text, at: say.at } : null;
    },
    async listTimeline(taskId, page) {
      parseCursor(page.cursor);
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) return { items: [] };
      const runs = data.runs.filter((r) => r.taskId === taskId);
      const runOf = new Map(runs.map((r) => [r.id, r]));
      const targets = new Set([
        `task:${taskId}`,
        ...data.subtasks.filter((s) => s.taskId === taskId).map((s) => `subtask:${s.id}`),
      ]);
      const ms = (from?: string, to?: string) => (from && to ? Date.parse(to) - Date.parse(from) : undefined);
      const items: TimelineRecord[] = [
        ...data.stateChanges
          .filter((c) => c.taskId === taskId)
          .map((c) => ({
            id: `state:${seq15(c.id)}`,
            at: c.at,
            source: 'engine' as const,
            kind: 'state',
            subtaskId: c.entity === 'subtask' ? c.entityId : undefined,
            payload: { entity: c.entity, from: c.from, to: c.to },
          })),
        ...runs.flatMap((r) => [
          {
            id: `run:${r.id}:1-queued`,
            at: r.queuedAt,
            source: 'engine' as const,
            kind: 'run_queued',
            runId: r.id,
            subtaskId: r.subtaskId,
            payload: { stage: r.stage, routeId: r.routeId, whyRoute: r.whyRoute },
          },
          ...(r.startedAt
            ? [
                {
                  id: `run:${r.id}:2-started`,
                  at: r.startedAt,
                  source: 'engine' as const,
                  kind: 'run_started',
                  runId: r.id,
                  subtaskId: r.subtaskId,
                  payload: { queueMs: ms(r.queuedAt, r.startedAt) },
                },
              ]
            : []),
          ...(r.endedAt && r.outcome
            ? [
                {
                  id: `run:${r.id}:3-ended`,
                  at: r.endedAt,
                  source: 'engine' as const,
                  kind: 'run_ended',
                  runId: r.id,
                  subtaskId: r.subtaskId,
                  payload: { outcome: r.outcome, runMs: ms(r.startedAt, r.endedAt) },
                },
              ]
            : []),
        ]),
        ...data.progress
          .filter((p) => runOf.has(p.runId) && !QUIET_PROGRESS_KINDS.includes(p.kind))
          .map((p) => ({
            id: `progress:${seq15(p.id)}`,
            at: p.at,
            source: 'session' as const,
            kind: p.kind,
            runId: p.runId,
            subtaskId: runOf.get(p.runId)?.subtaskId,
            payload: p.payload,
          })),
        ...data.audit
          .filter((a) => targets.has(a.target))
          .map((a) => ({
            id: `audit:${seq15(a.id)}`,
            at: a.at,
            source:
              a.actor.kind === 'user'
                ? ('person' as const)
                : a.actor.kind === 'agent'
                  ? ('session' as const)
                  : ('engine' as const),
            kind: a.action.split('.').at(-1) ?? a.action,
            payload: {
              ...(a.after && typeof a.after === 'object' ? a.after : {}),
              reason: a.reason,
              ok: a.ok,
              error: a.error,
            },
          })),
        ...data.notifications
          .filter((n) => n.taskId === taskId)
          .map((n) => ({
            id: `notification:${n.id}`,
            at: n.createdAt,
            source: 'engine' as const,
            kind: 'notification',
            payload: { level: n.level, title: n.title },
          })),
      ];
      return paginate(items, page);
    },
    async listAsks(taskId) {
      return data.asks.filter((a) => a.taskId === taskId).sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    },
    async getAsk(id) {
      return data.asks.find((a) => a.id === id) ?? null;
    },
    async answerAsk({ askId, answer, by }, entry) {
      const ask = data.asks.find((a) => a.id === askId);
      if (!ask) return 'not_found';
      if (ask.answer !== undefined) return 'already_answered';
      checkAudit(entry);
      ask.answer = answer;
      ask.answeredBy = by.id;
      ask.answeredAt = now().toISOString();
      audit(entry);
      changed('asks', askId);
      return 'ok';
    },

    // —— 调度台 ——
    async listChannels() {
      return [...data.channels].sort((a, b) => a.id.localeCompare(b.id));
    },
    async listPools() {
      return [...data.pools].sort((a, b) => a.id.localeCompare(b.id));
    },
    async listModels() {
      return [...data.models].sort((a, b) => a.id.localeCompare(b.id));
    },
    async listRoutes() {
      return [...data.routes].sort((a, b) => a.id.localeCompare(b.id));
    },
    async listStagePolicies() {
      return [...data.stagePolicies].sort(
        (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
      );
    },
    async listBans() {
      return data.bans;
    },
    async listQuotaWindows() {
      return [...data.quotaWindows].sort(
        (a, b) => a.poolId.localeCompare(b.poolId) || a.label.localeCompare(b.label),
      );
    },
    async updateStagePolicy({ stage, expected, next }, entry) {
      const current = data.stagePolicies.find((p) => p.stage === stage) ?? {
        stage,
        routeIds: [],
        pinned: false,
      };
      if (!sameValue(current, expected)) return 'conflict';
      checkAudit(entry);
      // 关着的仍关着（还挂在新顺序里的）；这次新挂进来的开着。
      const disabled = (current.disabledRouteIds ?? []).filter((id) => next.routeIds.includes(id));
      data.stagePolicies = [
        ...data.stagePolicies.filter((p) => p.stage !== stage),
        {
          stage,
          routeIds: [...next.routeIds],
          pinned: next.pinned,
          ...(disabled.length > 0 && { disabledRouteIds: disabled }),
        },
      ];
      audit(entry);
      changed('stage_policies', stage);
      return 'ok';
    },
    async setChannelEnabled({ channelId, enabled }, entry) {
      const channel = data.channels.find((ch) => ch.id === channelId);
      if (!channel) return 'not_found';
      checkAudit(entry);
      channel.enabled = enabled;
      audit(entry);
      changed('channels', channelId);
      return 'ok';
    },

    // —— 定时任务、通知、操作记录、设置 ——
    async listJobs() {
      return [...data.jobs]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((job): JobRecord => {
          const runs = data.scheduleRuns.filter((r) => r.job === job.id);
          const lastRun = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
          const lastSuccess = runs
            .filter((r) => (r.outcome === 'ok' || r.outcome === 'partial') && r.endedAt)
            .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
            .at(-1);
          return {
            ...job,
            lastRun: lastRun && {
              startedAt: lastRun.startedAt,
              endedAt: lastRun.endedAt,
              outcome: lastRun.outcome,
              scanned: lastRun.scanned,
              found: lastRun.found,
              why: lastRun.why,
            },
            lastSuccessAt: lastSuccess?.endedAt,
          };
        });
    },
    async listNotifications({ status, ...page }) {
      const items = data.notifications
        .filter((n) => status === 'all' || n.resolvedAt === undefined)
        .map((n) => ({ ...n, at: n.createdAt }));
      const result = paginate(items, page, isUuid);
      return {
        // 送到哪（target）只用来认出同一条送达记录，和库版一样不往外给。
        items: result.items.map(({ at: _at, ...n }) => ({
          ...n,
          deliveries: n.deliveries.map(({ target: _target, ...d }) => d),
        })),
        nextCursor: result.nextCursor,
      };
    },
    async resolveNotification({ id, by }, entry) {
      const n = data.notifications.find((x) => x.id === id);
      if (!n) return 'not_found';
      if (n.resolvedAt !== undefined) return 'already_resolved';
      checkAudit(entry);
      n.resolvedAt = now().toISOString();
      n.resolvedBy = by.id;
      audit(entry);
      changed('notifications', id);
      return 'ok';
    },
    async appendAudit(entry) {
      return audit(entry);
    },
    async listAudit({ target, ...page }) {
      return paginate(
        data.audit.filter((a) => target === undefined || a.target === target),
        page,
        isSerial,
      );
    },
    async listSettings() {
      return [...data.settings].sort((a, b) => a.key.localeCompare(b.key));
    },
    async putSetting({ key, value, expectedVersion, by }, entry) {
      const current = data.settings.find((s) => s.key === key);
      if ((current?.version ?? 0) !== expectedVersion) return 'conflict';
      checkAudit(entry);
      const next: SettingRecord = {
        key,
        value,
        version: expectedVersion + 1,
        updatedAt: now().toISOString(),
        updatedBy: by.id,
      };
      data.settings = [...data.settings.filter((s) => s.key !== key), next];
      audit(entry);
      changed('settings', key);
      return 'ok';
    },

    // —— fleet 命令 ——
    async getAgentSession(runId) {
      const run = data.runs.find((r) => r.id === runId);
      const task = run?.taskId === undefined ? undefined : data.tasks.find((t) => t.id === run.taskId);
      if (!run || !task) return null;
      const session: AgentSession = {
        runId: run.id,
        taskId: task.id,
        subtaskId: run.subtaskId,
        stage: run.stage,
        repoId: task.repoId,
        branch: run.branch,
        acceptance: task.acceptance ?? [],
        endedAt: run.endedAt,
      };
      return session;
    },
    async savePlan(runId, steps) {
      progress(runId, 'plan', { steps: steps.map(({ title, state }) => ({ title, state })) });
    },
    async appendProgress(runId, kind, payload) {
      progress(runId, kind, payload);
    },
    async openAsk({ runId, taskId, question, options: choices }) {
      const existing = data.asks.find((a) => a.runId === runId && a.question === question);
      if (existing) return { ask: existing, created: false };
      const ask: AskRecord = {
        id: crypto.randomUUID(),
        taskId,
        runId,
        question,
        options: choices,
        askedAt: now().toISOString(),
      };
      data.asks.push(ask);
      changed('asks', ask.id);
      progress(runId, 'ask', { askId: ask.id, question });
      return { ask, created: true };
    },
    async searchHistory({ repoId, query, limit }) {
      const terms = query
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .map((t) => t.toLowerCase());
      if (terms.length === 0) return [];
      return data.specs
        .map((spec) => ({ spec, task: data.tasks.find((t) => t.id === spec.taskId) }))
        .filter(
          (x): x is { spec: SpecRecord; task: Task } => x.task !== undefined && x.task.repoId === repoId,
        )
        .filter(({ spec, task }) => {
          const touches = data.subtasks.filter((s) => s.taskId === task.id).flatMap((s) => s.touches);
          const haystack = [
            task.title,
            task.rawRequest,
            task.specDir,
            spec.summary,
            spec.resultSummary,
            ...touches,
          ]
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.toLowerCase());
          return terms.every((term) => haystack.some((h) => h.includes(term)));
        })
        .sort(
          (a, b) =>
            (b.spec.mergedAt ?? '').localeCompare(a.spec.mergedAt ?? '') ||
            b.task.createdAt.localeCompare(a.task.createdAt),
        )
        .slice(0, Math.min(20, Math.max(1, limit)))
        .map(({ spec, task }) => ({
          taskId: task.id,
          title: task.title,
          specDir: task.specDir,
          resultSummary: spec.resultSummary,
          mergedAt: spec.mergedAt,
        }));
    },
    async getPullRequest(repoId, number) {
      return data.pullRequests.find((p) => p.repoId === repoId && p.number === number) ?? null;
    },
    async listTestRuns(runId) {
      return data.progress
        .filter((p) => p.runId === runId && p.kind === 'test')
        .sort(byAtThenId)
        .flatMap((p): TestRunRecord[] => {
          const payload = p.payload as { passed?: unknown; command?: unknown } | null;
          if (typeof payload?.passed !== 'boolean') return [];
          return [
            {
              at: p.at,
              passed: payload.passed,
              command: typeof payload.command === 'string' ? payload.command : undefined,
            },
          ];
        });
    },
    async claimCommand({ runId, key, action, takeOverBefore }): Promise<CommandClaim> {
      const k = commandKey(runId, key);
      const existing = data.idempotency.get(k);
      const at = now().toISOString();
      if (!existing) {
        data.idempotency.set(k, { action, target: `run:${runId}`, claimedAt: at });
        return { status: 'claimed', token: at };
      }
      if (existing.action !== action) return { status: 'other-action', action: existing.action };
      if (existing.completedAt !== undefined) return { status: 'done', result: existing.result };
      if (Date.parse(existing.claimedAt) < Date.parse(takeOverBefore)) {
        existing.claimedAt = at;
        return { status: 'claimed', token: at, tookOver: true };
      }
      return { status: 'in-flight', claimedAt: existing.claimedAt };
    },
    async completeCommand({ runId, key, token }, result) {
      const existing = data.idempotency.get(commandKey(runId, key));
      if (!heldBy(existing, token)) return false;
      existing.completedAt = now().toISOString();
      existing.result = result;
      return true;
    },
    async releaseCommand({ runId, key, token }) {
      const k = commandKey(runId, key);
      if (heldBy(data.idempotency.get(k), token)) data.idempotency.delete(k);
    },

    // —— GitHub 事件 ——
    async claimDelivery(delivery, { staleBefore, skipIfSeen }) {
      const at = now().toISOString();
      // 先看别的投递带没带过这一版（和 Postgres 版同一个次序：不管这条自己在不在库里）
      let seenBefore = false;
      if (skipIfSeen) {
        const carriers = [...data.githubEvents.values()].filter(
          (e) =>
            e.id !== delivery.id &&
            e.versions.some(
              (v) => v.object === skipIfSeen.object && sameInstant(v.version, skipIfSeen.version),
            ),
        );
        if (carriers.some((e) => e.status !== 'ignored')) return { status: 'duplicate' };
        seenBefore = carriers.some((e) => e.reason !== REPO_NOT_MANAGED);
      }
      const seen = seenBefore ? { seenBefore } : {};
      const existing = data.githubEvents.get(delivery.id);
      if (!existing) {
        if (new Set(delivery.versions.map((v) => v.object)).size !== delivery.versions.length) {
          throw new Error('github_event_versions_delivery_id_object_pk：同一条投递里同一个对象只能有一版');
        }
        data.githubEvents.set(delivery.id, {
          ...delivery,
          versions: delivery.versions.map((v) => ({ ...v })),
          status: 'processing',
          attempts: 1,
          receivedAt: at,
          claimedAt: at,
        });
        return { status: 'claimed', token: at, retry: false, ...seen };
      }
      if (!reclaimable(existing, staleBefore)) return { status: 'duplicate' };
      Object.assign(existing, { status: 'processing', attempts: reclaimedAttempts(existing), claimedAt: at });
      existing.finishedAt = undefined;
      return { status: 'claimed', token: at, retry: true, ...seen };
    },
    async reclaimDelivery(id, { staleBefore, force }) {
      const existing = data.githubEvents.get(id);
      if (!existing) return { status: 'not_found' };
      if (!reclaimable(existing, staleBefore)) {
        if (existing.status === 'processing') return { status: 'in_flight' };
        if (!force) return { status: 'finished' };
      }
      const at = now().toISOString();
      Object.assign(existing, { status: 'processing', attempts: reclaimedAttempts(existing), claimedAt: at });
      existing.finishedAt = undefined;
      return { status: 'claimed', token: at, delivery: copyDelivery(existing) };
    },
    async finishDelivery(id, token, outcome) {
      const existing = data.githubEvents.get(id);
      if (existing?.status !== 'processing' || existing.claimedAt !== token) return false;
      if (outcome.status !== 'accepted' && !outcome.reason) {
        throw new Error('github_events_reason_when_not_taken：不收、出错都得写原因');
      }
      existing.status = outcome.status;
      existing.reason = outcome.status === 'accepted' ? undefined : outcome.reason;
      existing.note = outcome.status === 'accepted' ? outcome.note : undefined;
      existing.finishedAt = now().toISOString();
      return true;
    },
    async getDelivery(id) {
      const existing = data.githubEvents.get(id);
      return existing ? copyDelivery(existing) : null;
    },
    async listUnfinishedDeliveries({ staleBefore, limit }) {
      return [...data.githubEvents.values()]
        .filter((e) => reclaimable(e, staleBefore))
        .sort(
          (a, b) =>
            a.attempts - b.attempts || a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map(copyDelivery);
    },
    async existingDeliveryIds(ids) {
      return new Set(ids.filter((id) => data.githubEvents.has(id)));
    },
    async findSupersedingVersion({ object, version, state, excludeDeliveryId }) {
      let newest: { deliveryId: string; version: string; state: 'open' | 'closed' } | null = null;
      for (const e of data.githubEvents.values()) {
        if (e.id === excludeDeliveryId || e.status !== 'accepted') continue;
        for (const v of e.versions) {
          if (v.object !== object || !v.state || v.state === state) continue;
          if (Date.parse(v.version) <= Date.parse(version)) continue;
          if (!newest || Date.parse(v.version) > Date.parse(newest.version)) {
            newest = { deliveryId: e.id, version: v.version, state: v.state };
          }
        }
      }
      return newest;
    },
    async countStuckDeliveries({ staleBefore, maxAttempts }) {
      const all = [...data.githubEvents.values()];
      return {
        exhausted: all.filter((e) => e.status === 'failed' && e.attempts >= maxAttempts).length,
        stale: all.filter((e) => e.status === 'processing' && e.claimedAt < staleBefore).length,
      };
    },

    // —— 接活 ——
    async findRepoByName(owner, name) {
      const repo = data.repos.find(
        (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
      );
      return repo ? { ...repoOnly(repo), autoDispatchSince: repo.autoDispatchSince ?? null } : null;
    },
    async findTaskByIssue(repoId, issueNumber) {
      return data.tasks.find((t) => t.repoId === repoId && t.issueNumber === issueNumber) ?? null;
    },
    async createTaskFromIssue(input, entry) {
      const existing = data.tasks.find(
        (t) => t.repoId === input.repoId && t.issueNumber === input.issueNumber,
      );
      if (existing) return { task: existing, created: false };
      if (!data.repos.some((r) => r.id === input.repoId))
        throw new Error(`tasks_repo_id_fk：没有仓 ${input.repoId}`);
      if (!(input.issueNumber > 0)) throw new Error('tasks_issue_number_positive：issue 号要大于 0');
      checkAudit(entry);
      const inRepo = data.tasks.filter((t) => t.repoId === input.repoId).map((t) => t.priority);
      const task: Task = {
        id: input.id,
        repoId: input.repoId,
        issueNumber: input.issueNumber,
        title: input.title,
        rawRequest: input.rawRequest,
        requestedBy: input.requestedBy,
        state: 'queued',
        // 排在这个仓最后
        priority: Math.max(0, ...inRepo) + 1,
        acceptance: [],
        createdAt: now().toISOString(),
      };
      data.tasks.push(task);
      data.stateChanges.push({
        id: nextId(),
        entity: 'task',
        entityId: task.id,
        taskId: task.id,
        to: task.state,
        at: task.createdAt,
      });
      audit(entry);
      changed('tasks', task.id);
      return { task, created: true };
    },
    async updateTaskRequest({ taskId, title, rawRequest }, entry) {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) return 'not_found';
      if (task.title === title && task.rawRequest === rawRequest) return 'unchanged';
      checkAudit(entry);
      task.title = title;
      task.rawRequest = rawRequest;
      audit(entry);
      changed('tasks', taskId);
      return 'ok';
    },
    async stopQueuedTask(taskId, entry) {
      const task = data.tasks.find((t) => t.id === taskId);
      if (task?.state !== 'queued') return 'not_queued';
      checkAudit(entry);
      task.state = 'stopped';
      data.stateChanges.push({
        id: nextId(),
        entity: 'task',
        entityId: task.id,
        taskId: task.id,
        from: 'queued',
        to: 'stopped',
        at: now().toISOString(),
      });
      audit(entry);
      changed('tasks', task.id);
      return 'ok';
    },

    // —— 飞书 ——
    async getDraft(id) {
      const row = data.feishuDrafts.find((d) => d.id === id);
      return row ? draftOut(row) : null;
    },
    async createDraft({ message, draft }, entry) {
      const existing = data.idempotency.get(feishuMessageKey(message.sourceMessageId));
      if (existing) return { status: 'replayed', message: messageOut(message.sourceMessageId, existing) };
      // 先把库里的约束都查一遍，再改数据（模拟事务：违反了就整笔不做）。
      checkAudit(entry);
      needUser(message.userId, 'feishu_drafts_proposed_by_users_id_fk');
      if (draft.repoId !== undefined) needRepo(draft.repoId, 'feishu_drafts_repo_id_repos_id_fk');
      checkUnderstanding(draft.understanding);
      if (data.feishuDrafts.some((d) => d.id === draft.id || d.sourceMessageId === message.sourceMessageId)) {
        throw new Error('feishu_drafts_pkey / feishu_drafts_source_message_id_unique：草稿重复');
      }
      const at = now().toISOString();
      const row: FeishuDraftRow = {
        id: draft.id,
        revision: 1,
        status: 'open',
        sourceMessageId: message.sourceMessageId,
        chatType: draft.chatType,
        rawText: draft.rawText,
        understanding: draft.understanding,
        unsure: draft.unsure,
        repoId: draft.repoId,
        proposedBy: message.userId,
        createdAt: at,
        updatedAt: at,
        openAttempts: 0,
      };
      data.feishuDrafts.push(row);
      data.idempotency.set(feishuMessageKey(message.sourceMessageId), {
        action: 'feishu.message',
        target: `user:${message.userId}`,
        claimedAt: at,
        completedAt: at,
        result: messagePayload(message, { kind: 'draft', draftId: row.id }),
      });
      audit(entry);
      return { status: 'created', draft: draftOut(row) };
    },
    async reviseDraft({ draftId, note, repoId, key }, entry) {
      if (key.type === 'message') {
        const handled = data.idempotency.get(feishuMessageKey(key.message.sourceMessageId));
        if (handled) {
          return {
            status: 'replayed_message',
            message: messageOut(key.message.sourceMessageId, handled),
          };
        }
      }
      const row = data.feishuDrafts.find((d) => d.id === draftId);
      if (!row) return { status: 'not_found' };
      const fingerprint = reviseFingerprint({ note, repoId });
      if (key.type === 'request') {
        const reviseKey = feishuReviseKey(draftId, key.requestId);
        const seen = data.idempotency.get(reviseKey);
        if (seen) {
          const replay = reviseReplay(reviseKey, seen, fingerprint);
          return { status: replay === 'same' ? 'replayed' : 'request_reused', draft: draftOut(row) };
        }
      }
      if (row.status === 'confirmed') return { status: 'confirmed', draft: draftOut(row) };
      checkAudit(entry);
      if (repoId !== undefined) needRepo(repoId, 'feishu_drafts_repo_id_repos_id_fk');
      const next = note ? withNote(row, note) : row;
      checkUnderstanding(next.understanding);
      const at = now().toISOString();
      row.revision += 1;
      row.rawText = next.rawText;
      row.understanding = next.understanding;
      if (repoId !== undefined) row.repoId = repoId;
      row.updatedAt = at;
      data.idempotency.set(
        key.type === 'request'
          ? feishuReviseKey(draftId, key.requestId)
          : feishuMessageKey(key.message.sourceMessageId),
        key.type === 'request'
          ? {
              action: 'feishu.revise',
              target: `draft:${draftId}`,
              claimedAt: at,
              completedAt: at,
              result: revisePayload(row.revision, fingerprint),
            }
          : {
              action: 'feishu.message',
              target: `user:${key.message.userId}`,
              claimedAt: at,
              completedAt: at,
              result: messagePayload(key.message, { kind: 'draft', draftId }),
            },
      );
      audit(entry);
      return { status: 'revised', draft: draftOut(row) };
    },
    async confirmDraft({ draftId, revision, repoId, by }, entry) {
      const row = data.feishuDrafts.find((d) => d.id === draftId);
      if (!row) return { status: 'not_found' };
      if (row.status === 'confirmed') return { status: 'already', draft: draftOut(row) };
      if (row.revision !== revision) return { status: 'changed', draft: draftOut(row) };
      checkAudit(entry);
      needRepo(repoId, 'feishu_drafts_repo_id_repos_id_fk');
      needUser(by, 'feishu_drafts_confirmed_by_users_id_fk');
      const at = now().toISOString();
      row.status = 'confirmed';
      row.confirmedBy = by;
      row.confirmedAt = at;
      row.repoId = repoId;
      row.updatedAt = at;
      audit(entry);
      return { status: 'confirmed', draft: draftOut(row) };
    },
    async listDraftsToOpen(limit) {
      return data.feishuDrafts
        .filter((d) => d.status === 'confirmed' && d.taskId === undefined)
        .sort((a, b) => (a.confirmedAt ?? '').localeCompare(b.confirmedAt ?? '') || compareIds(a.id, b.id))
        .slice(0, limit)
        .map(draftOut);
    },
    async recordDraftOpened({ draftId, taskId }) {
      const row = data.feishuDrafts.find((d) => d.id === draftId);
      if (row?.status !== 'confirmed' || row.taskId !== undefined) return 'not_pending';
      if (!data.tasks.some((t) => t.id === taskId)) return 'task_not_found';
      row.taskId = taskId;
      row.openError = undefined;
      row.updatedAt = now().toISOString();
      return 'ok';
    },
    async recordDraftOpenFailure({ draftId, error }) {
      const row = data.feishuDrafts.find((d) => d.id === draftId);
      if (!row) return;
      row.openAttempts += 1;
      row.openError = error;
      row.openTriedAt = now().toISOString();
    },
    async getFeishuMessage(sourceMessageId) {
      const rec = data.idempotency.get(feishuMessageKey(sourceMessageId));
      return rec ? messageOut(sourceMessageId, rec) : null;
    },
    async recordFeishuMessage({ message, result }) {
      const k = feishuMessageKey(message.sourceMessageId);
      const existing = data.idempotency.get(k);
      if (existing) return messageOut(message.sourceMessageId, existing);
      const at = now().toISOString();
      const rec: IdempotencyRecord = {
        action: 'feishu.message',
        target: `user:${message.userId}`,
        claimedAt: at,
        completedAt: at,
        result: messagePayload(message, result),
      };
      data.idempotency.set(k, rec);
      return messageOut(message.sourceMessageId, rec);
    },
    async findTasksByIssue(issueNumber) {
      const repoName = (t: Task) => {
        const r = data.repos.find((x) => x.id === t.repoId);
        return r ? `${r.owner}/${r.name}` : '';
      };
      return data.tasks
        .filter((t) => t.issueNumber === issueNumber)
        .sort((a, b) => repoName(a).localeCompare(repoName(b)) || compareIds(a.id, b.id));
    },
    async setFollow({ taskId, userId, follow }, entry) {
      if (!data.tasks.some((t) => t.id === taskId)) return 'task_not_found';
      const existing = data.feishuFollows.find((f) => f.taskId === taskId && f.userId === userId);
      if ((existing?.following ?? false) === follow) return 'unchanged';
      checkAudit(entry);
      needUser(userId, 'feishu_follows_user_id_users_id_fk');
      const at = now().toISOString();
      if (existing) {
        existing.following = follow;
        existing.updatedAt = at;
      } else {
        data.feishuFollows.push({ taskId, userId, following: follow, updatedAt: at });
      }
      audit(entry);
      return 'changed';
    },
    async putCard(record) {
      const at = now().toISOString();
      const existing = data.feishuCards.find((c) => c.messageId === record.messageId);
      if (existing) {
        existing.kind = record.kind;
        existing.ref = { ...record.ref };
        existing.updatedAt = at;
        return;
      }
      data.feishuCards.push({ ...record, ref: { ...record.ref }, updatedAt: at });
    },
    async getCard(messageId) {
      const card = data.feishuCards.find((c) => c.messageId === messageId);
      return card ? cardOut(card) : null;
    },
    async latestBoardCard() {
      const card = latestCard((c) => c.kind === 'board');
      return card ? { messageId: card.messageId, sentAt: card.sentAt } : null;
    },
    async stateSince(entityIds) {
      const out = new Map<string, string>();
      for (const id of entityIds) {
        const latest = data.stateChanges
          .filter((c) => c.entityId === id)
          .sort(byAtThenId)
          .at(-1);
        if (latest) out.set(id, latest.at);
      }
      return out;
    },
    async countMergedSubtasksSince(since) {
      const cutoff = Date.parse(since);
      return new Set(
        data.stateChanges
          .filter((c) => c.entity === 'subtask' && c.to === 'merged' && Date.parse(c.at) >= cutoff)
          .map((c) => c.entityId),
      ).size;
    },
    async listOutboxSources(since) {
      const cutoff = Date.parse(since);
      const recent = (at: string | undefined) => at === undefined || Date.parse(at) >= cutoff;
      const nameOf = (id: string | undefined) =>
        id === undefined ? undefined : data.users.find((u) => u.id === id)?.displayName;
      const asks = data.asks
        .filter((a) => a.answer === undefined || recent(a.answeredAt))
        .sort((a, b) => a.askedAt.localeCompare(b.askedAt) || compareIds(a.id, b.id))
        .map((ask) => {
          const task = taskInfo(ask.taskId);
          if (!task) throw new Error(`asks_task_id_tasks_id_fk：追问 ${ask.id} 的需求不在库里`);
          return { ask, task, answeredByName: nameOf(ask.answeredBy) };
        });
      const notifications = data.notifications
        .filter((n) => n.resolvedAt === undefined || recent(n.resolvedAt))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || compareIds(a.id, b.id))
        .map(({ deliveries: _d, ...notification }) => ({
          notification,
          task: notification.taskId === undefined ? undefined : taskInfo(notification.taskId),
          resolvedByName: nameOf(notification.resolvedBy),
        }));
      return { asks, notifications };
    },
    async syncOutbox(items) {
      const out = new Map<string, FeishuOutboxState>();
      for (const item of items) {
        let row = data.feishuOutbox.find((r) => r.id === item.id);
        const at = now().toISOString();
        if (!row) {
          if (!item.create) continue;
          row = {
            id: item.id,
            revision: 1,
            fingerprint: item.fingerprint,
            createdAt: at,
            updatedAt: at,
            failures: 0,
          };
          data.feishuOutbox.push(row);
        } else if (row.fingerprint !== item.fingerprint) {
          row.revision += 1;
          row.fingerprint = item.fingerprint;
          row.updatedAt = at;
        }
        out.set(item.id, outboxStateOut(row));
      }
      return out;
    },
    async ackOutbox(acks, at) {
      const report: FeishuAckReport = { applied: 0, skipped: [] };
      for (const ack of acks) {
        const row = data.feishuOutbox.find((r) => r.id === ack.itemId);
        if (!row) {
          report.skipped.push({ itemId: ack.itemId, revision: ack.revision, why: 'unknown_item' });
          continue;
        }
        if (ack.revision > row.revision) {
          report.skipped.push({ itemId: ack.itemId, revision: ack.revision, why: 'future_revision' });
          continue;
        }
        const r = ack.result;
        const current = ack.revision === row.revision;
        if (!current && r.status !== 'sent' && r.status !== 'updated') {
          report.skipped.push({ itemId: ack.itemId, revision: ack.revision, why: 'stale_revision' });
          continue;
        }
        // 已经送到过更新一版的卡：旧版本的回执后到（重试、迟到）不能把「送到的卡」退回旧卡。
        if (
          !current &&
          row.deliveredMessageId !== undefined &&
          row.deliveredRevision !== undefined &&
          ack.revision < row.deliveredRevision
        ) {
          report.skipped.push({ itemId: ack.itemId, revision: ack.revision, why: 'stale_revision' });
          continue;
        }
        const next: Partial<FeishuOutboxRow> = {};
        if (r.status === 'sent') {
          Object.assign(next, {
            deliveredMessageId: r.messageId,
            deliveredChatId: r.chatId,
            deliveredAt: r.sentAt,
            deliveredRevision: ack.revision,
          });
        } else if (r.status === 'updated') {
          // 「改了」只带消息编号：会话和发出时刻取回执记过的，没记过就按卡片登记补；都查不到就不记这张卡。
          const known =
            row.deliveredMessageId === r.messageId &&
            row.deliveredChatId !== undefined &&
            row.deliveredAt !== undefined
              ? { chatId: row.deliveredChatId, sentAt: row.deliveredAt }
              : data.feishuCards.find((c) => c.messageId === r.messageId);
          if (known) {
            Object.assign(next, {
              deliveredMessageId: r.messageId,
              deliveredChatId: known.chatId,
              deliveredAt: known.sentAt,
              deliveredRevision: ack.revision,
            });
          }
        }
        if (current) {
          Object.assign(next, {
            ackRevision: ack.revision,
            ackStatus: r.status,
            ackReason:
              r.status === 'dropped' || r.status === 'deferred'
                ? r.reason
                : r.status === 'failed'
                  ? r.error
                  : undefined,
            holdUntil: r.status === 'deferred' ? r.until : r.status === 'failed' ? r.retryAfter : undefined,
          });
        }
        // 记下来什么都不变：同一条回执又来了一遍（网关重发、两批叠上），不再记一次（失败次数、送达尝试数都不加）。
        if (!changesOutboxRow(row, next)) {
          report.applied += 1;
          continue;
        }
        Object.assign(row, next);
        if (current) {
          row.ackedAt = at;
          if (r.status === 'failed') row.failures += 1;
        }
        mirrorDelivery(ack, at);
        report.applied += 1;
      }
      return report;
    },
  };
}
