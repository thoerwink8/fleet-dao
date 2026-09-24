// 内存里的 Store：测试和本地开发用。行为照 ports.ts 的约定（比较后再改、和操作记录一起写、同一句追问复用……），
// db 包实现真 Store 时可以拿同一批测试对照。onChange 模拟数据库的 NOTIFY fleet_changes。
import type {
  Ban,
  Channel,
  Model,
  Pool,
  ProgressKind,
  QuotaWindow,
  Repo,
  Route,
  SessionRun,
  StagePolicy,
  Subtask,
  Task,
} from '@fleet-dao/shared';
import type {
  AgentSession,
  AskRecord,
  AuditRecord,
  HistoryItem,
  JobRecord,
  NewAuditEntry,
  NotificationRecord,
  Page,
  PageRequest,
  PullRequestRecord,
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

export interface MemoryData {
  users: User[];
  repos: Repo[];
  tasks: Task[];
  subtasks: Subtask[];
  runs: SessionRun[];
  plans: Map<string, RunPlan>;
  progress: ProgressRecord[];
  /** 引擎记的时间线条目（状态变化等），按 taskId 归属。 */
  engineEvents: (TimelineRecord & { taskId: string })[];
  asks: AskRecord[];
  channels: Channel[];
  pools: Pool[];
  models: Model[];
  routes: Route[];
  stagePolicies: StagePolicy[];
  bans: Ban[];
  quotaWindows: QuotaWindow[];
  jobs: JobRecord[];
  notifications: NotificationRecord[];
  audit: AuditRecord[];
  settings: SettingRecord[];
  agentSessions: AgentSession[];
  pullRequests: PullRequestRecord[];
  testRuns: (TestRunRecord & { runId: string })[];
  history: (HistoryItem & { repoId: string })[];
  deliveries: Set<string>;
}

export function emptyData(): MemoryData {
  return {
    users: [],
    repos: [],
    tasks: [],
    subtasks: [],
    runs: [],
    plans: new Map(),
    progress: [],
    engineEvents: [],
    asks: [],
    channels: [],
    pools: [],
    models: [],
    routes: [],
    stagePolicies: [],
    bans: [],
    quotaWindows: [],
    jobs: [],
    notifications: [],
    audit: [],
    settings: [],
    agentSessions: [],
    pullRequests: [],
    testRuns: [],
    history: [],
    deliveries: new Set(),
  };
}

export interface MemoryStoreOptions {
  now?: () => Date;
  onChange?: (table: string, id: string) => void;
}

function sameValue(a: StagePolicyValue, b: StagePolicyValue): boolean {
  return (
    a.pinned === b.pinned &&
    a.routeIds.length === b.routeIds.length &&
    a.routeIds.every((id, i) => id === b.routeIds[i])
  );
}

/** 按 (at, id) 倒序翻页；游标就是上一页最后一条的 `at|id`。 */
function paginate<T extends { at: string; id: string }>(items: T[], page: PageRequest): Page<T> {
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  let start = 0;
  if (page.cursor) {
    const sep = page.cursor.lastIndexOf('|');
    const at = page.cursor.slice(0, sep);
    const id = page.cursor.slice(sep + 1);
    start = sorted.findIndex((x) => x.at < at || (x.at === at && x.id < id));
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
  const changed = (table: string, id: string) => options.onChange?.(table, id);
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(6, '0')}`;

  function audit(entry: NewAuditEntry): string {
    const id = nextId('a');
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
    const id = nextId('p');
    data.progress.push({ id, runId, at: now().toISOString(), kind, payload });
    changed('progress_events', id);
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
      return data.repos;
    },
    async getRepo(id) {
      return data.repos.find((r) => r.id === id) ?? null;
    },
    async listBoardTasks(repoId) {
      return data.tasks.filter((t) => t.repoId === repoId);
    },
    async getTask(id) {
      return data.tasks.find((t) => t.id === id) ?? null;
    },
    async listSubtasks(taskIds) {
      return data.subtasks.filter((s) => taskIds.includes(s.taskId));
    },
    async listRuns({ taskIds, active }) {
      return data.runs.filter(
        (r) =>
          (!taskIds || (r.taskId !== undefined && taskIds.includes(r.taskId))) &&
          (!active || r.endedAt === undefined),
      );
    },
    async getRun(id) {
      return data.runs.find((r) => r.id === id) ?? null;
    },
    async getPlans(runIds) {
      const out = new Map<string, RunPlan>();
      for (const id of runIds) {
        const plan = data.plans.get(id);
        if (plan) out.set(id, plan);
      }
      return out;
    },
    async lastSay(runId) {
      const say = data.progress.filter((p) => p.runId === runId && p.kind === 'say').at(-1);
      if (!say) return null;
      const text = (say.payload as { text?: unknown }).text;
      return typeof text === 'string' ? { text, at: say.at } : null;
    },
    async listTimeline(taskId, page) {
      const runOf = new Map(data.runs.filter((r) => r.taskId === taskId).map((r) => [r.id, r]));
      const items: TimelineRecord[] = [
        ...data.progress
          .filter((p) => runOf.has(p.runId))
          .map((p) => ({
            id: p.id,
            at: p.at,
            source: 'session' as const,
            kind: p.kind,
            runId: p.runId,
            subtaskId: runOf.get(p.runId)?.subtaskId,
            payload: p.payload,
          })),
        ...data.engineEvents.filter((e) => e.taskId === taskId).map(({ taskId: _t, ...e }) => e),
        ...data.audit
          .filter((a) => a.target === `task:${taskId}`)
          .map((a) => ({
            id: a.id,
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
      ];
      return paginate(items, page);
    },
    async listAsks(taskId) {
      return data.asks.filter((a) => a.taskId === taskId);
    },
    async getAsk(id) {
      return data.asks.find((a) => a.id === id) ?? null;
    },
    async answerAsk({ askId, answer, by }, entry) {
      const ask = data.asks.find((a) => a.id === askId);
      if (!ask) return 'not_found';
      if (ask.answer !== undefined) return 'already_answered';
      ask.answer = answer;
      ask.answeredBy = by.id;
      ask.answeredAt = now().toISOString();
      audit(entry);
      changed('asks', askId);
      return 'ok';
    },

    // —— 调度台 ——
    async listChannels() {
      return data.channels;
    },
    async listPools() {
      return data.pools;
    },
    async listModels() {
      return data.models;
    },
    async listRoutes() {
      return data.routes;
    },
    async listStagePolicies() {
      return data.stagePolicies;
    },
    async listBans() {
      return data.bans;
    },
    async listQuotaWindows() {
      return data.quotaWindows;
    },
    async updateStagePolicy({ stage, expected, next }, entry) {
      const current = data.stagePolicies.find((p) => p.stage === stage) ?? {
        stage,
        routeIds: [],
        pinned: false,
      };
      if (!sameValue(current, expected)) return 'conflict';
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
      channel.enabled = enabled;
      audit(entry);
      changed('channels', channelId);
      return 'ok';
    },

    // —— 定时任务、通知、操作记录、设置 ——
    async listJobs() {
      return data.jobs;
    },
    async listNotifications({ status, ...page }) {
      const items = data.notifications
        .filter((n) => status === 'all' || n.resolvedAt === undefined)
        .map((n) => ({ ...n, at: n.createdAt }));
      const result = paginate(items, page);
      return { items: result.items.map(({ at: _at, ...n }) => n), nextCursor: result.nextCursor };
    },
    async resolveNotification({ id, by }, entry) {
      const n = data.notifications.find((x) => x.id === id);
      if (!n) return 'not_found';
      if (n.resolvedAt !== undefined) return 'already_resolved';
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
      );
    },
    async listSettings() {
      return data.settings;
    },
    async putSetting({ key, value, expectedVersion, by }, entry) {
      const current = data.settings.find((s) => s.key === key);
      if ((current?.version ?? 0) !== expectedVersion) return 'conflict';
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
      return data.agentSessions.find((s) => s.runId === runId) ?? null;
    },
    async savePlan(runId, steps) {
      data.plans.set(runId, { steps, updatedAt: now().toISOString() });
      progress(runId, 'plan', { steps });
    },
    async appendProgress(runId, kind, payload) {
      progress(runId, kind, payload);
    },
    async openAsk({ runId, taskId, question, options: choices }) {
      const existing = data.asks.find((a) => a.runId === runId && a.question === question);
      if (existing) return { ask: existing, created: false };
      const ask: AskRecord = {
        id: nextId('ask'),
        taskId,
        runId,
        question,
        options: choices,
        askedAt: now().toISOString(),
      };
      data.asks.push(ask);
      changed('asks', ask.id);
      return { ask, created: true };
    },
    async searchHistory({ repoId, query, limit }) {
      const q = query.toLowerCase();
      return data.history
        .filter((h) => h.repoId === repoId)
        .filter((h) => [h.title, h.specDir, h.resultSummary].some((s) => s?.toLowerCase().includes(q)))
        .slice(0, limit)
        .map(({ repoId: _r, ...h }) => h);
    },
    async getPullRequest(repoId, number) {
      return data.pullRequests.find((p) => p.repoId === repoId && p.number === number) ?? null;
    },
    async listTestRuns(runId) {
      return data.testRuns.filter((t) => t.runId === runId).map(({ runId: _r, ...t }) => t);
    },

    // —— GitHub ——
    async claimDelivery({ id }) {
      if (data.deliveries.has(id)) return 'duplicate';
      data.deliveries.add(id);
      return 'new';
    },
    async releaseDelivery(id) {
      data.deliveries.delete(id);
    },
  };
}
