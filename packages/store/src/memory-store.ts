// 内存里的 Store：测试和本地开发用，也是 ports.ts 语义的参照实现。数据按 Postgres 的表来摆（packages/db 的 schema），
// 行为照库的约束来（比较后再改、和操作记录同一「事务」、ok=false 的操作记录必须带原因……），
// 和 pg-store.ts 过同一套契约测试（test/store-contract.ts）。onChange 模拟数据库的 NOTIFY fleet_changes。
import {
  type Ban,
  type Channel,
  type ChannelStateRecord,
  type Model,
  type Pool,
  type ProgressKind,
  type RealtimeTable,
  type Repo,
  type Route,
  type ScheduleOutcome,
  type SegmentRun,
  type SessionRun,
  type Subtask,
  type Task,
  taskWorkflowId,
} from '@fleet-dao/shared';
import {
  claimedCommandResult,
  commandKey,
  commandTarget,
  judgeExistingCommand,
  tookOverResult,
} from './command-logic.ts';
import { isNotificationOpen, isSettingConflict, nextSettingVersion } from './console-logic.ts';
import { clearedFailures, isLockedAt, nextFailureState, passwordNeedsUsername } from './credentials-logic.ts';
import {
  assertOutcomeHasReason,
  claimedResult,
  duplicateVersionObject,
  isForceReclaimable,
  isReclaimable,
  judgeCarriers,
  newestSuperseding,
  outcomeFields,
  reclaimedAttempts,
  reclaimMissStatus,
  sameInstant,
  supersedes,
} from './delivery-logic.ts';
import { testRunOf } from './done-check.ts';
import { isSerial, isUuid, parseCursor } from './ids.ts';
import { nodeReportRow, readNodeSnapshot } from './node-logic.ts';
import { byAtThenId, compareIds, pageOfSorted } from './paging.ts';
import { planSteps } from './plan-logic.ts';
import type {
  AgentSession,
  AuditRecord,
  CommandClaim,
  GitHubDelivery,
  JobRecord,
  NewAuditEntry,
  NodeReportRecord,
  NotificationRecord,
  Page,
  PageRequest,
  PasswordCredentials,
  PullRequestRecord,
  QuotaWindowRecord,
  RunPlan,
  SegmentRunRecord,
  SettingRecord,
  Store,
  User,
} from './ports.ts';
import {
  autoDispatchAudit,
  autoDispatchChanged,
  autoDispatchUnchanged,
  boardCutoffMs,
  canStopTask,
  isAutoDispatchUnchanged,
  isRequestUnchanged,
  keepOnBoard,
  NEW_TASK_STATE,
  nextTaskPriority,
  segmentRunMatch,
} from './task-logic.ts';

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

/** repos 表的一行：多一个自动派活开关（打开的时刻，不填 = 关着）。列仓的接口不带这一样。 */
export type RepoRecord = Repo & { autoDispatchSince?: string | undefined };

/** 和库里的表一一对应（去掉了库自己算的列）。 */
/** 内存里的人：多一个可选的创建时刻（库里 users.created_at），只用来给 listUsers 排序，读出去时不带。 */
export type MemoryUser = User & { createdAt?: string | undefined };

export interface MemoryData {
  users: MemoryUser[];
  repos: RepoRecord[];
  tasks: Task[];
  subtasks: Subtask[];
  /** 老流程的会话（库里的 session_runs）。 */
  runs: SessionRun[];
  /** 三段的流水（库里的 runs 表，名字撞了：这里叫 segmentRuns）。 */
  segmentRuns: SegmentRun[];
  /** 会话进度：fleet plan 的步骤清单、测试结果都在这里（最近一条 plan 就是现行清单，kind=test 就是测试记录）。 */
  progress: ProgressRecord[];
  /** 需求和子任务的状态变化（库里由触发器写）；建库时没给的，按建单时刻补一条初始状态。 */
  stateChanges: StateChangeRecord[];
  channels: Channel[];
  channelStates: ChannelStateRecord[];
  pools: Pool[];
  models: Model[];
  routes: Route[];
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
  /** 收到的 GitHub 事件（github_events），按投递编号。 */
  githubEvents: Map<string, GitHubDelivery>;
  /** 账密登录的几列（库里是 users 表上的列），按用户编号；没设过的人不在里面。 */
  credentials: Map<string, PasswordCredentials>;
  /** 别的环境推来的快照（node_reports），一个环境一行。 */
  nodeReports: NodeReportRecord[];
}

