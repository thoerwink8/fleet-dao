// 派工器：把指挥官的 spawn_worker 请求变成跑着的工人，交回先机械核验再记进指挥官的收件箱。
// 一条线：收请求（intake.ts）→ 领活 → 发工人令牌 → 起工人（心跳续租，被取消或丢租约就叫停）→ 撤令牌 →
// 核验（verify.ts）→ 记 handback.recorded → 完成或退避重试。
// 重试只给“确定没有副作用”的失败（进程没起来、起步无进展、影子自检没过）；做到一半死了的结局不知道，记 unknown 就停，不盲重派。
import {
  appendToSession,
  issueToken,
  readSessionByTask,
  readSessionByType,
  revokeToken,
} from '@fleet-dao/harness-api';
import {
  BUDGETS,
  type Budget,
  BudgetTooLongError,
  makeRedactor,
  type Redactor,
  StopReason,
  secretsFromEnv,
} from '@fleet-dao/harness-runner';
import {
  claimJobs,
  completeJob,
  type Db,
  heartbeat,
  type Job,
  LostClaimError,
  readStream,
  retryJob,
} from '@fleet-dao/harness-store';
import {
  type ClaudePermissionMode,
  ForbiddenEnvError,
  type McpEndpoint,
  runClaudeWorker,
  type ShadowProbes,
  ShadowSelfCheckError,
  type WorkerTurnResult,
} from '@fleet-dao/harness-workers';
import { z } from 'zod';
import {
  type DispatchPayload,
  intakeSpawnRequests,
  intakeStopRequests,
  registerWorkerQueue,
  WORKER_QUEUE,
} from './intake.ts';
import { buildWorkerPrompt, SpawnRequest } from './prompt.ts';
import { type VerifyReport, verifyHandback } from './verify.ts';

/** 工人的工作环境，由部署决定怎么建（克隆、worktree）；核验就在这里面做。 */
export interface Workspace {
  cwd: string;
  /** 工人开工时的基线提交。 */
  baseRef: string;
  allowedPaths?: readonly string[];
  forbiddenPaths?: readonly string[];
  /** 检查命令（argv）。 */
  checkCommand?: readonly string[];
  /** 终局交回记完、收尾之前调（影子拿它抓补丁）；失败进 onError，不改交回、不挡收尾。 */
  collect?(handback: { verdict: VerifyReport['verdict']; wallMs: number }): Promise<void>;
  /** 记完交回后调；失败不影响结果。 */
  cleanup?(): Promise<void>;
}

export interface DispatcherOptions {
  db: Db;
  /** 工人连回来的 MCP 地址（不带令牌）；令牌每个工人现发。 */
  mcpUrl: string;
  /** 执行体命令前缀：生产是 reclaude；测试换假执行体。 */
  command: readonly string[];
  model: string;
  permissionMode: ClaudePermissionMode;
  prepareWorkspace(req: SpawnRequest, ctx: { runId: string; sessionId: string }): Promise<Workspace>;
  shadow?: ShadowProbes;
  hostEnv?: Readonly<Record<string, string | undefined>>;
  extraEnv?: Readonly<Record<string, string>>;
  tmpRoot?: string;
  workerBudget?: Budget;
  /** 同时在跑的工人数，默认 1（影子期的规矩）。 */
  maxInflight?: number;
  perMinute?: number;
  /** 活的租约，默认 60 秒；心跳间隔默认租约的三分之一。 */
  leaseMs?: number;
  heartbeatMs?: number;
  /** 给核验和记账留的时间，从活的截止时刻往前扣。默认 15 分钟。 */
  verifyReserveMs?: number;
  retryBackoffMs?: number;
  maxAttempts?: number;
  jobTtlMs?: number;
  pageSize?: number;
  checkTimeoutMs?: number;
  onError?(err: unknown, job?: Job): void;
}

export type OutcomeKind =
  | 'completed'
  | 'killed'
  | 'failed-to-start'
  | 'cancelled'
  | 'uncertain'
  | 'retry'
  | 'lost'
  | 'already-recorded'
  | 'error';

export interface JobOutcome {
  jobKey: string;
  taskId?: string;
  runId?: string;
  outcome: OutcomeKind;
  verdict?: VerifyReport['verdict'];
  /** 这条交回是不是终局；false 是还会重试。 */
  final: boolean;
  error?: string;
}

const Payload = z.object({
  sessionId: z.string().min(1),
  eventId: z.number().int().positive(),
  taskId: z.string().min(1),
  request: SpawnRequest,
});

