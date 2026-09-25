// 假实现：不碰真仓、真会话、真 GitHub，用来把流程跑通（测试、联调）。行为可以按剧本改。

import type { StageKind } from '@fleet-dao/shared';
import type { MergeOutcome, TestResult } from './decisions/merge.ts';
import type { PlannedSubtask } from './decisions/plan.ts';
import type { TriageVerdict } from './decisions/triage.ts';
import type { CiResult, ReviewResult, SyncResult } from './decisions/verify.ts';
import {
  type AskHumanInput,
  type EnginePorts,
  type LaunchSessionInput,
  type MergePrInput,
  type PickRouteInput,
  type PickRouteResult,
  type PortContext,
  PortError,
  type PortName,
  type PushBranchInput,
  type RaiseAlertInput,
  type RequestApprovalInput,
  type RouteChoice,
  type RunTestsInput,
  type SessionEnd,
  type SessionOutput,
  type StartSessionResult,
  type SyncMainlineInput,
  type TaskStateSnapshot,
  type TimingEntry,
  type WaitCiInput,
} from './ports.ts';

export interface FakeSessionPlan {
  outcome?: 'done' | 'failed' | 'stalled' | 'blocked';
  failure?: { code: string; message?: string; retryable?: boolean };
  blocked?: { reason?: string; question?: string; options?: string[] };
  /** 会话挂着不结束，直到 release()、stopSession 或取消。 */
  hold?: boolean;
  /** 第一次看守不心跳也不返回（模拟工人进程没了），重试的那次接上。 */
  loseFirstWatch?: boolean;
  output?: SessionOutput;
}

export interface FakeScript {
  plan: PlannedSubtask[];
  triage: (n: number) => TriageVerdict;
  /** n = 这个阶段第几次起会话（从 1 开始）。 */
  session: (input: LaunchSessionInput, n: number) => FakeSessionPlan | undefined;
  review: (input: LaunchSessionInput, n: number) => Omit<ReviewResult, 'head'> | undefined;
  ci: (input: WaitCiInput, n: number) => Partial<CiResult> | undefined;
  sync: (input: SyncMainlineInput, n: number) => Partial<SyncResult> | undefined;
  tests: (input: RunTestsInput, n: number) => Partial<TestResult> | undefined;
  merge: (input: MergePrInput, n: number) => Partial<MergeOutcome> | undefined;
  /** 推分支：给了就抛它（假的卫生检查拦下、名单没读到……）；n = 第几次推（从 1 开始）。 */
  push: (input: PushBranchInput, n: number) => PortError | undefined;
  route: (input: PickRouteInput, n: number) => PickRouteResult | undefined;
  /** 前 N 次调用抛可重试的 TRANSIENT。 */
  failFirst: Partial<Record<PortName, number>>;
  /** 前 N 次调用做完了再抛可重试的 TRANSIENT（事办成了、回话丢了：重试时考的是幂等）。 */
  failAfter: Partial<Record<PortName, number>>;
  /** 每次调用先等这么久（测串行、并发用）。 */
  delayMs: Partial<Record<PortName, number>>;
  /** 这几个端口的调用挂着不返回，直到 releasePort（要控制先后时用它，别赌延时够不够长）。 */
  holdPorts: PortName[];
  heartbeatMs: number;
  routes: RouteChoice[];
}

export interface FakeCall {
  port: PortName;
  input: unknown;
  attempt: number;
  at: number;
  end: number | null;
  ok: boolean | null;
}

export interface FakeSession {
  id: string;
  runId: string;
  stage: StageKind;
  input: LaunchSessionInput;
  plan: FakeSessionPlan;
  n: number;
  released: boolean;
  stopped: boolean;
  watching: boolean;
}

