// 引擎端口 → AI 会话（目前只接了 Claude Code，经 reclaude 无头起）：起会话、看守、叫停、收孤儿。
//
// 起会话：按 runId 幂等（库里 session_runs 一行；叫停过的 runId 不再起）。会话用户按账号池定（pools.run_as_user）。
// 会话断了接着干（design 第一节、第九节、第十四节）：同一个会话用户 --resume 续上；换了会话用户、上下文还小
// （< forkMaxContextTokens）就把工作树和过程记录交给新用户（fleet-agent-scope adopt）再 --fork-session 续；上下文大了
// 或记录没拷成，开新会话、带接力任务书（做到哪了、已提交了什么）。工作树由会话用户自己从引擎镜像打的 bundle 建，
// 引擎不以自己的身份在会话目录里跑 git。进程起来（onSpawn）才算开工：记进程号和 scope，交回工作流。
//
// 看守：进程是这个工人进程起的（registry）。接不上（工人重启过、输出管道断了）就按记下的 scope 收掉旧会话，回
// SESSION_LOST，工作流续会话重起。过程中：心跳；进度事件攒一小批写库（fleet done 的核实要读会话自己跑过的测试，
// 所以写得要快）；额度读数顺手记账；每分钟按进展判一次停滞（failure/stall.ts），在绕圈、工具卡死就停掉，结局 stalled
// （光是没动静由插头自己的 idle 超时管）。结束后：写码类看 fleet done 和工作树（有新提交、没有没提交的已跟踪改动）；
// 分诊、需求文档、方案、审查读 .fleet-out/ 下的结论文件，形状不对算交错了。
// 失败原样交给工作流的失败分流；这里只按同一张规则表认出「要人修的整池问题」（设备被撤销、封号、登录失效、欠费）：
// 写一条 pool-hold:<池> 的「要人拍」提醒，选路就避开整个池；续会话的那一单是试探，跑通了就撤掉这条提醒。

import { randomUUID } from 'node:crypto';
import {
  type CgroupScope,
  type ClaudeCodeRunOptions,
  type ClaudeCodeRunReport,
  type ClaudeCodeRunSpec,
  type ClaudeSession,
  type DeliveryCheck,
  judgeClaudeRun,
  listAgentScopes,
  type PlanPayload,
  type RateLimitReading,
  reapSession,
  runClaudeCode,
  SESSION_USERS,
  type SessionUser,
  type SpawnInfo,
  stopScope,
  type ToolPayload,
} from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import { PLAN_DOC } from '@fleet-dao/conventions';
import {
  appendProgressEvents,
  type Db,
  finishSessionRun,
  getSessionRun,
  latestRunOfSession,
  markSessionRunStarted,
  openAlertsByPrefix,
  openSessionRun,
  requestSessionStop,
  resolveAlertByKey,
  routeLaunchFacts,
  runProgressFacts,
  type SessionRunState,
  savePoolQuota,
  type TaskContext,
  taskContext,
  upsertAlert,
} from '@fleet-dao/db';
import type { ProgressEvent, RunOutcome, StageKind } from '@fleet-dao/shared';
import { classifyFailure } from '../failure/classify.ts';
import { judgeStall, type StallPolicy, type StallToolCall } from '../failure/stall.ts';
import {
  type AwaitSessionInput,
  type EnginePorts,
  type LaunchSessionInput,
  PortError,
  type SessionEnd,
  type SessionHandle,
  type SessionOutput,
  type StartSessionResult,
} from '../ports.ts';
import type { UserExec } from './exec.ts';
import { bundleFromMirror, type MirrorGitHub, mapped } from './mirror.ts';
import {
  OUTPUT_FILES,
  type OutputKind,
  outputKindOf,
  type Parsed,
  parsePlan,
  parseRequirementDoc,
  parseReview,
  parseTriage,
  type RelayFacts,
  stagePrompt,
} from './prompts.ts';
import { POOL_HOLD_PREFIX, poolHoldKey } from './store-ports.ts';
import {
  changedFilesSince,
  checkoutBranch,
  checkoutDetached,
  commitsSince,
  diffstatSince,
  fetchBundle,
  hasCommit,
  hasRepo,
  headOf,
  headOfIncoming,
  readFileAs,
  type UserTree,
  uncommittedTracked,
} from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

/** 上下文比这个小才 fork 续到别的会话用户；大了开新会话带接力任务书（design 第九节「上下文越长越贵」）。 */
export const DEFAULT_FORK_MAX_CONTEXT_TOKENS = 100_000;

export type ContinueMode = 'new' | 'resume' | 'fork' | 'relay';

