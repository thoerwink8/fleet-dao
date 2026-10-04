// 起一次无头会话的真实进程——起、看守、收 stdout、记退出码、到点 kill。
//
// 关键约束（specs/509-需求梳理/流程重做方案.md；本切片强制）：
// 1. **不许续会话**：不接 resume / fork / session 接手参数。传进来直接抛。
// 2. **不许超时**：默认 60 分钟，到点 SIGKILL（先 SIGTERM 给 5 秒收尾），outcome='timeout'。
// 3. **不跑测试**：新起的进程不接 lastSessionTest 之类的依赖；测试移到 PR 上由 554-2 那一片做。
// 4. **不保留 .fleet-out/ 进度事件**：那是 Fusion 会话 io 的形状；本切片只认 stdout / stderr / exit code 三样。
// 5. **起前做内存准入**：沿用 real/memory-admission.ts；放不下**不派**（明确失败，不鲁式化）。
// 6. **stdout / stderr 落盘** `_tmp/<runId>/`：会话结束 24h 后由现有 _tmp 清理机制收（见引擎现有架子）。
// 7. **开跑先在 runs 留一行没结束的**（#157）：切号数带组织类型的池上在跑的会话靠这一行，写不进去就不起会话
//    （RUN_START_FAILED）。留了这一行之后的每条出路（跑完、超时、被杀、起不来）都要把它收掉——收不掉的行切号会一直当它在跑。
// 8. **切号叫停（deps.stop，#59）**：信号响了，还没起会话的不起、起了的被杀，结局记 org_switch（不是 killed、不算失败），
//    任务工作流切完在原分支上重跑这一段。叫停之后会话自己跑完了（done）照样算 done；没跑完的一律算 org_switch——是我们停的。
// 9. **记到谁名下（#216）**：单子（taskId、单号）、派工档、工作流编号、PR、分支开跑那一行和收场那一笔带同一份（runFields）；
//    收场是整行覆盖，两处不一样就把开跑写的冲掉。取值对不上 runs 的约束（派工档不在三档里、对题验收带了档……）一进来就报
//    BAD_RUN_INPUT：不起会话、一行不写。
// 10. **收场那一笔带上算不算路由的账（#758）**：每条出路都经 recordRun，由 evidence.ts 的 routeOutcomeOf 判（和失败分流同一份
//    证据），选路的熔断、战绩靠它看见三段的会话。
// 11. **开跑那一行就是占上池的名额（#757）**：选路时预占的名额（reservationId）交给 runs.start，同一下换成这一行；没预占着、
//    池又满了，start 抛 NoSlotError，这里报 NO_SLOT、不起会话（不是库写不进，别当成 RUN_START_FAILED）。没开跑就收场的那几条路
//    （内存放不下、切号停下）不碰预占：内存放不下的调用方隔一会儿再来，名额还给它占着；放不放由调用方收场时定。
//
// **Spawner 依赖注入**：真实的生产 spawn 走 `real/exec.ts` 那一份 `fleet-agent-scope`；测试里换 fake——
// 不调真进程，不调 sudo，不调 systemd，不写 /sys/fs/cgroup。本机 Windows / macOS 上跑也是 fake。

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SLICE_MEMORY_HIGH_MB } from '../limits.ts';
import type { MemoryAdmissionDeps } from '../real/memory-admission.ts';
import { AGENT_SLICE_PATH, admitSessionMemory, CGROUP_ROOT } from '../real/memory-admission.ts';
import type { AnyBrief } from './brief.ts';
import { routeOutcomeOf } from './evidence.ts';
import { NoSlotError, type RunRecord, type RunStart, RunStartSchema, type RunsWriter } from './not-wired.ts';
import type { Tier } from './tier.ts';

/** 默认会话总时限（分钟）。不调传。 */
export const DEFAULT_TIMEOUT_MINUTES = 60;
/** 把 stdout / stderr 落盘到 tmpDir 下的子目录名。 */
export function runDirOf(tmpDir: string, runId: string): string {
  return join(tmpDir, runId);
}