export function emptyData(): MemoryData {
  return {
    users: [],
    repos: [],
    tasks: [],
    subtasks: [],
    runs: [],
    segmentRuns: [],
    progress: [],
    stateChanges: [],
    channels: [],
    channelStates: [],
    pools: [],
    models: [],
    routes: [],
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
    githubEvents: new Map(),
    credentials: new Map(),
    nodeReports: [],
  };
}

export interface MemoryStoreOptions {
  now?: () => Date;
  onChange?: (table: RealtimeTable, id: string) => void;
}

/** 列环境不带快照本体。 */
const summaryOf = ({ snapshot: _snapshot, ...summary }: NodeReportRecord) => summary;

const repoOnly = ({ autoDispatchSince: _switch, ...repo }: RepoRecord): Repo => repo;

/** 给出去的是副本：调用方改了不影响库里的。对象版本按对象排（和库版一样）。 */
const copyDelivery = (e: GitHubDelivery): GitHubDelivery => ({
  ...e,
  versions: e.versions
    .map((v) => ({ ...v }))
    .sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0)),
});

/** 按 (at, id) 倒序翻页；游标就是上一页最后一条的 `at|id`，看不懂就抛 InvalidCursorError（和库版同一个判法）。 */
function paginate<T extends { at: string; id: string }>(
  items: T[],
  page: PageRequest,
  idOk?: (id: string) => boolean,
): Page<T> {
  const cursor = parseCursor(page.cursor, idOk);
  return pageOfSorted(
    [...items].sort((a, b) => byAtThenId(b, a)),
    cursor,
    page.limit,
  );
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
  /** 用户对象换一个新的（不原地改）：外面拿着的旧对象不跟着变，和库版读出来的是快照一样。 */
  function bumpVersion(userId: string): boolean {
    const i = data.users.findIndex((u) => u.id === userId);
    const u = data.users[i];
    if (!u) return false;
    data.users[i] = { ...u, sessionVersion: (u.sessionVersion ?? 0) + 1 };
    return true;
  }

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
    return { steps: planSteps(record.payload), updatedAt: record.at };
  }

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
    // 和库版一样：创建时刻、并列再按编号；内存里没记创建时刻的当作并列（只剩按编号）。交出去的是副本，不带创建时刻。
    async listUsers() {
      return [...data.users]
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || compareIds(a.id, b.id))
        .map(({ createdAt: _createdAt, ...user }): User => user);
    },
    async findUserByUsername(username) {
      const want = username.toLowerCase();
      for (const c of data.credentials.values()) {
        if (c.username?.toLowerCase() === want) return data.users.find((u) => u.id === c.userId) ?? null;
      }
      return null;
    },
    async getPasswordCredentials(userId) {
      if (!data.users.some((u) => u.id === userId)) return null;
      return { ...(data.credentials.get(userId) ?? { userId, failedLogins: 0 }) };
    },
    async setPasswordCredentials({ userId, username, passwordHash, at }, entry) {
      if (!data.users.some((u) => u.id === userId)) return 'not_found';
      if (username !== undefined) {
        const want = username.toLowerCase();
        for (const c of data.credentials.values()) {
          if (c.userId !== userId && c.username?.toLowerCase() === want) return 'username_taken';
        }
      }
      const current = data.credentials.get(userId) ?? { userId, failedLogins: 0 };
      const next: PasswordCredentials = {
        ...current,
        ...(username !== undefined && { username }),
        ...(passwordHash !== undefined && { passwordHash, passwordChangedAt: at.toISOString() }),
        ...clearedFailures(),
      };
      // 和库里的约束 users_password_needs_username 一样：有密码就得有用户名
      if (passwordNeedsUsername(next)) {
        throw new Error('users_password_needs_username：设密码之前要先有用户名');
      }
      checkAudit(entry);
      data.credentials.set(userId, next);
      if (passwordHash !== undefined) bumpVersion(userId);
      audit(entry);
      return 'ok';
    },
    async recordPasswordFailure({ userId, at, maxFails, lockMs }) {
      if (!data.users.some((u) => u.id === userId)) return null;
      const c = data.credentials.get(userId) ?? { userId, failedLogins: 0 };
      if (isLockedAt(c, at.getTime())) return { lockedUntil: c.lockedUntil };
      const next: PasswordCredentials = { ...c, ...nextFailureState(c, at.getTime(), maxFails, lockMs) };
      data.credentials.set(userId, next);
      return { lockedUntil: next.lockedUntil };
    },
    async bumpSessionVersion(userId) {
      return bumpVersion(userId);
    },
    async recordPasswordSuccess(userId) {
      const c = data.credentials.get(userId);
      if (c) data.credentials.set(userId, { ...c, ...clearedFailures() });
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
      const cutoff = boardCutoffMs(now().getTime());
      return data.tasks
        .filter((t) => t.repoId === repoId)
        .filter((t) => {
          const since = data.stateChanges
            .filter((c) => c.entityId === t.id)
            .sort(byAtThenId)
            .at(-1)?.at;
          return keepOnBoard(t.state, Date.parse(since ?? t.createdAt), cutoff);
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
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || compareIds(a.id, b.id));
    },
    async getRun(id) {
      return data.runs.find((r) => r.id === id) ?? null;
    },
    async listSegmentRuns(taskId) {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) return [];
      const repo = data.repos.find((r) => r.id === task.repoId);
      const workflowId = repo ? taskWorkflowId(repo, task.issueNumber) : undefined;
      return data.segmentRuns
        .flatMap((r): SegmentRunRecord[] => {
          const matchedBy = segmentRunMatch(r, { id: taskId, issueNumber: task.issueNumber, workflowId });
          return matchedBy === undefined ? [] : [{ ...r, matchedBy }];
        })
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || compareIds(a.id, b.id));
    },
    async listSegmentRunsForTasks(taskIds) {
      const wanted = new Set(taskIds);
      return data.segmentRuns
        .filter((r) => r.taskId !== undefined && wanted.has(r.taskId))
        .map((r): SegmentRunRecord => ({ ...r, matchedBy: 'task' }))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || compareIds(a.id, b.id));
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
    async listPullRequests(input = {}) {
      const limit = input.limit ?? 50;
      const rows = data.pullRequests.filter((p) => input.state === undefined || p.state === input.state);
      // 和库版一样：merged 按合并时刻倒序、没读到合并时刻的排最后（不拿 updatedAt 顶，不当「最新」）；
      // 其余按镜像更新时刻倒序（没读到的排最后）；并列都按编号倒序。
      const keyOf = (p: (typeof rows)[number]) => (input.state === 'merged' ? p.mergedAt : p.updatedAt);
      const byKeyDesc = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
        const ka = keyOf(a);
        const kb = keyOf(b);
        if (ka === undefined || kb === undefined) return ka === kb ? 0 : ka === undefined ? 1 : -1;
        return kb.localeCompare(ka);
      };
      return [...rows].sort((a, b) => byKeyDesc(a, b) || b.number - a.number).slice(0, limit);
    },

    // —— 调度台 ——
    async listChannels() {
      return [...data.channels].sort((a, b) => a.id.localeCompare(b.id));
    },
    async listChannelStates() {
      return [...data.channelStates].sort((a, b) => a.channelId.localeCompare(b.channelId));
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
    // 库里按自增编号排＝写入先后；交出去的是副本。
    async listBans() {
      return data.bans.map((b) => ({ ...b }));
    },
    async listQuotaWindows() {
      return [...data.quotaWindows].sort(
        (a, b) => a.poolId.localeCompare(b.poolId) || a.label.localeCompare(b.label),
      );
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
      if (!isNotificationOpen(n)) return 'already_resolved';
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
      if (isSettingConflict(current?.version, expectedVersion)) return 'conflict';
      checkAudit(entry);
      const next: SettingRecord = {
        key,
        value,
        version: nextSettingVersion(expectedVersion),
        updatedAt: now().toISOString(),
        updatedBy: by.id,
      };
      data.settings = [...data.settings.filter((s) => s.key !== key), next];
      audit(entry);
      changed('settings', key);
      return 'ok';
    },

    // —— 别的环境推来的快照 ——
    async putNodeReport(input) {
      const { row, snapshot } = nodeReportRow(input);
      const next: NodeReportRecord = { ...row, receivedAt: now().toISOString(), snapshot };
      data.nodeReports = [...data.nodeReports.filter((r) => r.nodeId !== row.nodeId), next];
      changed('node_reports', row.nodeId);
      return summaryOf(next);
    },
    async listNodeReports() {
      return [...data.nodeReports].sort((a, b) => compareIds(a.nodeId, b.nodeId)).map(summaryOf);
    },
    async getNodeReport(nodeId) {
      const found = data.nodeReports.find((r) => r.nodeId === nodeId);
      if (!found) return null;
      // 和库版一样读回来再认一遍：种子数据、别处直接改的 data 里放了坏的也拦得住
      return {
        ...summaryOf(found),
        snapshot: readNodeSnapshot(found.nodeId, found.schemaVersion, structuredClone(found.snapshot)),
      };
    },

    // —— fleet 命令 ——
    async getAgentSession(runId) {
      const run = data.runs.find((r) => r.id === runId);
      const task = run?.taskId === undefined ? undefined : data.tasks.find((t) => t.id === run.taskId);
      // 和库里一样：任务挂的仓不在就当没有这个会话（库里是 inner join）
      const repo = task ? data.repos.find((r) => r.id === task.repoId) : undefined;
      if (!run || !task || !repo) return null;
      const session: AgentSession = {
        runId: run.id,
        taskId: task.id,
        subtaskId: run.subtaskId,
        stage: run.stage,
        repoId: task.repoId,
        // 和库里一样认起会话时记下的那条，不读仓此刻的
        testCommand: run.testCommand,
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
        .map((p) => testRunOf(p.at, p.payload));
    },
    async claimCommand({ runId, key, action, takeOverBefore }): Promise<CommandClaim> {
      const k = commandKey(runId, key);
      const existing = data.idempotency.get(k);
      const at = now().toISOString();
      if (!existing) {
        data.idempotency.set(k, { action, target: commandTarget(runId), claimedAt: at });
        return claimedCommandResult(at);
      }
      const verdict = judgeExistingCommand(
        {
          action: existing.action,
          claimedAt: existing.claimedAt,
          completed: existing.completedAt !== undefined,
          result: existing.result,
        },
        action,
        takeOverBefore,
      );
      if (verdict.status !== 'take-over') return verdict;
      existing.claimedAt = at;
      return tookOverResult(at);
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
        const verdict = judgeCarriers(carriers);
        if (verdict.duplicate) return { status: 'duplicate' };
        seenBefore = verdict.seenBefore;
      }
      const existing = data.githubEvents.get(delivery.id);
      if (!existing) {
        if (duplicateVersionObject(delivery.versions) !== undefined) {
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
        return claimedResult(at, false, seenBefore);
      }
      if (!isReclaimable(existing, staleBefore)) return { status: 'duplicate' };
      Object.assign(existing, { status: 'processing', attempts: reclaimedAttempts(existing), claimedAt: at });
      existing.finishedAt = undefined;
      return claimedResult(at, true, seenBefore);
    },
    async reclaimDelivery(id, { staleBefore, force }) {
      const existing = data.githubEvents.get(id);
      if (!existing) return { status: reclaimMissStatus(undefined) };
      if (!(force ? isForceReclaimable(existing, staleBefore) : isReclaimable(existing, staleBefore))) {
        return { status: reclaimMissStatus(existing.status) };
      }
      const at = now().toISOString();
      Object.assign(existing, { status: 'processing', attempts: reclaimedAttempts(existing), claimedAt: at });
      existing.finishedAt = undefined;
      return { status: 'claimed', token: at, delivery: copyDelivery(existing) };
    },
    async finishDelivery(id, token, outcome) {
      const existing = data.githubEvents.get(id);
      if (existing?.status !== 'processing' || existing.claimedAt !== token) return false;
      assertOutcomeHasReason(outcome);
      Object.assign(existing, outcomeFields(outcome));
      existing.finishedAt = now().toISOString();
      return true;
    },
    async getDelivery(id) {
      const existing = data.githubEvents.get(id);
      return existing ? copyDelivery(existing) : null;
    },
    async listUnfinishedDeliveries({ staleBefore, limit }) {
      return [...data.githubEvents.values()]
        .filter((e) => isReclaimable(e, staleBefore))
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
      const query = { object, version, state };
      const candidates: { deliveryId: string; version: string; state: 'open' | 'closed' }[] = [];
      for (const e of data.githubEvents.values()) {
        if (e.id === excludeDeliveryId || e.status !== 'accepted') continue;
        for (const v of e.versions) {
          if (supersedes(v, query)) candidates.push({ deliveryId: e.id, version: v.version, state: v.state });
        }
      }
      return newestSuperseding(candidates);
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
      return repo
        ? {
            ...repoOnly(repo),
            autoDispatchSince: repo.autoDispatchSince ?? null,
          }
        : null;
    },
    async findTaskByIssue(repoId, issueNumber) {
      return data.tasks.find((t) => t.repoId === repoId && t.issueNumber === issueNumber) ?? null;
    },
    async findTasksByIssues(refs) {
      const wanted = new Set(refs.map((r) => `${r.repoId}#${r.issueNumber}`));
      return data.tasks.filter((t) => wanted.has(`${t.repoId}#${t.issueNumber}`));
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
        state: NEW_TASK_STATE,
        // 排在这个仓最后
        priority: nextTaskPriority(inRepo),
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
      if (isRequestUnchanged(task, { title, rawRequest })) return 'unchanged';
      checkAudit(entry);
      task.title = title;
      task.rawRequest = rawRequest;
      audit(entry);
      changed('tasks', taskId);
      return 'ok';
    },
    async stopQueuedTask(taskId, entry) {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task || !canStopTask(task.state)) return 'not_queued';
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
    async adoptOrphanTask(input, entry) {
      const task = data.tasks.find((t) => t.id === input.taskId);
      if (!task) return 'not_found';
      if (task.state !== 'queued' && task.state !== 'stopped') return 'not_orphan';
      checkAudit(entry);
      const from = task.state;
      task.title = input.title;
      task.rawRequest = input.rawRequest;
      if (from !== 'queued') {
        task.state = 'queued';
        data.stateChanges.push({
          id: nextId(),
          entity: 'task',
          entityId: task.id,
          taskId: task.id,
          from,
          to: 'queued',
          at: now().toISOString(),
        });
      }
      audit(entry);
      changed('tasks', task.id);
      return 'adopted';
    },
    async setAutoDispatch({ repoId, on }, entry) {
      const repo = data.repos.find((r) => r.id === repoId);
      if (!repo) return 'not_found';
      const before = repo.autoDispatchSince ?? null;
      if (isAutoDispatchUnchanged(before, on)) return autoDispatchUnchanged(before);
      const after = on ? now().toISOString() : null;
      const full = autoDispatchAudit(entry, before, after);
      checkAudit(full);
      repo.autoDispatchSince = after ?? undefined;
      return autoDispatchChanged(after, audit(full));
    },
  };
}