export interface SessionPortsDeps {
  db: Db;
  trees: WorkTrees;
  /** 以会话用户的身份跑命令（生产 scopeExec）。 */
  exec: UserExec;
  gh: MirrorGitHub & {
    commitIdentity(repo: { owner: string; name: string }): Promise<{ name: string; email: string }>;
  };
  /** 引擎自己的临时目录（从镜像打的 bundle 落在这里，读进内存就删）。 */
  tmpDir: string;
  /** 这台机器给人看的名字（例如「法国」）：只有人能修的（重新登录）要写清去哪台机器。 */
  machine: string;
  /** 起 Claude Code 的命令（绝对路径）：reclaude 装在各会话用户自己家里。 */
  claudeCommand(user: SessionUser): string[];
  forkMaxContextTokens?: number;
  /** 经 sudo 调的帮手（fleet-agent-scope）；测试里换成假的。 */
  helper?: string;
  sudo?: readonly string[];
  /** 会话目录里跑的 git、sh（测试里换成 PATH 上的）。 */
  gitBin?: string;
  shBin?: string;
  /** 宿主环境（会话环境只从里面抄一小撮基础变量，见 adapters/env.ts）。 */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** 起会话的插头；测试里换成假的（不起真执行体）。 */
  run?: (spec: ClaudeCodeRunSpec, options: ClaudeCodeRunOptions) => Promise<ClaudeCodeRunReport>;
  stallPolicy?: Partial<StallPolicy>;
  now?: () => Date;
  /** 看守多久醒一次（心跳、写进度）、多久判一次停滞、进度攒多久写一次、等进程起来最多多久。 */
  tickMs?: number;
  stallCheckMs?: number;
  flushMs?: number;
  spawnTimeoutMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type SessionPorts = Pick<EnginePorts, 'startSession' | 'awaitSession' | 'stopSession'> & {
  /** 工人起来接活之前：收掉上一轮留下的会话 scope（fleet-agent-scope list 再逐个 stop），回收了几个。 */
  reapOrphanSessions(): Promise<number>;
};

interface Live {
  runId: string;
  sessionId: string;
  taskId: string;
  stage: StageKind;
  kind: OutputKind;
  mode: ContinueMode;
  user: SessionUser;
  poolId: string;
  routeId: string;
  dir: string;
  baseHead: string | undefined;
  reviewHead: string | undefined;
  /** 续会话时上一轮结束时的会话累计花费：这一轮的花费按它求差。 */
  previousCost: number | null | undefined;
  startedAt: number;
  spawned: Promise<SpawnInfo>;
  report: Promise<ClaudeCodeRunReport>;
  abort: AbortController;
  stop: { kind: 'stop'; reason: string } | { kind: 'stall'; rule: string; basis: string } | undefined;
  pending: ProgressEvent[];
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  flushing: Promise<void>;
  writeError: string | undefined;
  dropped: number;
  lastEventAt: number | null;
  lastStepAt: number | undefined;
  lastFileAt: number | undefined;
  tools: Map<string, { name: string; since: number }>;
  recent: StallToolCall[];
  says: string[];
  plan: Map<string, string>;
  rateLimits: RateLimitReading[];
  quotaError: string | undefined;
}

const STEP_RANK: Record<string, number> = { pending: 0, in_progress: 1, done: 2 };
const PENDING_MAX = 5_000;
const RECENT_TOOLS = 30;
const SAYS_KEPT = 12;
const SHA = /^[0-9a-f]{40}$/;
const OUTCOME: Record<SessionEnd['outcome'], RunOutcome> = {
  done: 'ok',
  blocked: 'ok',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};
const NEEDS = new Set(['human', 'info', 'access', 'other']);

function asSessionUser(user: string | null | undefined): SessionUser | undefined {
  return (SESSION_USERS as readonly string[]).includes(user ?? '') ? (user as SessionUser) : undefined;
}

function claudeSession(mode: ContinueMode, id: string, from: string | undefined): ClaudeSession {
  if (mode === 'resume') return { mode: 'resume', id };
  if (mode === 'fork' && from) return { mode: 'fork', from, id };
  return { mode: 'new', id };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSessionPorts(deps: SessionPortsDeps): SessionPorts {
  const { db, trees, gh } = deps;
  const clock = deps.now ?? (() => new Date());
  const run = deps.run ?? runClaudeCode;
  const forkMax = deps.forkMaxContextTokens ?? DEFAULT_FORK_MAX_CONTEXT_TOKENS;
  const tickMs = deps.tickMs ?? 5_000;
  const stallCheckMs = deps.stallCheckMs ?? 60_000;
  const flushMs = deps.flushMs ?? 300;
  const spawnTimeoutMs = deps.spawnTimeoutMs ?? 120_000;
  const log = deps.log ?? ((message, fields) => console.warn(message, fields ?? {}));
  const helperOpts = {
    ...(deps.helper ? { helper: deps.helper } : {}),
    ...(deps.sudo ? { sudo: deps.sudo } : {}),
  };
  const registry = new Map<string, Live>();
  const identities = new Map<string, Promise<{ name: string; email: string }>>();

  const treeAs = (dir: string, user: SessionUser, prefix: string, signal?: AbortSignal): UserTree => ({
    exec: deps.exec,
    user,
    dir,
    scopePrefix: prefix,
    ...(signal ? { signal } : {}),
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  });

  const identityOf = (repo: TaskContext['repo']) => {
    const key = `${repo.owner}/${repo.name}`;
    let p = identities.get(key);
    if (!p) {
      p = mapped(() => gh.commitIdentity(repo));
      identities.set(key, p);
      p.catch(() => identities.delete(key));
    }
    return p;
  };

  // ---- 进度：攒一小批写库

  const flush = (live: Live): Promise<void> => {
    live.flushing = live.flushing.then(async () => {
      while (live.pending.length > 0) {
        const batch = live.pending.splice(0, 500);
        try {
          const r = await appendProgressEvents(
            db,
            live.runId,
            batch.map((e) => ({ at: new Date(e.at), kind: e.kind, payload: e.payload })),
          );
          if (r === 'run_not_found') {
            live.writeError ??= `库里没有会话 ${live.runId}，进度写不进去`;
            return;
          }
        } catch (error) {
          live.writeError ??= errorText(error);
          // 写不进去先放回去，下一轮再写；攒太多就丢最老的，记下丢了几条（不静默）。
          live.pending.unshift(...batch);
          if (live.pending.length > PENDING_MAX) {
            const drop = live.pending.length - PENDING_MAX;
            live.pending.splice(0, drop);
            live.dropped += drop;
          }
          return;
        }
      }
    });
    return live.flushing;
  };

  const scheduleFlush = (live: Live) => {
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = undefined;
      void flush(live);
    }, flushMs);
  };