/** 起一次无头进程的全部入参。Spawner 不感知模型 / 路由——挑模型是更高一层（554-3）的事。 */
export interface OneShotInput {
  /** 调用方给的 runId；同一 runId 不能再起（由 #556 真实 RunsWriter 幂等去重）。 */
  runId?: string;
  /** 哪一段：scope | manual | verify。 */
  segment: 'scope' | 'manual' | 'verify';
  /** 挑好的模型 id（上游挑好传进来）。 */
  modelId: string;
  /** 渠道（poolId / routeId 的渠道段）；读不到不给。 */
  channel?: string;
  /** 需求单号；不属于任何需求的可空。 */
  issueNumber?: number;
  /** 库里的 tasks.id：这一笔记到哪张单名下（#216）；不属于任何需求的不给。 */
  taskId?: string;
  /** 派工档（只有动手段有，tier.ts 的三档）：只记账，起会话看的是 effort。 */
  tier?: Tier;
  /** 跑在哪条 Temporal 工作流里（任务工作流：taskWorkflowId）；不在工作流里跑的不给。 */
  workflowId?: string;
  /** 这一段对着的 PR；还没开 PR 的不给。 */
  prNumber?: number;
  /** 会话干活的分支。 */
  branch?: string;
  /** 喂给会话的那段文字（brief 渲染好的）。 */
  prompt: string;
  /** 工作目录（会话 cwd）。 */
  cwd: string;
  /** 超时（分钟），默认 DEFAULT_TIMEOUT_MINUTES。 */
  timeoutMinutes?: number;
  /** 不许给：resume / session 接手。给了当场抛。 */
  resumeSessionId?: string;
  /**
   * 路由编号：生产 Spawner（real/segment-spawner.ts）据此在库里查执行方式、会话用户、上游模型串；
   * 测试里的假 Spawner 不看。modelId 只是记账和提示用，真正起谁看这个。
   */
  routeId?: string;
  /** 思考档位（按改动面分档给的，tier.ts 的 effort）；不给用执行方式自己的默认。 */
  effort?: string;
  /** 选路时给这一段预占的池的名额（#757，pool_reservations 的编号）：开跑那一行写进去时换成这一行。不经选路的不给。 */
  reservationId?: string;
}

export const ONE_SHOT_OUTCOMES = [
  'done',
  'timeout',
  'killed',
  'spawn_failed',
  'admission_blocked',
  'failed',
  'org_switch',
] as const;
export type OneShotOutcome = (typeof ONE_SHOT_OUTCOMES)[number];

export interface OneShotResult {
  runId: string;
  outcome: OneShotOutcome;
  /** null 表示进程被 kill / 没起成。 */
  exitCode: number | null;
  /** 完整 stdout（同时落盘到 `_tmp/<runId>/stdout.txt`）。 */
  stdout: string;
  /** 末尾一段 stderr（最多 4 KiB；落盘的是完整版）。 */
  stderrTail: string;
  startedAt: string;
  endedAt: string;
  /** 取消原因，outcome != 'done' 时给。 */
  failureReason?: string;
  runsNotWired: boolean;
  /** Spawner 带回来的执行体事实（用量、花费、额度……）；没带就没有。 */
  facts?: SpawnFacts;
}

/**
 * 起进程的最小接口——fake（测试）和真实（生产接 fleet-agent-scope）共用这一个形状。
 * 实现要么 resolve 出 SpawnOutcome，要么抛 SpawnError（起不来）。
 */
export interface SpawnOutcome {
  /** null = 被 kill / 超时被终 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 是不是我们自己的 watch 把进程杀了。 */
  killed: boolean;
  /** 执行体自己报的东西（用量、花费、实际模型、额度）。读不到的字段不给，不当成 0；假 Spawner 可以不给。 */
  facts?: SpawnFacts;
}

/** 一次无头会话跑完，执行体那一侧能读到的事实。失败分流按 reason、quotaExhausted、resetsAt、httpStatus 认。 */
export interface SpawnFacts {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** 执行体自报的本轮花费（美元）。 */
  costUsd?: number;
  /** 实际回话的模型（只写观测值）。 */
  actualModel?: string;
  quotaExhausted?: boolean;
  /** 额度用满时上游给的清零时刻。 */
  resetsAt?: string;
  /** 上游的 HTTP 状态码。 */
  httpStatus?: number;
  /** 判定原因码（adapters 的 judgeRun：quota_exhausted、model_mismatch、no_result……）；成功是 delivered / answered。 */
  reason?: string;
  /** 一句白话。 */
  detail?: string;
  /** 执行体报的原话（认证、额度、网络报错只在 stderr 的那几家）。 */
  rawError?: string;
}

export interface SpawnCommand {
  argv: string[];
  cwd: string;
  stdin: string;
  /** 调用方给的 AbortSignal：调用方想取消时触发。 */
  signal: AbortSignal;
  /** 这一次的全部入参（生产 Spawner 要里面的 routeId、effort、runId、modelId）。 */
  input: OneShotInput & { runId: string };
  /** 这一次的时限（毫秒）：Spawner 自己的看守要比它晚到，让这里的 signal 先触发。 */
  timeoutMs: number;
}
export type OneShotSpawner = (cmd: SpawnCommand) => Promise<SpawnOutcome>;