export interface FakeWorld {
  ports: EnginePorts;
  calls: FakeCall[];
  timings: TimingEntry[];
  /** 写进「库」的任务状态，按写入顺序。 */
  states: TaskStateSnapshot[];
  sessions: Map<string, FakeSession>;
  /** 真起了进程的 runId，每起一次记一次（同一个 runId 出现两次 = 起了两个会话）。 */
  spawned: string[];
  /** 发出去的提问卡片（按 askId 去重后的）。 */
  asks: AskHumanInput[];
  /** 发出去的批准卡片（按 approvalId 去重后的）。 */
  approvals: RequestApprovalInput[];
  /** 报过的警（按调用顺序，含重复的 dedupeKey）。 */
  alerts: RaiseAlertInput[];
  callsOf<P extends PortName>(port: P): (FakeCall & { input: Parameters<EnginePorts[P]>[0] })[];
  count(port: PortName): number;
  /** 放行一个挂着的会话。 */
  release(sessionId: string): void;
  /** 放行 holdPorts 挂着的那个端口（挂着的和以后的调用都不再挂）。 */
  releasePort(port: PortName): void;
  /** 正挂着、有人在看守的会话。 */
  held(): FakeSession[];
}

export const FAKE_ROUTES: readonly RouteChoice[] = [
  { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  { routeId: 'r2', poolId: 'p2', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  { routeId: 'r3', poolId: 'p3', modelId: 'm2', family: 'kimi', hostId: 'api-shell' },
];

const DOC_FILE = { requirement: '需求.md', plan: '方案.md', result: '结果.md' } as const;

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve());
  });
}