  const onEvent = (live: Live, event: ProgressEvent) => {
    const at = Date.parse(event.at);
    const when = Number.isNaN(at) ? clock().getTime() : at;
    live.lastEventAt = when;
    const payload = event.payload as Record<string, unknown> | null;
    if (event.kind === 'tool' && payload) {
      const tool = payload as unknown as ToolPayload;
      if (tool.phase === 'start') {
        live.tools.set(tool.toolUseId, { name: tool.name, since: when });
        live.recent.push({ name: tool.name, summary: tool.summary, action: tool.action });
        if (live.recent.length > RECENT_TOOLS) live.recent.shift();
      } else {
        live.tools.delete(tool.toolUseId);
      }
    } else if (event.kind === 'file') {
      live.lastFileAt = when;
    } else if (event.kind === 'plan' && payload) {
      const steps = (payload as unknown as PlanPayload).steps ?? [];
      const advanced = steps.some(
        (s) => (STEP_RANK[s.state] ?? 0) > (STEP_RANK[live.plan.get(s.title) ?? 'pending'] ?? 0),
      );
      if (advanced) live.lastStepAt = when;
      live.plan = new Map(steps.map((s) => [s.title, s.state]));
    } else if (event.kind === 'say' && typeof payload?.text === 'string') {
      live.says.push(payload.text);
      if (live.says.length > SAYS_KEPT) live.says.shift();
    }
    live.pending.push(event);
    scheduleFlush(live);
  };

  const onRateLimit = (live: Live, reading: RateLimitReading) => {
    live.rateLimits.push(reading);
    const windows = readingsFromRateLimit(reading, { poolId: live.poolId });
    if (!windows?.length) return;
    // 会话里顺带读到的只是几个窗口：complete=false，不标别的窗口过期、不算一次读成。
    void savePoolQuota(db, {
      poolId: live.poolId,
      readAt: reading.observedAt,
      complete: false,
      windows,
    }).catch((error: unknown) => {
      live.quotaError ??= errorText(error);
    });
  };

  // ---- 起会话