/** 装配 one-shot 的依赖。所有 IO 都依赖注入——测试不用碰真机器。 */
export interface OneShotDeps {
  spawn: OneShotSpawner;
  /**
   * 拼装 argv 的回调：调用方知道哪个执行体怎么起。不给＝由 Spawner 自己按 routeId 定怎么起（生产：real/segment-spawner.ts），
   * 传给它的 argv 是空的。
   */
  buildCommand?: (input: OneShotInput) => { argv: string[]; cwd?: string };
  memoryAdmission?: MemoryAdmissionDeps;
  /** stdout / stderr 落盘的根目录；默认 `_tmp`。 */
  tmpDir?: string;
  /** runs 占位（#556 换上真实现）。不在 deps 里就不记（不鲁式化）。 */
  runs: RunsWriter;
  now?: () => Date;
  /**
   * 切号叫停（#59，real/one-shot-sessions.ts 的登记交回的信号；signal.reason 的 message 写为什么停）：响了就不起会话、
   * 起了的杀掉，结局 org_switch。不给 = 切号停不下这一段。
   */
  stop?: AbortSignal;
}

/** 子进程结束 24h 后清落盘目录：调用方起 setTimeout / 调度器干；本文件只负责标「该清」。 */
export const SESSION_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export class OneShotError extends Error {
  /**
   * RUN_START_FAILED：开跑那一行写不进 runs，会话没起（库一时不通，过一会儿再来就行）。
   * NO_SLOT：开跑时池的名额满了（选路时预占的名额过期了、或没预占，#757），会话没起、一行没写；过一会儿重新选路就行。
   * BAD_RUN_INPUT：记到谁名下的字段对不上 runs 的约束，会话没起、一行没写；是调用方的毛病，重试没用。
   */
  readonly code:
    | 'RESUME_FORBIDDEN'
    | 'ADMISSION_BLOCKED'
    | 'SPAWN_FAILED'
    | 'RUN_START_FAILED'
    | 'NO_SLOT'
    | 'BAD_RUN_INPUT';
  constructor(code: OneShotError['code'], message: string) {
    super(message);
    this.name = 'OneShotError';
    this.code = code;
  }
}

