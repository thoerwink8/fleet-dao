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
import { isSerial, isUuid, parseCursor } from './ids.ts';
import type {
  AgentSession,
  AskRecord,
  AuditRecord,
  CommandClaim,
  JobRecord,
  NewAuditEntry,
  NotificationRecord,
  Page,
  PageRequest,
  PullRequestRecord,
  QuotaWindowRecord,
  RunPlan,
  SettingRecord,
  StagePolicyValue,
  Store,
  TestRunRecord,
  TimelineRecord,
  User,
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

/** 和库里的表一一对应（去掉了库自己算的列）。 */
export interface MemoryData {
  users: User[];
  repos: Repo[];
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
      return [...data.repos].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
    },
    async getRepo(id) {
      return data.repos.find((r) => r.id === id) ?? null;
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
      data.stagePolicies = [
        ...data.stagePolicies.filter((p) => p.stage !== stage),
        { stage, routeIds: [...next.routeIds], pinned: next.pinned },
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
      return { items: result.items.map(({ at: _at, ...n }) => n), nextCursor: result.nextCursor };
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

    // —— GitHub ——
    async claimDelivery({ id, event, source }) {
      const k = `github-delivery:${id}`;
      if (data.idempotency.has(k)) return 'duplicate';
      data.idempotency.set(k, { action: `github.${event}`, target: source, claimedAt: now().toISOString() });
      return 'new';
    },
    async releaseDelivery(id) {
      const k = `github-delivery:${id}`;
      if (data.idempotency.get(k)?.completedAt === undefined) data.idempotency.delete(k);
    },
  };
}