export function createFakeWorld(script: Partial<FakeScript> = {}): FakeWorld {
  const calls: FakeCall[] = [];
  const timings: TimingEntry[] = [];
  const states: TaskStateSnapshot[] = [];
  const sessions = new Map<string, FakeSession>();
  const spawned: string[] = [];
  const asks: AskHumanInput[] = [];
  const approvals: RequestApprovalInput[] = [];
  const alerts: RaiseAlertInput[] = [];
  /** 和真实现一样按 runId 幂等：起过的原样返回，叫停过的不再起。 */
  const byRun = new Map<string, StartSessionResult>();
  const stoppedRuns = new Set<string>();
  const heldPorts = new Set<PortName>(script.holdPorts ?? []);
  const counters = new Map<string, number>();
  const prByBranch = new Map<string, number>();
  const heartbeatMs = script.heartbeatMs ?? 50;
  const routes = script.routes ?? [...FAKE_ROUTES];
  let seq = 0;
  const next = (key: string) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return n;
  };

  const outputFor = (s: FakeSession): SessionOutput => {
    if (s.plan.output) return s.plan.output;
    const brief = s.input.brief;
    switch (s.stage) {
      case 'triage':
        return {
          kind: 'triage',
          verdict: script.triage?.(s.n) ?? { clear: true, summary: `理解为：${brief.title}` },
        };
      case 'spec':
        return { kind: 'doc', markdown: `# 需求：${brief.title}\n\n${brief.request}\n` };
      case 'plan':
        return {
          kind: 'plan',
          markdown: `# 方案：${brief.title}\n`,
          subtasks: script.plan ?? [{ key: 'main', title: brief.title, touches: ['src'] }],
        };
      case 'review': {
        const review = script.review?.(s.input, s.n) ?? { verdict: 'pass', findings: [] };
        return { kind: 'review', review: { ...review, head: brief.head ?? '' } };
      }
      default:
        seq += 1;
        return {
          kind: 'delivery',
          head: `${s.input.subtaskKey ?? 'x'}-${seq}`,
          summary: `做完：${brief.title}`,
          testsPassed: true,
          // 老老实实改方案点名的地方。
          changedFiles: brief.touches.map((t) => (t === '*' ? 'README.md' : `${t}/changed.ts`)),
        };
    }
  };

  /** 和真执行体一样：token 报这一次的，花费报会话累计的（同一个会话每跑一次加 1 分钱）。 */
  const costTotals = new Map<string, number>();
  const usageOf = (sessionId: string) => {
    const sessionCostUsd = Math.round(((costTotals.get(sessionId) ?? 0) + 0.01) * 100) / 100;
    costTotals.set(sessionId, sessionCostUsd);
    return { usage: { inputTokens: 100, outputTokens: 10 }, sessionCostUsd };
  };

  const endFor = (s: FakeSession): SessionEnd => {
    const spent = usageOf(s.id);
    if (s.stopped) return { sessionId: s.id, outcome: 'stopped', ...spent };
    const outcome = s.plan.outcome ?? 'done';
    if (outcome === 'done') return { sessionId: s.id, outcome, output: outputFor(s), ...spent };
    if (outcome === 'blocked') {
      return {
        sessionId: s.id,
        outcome,
        ...spent,
        blocked: {
          reason: s.plan.blocked?.reason ?? '需要人回答',
          needs: 'human',
          ...(s.plan.blocked?.question ? { question: s.plan.blocked.question } : {}),
          ...(s.plan.blocked?.options ? { options: s.plan.blocked.options } : {}),
        },
      };
    }
    const failure = s.plan.failure ?? { code: outcome === 'stalled' ? 'SESSION_STALLED' : 'SESSION_FAILED' };
    return {
      sessionId: s.id,
      outcome,
      ...spent,
      failure: {
        code: failure.code,
        message: failure.message ?? `假会话${outcome === 'stalled' ? '没动静' : '失败'}`,
        ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      },
    };
  };

  const impl: EnginePorts = {
    async pickRoute(input) {
      const scripted = script.route?.(input, next('pickRoute'));
      if (scripted) return scripted;
      const usable = routes.filter(
        (r) =>
          !input.avoidRouteIds.includes(r.routeId) &&
          !input.avoidPoolIds.includes(r.poolId) &&
          !input.avoidModelIds.includes(r.modelId),
      );
      const preferred = input.preferRouteId
        ? usable.find((r) => r.routeId === input.preferRouteId)
        : undefined;
      // 续同一个会话：还是那一条（和真选路一样，避开的照样不派）。
      const stuck = input.stickRouteId ? usable.find((r) => r.routeId === input.stickRouteId) : undefined;
      const route = preferred ?? stuck ?? usable[0];
      if (!route) return { ok: false, waitFor: 'none', detail: '能用的路由都被避开了' };
      return {
        ok: true,
        route,
        why: preferred ? '点名的路由' : stuck ? '续同一个会话' : '排第一的可用路由',
      };
    },
    async startSession(input) {
      const known = byRun.get(input.runId);
      if (known) return known;
      if (stoppedRuns.has(input.runId)) {
        throw new PortError('SESSION_STOPPED', `会话 ${input.runId} 已经叫停，不再起`, { retryable: false });
      }
      const n = next(`session:${input.stage}`);
      const id = input.resumeSessionId ?? `s${next('sessionId')}`;
      sessions.set(id, {
        id,
        runId: input.runId,
        stage: input.stage,
        input,
        plan: script.session?.(input, n) ?? {},
        n,
        released: false,
        stopped: false,
        watching: false,
      });
      spawned.push(input.runId);
      const started: StartSessionResult = {
        sessionId: id,
        resumed: Boolean(input.resumeSessionId),
        handle: { pid: 40_000 + next('pid'), scope: `fleet-agent-${input.runId}.scope` },
      };
      byRun.set(input.runId, started);
      return started;
    },
    async awaitSession(input, ctx) {
      const s = sessions.get(input.sessionId);
      if (!s || s.runId !== input.runId) {
        throw new PortError('SESSION_LOST', `接不上会话 ${input.sessionId}`, { retryable: false });
      }
      if (s.plan.loseFirstWatch && ctx.attempt === 1) {
        // 工人「没了」：不心跳、不返回，直到这个进程里的工人关掉。
        await aborted(ctx.signal);
        throw new Error('看守随工人一起没了');
      }
      s.watching = true;
      try {
        while (s.plan.hold && !s.released && !s.stopped && !ctx.signal.aborted) {
          ctx.heartbeat({ sessionId: s.id });
          await pause(heartbeatMs, ctx.signal);
        }
      } finally {
        s.watching = false;
      }
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('取消');
      return endFor(s);
    },
    async stopSession(input) {
      stoppedRuns.add(input.runId);
      const started = byRun.get(input.runId);
      const s = started ? sessions.get(started.sessionId) : undefined;
      if (s && s.runId === input.runId) s.stopped = true;
    },
    async createWorktree(input) {
      return {
        path: `/fake/worktrees/${input.taskId}/${input.subtaskKey ?? 'main'}`,
        branch: input.branch,
        baseSha: 'base',
      };
    },
    async removeWorktree(input) {
      return {
        removed: true,
        gone: false,
        ...(input.archive
          ? { archivedTo: `/fake/archive/${input.taskId}/${input.subtaskKey ?? 'main'}` }
          : {}),
      };
    },
    async pushBranch(input) {
      const refused = script.push?.(input, next('pushBranch'));
      if (refused) throw refused;
      return { head: input.head };
    },
    async runTests(input) {
      return { passed: true, head: input.head, summary: '全绿', ...script.tests?.(input, next('runTests')) };
    },
    async openPr(input) {
      let pr = prByBranch.get(input.branch);
      if (pr === undefined) {
        pr = 100 + prByBranch.size;
        prByBranch.set(input.branch, pr);
      }
      return { prNumber: pr };
    },
    async waitCi(input) {
      return { state: 'green', head: input.head, failedChecks: [], ...script.ci?.(input, next('waitCi')) };
    },
    async syncMainline(input) {
      return {
        state: 'clean',
        head: input.head,
        conflictFiles: [],
        ...script.sync?.(input, next('syncMainline')),
      };
    },
    async mergePr(input) {
      const n = next('mergePr');
      return { merged: true, mergeCommit: `mc-${input.prNumber}-${n}`, ...script.merge?.(input, n) };
    },
    async updateIssueProgress() {},
    async saveTaskState(input) {
      states.push(input);
    },
    async closeIssue() {},
    async writeSpecDoc(input) {
      return { path: `${input.specDir}/${DOC_FILE[input.doc]}` };
    },
    async askHuman(input) {
      if (!asks.some((a) => a.askId === input.askId)) asks.push(input);
    },
    async requestApproval(input) {
      if (!approvals.some((a) => a.approvalId === input.approvalId)) approvals.push(input);
    },
    async raiseAlert(input) {
      alerts.push(input);
      return { alertId: `alert-${next('alert')}` };
    },
    async recordTiming(input) {
      timings.push(input);
    },
  };

  const ports = {} as Record<PortName, (input: unknown, ctx: PortContext) => Promise<unknown>>;
  for (const name of Object.keys(impl) as PortName[]) {
    const fn = impl[name] as (input: unknown, ctx: PortContext) => Promise<unknown>;
    ports[name] = async (input, ctx) => {
      const call: FakeCall = { port: name, input, attempt: ctx.attempt, at: Date.now(), end: null, ok: null };
      calls.push(call);
      try {
        while (heldPorts.has(name) && !ctx.signal.aborted) await pause(heartbeatMs, ctx.signal);
        const delay = script.delayMs?.[name] ?? 0;
        if (delay > 0) await pause(delay, ctx.signal);
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('取消');
        const failures = script.failFirst?.[name] ?? 0;
        if (failures > 0 && calls.filter((c) => c.port === name).length <= failures) {
          throw new PortError('TRANSIENT', `${name} 假失败`, { retryable: true });
        }
        const out = await fn(input, ctx);
        const lostReplies = script.failAfter?.[name] ?? 0;
        if (lostReplies > 0 && calls.filter((c) => c.port === name).length <= lostReplies) {
          throw new PortError('TRANSIENT', `${name} 做完了、回话丢了（假）`, { retryable: true });
        }
        call.ok = true;
        return out;
      } catch (error) {
        call.ok = false;
        throw error;
      } finally {
        call.end = Date.now();
      }
    };
  }

  return {
    ports: ports as unknown as EnginePorts,
    calls,
    timings,
    states,
    sessions,
    spawned,
    asks,
    approvals,
    alerts,
    callsOf: (<P extends PortName>(port: P) => calls.filter((c) => c.port === port)) as FakeWorld['callsOf'],
    count: (port) => calls.filter((c) => c.port === port).length,
    release(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.released = true;
    },
    releasePort(port) {
      heldPorts.delete(port);
    },
    held: () => [...sessions.values()].filter((s) => s.plan.hold && !s.released && !s.stopped && s.watching),
  };
}