/** 起一次无头会话。返回一次性结果；成败判定在 verdict.ts。 */
export async function runOneShot(input: OneShotInput, deps: OneShotDeps): Promise<OneShotResult> {
  if (input.resumeSessionId !== undefined && input.resumeSessionId !== '') {
    throw new OneShotError(
      'RESUME_FORBIDDEN',
      'one-shot 不许续会话（#554）：拿到 resumeSessionId，把这条从上游改掉再来。',
    );
  }
  const runId = input.runId ?? randomUUID();
  const startedAt = (deps.now ?? (() => new Date()))().toISOString();
  // 先照 runs 的约束对一遍再干别的：对不上的写进库会被拒，拖到开跑那一行才发现就成了 RUN_START_FAILED（被当成库一时不通、
  // 可以重试）；内存放不下、切号停下那几条路也会记一笔，所以要在它们前面
  const opening = runFields(input, runId, startedAt);
  const checked = RunStartSchema.safeParse(opening);
  if (!checked.success) {
    throw new OneShotError(
      'BAD_RUN_INPUT',
      `记账的字段对不上 runs 的约束，没起会话、一行没写：${checked.error.issues
        .map((i) => `${i.path.join('.') || '整行'}：${i.message}`)
        .join('；')}`,
    );
  }
  const timeoutMs = (input.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60 * 1000;
  const halted = (stop: AbortSignal, where: string): OneShotResult => ({
    runId,
    outcome: 'org_switch',
    exitCode: null,
    stdout: '',
    stderrTail: '',
    startedAt,
    endedAt: (deps.now ?? (() => new Date()))().toISOString(),
    failureReason: switchReason(stop, where),
    runsNotWired: false,
  });

  // 切号已经叫停了（调用方等内存时叫停的也在这儿收）：先于内存准入看——放在准入后面，内存一直放不下时
  // 这一段会一直回 admission_blocked、调用方一直等，切号等它收场等到超时。
  if (deps.stop?.aborted) {
    const result = halted(deps.stop, '还没起会话');
    await recordRun(input, result, deps.runs);
    return result;
  }

  // 内存准入（沿用 real/memory-admission.ts）：本机（没挂载）会 skip，放了 block 才拦。
  if (deps.memoryAdmission !== undefined) {
    const verdict = await admitSessionMemory(deps.memoryAdmission);
    if (verdict.kind === 'wait') {
      const blocked: OneShotResult = {
        runId,
        outcome: 'admission_blocked',
        exitCode: null,
        stdout: '',
        stderrTail: '',
        startedAt,
        endedAt: (deps.now ?? (() => new Date()))().toISOString(),
        failureReason: verdict.detail,
        runsNotWired: false,
      };
      await recordRun(input, blocked, deps.runs);
      return blocked;
    }
    if (verdict.kind === 'readError') {
      throw new OneShotError('SPAWN_FAILED', `内存准入没查成（不能装放下、也不能装跳过）：${verdict.detail}`);
    }
  }

  const { argv, cwd } = deps.buildCommand?.(input) ?? { argv: [] };
  const tmpDir = deps.tmpDir ?? '_tmp';
  const runDir = runDirOf(tmpDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'brief.txt'), input.prompt, 'utf8');

  // 查内存、建落盘目录那会儿叫停的：同样不起会话，记一笔 org_switch（没起也有账）
  if (deps.stop?.aborted) {
    const result = halted(deps.stop, '还没起会话');
    await settle(runDir, input, result, deps.runs);
    return result;
  }

  // 开跑：先留一行没结束的。写不进去不起会话——起了就是一个切号看不见的会话（切号会把它当场掐断）。
  try {
    if (input.reservationId === undefined) await deps.runs.start(opening);
    else await deps.runs.start(opening, { reservationId: input.reservationId });
  } catch (err) {
    if (err instanceof NoSlotError) {
      throw new OneShotError('NO_SLOT', `池的名额满了，没起会话：${err.message}`);
    }
    throw new OneShotError(
      'RUN_START_FAILED',
      `开跑那一行写不进 runs，没起会话（不然切号看不见它在跑）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ac = new AbortController();
  const killTimer = setTimeout(() => ac.abort(new Error('one-shot timeout')), timeoutMs);
  // 切号停的（超时先到的算超时）
  const switched = () => deps.stop?.aborted === true && !ac.signal.aborted;
  let spawnResult: SpawnOutcome;
  try {
    spawnResult = await deps.spawn({
      argv,
      cwd: cwd ?? input.cwd,
      stdin: input.prompt,
      signal: deps.stop ? AbortSignal.any([ac.signal, deps.stop]) : ac.signal,
      input: { ...input, runId },
      timeoutMs,
    });
  } catch (err) {
    clearTimeout(killTimer);
    const reason = err instanceof Error ? err.message : String(err);
    if (switched() && deps.stop) {
      const result: OneShotResult = { ...halted(deps.stop, '会话被停下'), stderrTail: reason.slice(-4096) };
      await settle(runDir, input, result, deps.runs);
      return result;
    }
    if (ac.signal.aborted) {
      // 我们 kill 的：明确 timeout。
      const result: OneShotResult = {
        runId,
        outcome: 'timeout',
        exitCode: null,
        stdout: '',
        stderrTail: reason.slice(-4096),
        startedAt,
        endedAt: (deps.now ?? (() => new Date()))().toISOString(),
        failureReason: `超过 ${input.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES} 分钟，按规矩 kill（#554 不许拿超过 N 分钟）`,
        runsNotWired: false,
      };
      await settle(runDir, input, result, deps.runs);
      return result;
    }
    // 起不来：开跑那一行收成 spawn_failed（不留一行没结束的），再照旧抛
    const failed: OneShotResult = {
      runId,
      outcome: 'spawn_failed',
      exitCode: null,
      stdout: '',
      stderrTail: reason.slice(-4096),
      startedAt,
      endedAt: (deps.now ?? (() => new Date()))().toISOString(),
      failureReason: `起子进程没起成：${reason}`,
      runsNotWired: false,
    };
    try {
      await recordRun(input, failed, deps.runs);
    } catch (recordErr) {
      throw new OneShotError(
        'SPAWN_FAILED',
        `起子进程没起成：${reason}；开跑那一行也没收上（${recordErr instanceof Error ? recordErr.message : String(recordErr)}）`,
      );
    }
    throw new OneShotError('SPAWN_FAILED', `起子进程没起成：${reason}`);
  }
  clearTimeout(killTimer);

  const endedAt = (deps.now ?? (() => new Date()))().toISOString();
  const ended: OneShotOutcome = spawnResult.killed
    ? ac.signal.aborted
      ? 'timeout'
      : 'killed'
    : spawnResult.exitCode === 0
      ? 'done'
      : 'failed';
  // 叫停之后没跑完的（被杀、杀的时候报了别的错）都是我们停的；赶在叫停前跑完了的照样是 done
  const outcome: OneShotOutcome = ended !== 'done' && switched() ? 'org_switch' : ended;
  const result: OneShotResult = {
    runId,
    outcome,
    exitCode: spawnResult.exitCode,
    stdout: spawnResult.stdout,
    stderrTail: spawnResult.stderr.slice(-4096),
    startedAt,
    endedAt,
    ...(outcome === 'org_switch' && deps.stop
      ? { failureReason: switchReason(deps.stop, '会话被停下') }
      : outcome !== 'done'
        ? {
            failureReason: `exit=${String(spawnResult.exitCode)} killed=${String(spawnResult.killed)}`,
          }
        : {}),
    runsNotWired: false,
    ...(spawnResult.facts !== undefined ? { facts: spawnResult.facts } : {}),
  };
  await settle(runDir, input, result, deps.runs);
  return result;
}