  async function prepareTree(
    input: LaunchSessionInput,
    task: TaskContext,
    kind: OutputKind,
    dir: string,
    user: SessionUser,
    mode: ContinueMode,
    transcript: { from: SessionUser; sessionId: string } | undefined,
    signal: AbortSignal,
  ): Promise<'ok' | 'transcript_missing'> {
    const owner = await trees.ownerOf(dir);
    let adopted: 'ok' | 'transcript_missing' = 'ok';
    const fresh = owner === null;
    if (owner !== user || transcript) adopted = await trees.adopt(dir, user, transcript);
    const t = treeAs(dir, user, `prep-${input.runId}`, signal);
    const identity = await identityOf(task.repo);
    const repoRef = { owner: task.repo.owner, name: task.repo.name };
    if (kind === 'delivery') {
      if (!fresh && (await hasRepo(t))) return adopted;
      const base = input.baseHead;
      const branch = input.brief.branch;
      if (!base || !SHA.test(base) || !branch) {
        throw new PortError('BAD_INPUT', '写码会话要给起会话前的头（baseHead）和分支（brief.branch）', {
          retryable: false,
        });
      }
      const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, base, [], signal);
      await fetchBundle(t, bytes, ref, { identity });
      await checkoutBranch(t, branch, base);
      return adopted;
    }
    // 分诊、需求文档、方案、审查：检出副本。续同一个会话（resume / fork）不动它；开新会话从干净的检出起。
    if (!fresh && (mode === 'resume' || mode === 'fork') && adopted === 'ok') return adopted;
    let sha: string;
    if (kind === 'review') {
      sha = input.brief.head ?? '';
      if (!SHA.test(sha)) {
        throw new PortError('BAD_INPUT', `审查会话要给 PR 的头（完整提交号）：${sha || '没给'}`, {
          retryable: false,
        });
      }
    } else {
      sha = (await mapped(() => gh.fetchMainline({ repo: repoRef, signal }))).head;
    }
    const exclude: string[] = [];
    const known = await hasRepo(t);
    // 仓里已经有这个提交（主线没动过）：直接换检出。要是照样去镜像取，包里一个新提交都没有，git 拒绝打空包。
    if (!known || !(await hasCommit(t, sha))) {
      if (known) {
        const last = await headOfIncoming(t).catch(() => undefined);
        if (last) exclude.push(last);
      }
      const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, sha, exclude, signal);
      await fetchBundle(t, bytes, ref, { identity });
    }
    await checkoutDetached(t, sha);
    return adopted;
  }

  async function relayFacts(
    prior: SessionRunState | null,
    t: UserTree,
    kind: OutputKind,
    base: string | undefined,
    why: string,
  ): Promise<RelayFacts> {
    const progress = prior ? await runProgressFacts(db, prior.id, { saysLimit: 8 }) : null;
    const delivery = kind === 'delivery' && base !== undefined && SHA.test(base);
    return {
      steps: progress?.lastPlan?.steps ?? [],
      says: (progress?.says ?? []).map((s) => s.text).filter(Boolean),
      commits: delivery ? await commitsSince(t, base, 30) : [],
      diffstat: delivery ? await diffstatSince(t, base) : [],
      why,
    };
  }

  const resultOf = (live: Live, info: SpawnInfo): StartSessionResult => ({
    sessionId: live.sessionId,
    resumed: live.mode === 'resume' || live.mode === 'fork',
    handle: { pid: info.pid, ...(info.scope ? { scope: info.scope } : {}) },
  });

  async function startSession(input: LaunchSessionInput, ctx: Parameters<EnginePorts['startSession']>[1]) {
    const known = registry.get(input.runId);
    if (known) return resultOf(known, await known.spawned);

    const route = await routeLaunchFacts(db, input.route.routeId);
    if (!route) {
      throw new PortError('ROUTE_NOT_FOUND', `库里没有路由 ${input.route.routeId}`, { retryable: false });
    }
    if (route.hostId !== 'claude-code') {
      throw new PortError(
        'HOST_NOT_WIRED',
        `执行方式 ${route.hostId} 引擎还没接上（目前只接了 Claude Code）`,
        {
          retryable: false,
        },
      );
    }
    const user = asSessionUser(route.runAsUser);
    if (!user) {
      throw new PortError('CONFIG_MISSING', `账号池 ${route.poolId} 没定会话用户（pools.run_as_user）`, {
        retryable: false,
      });
    }
    const task = await taskContext(db, input.taskId);
    if (!task) throw new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}`, { retryable: false });
    let kind: OutputKind;
    try {
      kind = outputKindOf(input.stage);
    } catch (error) {
      throw new PortError('BAD_INPUT', errorText(error), { retryable: false });
    }
    let dir: string;
    if (kind === 'delivery') {
      if (!input.worktreePath) {
        throw new PortError('BAD_INPUT', '写码会话没给工作树', { retryable: false });
      }
      dir = input.worktreePath;
    } else {
      dir = trees.scratchFor(task.repo, task.issueNumber, input.stage, input.subtaskKey);
    }

    const opened = await openSessionRun(db, {
      id: input.runId,
      taskId: input.taskId,
      subtaskId: input.subtaskId ?? null,
      stage: input.stage,
      routeId: route.routeId,
      whyRoute: input.whyRoute,
      branch: input.brief.branch ?? null,
      queuedAt: new Date(input.queuedAt),
      workflowId: null,
      runAsUser: user,
      worktreePath: dir,
    });
    const existing = opened.run;
    if (existing.stopRequested) {
      throw new PortError(
        'SESSION_STOPPED',
        `会话 ${input.runId} 已经叫停（${existing.stopRequested.reason}），不再起`,
        {
          retryable: false,
        },
      );
    }
    if (existing.endedAt) {
      throw new PortError('SESSION_ENDED', `会话 ${input.runId} 已经结束过，不再起`, { retryable: false });
    }
    if (existing.startedAt && existing.sessionId) {
      // 上一个工人进程起过、没等到回话就没了：原样交回，看守接不上会按 SESSION_LOST 收掉它、续会话重起。
      return {
        sessionId: existing.sessionId,
        resumed: Boolean(input.resumeSessionId),
        ...(existing.handle ? { handle: existing.handle } : {}),
      };
    }

    // 接着干的方式：看这个会话上一次跑在哪个会话用户下。
    let mode: ContinueMode = 'new';
    let sessionId: string = randomUUID();
    let from: string | undefined;
    let prior: SessionRunState | null = null;
    let why = '';
    if (input.resumeSessionId) {
      prior = await latestRunOfSession(db, input.resumeSessionId);
      const priorUser = asSessionUser(prior?.runAsUser);
      if (!prior || !priorUser) {
        mode = 'relay';
        why = `上一个会话 ${input.resumeSessionId} 的记录查不到`;
      } else if (priorUser === user) {
        mode = 'resume';
        sessionId = input.resumeSessionId;
      } else if (prior.contextTokens !== null && prior.contextTokens < forkMax) {
        mode = 'fork';
        from = input.resumeSessionId;
      } else {
        mode = 'relay';
        why =
          prior.contextTokens === null
            ? `换了账号池（${priorUser} → ${user}），上一轮的上下文大小不知道`
            : `换了账号池（${priorUser} → ${user}），上一轮的上下文有 ${prior.contextTokens} 个 token，大了不 fork`;
      }
    }
    const priorUser = asSessionUser(prior?.runAsUser);
    const adopted = await prepareTree(
      input,
      task,
      kind,
      dir,
      user,
      mode,
      mode === 'fork' && priorUser && from ? { from: priorUser, sessionId: from } : undefined,
      ctx.signal,
    );
    if (mode === 'fork' && adopted === 'transcript_missing') {
      mode = 'relay';
      sessionId = randomUUID();
      from = undefined;
      why = `换了账号池，上一个会话的过程记录没找到（拷不过去）`;
    }
    const t = treeAs(dir, user, `prep-${input.runId}`, ctx.signal);
    const relay =
      mode === 'relay'
        ? await relayFacts(
            prior,
            t,
            kind,
            input.baseHead,
            prior?.failureMessage ? `${why}；${prior.failureMessage}` : why,
          )
        : undefined;
    const prompt = stagePrompt({
      stage: input.stage,
      brief: input.brief,
      repo: task.repo,
      issueNumber: task.issueNumber,
      mode,
      previousProblem: prior?.failureMessage ?? undefined,
      relay,
    });

    // 登记之后再核一次叫停：叫停可能落在上面建树的那几秒里。
    const again = await getSessionRun(db, input.runId);
    if (again?.stopRequested) {
      throw new PortError('SESSION_STOPPED', `会话 ${input.runId} 已经叫停，不再起`, { retryable: false });
    }

    const abort = new AbortController();
    let spawnResolve!: (info: SpawnInfo) => void;
    let spawnReject!: (error: unknown) => void;
    const spawned = new Promise<SpawnInfo>((resolve, reject) => {
      spawnResolve = resolve;
      spawnReject = reject;
    });
    spawned.catch(() => undefined);
    const live: Live = {
      runId: input.runId,
      sessionId,
      taskId: input.taskId,
      stage: input.stage,
      kind,
      mode,
      user,
      poolId: route.poolId,
      routeId: route.routeId,
      dir,
      baseHead: input.baseHead,
      reviewHead: input.brief.head,
      previousCost: mode === 'resume' ? (prior?.sessionCostUsd ?? null) : undefined,
      startedAt: clock().getTime(),
      spawned,
      report: Promise.resolve(undefined as unknown as ClaudeCodeRunReport),
      abort,
      stop: undefined,
      pending: [],
      flushTimer: undefined,
      flushing: Promise.resolve(),
      writeError: undefined,
      dropped: 0,
      lastEventAt: null,
      lastStepAt: undefined,
      lastFileAt: undefined,
      tools: new Map(),
      recent: [],
      says: [],
      plan: new Map(),
      rateLimits: [],
      quotaError: undefined,
    };
    const r = input.resources;
    const cgroup: CgroupScope = {
      id: input.runId,
      user,
      limits: {
        memoryHigh: `${r.memoryHighMb}M`,
        memoryMax: `${r.memoryMaxMb}M`,
        memorySwapMax: `${r.swapMaxMb}M`,
      },
      ...helperOpts,
    };
    registry.set(input.runId, live);
    let spawnedYet = false;
    live.report = run(
      {
        runId: input.runId,
        cwd: dir,
        prompt,
        env: {
          base: deps.baseEnv ?? process.env,
          fleetApi: input.launch.fleetApi,
          fleetToken: input.launch.fleetToken,
          pathPrepend: input.launch.pathPrepend,
        },
        limits: {
          // 插头自己的 idle 超时管「光是没动静」；总时长比看守的限时（sessionMinutes）早一分钟到，插头先收场。
          idleMs: input.stallSeconds * 1000,
          wallClockMs: Math.max(60_000, input.sessionMinutes * 60_000 - 60_000),
        },
        testCommands: task.repo.testCommand ? [task.repo.testCommand] : [],
        cgroup,
        model: route.upstreamModel ?? route.modelId,
        session: claudeSession(mode, sessionId, from),
        // 会话用户读不到引擎的配置和机器人凭据（design 第十四节），无头会话没人批权限：放开。
        permissionMode: 'bypassPermissions',
      },
      {
        command: deps.claudeCommand(user),
        signal: abort.signal,
        ...(deps.now ? { now: deps.now } : {}),
        onEvent: (e) => onEvent(live, e),
        onRateLimit: (reading) => onRateLimit(live, reading),
        onSpawn: (info) => {
          spawnedYet = true;
          spawnResolve(info);
        },
      },
    ).then(
      (report) => {
        if (!spawnedYet) {
          spawnReject(
            // 不可重试：活动原地重试用的是同一个 runId，库里这一行已经记了结局，第二次只会报「已经结束过」，
            // 把起不来的真原因（reclaude 不在之类，失败分流 CF1 认它）吞掉。交回工作流，由它换新 runId 再起。
            new PortError('SPAWN_FAILED', `会话没起来：${report.spawnError ?? '进程起不来'}`, {
              retryable: false,
            }),
          );
        }
        return report;
      },
      (error: unknown) => {
        spawnReject(
          new PortError('LAUNCH_FAILED', `起会话之前就被拦下了：${errorText(error)}`, { retryable: false }),
        );
        throw error;
      },
    );
    live.report.catch(() => undefined);

    let info: SpawnInfo;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      info = await Promise.race([
        spawned,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new PortError('SPAWN_TIMEOUT', `等了 ${spawnTimeoutMs / 1000} 秒进程还没起来`, {
                  retryable: false,
                }),
              ),
            spawnTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      live.stop = { kind: 'stop', reason: '没起来' };
      abort.abort();
      registry.delete(input.runId);
      await finishSessionRun(db, {
        id: input.runId,
        outcome: 'failed',
        endedAt: clock(),
        failureCode: error instanceof PortError ? error.code : 'LAUNCH_FAILED',
        failureMessage: errorText(error),
        routeOutcome: 'neutral',
      }).catch((e: unknown) => log('没起来的会话没记上结局', { runId: input.runId, error: errorText(e) }));
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const handle: SessionHandle = { pid: info.pid, ...(info.scope ? { scope: info.scope } : {}) };
    const marked = await markSessionRunStarted(db, {
      id: input.runId,
      startedAt: new Date(info.startedAt),
      sessionId,
      handle,
    });
    if (marked === 'not_found') log('会话开工没记上：库里没这一行', { runId: input.runId });
    return resultOf(live, info);
  }

  // ---- 看守

  async function reapLost(runId: string, user: SessionUser | undefined, handle: SessionHandle | undefined) {
    if (!user) return '（库里没记会话用户，旧会话的 scope 没法收）';
    try {
      const r = await reapSession({
        runId,
        scope: { id: runId, user, ...helperOpts },
        ...(handle?.pid ? { rootPid: handle.pid } : {}),
      });
      if (r.error) return `（收旧会话时出错：${r.error}）`;
      if (r.leftovers === undefined) return '（旧会话收没收干净没查成）';
      if (r.leftovers > 0) return `（旧会话还剩 ${r.leftovers} 个进程没收掉）`;
      return r.found > 0 ? `（收掉了旧会话的 ${r.found} 个进程）` : '';
    } catch (error) {
      return `（收旧会话时出错：${errorText(error)}）`;
    }
  }

  async function checkStall(live: Live): Promise<void> {
    let pendingAsk: { question: string; askedAt: Date } | null = null;
    try {
      pendingAsk = (await runProgressFacts(db, live.runId, { saysLimit: 1 }))?.pendingAsk ?? null;
    } catch (error) {
      log('停滞判断读不到在等的问题，这一轮不判', { runId: live.runId, error: errorText(error) });
      return;
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    const verdict = judgeStall(
      {
        now: clock().toISOString(),
        startedAt: iso(live.startedAt),
        lastEventAt: live.lastEventAt === null ? null : iso(live.lastEventAt),
        ...(live.lastStepAt === undefined ? {} : { lastStepAt: iso(live.lastStepAt) }),
        ...(live.lastFileAt === undefined ? {} : { lastFileChangeAt: iso(live.lastFileAt) }),
        processAlive: true,
        toolsInFlight: [...live.tools.values()].map((t) => ({ name: t.name, since: iso(t.since) })),
        ...(pendingAsk
          ? {
              waiting: {
                on: 'human' as const,
                since: pendingAsk.askedAt.toISOString(),
                detail: pendingAsk.question,
              },
            }
          : {}),
        recentTools: live.recent,
        transcriptTail: live.says.slice(-5),
      },
      deps.stallPolicy,
    );
    // 光是没动静（D5）交给插头的 idle 超时：它按真实活动（包括思考帧）计时，这里只看得到进度事件。
    const act = verdict.state === 'looping' || (verdict.state === 'dead' && verdict.rule !== 'D5');
    if (act && !live.stop) {
      live.stop = { kind: 'stall', rule: verdict.rule, basis: verdict.basis };
      live.abort.abort();
    }
  }

  async function deliveryCheck(
    live: Live,
  ): Promise<{ check: DeliveryCheck; head?: string; changed: string[] }> {
    const base = live.baseHead;
    const target = base ?? '（没给起会话前的头）';
    const t = treeAs(live.dir, live.user, `done-${live.runId}`);
    try {
      const head = await headOf(t);
      const dirty = await uncommittedTracked(t);
      if (dirty.length > 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            uncommitted: dirty.length,
            detail: `工作树里有没提交的已跟踪改动（引擎只推提交，这部分会丢）：${dirty.slice(0, 5).join('；')}`,
          },
          head,
          changed: [],
        };
      }
      if (!base || !SHA.test(base)) {
        return {
          check: { state: 'unknown', target, detail: '没给起会话前的头，判不了有没有新提交' },
          head,
          changed: [],
        };
      }
      const commits = head === base ? [] : await commitsSince(t, base, 50);
      if (commits.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: 0,
            detail: `起会话前的头 ${base.slice(0, 7)} 之后没有新提交`,
          },
          head,
          changed: [],
        };
      }
      const changed = await changedFilesSince(t, base);
      if (changed.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: commits.length,
            hasDiff: false,
            detail: '有新提交，但和起会话前比没有内容差异',
          },
          head,
          changed,
        };
      }
      return {
        check: {
          state: 'delivered',
          target,
          newCommits: commits.length,
          hasDiff: true,
          uncommitted: 0,
          detail: `${commits.length} 个新提交，改了 ${changed.length} 个文件`,
        },
        head,
        changed,
      };
    } catch (error) {
      return { check: { state: 'unknown', target, detail: errorText(error) }, changed: [] };
    }
  }

  async function readOutput(live: Live): Promise<Parsed<SessionOutput>> {
    const t = treeAs(live.dir, live.user, `out-${live.runId}`);
    const read = async (path: string) => {
      const text = await readFileAs(t, path);
      return text;
    };
    try {
      switch (live.kind) {
        case 'triage': {
          const text = await read(OUTPUT_FILES.triage[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.triage[0]}` };
          const v = parseTriage(text);
          return 'error' in v ? v : { ok: { kind: 'triage', verdict: v.ok } };
        }
        case 'doc': {
          const text = await read(OUTPUT_FILES.doc[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.doc[0]}` };
          // 「对应计划：」那一行要对得上检出副本里的 plan.md（仓里没有就只要写清）
          const plan = await read(PLAN_DOC);
          const v = parseRequirementDoc(text, plan ?? undefined);
          return 'error' in v ? v : { ok: { kind: 'doc', markdown: v.ok } };
        }
        case 'plan': {
          const [md, json] = await Promise.all([read(OUTPUT_FILES.plan[0]), read(OUTPUT_FILES.plan[1])]);
          if (md === null || json === null) {
            return {
              error: `会话结束了，但没写 ${md === null ? OUTPUT_FILES.plan[0] : OUTPUT_FILES.plan[1]}`,
            };
          }
          const v = parsePlan(md, json);
          return 'error' in v
            ? v
            : { ok: { kind: 'plan', markdown: v.ok.markdown, subtasks: v.ok.subtasks } };
        }
        case 'review': {
          const text = await read(OUTPUT_FILES.review[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.review[0]}` };
          const v = parseReview(text, live.reviewHead ?? '');
          return 'error' in v ? v : { ok: { kind: 'review', review: v.ok } };
        }
        case 'delivery':
          return { error: '写码会话不读结论文件' };
      }
    } catch (error) {
      throw new PortError('READ_FAILED', `读会话交回来的结论文件没成：${errorText(error)}`, {
        retryable: true,
      });
    }
  }

  function costOfThisRun(live: Live, sessionCost: number | undefined): number | undefined {
    if (sessionCost === undefined || live.mode === 'fork') return undefined;
    if (live.mode !== 'resume') return sessionCost;
    if (live.previousCost === null || live.previousCost === undefined) return undefined;
    return Math.max(0, sessionCost - live.previousCost);
  }

  async function holdOrRelease(live: Live, end: SessionEnd): Promise<'ok' | 'fail' | 'neutral'> {
    if (end.outcome === 'done' || end.outcome === 'blocked') {
      // 这个池能跑通了（续会话的试探成了）：撤掉整池暂停。
      try {
        const held = await openAlertsByPrefix(db, poolHoldKey(live.poolId));
        if (held.some((a) => a.dedupeKey === poolHoldKey(live.poolId))) {
          await resolveAlertByKey(db, { dedupeKey: poolHoldKey(live.poolId), by: 'engine' });
        }
      } catch (error) {
        log('账号池的暂停没撤掉', { poolId: live.poolId, error: errorText(error) });
      }
      return 'ok';
    }
    if (end.outcome !== 'failed' || !end.failure) return 'neutral';
    const f = end.failure;
    let verdict: ReturnType<typeof classifyFailure>;
    try {
      verdict = classifyFailure({
        source: `session:${live.stage}`,
        stage: live.stage,
        poolId: live.poolId,
        routeId: live.routeId,
        hostId: 'claude-code',
        code: f.code,
        message: f.message,
        ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
        ...(f.exitCode === undefined ? {} : { exitCode: f.exitCode }),
        ...(f.signal === undefined ? {} : { signal: f.signal }),
        ...(f.transcriptTail ? { transcriptTail: f.transcriptTail } : {}),
        ...(f.resetsAt ? { resetsAt: f.resetsAt } : {}),
        machine: deps.machine,
        runAsUser: live.user,
        now: clock().toISOString(),
      });
    } catch (error) {
      log('失败分流判不了这次会话（按不算路由账记）', { runId: live.runId, error: errorText(error) });
      return 'neutral';
    }
    if (verdict.shared?.scope === 'pool' && verdict.shared.until === undefined) {
      // 要人修的整池问题：所有任务一起避开这个池，等人修好（或续会话的试探跑通）。
      try {
        await upsertAlert(db, {
          dedupeKey: poolHoldKey(live.poolId),
          level: 'decision',
          taskId: live.taskId,
          title: `账号池 ${live.poolId} 整池暂停：${verdict.title}`,
          body: [verdict.humanFix, verdict.reason].filter(Boolean).join('。'),
        });
      } catch (error) {
        log('账号池暂停没写进库（选路照样会派过去）', { poolId: live.poolId, error: errorText(error) });
      }
    }
    return verdict.routeOutcome;
  }

  async function endOf(live: Live, report: ClaudeCodeRunReport): Promise<SessionEnd> {
    const r = report.stream.result;
    const usage = {
      ...(r?.usage?.inputTokens === undefined ? {} : { inputTokens: r.usage.inputTokens }),
      ...(r?.usage?.outputTokens === undefined ? {} : { outputTokens: r.usage.outputTokens }),
    };
    const common = {
      sessionId: live.sessionId,
      usage,
      ...(r?.sessionCostUsd === undefined ? {} : { sessionCostUsd: r.sessionCostUsd }),
    };
    const notes = [
      live.writeError ? `进度事件没写进库：${live.writeError}` : '',
      live.dropped > 0 ? `丢了 ${live.dropped} 条进度事件` : '',
    ].filter(Boolean);
    const failed = (code: string, message: string): SessionEnd => {
      const exhausted = [...live.rateLimits].reverse().find((x) => x.exhausted);
      const resetsAt =
        exhausted?.resetsAt ?? exhausted?.windows.find((w) => w.name === exhausted.rateLimitType)?.resetsAt;
      return {
        ...common,
        outcome: 'failed',
        failure: {
          code,
          message: [message, ...notes].join('；'),
          ...(resetsAt ? { resetsAt } : {}),
          ...(r?.apiErrorStatus === undefined ? {} : { httpStatus: r.apiErrorStatus }),
          exitCode: report.exitCode,
          signal: report.signal,
          transcriptTail: live.says.slice(-6),
          machine: deps.machine,
          runAsUser: live.user,
        },
      };
    };

    if (live.stop?.kind === 'stop') return { ...common, outcome: 'stopped' };
    if (live.stop?.kind === 'stall') {
      return {
        ...common,
        outcome: 'stalled',
        failure: {
          code: 'SESSION_STALLED',
          message: `${live.stop.rule}：${live.stop.basis}`,
          retryable: true,
        },
      };
    }

    let progress: Awaited<ReturnType<typeof runProgressFacts>>;
    try {
      progress = await runProgressFacts(db, live.runId);
    } catch (error) {
      return failed('delivery_unknown', `会话交没交活没查成（读不到进度）：${errorText(error)}`);
    }
    const done = progress?.done ?? null;
    const blocked = progress?.blocked ?? null;
    if (blocked && (!done || blocked.at.getTime() > done.at.getTime())) {
      const needs = NEEDS.has(blocked.needs)
        ? (blocked.needs as 'human' | 'info' | 'access' | 'other')
        : 'other';
      return { ...common, outcome: 'blocked', blocked: { reason: blocked.reason || '会话说卡住了', needs } };
    }

    if (live.kind === 'delivery') {
      const delivery = await deliveryCheck(live);
      const verdict = judgeClaudeRun(report, delivery.check);
      if (verdict.outcome === 'stalled') {
        return {
          ...common,
          outcome: 'stalled',
          failure: { code: 'SESSION_STALLED', message: verdict.detail, retryable: true },
        };
      }
      if (verdict.outcome === 'stopped') return { ...common, outcome: 'stopped' };
      if (verdict.outcome !== 'ok') return failed(verdict.reason, verdict.detail);
      if (!done) {
        return failed('not_delivered', '会话结束了，但没用 fleet done 交活（也没用 fleet blocked 说卡在哪）');
      }
      if (!delivery.head) return failed('delivery_unknown', '读不到工作树的头');
      return {
        ...common,
        outcome: 'done',
        output: {
          kind: 'delivery',
          head: delivery.head,
          summary: done.summary,
          testsPassed: done.testsPassed === true,
          changedFiles: delivery.changed,
        },
      };
    }

    const verdict = judgeClaudeRun(report);
    if (verdict.outcome === 'stalled') {
      return {
        ...common,
        outcome: 'stalled',
        failure: { code: 'SESSION_STALLED', message: verdict.detail, retryable: true },
      };
    }
    if (verdict.outcome === 'stopped') return { ...common, outcome: 'stopped' };
    if (verdict.outcome !== 'ok') return failed(verdict.reason, verdict.detail);
    const output = await readOutput(live);
    if ('error' in output) return failed('wrong_output', output.error);
    return { ...common, outcome: 'done', output: output.ok };
  }

  async function awaitSession(input: AwaitSessionInput, ctx: Parameters<EnginePorts['awaitSession']>[1]) {
    const live = registry.get(input.runId);
    if (!live || live.sessionId !== input.sessionId) {
      // 接不上：工人重启过（会话的输出管道已经断了）。按记下的 scope 收掉旧会话，交回 SESSION_LOST，工作流续会话重起。
      const stored = await getSessionRun(db, input.runId);
      const user = asSessionUser(stored?.runAsUser);
      const handle = input.handle ?? stored?.handle ?? undefined;
      const reaped = await reapLost(input.runId, user, handle);
      const message = `接不上会话 ${input.sessionId}：引擎工人重启过，输出管道断了${reaped}`;
      if (stored && !stored.endedAt) {
        await finishSessionRun(db, {
          id: input.runId,
          outcome: 'failed',
          endedAt: clock(),
          failureCode: 'SESSION_LOST',
          failureMessage: message,
          routeOutcome: 'neutral',
        });
      }
      return {
        sessionId: input.sessionId,
        outcome: 'failed' as const,
        failure: {
          code: 'SESSION_LOST',
          message,
          retryable: true,
          machine: deps.machine,
          ...(user ? { runAsUser: user } : {}),
        },
      };
    }

    let nextStall = Date.now() + stallCheckMs;
    let settled = false;
    const ended = live.report.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, tickMs);
        }),
      ]);
      clearTimeout(timer);
      if (settled) break;
      if (ctx.signal.aborted) {
        // 活动被取消（工作流叫停）：会话由工作流收尾时按 runId 停，这里不替它做主。
        throw ctx.signal.reason ?? new Error('看守被取消');
      }
      ctx.heartbeat({ runId: live.runId, sessionId: live.sessionId });
      await flush(live);
      if (Date.now() >= nextStall) {
        nextStall = Date.now() + stallCheckMs;
        try {
          await checkStall(live);
        } catch (error) {
          log('停滞判断出错（这一轮不判）', { runId: live.runId, error: errorText(error) });
        }
      }
    }

    clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
    await flush(live);
    let end: SessionEnd;
    let report: ClaudeCodeRunReport | undefined;
    try {
      report = await live.report;
      end = await endOf(live, report);
    } catch (error) {
      end = {
        sessionId: live.sessionId,
        outcome: 'failed',
        failure: {
          code: error instanceof PortError ? error.code : 'LAUNCH_FAILED',
          message: errorText(error),
          machine: deps.machine,
          runAsUser: live.user,
        },
      };
    }
    registry.delete(live.runId);
    const routeOutcome = await holdOrRelease(live, end);
    const cost = costOfThisRun(live, end.sessionCostUsd);
    const contextTokens = report?.stream.lastContextTokens;
    const actualModel = report?.stream.observedModel;
    try {
      await finishSessionRun(db, {
        id: live.runId,
        outcome: OUTCOME[end.outcome],
        endedAt: clock(),
        sessionId: live.sessionId,
        ...(actualModel ? { actualModel } : {}),
        ...(end.usage?.inputTokens === undefined ? {} : { inputTokens: end.usage.inputTokens }),
        ...(end.usage?.outputTokens === undefined ? {} : { outputTokens: end.usage.outputTokens }),
        ...(cost === undefined ? {} : { costUsd: cost }),
        ...(end.sessionCostUsd === undefined ? {} : { sessionCostUsd: end.sessionCostUsd }),
        ...(end.failure ? { failureCode: end.failure.code, failureMessage: end.failure.message } : {}),
        routeOutcome,
        ...(contextTokens === undefined ? {} : { contextTokens }),
      });
    } catch (error) {
      log('会话结局没写进库（工作流记计时时会再写一次）', { runId: live.runId, error: errorText(error) });
    }
    if (live.quotaError) log('会话里读到的额度没记上', { poolId: live.poolId, error: live.quotaError });
    return end;
  }

  async function stopSession(input: Parameters<EnginePorts['stopSession']>[0]) {
    await requestSessionStop(db, { runId: input.runId, reason: input.reason });
    const live = registry.get(input.runId);
    if (live) {
      // 优雅停（停在干净的点）还没做：一律立刻停，工作树里已提交的不会丢。
      live.stop ??= { kind: 'stop', reason: input.reason };
      live.abort.abort();
      return;
    }
    // 不在这个工人进程里（工人重启过）：按记下的 scope 收。
    const stored = await getSessionRun(db, input.runId);
    const user = asSessionUser(stored?.runAsUser);
    if (!stored?.startedAt || !user) return;
    const error = await stopScope({ id: input.runId, user, ...helperOpts });
    if (error)
      throw new PortError('STOP_FAILED', `停会话 ${input.runId} 没成：${error}`, { retryable: true });
  }

  async function reapOrphanSessions(): Promise<number> {
    const listed = await listAgentScopes(helperOpts);
    if (!listed.ok) {
      throw new Error(`查不了上一轮留下的会话（fleet-agent-scope list）：${listed.detail}`);
    }
    let reaped = 0;
    for (const scope of listed.scopes) {
      if (scope.state === 'inactive') continue;
      // stop 只按编号收；用户只过帮手参数的校验。
      const error = await stopScope({ id: scope.id, user: SESSION_USERS[0], ...helperOpts });
      if (error) throw new Error(`收不掉上一轮留下的会话 ${scope.id}：${error}`);
      reaped += 1;
    }
    return reaped;
  }

  return { startSession, awaitSession, stopSession, reapOrphanSessions };
}

/** 选路那边认的前缀，从这里也导出一份：session 端口写、store 端口读，同一个常量。 */
export { POOL_HOLD_PREFIX };