/** 递归脱敏：事件表里不许有密钥（H1）。 */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T;
  }
  return value;
}

interface Lease {
  stop(): void;
  readonly state: 'ok' | 'cancelled' | 'lost';
}

/** 续租：每隔 everyMs 一次心跳；回 cancelled 或 lost 就叫停；库连不上超过一个租约时长也按丢了算（租约反正已经过了）。 */
function startLease(
  db: Db,
  job: Job,
  leaseMs: number,
  everyMs: number,
  onStop: (state: 'cancelled' | 'lost') => void,
): Lease {
  let state: 'ok' | 'cancelled' | 'lost' = 'ok';
  let stopped = false;
  let lastOk = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const beat = async () => {
    if (stopped) return;
    try {
      const r = await heartbeat(db, job, leaseMs);
      if (r === 'ok') lastOk = Date.now();
      else {
        state = r;
        onStop(r);
        return;
      }
    } catch {
      if (Date.now() - lastOk > leaseMs) {
        state = 'lost';
        onStop('lost');
        return;
      }
    }
    if (!stopped) timer = setTimeout(beat, everyMs);
  };
  timer = setTimeout(beat, everyMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    get state() {
      return state;
    },
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Dispatcher {
  readonly #o: DispatcherOptions;
  readonly #inflight = new Set<AbortController>();
  readonly #running = new Set<Promise<void>>();
  #outcomes: JobOutcome[] = [];
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: DispatcherOptions) {
    this.#o = options;
  }

  /** 登记队列限速（没登记 claimJobs 不让领）。启动时调一次。 */
  async init(): Promise<void> {
    await registerWorkerQueue(this.#o.db, this.#o.maxInflight ?? 1, this.#o.perMinute ?? 6);
  }

  /** 一轮：收新请求和叫停、领活并在后台开跑。不等工人跑完（叫停要在工人跑着时也能收到）。回领到几件。 */
  async poll(): Promise<number> {
    const { db } = this.#o;
    const intake = {
      ...(this.#o.pageSize ? { pageSize: this.#o.pageSize } : {}),
      ...(this.#o.maxAttempts ? { maxAttempts: this.#o.maxAttempts } : {}),
      ...(this.#o.jobTtlMs ? { jobTtlMs: this.#o.jobTtlMs } : {}),
    };
    await intakeSpawnRequests(db, intake);
    await intakeStopRequests(db, this.#o.pageSize ? { pageSize: this.#o.pageSize } : {});
    if (this.#stopped) return 0;
    const free = (this.#o.maxInflight ?? 1) - this.#running.size;
    if (free <= 0) return 0;
    // 调度器直接收成 dead 的活（排队时过了截止、领到上限的毒活）不经 processJob：同一个事务里记终局交回，
    // 指挥官收件箱里不会少一件
    const redact = makeRedactor(secretsFromEnv(this.#o.hostEnv ?? process.env));
    const jobs = await claimJobs(db, WORKER_QUEUE, free, this.#o.leaseMs ?? 60_000, {
      onDead: async (tx, dead) => {
        for (const d of dead) {
          const parsed = Payload.safeParse(d.payload);
          if (!parsed.success) continue;
          const { sessionId, taskId } = parsed.data as unknown as DispatchPayload;
          await appendToSession(
            tx,
            sessionId,
            'handback.recorded',
            redactDeep(
              {
                jobKey: d.key,
                taskId,
                attempt: d.attempts,
                final: true,
                outcome: 'dead',
                verdict: 'unknown',
                reasons: [d.lastError ?? '调度器收成了 dead'],
              },
              redact,
            ),
          );
        }
      },
    });
    for (const job of jobs) {
      const p: Promise<void> = this.processJob(job)
        .then((o) => {
          this.#outcomes.push(o);
        })
        .catch((err: unknown) => {
          this.#o.onError?.(err, job);
          this.#outcomes.push({ jobKey: job.key, outcome: 'error', final: false, error: errMsg(err) });
        })
        .finally(() => {
          this.#running.delete(p);
        });
      this.#running.add(p);
    }
    return jobs.length;
  }

  /** 等在跑的都收尾，回这段时间里各件活的结局。 */
  async settled(): Promise<JobOutcome[]> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
    const out = this.#outcomes;
    this.#outcomes = [];
    return out;
  }

  start(intervalMs = 2_000): void {
    this.#stopped = false;
    const loop = async () => {
      if (this.#stopped) return;
      try {
        await this.poll();
      } catch (err) {
        this.#o.onError?.(err);
      }
      if (!this.#stopped) this.#timer = setTimeout(loop, intervalMs);
    };
    this.#timer = setTimeout(loop, 0);
  }

  /** 停机：不再领新活，在跑的工人叫停（release-pause），等它们收尾。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    for (const ac of this.#inflight) ac.abort(new StopReason('release-pause', '派工器停机'));
    await this.settled();
  }

  async #finish(job: Job): Promise<void> {
    try {
      await completeJob(this.#o.db, job);
    } catch (err) {
      if (!(err instanceof LostClaimError)) throw err;
    }
  }

  async #record(sessionId: string, payload: Record<string, unknown>, redact: Redactor): Promise<void> {
    await appendToSession(this.#o.db, sessionId, 'handback.recorded', redactDeep(payload, redact));
  }

  async processJob(job: Job): Promise<JobOutcome> {
    const o = this.#o;
    const { db } = o;
    const parsed = Payload.safeParse(job.payload);
    if (!parsed.success) throw new Error(`活 ${job.key} 的载荷不合契约：${parsed.error.message}`);
    const { sessionId, eventId, taskId, request } = parsed.data as unknown as DispatchPayload;
    const host = o.hostEnv ?? process.env;
    const runId = `d${eventId}-a${job.attempts}`;
    const ids = { jobKey: job.key, taskId, runId };
    const baseRedact = makeRedactor(secretsFromEnv(host));

    // 1. 已经有终局交回了（记完、没来得及完成活就崩了）：只补完成，不再起工人
    const recorded = (await readSessionByTask(db, sessionId, taskId)).filter(
      (e) => e.type === 'handback.recorded',
    );
    if (recorded.some((e) => e.payload.final === true)) {
      await this.#finish(job);
      return { ...ids, outcome: 'already-recorded', final: true };
    }
    // 2. 上一次领取起过工人却没留下交回：工人做到哪一步不知道，记 unknown 就停（不盲重派）
    if (job.attempts > 1) {
      const prev = `d${eventId}-a${job.attempts - 1}`;
      const spawned = (await readStream(db, `worker:${prev}`, 0, 1)).length > 0;
      if (spawned && !recorded.some((e) => e.payload.runId === prev)) {
        await this.#record(
          sessionId,
          {
            taskId,
            runId: prev,
            attempt: job.attempts - 1,
            final: true,
            outcome: 'uncertain',
            verdict: 'unknown',
            reasons: [
              '上一次领取起了工人却没留下交回记录（派工器多半在中途死了），工人做到哪一步不知道，不重派',
            ],
            evidence: {},
          },
          baseRedact,
        );
        await this.#finish(job);
        return { ...ids, runId: prev, outcome: 'uncertain', verdict: 'unknown', final: true };
      }
    }

    // 3. 起工人
    const token = await issueToken(db, `worker-${runId}`, 'worker');
    const redact = makeRedactor([token.token, ...secretsFromEnv(host)]);
    const mcp: McpEndpoint = { url: o.mcpUrl, token: token.token };
    const ac = new AbortController();
    this.#inflight.add(ac);
    const leaseMs = o.leaseMs ?? 60_000;
    const lease = startLease(
      db,
      job,
      leaseMs,
      o.heartbeatMs ?? Math.max(1_000, Math.floor(leaseMs / 3)),
      (s) => {
        ac.abort(
          s === 'cancelled'
            ? new StopReason('user-stop', '活被取消（指挥官叫停）')
            : new StopReason('lease-lost', '活的租约丢了'),
        );
      },
    );
    let ws: Workspace | undefined;
    let turn: WorkerTurnResult | undefined;
    let error: Error | undefined;
    let phase: 'prepare' | 'run' = 'prepare';
    try {
      try {
        ws = await o.prepareWorkspace(request, { runId, sessionId });
        phase = 'run';
        const parentDeadline = job.deadlineAt
          ? new Date(job.deadlineAt.getTime() - (o.verifyReserveMs ?? 15 * 60_000))
          : undefined;
        turn = await runClaudeWorker({
          db,
          runId,
          command: o.command,
          model: o.model,
          permissionMode: o.permissionMode,
          prompt: buildWorkerPrompt(request),
          cwd: ws.cwd,
          mcp,
          budget: o.workerBudget ?? BUDGETS.workerTurn,
          hostEnv: host,
          signal: ac.signal,
          ...(parentDeadline ? { parentDeadline } : {}),
          ...(o.shadow ? { shadow: o.shadow } : {}),
          ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}),
          ...(o.tmpRoot ? { tmpRoot: o.tmpRoot } : {}),
        });
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      } finally {
        await revokeToken(db, token.tokenId);
      }

      if (lease.state === 'lost') return { ...ids, outcome: 'lost', final: false };

      // 4. 归类：确定没副作用的失败可以重试，其余记下来就停
      const result = turn?.result;
      const noEffect =
        error instanceof ShadowSelfCheckError ||
        (error !== undefined && phase === 'prepare') ||
        Boolean(result?.spawnError) ||
        result?.killed?.reason === 'no_progress';
      const deterministic = error instanceof BudgetTooLongError || error instanceof ForbiddenEnvError;
      const workerClean = Boolean(result && result.exitCode === 0 && !result.killed && !result.spawnError);

      let report: VerifyReport | null = null;
      if (result && ws && !noEffect) {
        report = await verifyHandback({
          cwd: ws.cwd,
          baseRef: ws.baseRef,
          workerClean,
          redact,
          hostEnv: host,
          ...(ws.allowedPaths ? { allowedPaths: ws.allowedPaths } : {}),
          ...(ws.forbiddenPaths ? { forbiddenPaths: ws.forbiddenPaths } : {}),
          ...(ws.checkCommand ? { checkCommand: ws.checkCommand } : {}),
          ...(o.checkTimeoutMs ? { checkTimeoutMs: o.checkTimeoutMs } : {}),
          signal: ac.signal,
        });
      }

      let outcome: OutcomeKind;
      let verdict: VerifyReport['verdict'];
      let reasons: string[];
      if (error) {
        const failedClean = noEffect || deterministic;
        outcome = failedClean ? 'failed-to-start' : 'uncertain';
        verdict = failedClean ? 'failed' : 'unknown';
        reasons = [
          failedClean ? `没起来：${errMsg(error)}` : `起工人的过程中出错，结局不明：${errMsg(error)}`,
        ];
      } else if (result?.spawnError) {
        outcome = 'failed-to-start';
        verdict = 'failed';
        reasons = [`进程没起来：${result.spawnError}`];
      } else if (result?.killed) {
        outcome = lease.state === 'cancelled' ? 'cancelled' : 'killed';
        verdict = report?.verdict ?? 'failed';
        reasons = [`被停：${result.killed.reason}（${result.killed.detail}）`, ...(report?.reasons ?? [])];
      } else {
        outcome = 'completed';
        verdict = report?.verdict ?? 'unknown';
        reasons = report?.reasons ?? ['没有核验报告'];
      }

      const willRetry =
        noEffect &&
        !deterministic &&
        lease.state === 'ok' &&
        !ac.signal.aborted &&
        job.attempts < job.maxAttempts;
      const selfReport = turn
        ? (await readSessionByType(db, `worker-${runId}`, 'worker.result.submitted', 0, 1))[0]?.payload
        : undefined;

      await this.#record(
        sessionId,
        {
          taskId,
          runId,
          attempt: job.attempts,
          final: !willRetry,
          willRetry,
          outcome,
          verdict,
          reasons,
          workerSessionId: turn?.sessionId ?? null,
          evidence: {
            worker: result
              ? {
                  exitCode: result.exitCode,
                  signal: result.signal,
                  killed: result.killed ?? null,
                  lastStep: result.lastStep,
                  wallMs: result.wallMs,
                  firstProgressMs: result.firstProgressMs ?? null,
                  stragglers: result.stragglers,
                  leftovers: result.leftovers ?? null,
                  spawnError: result.spawnError ?? null,
                  stderrTail: result.stderrTail.slice(-1024),
                }
              : null,
            // 工人自己交的话，只当参考，不参与判定
            selfReport: selfReport
              ? {
                  status: selfReport.status,
                  summary: String(selfReport.summary ?? '').slice(0, 2000),
                }
              : null,
            verify: report,
          },
        },
        redact,
      );

      if (willRetry) {
        const backoff = (o.retryBackoffMs ?? 30_000) * 2 ** (job.attempts - 1);
        try {
          await retryJob(db, job, `重试：${reasons[0] ?? ''}`.slice(0, 500), backoff);
        } catch (err) {
          if (!(err instanceof LostClaimError)) throw err;
        }
        return { ...ids, outcome: 'retry', verdict, final: false };
      }
      if (ws?.collect) {
        try {
          await ws.collect({ verdict, wallMs: result?.wallMs ?? 0 });
        } catch (err) {
          o.onError?.(err, job);
        }
      }
      await this.#finish(job);
      return { ...ids, outcome, verdict, final: true };
    } finally {
      lease.stop();
      this.#inflight.delete(ac);
      await ws?.cleanup?.().catch(() => {});
    }
  }
}