/** 切号停下的原因：叫停信号带的那句（real/one-shot-sessions.ts 写的「切号：…」），没带就写停在哪一步。 */
function switchReason(stop: AbortSignal, where: string): string {
  const why = stop.reason instanceof Error ? stop.reason.message : stop.reason ? String(stop.reason) : '';
  return why.trim() ? `${why}（${where}）` : `切号叫停（${where}）`;
}

/** 收场：落盘和补完开跑那一行两样都做（一样没成不耽误另一样），没成的照抛。 */
async function settle(runDir: string, input: OneShotInput, result: OneShotResult, runs: RunsWriter) {
  const [recorded, persisted] = await Promise.allSettled([
    recordRun(input, result, runs),
    persistArtifacts(runDir, result),
  ]);
  if (recorded.status === 'rejected') throw recorded.reason;
  if (persisted.status === 'rejected') throw persisted.reason;
}

async function persistArtifacts(runDir: string, result: OneShotResult): Promise<void> {
  // prompt 在 run 起的时候已经写过；这里写 stdout / stderr / verdict 元数据。
  await writeFile(join(runDir, 'stdout.txt'), result.stdout, 'utf8');
  await writeFile(join(runDir, 'stderr.txt'), result.stderrTail, 'utf8');
  const meta = {
    runId: result.runId,
    outcome: result.outcome,
    exitCode: result.exitCode,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    failureReason: result.failureReason,
    /** 落盘 TTL：调用方该在这之后清理。 */
    cleanupAfter: SESSION_ARTIFACT_TTL_MS,
  };
  await writeFile(join(runDir, 'result.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * 开跑那一行和收场那一笔共有的列：哪一段、哪个模型和路由、记到谁名下（单子、派工档、工作流、PR、分支）。
 * 收场那一笔整行覆盖开跑那一行（db 的 startRun 按编号整行写），两处必须用这同一份，漏一样就把开跑写的冲成空。
 * 没给的不写：不拿 0、空串顶。
 */
function runFields(input: OneShotInput, runId: string, startedAt: string): RunStart {
  return {
    runId,
    segment: input.segment,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
    model: input.modelId,
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.routeId !== undefined ? { routeId: input.routeId } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    startedAt,
  };
}

/** 记一笔 runs（占位还是真实现由装配方定）。 */
async function recordRun(input: OneShotInput, result: OneShotResult, runs: RunsWriter): Promise<void> {
  const record: RunRecord = {
    ...runFields(input, result.runId, result.startedAt),
    endedAt: result.endedAt,
    // 一次性会话的结局和 runs 的结局是同一份（ONE_SHOT_OUTCOMES、RunRecord.outcome、库里 runs_outcome_known）
    outcome: result.outcome,
    routeOutcome: routeOutcomeOf(result, input.segment),
    ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
    ...usageFields(result.facts),
  };
  await runs.record(record);
}

/** 执行体读到的用量和花费记进这一笔；读不到的字段不写，不当成 0（#216）。 */
function usageFields(facts: SpawnFacts | undefined): Partial<RunRecord> {
  if (!facts) return {};
  const u = facts.usage;
  return {
    ...(u?.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u?.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u?.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(u?.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
    ...(facts.costUsd !== undefined ? { costUsd: facts.costUsd } : {}),
  };
}

/** 生产装配：沿用 real/memory-admission.ts 的真实现。打包到一起方便 main.ts 用。 */
export function productionMemoryAdmission(overrides: Partial<MemoryAdmissionDeps> = {}): MemoryAdmissionDeps {
  return {
    readText: (path) => import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')),
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    sliceHighMb: SLICE_MEMORY_HIGH_MB,
    reservePerSessionMb: 2048,
    ...overrides,
  };
}

/** 类型导出方便外部用 brief 的类型参数。 */
export type { AnyBrief };
