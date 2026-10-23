// 起一次无头会话的真实进程——起、看守、收 stdout、记退出码、到点 kill。
//
// 关键约束（specs/509-需求梳理/流程重做方案.md；本切片强制）：
// 1. **续会话按入参**：给了 resumeSessionId 就交给 Spawner 续那个会话（--resume 一类，决定 0088），不给开新会话。
//    续不续、续哪个由调用方（任务工作流经 planSegmentResume）定；这里不判，只原样交下去。没有 fork。
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
// 12. **脱开引擎跑（input.detach，#2238，动手段和一家验的冷验收给（#2848））**：Spawner 交回 detached（引擎要走了、会话没停）就抛 OneShotDetached，
//    开跑那一行不收、不落盘——会话还在跑，下一个引擎带上 attach（原来的 runId、起的时刻）再调一次接回：不过内存准入、不再开跑，
//    时限只剩原来的减去已经跑掉的，结局照常记到原来那一行。
//
// **Spawner 依赖注入**：真实的生产 spawn 走 `real/exec.ts` 那一份 `fleet-agent-scope`；测试里换 fake——
// 不调真进程，不调 sudo，不调 systemd，不写 /sys/fs/cgroup。本机 Windows / macOS 上跑也是 fake。

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact, StopReason, type TranscriptEntry } from '@fleet-dao/adapters';
import { clipCauseSummary, type RunCause, sessionlessUsage } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { MemoryAdmissionDeps } from '../real/memory-admission.ts';
import { admitSessionMemory } from '../real/memory-admission.ts';
import type { ScopeOomEvidence } from '../real/scope-oom-evidence.ts';
import type { AnyBrief } from './brief.ts';
import { routeOutcomeOf } from './evidence.ts';
import { NoSlotError, type RunRecord, type RunStart, RunStartSchema, type RunsWriter } from './not-wired.ts';
import type { Tier } from './tier.ts';

/** 默认会话总时限（分钟）。不调传。 */
export const DEFAULT_TIMEOUT_MINUTES = 60;
/** 记进 runs.failure_reason 的报错尾巴最多多少字（脱敏之后按字符留末尾）。 */
export const SESSION_ERROR_TAIL_MAX = 600;

/**
 * 会话报错的尾巴：先脱敏（令牌、邮箱、长串），再留下末尾最多 600 字。
 * redact 超长时会在前面加一个省略号，这里再按 600 字截掉，保证不超过。空串就是没有尾巴。
 */
export function sessionErrorTail(text: string): string {
  const cleaned = redact(text, SESSION_ERROR_TAIL_MAX);
  return cleaned.length > SESSION_ERROR_TAIL_MAX ? cleaned.slice(-SESSION_ERROR_TAIL_MAX) : cleaned;
}

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
  /** 当前活动 SDK execution；本机会话不给。 */
  temporalRunId?: string;
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
  /** 续哪个会话（决定 0088）：给了交给 Spawner 续它，不给开新会话。空串当没给。 */
  resumeSessionId?: string;
  /**
   * 续会话判定为新会话时的原因。新写法直接给这个字段（#3140）；老历史里的活动入参还借 route.why 的内部标记
   * （fleet-resume-new:…）带它，下面 runFields 仍认，只为在途任务重放。
   */
  resumeReason?: string;
  /** 为什么起这一笔（#3140，shared 的 RunCause）和起因摘要、所属回合（task_rounds.seq）：记进 runs。不经任务工作流的不给。 */
  cause?: RunCause;
  causeSummary?: string;
  roundSeq?: number;
  /**
   * 路由编号：生产 Spawner（real/segment-spawner.ts）据此在库里查执行方式、会话用户、上游模型串；
   * 测试里的假 Spawner 不看。modelId 只是记账和提示用，真正起谁看这个。
   */
  routeId?: string;
  /** 思考档位（按改动面分档给的，tier.ts 的 effort）；不给用执行方式自己的默认。 */
  effort?: string;
  /** 选路时给这一段预占的池的名额（#757，pool_reservations 的编号）：开跑那一行写进去时换成这一行。不经选路的不给。 */
  reservationId?: string;
  /** 选路那句「为什么派它」（写进 runs.route_why）。不经选路的不给。 */
  routeWhy?: string;
  /**
   * 交给 Spawner 的脱开引擎跑的那一套（#2238，SpawnCommand.detach 原样交下去）：动手段和一家验的冷验收给（#2848）。给了，引擎要走时 Spawner 交回
   * detached，这里抛 OneShotDetached（开跑那一行不收、不落盘）。attach 时 runId 必给。
   */
  detach?: { attach?: { startedAt: string } };
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
  /**
   * 引擎要走了、会话没停（#2238）：Spawner 放手，会话接着在自己的 scope 里跑，下一个引擎从收发目录接回。给了就没有结局，
   * 其余字段不作数。
   */
  detached?: { at: string };
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
  /**
   * 执行体报的会话号（只写真号，不写起会话前的临时号）：记进 runs.session_id。经 Mirasim 起的会话结束时用量多半还没回填，
   * 「用量补记」凭它按会话补读（#1935）。
   */
  sessionId?: string;
  /** 执行体没有报真会话号时的具体原因，写进 runs.usage_note，避免空号看起来像没跑。 */
  sessionIdWhy?: string;
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
  /** 会话 scope 的内存峰值（MB，整数，real/memory-peak.ts 采的 cgroup memory.peak）；没读到不给，不当成 0（#948）。 */
  memoryPeakMb?: number;
  /** 没读到内存峰值的原因（白话）：进日志和落盘的 result.json，runs 那一列留空（#948）。 */
  memoryPeakWhy?: string;
  /** 这一次会话的 CPU 秒数（cpu.stat 的 usage_usec 向上取整）。没读到不给，不当成 0（#1980）。 */
  cpuSeconds?: number;
  /**
   * 用量没照终帧读到时，记的是怎么来的、缺的为什么读不到（白话）：写进 runs.usage_note。会话被叫停、超时杀时各家插头给
   * （real/hosts.ts），四样都照终帧读到了不给。
   */
  usageWhy?: string;
  /** 没读到 CPU 秒数的原因（白话）：进日志和落盘的 result.json，runs 那一列留空。 */
  cpuWhy?: string;
  /**
   * 会话 scope 自己的内存事件见证（real/scope-oom-evidence.ts，#3448）：只落 result.json，不进 runs 列、stderr、failureReason。
   * 证明「这个 scope 里有没有 OOM 事件」，不证明主进程被谁终止。
   */
  scopeOom?: ScopeOomEvidence;
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
  /**
   * 续哪个会话（--resume）：runOneShot 照入参的 resumeSessionId 给（动手段续上一段，决定 0088）；指挥官会话
   * （real/intake-chat.ts，#2061）直接调 Spawner 时也给。不给 = 开新会话。
   */
  resumeSessionId?: string;
  /** 会话过程每一条（指挥官会话流式推给页面用）：按流里的先后给，抛了只记日志、不影响会话。 */
  onTranscript?: (entry: TranscriptEntry) => void;
  /**
   * 脱开引擎跑（#2238，动手段和一家验的冷验收给，#2848）：执行方式支持的（命令行那几家，和 Mirasim：#2815），会话输入输出走收发目录（Mirasim 只放交接单）、引擎要走时放手
   * （交回 detached）；attach = 接回上一个引擎放手的那个会话，不起进程。
   * detachable 在定了「脱开跑」、交给驱动之前调：发布排空不再等它、不再停它。
   */
  detach?: { attach?: boolean; detachable?: () => void };
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
  readonly code: 'ADMISSION_BLOCKED' | 'SPAWN_FAILED' | 'RUN_START_FAILED' | 'NO_SLOT' | 'BAD_RUN_INPUT';
  constructor(code: OneShotError['code'], message: string) {
    super(message);
    this.name = 'OneShotError';
    this.code = code;
  }
}

/**
 * 引擎要走了，脱开跑的会话被放手（#2238）：没有结局，开跑那一行还开着（会话还在跑），下一个引擎带上 runId、startedAt 接回。
 */
export class OneShotDetached extends Error {
  readonly runId: string;
  readonly startedAt: string;
  constructor(runId: string, startedAt: string) {
    super(`引擎要走了：会话 ${runId} 脱开引擎接着跑，下一个引擎从收发目录接回`);
    this.name = 'OneShotDetached';
    this.runId = runId;
    this.startedAt = startedAt;
  }
}

/** 起一次无头会话。返回一次性结果；成败判定在 verdict.ts。 */
export async function runOneShot(input: OneShotInput, deps: OneShotDeps): Promise<OneShotResult> {
  const runId = input.runId ?? randomUUID();
  const attach = input.detach?.attach;
  if (attach && input.runId === undefined) {
    throw new OneShotError('BAD_RUN_INPUT', '接回会话要给原来那一次的 runId，没起会话、一行没写');
  }
  if (attach) {
    if (!deps.runs.readSource) {
      throw new OneShotError('BAD_RUN_INPUT', '接回会话无法读取原 runs 来源，没接会话、一行没写');
    }
    const source = await deps.runs.readSource(runId);
    if (!source) {
      throw new OneShotError('BAD_RUN_INPUT', `接回会话缺少原 runs 行（${runId}），没接会话、一行没写`);
    }
    // attach 属于原会话，不能把接回活动的 execution/workflow 混进首次来源（含历史 NULL）。
    const { workflowId: _workflow, temporalRunId: _execution, ...rest } = input;
    input = {
      ...rest,
      ...(source.workflowId !== null ? { workflowId: source.workflowId } : {}),
      ...(source.temporalRunId !== null ? { temporalRunId: source.temporalRunId } : {}),
    };
  }
  // 接回（#2238）：起的时刻照原来那一行，总时长照原来的起点算
  const startedAt = attach?.startedAt ?? (deps.now ?? (() => new Date()))().toISOString();
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

  // 接回（#2238）：会话已经在跑、开跑那一行已经在（上一个引擎写的），不再过内存准入、不再开跑；切号这时叫停了照样接上再停
  // （信号一开始就是响的，驱动接回时当场收 scope），结局照下面的规矩记 org_switch
  if (!attach) {
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
        throw new OneShotError(
          'SPAWN_FAILED',
          `内存准入没查成（不能装放下、也不能装跳过）：${verdict.detail}`,
        );
      }
    }
  }

  const { argv, cwd } = deps.buildCommand?.(input) ?? { argv: [] };
  const tmpDir = deps.tmpDir ?? '_tmp';
  const runDir = runDirOf(tmpDir, runId);
  await mkdir(runDir, { recursive: true });
  if (!attach) await writeFile(join(runDir, 'brief.txt'), input.prompt, 'utf8');

  if (!attach) {
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
        `开跑那一行写不进 runs，没起会话（不然切号看不见它在跑）：${errMessage(err)}`,
      );
    }
  }

  const ac = new AbortController();
  // 接回的只剩原来的时限减去已经跑掉的（到了就当场按超时收）
  const killAfterMs = attach
    ? Math.max(0, timeoutMs - ((deps.now ?? (() => new Date()))().getTime() - Date.parse(startedAt)))
    : timeoutMs;
  const killTimer = setTimeout(() => ac.abort(new StopReason('wall-clock', 'one-shot timeout')), killAfterMs);
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
      ...(input.resumeSessionId?.trim() ? { resumeSessionId: input.resumeSessionId.trim() } : {}),
      ...(input.detach ? { detach: { attach: attach !== undefined } } : {}),
    });
  } catch (err) {
    clearTimeout(killTimer);
    const reason = errMessage(err);
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
        `起子进程没起成：${reason}；开跑那一行也没收上（${errMessage(recordErr)}）`,
      );
    }
    throw new OneShotError('SPAWN_FAILED', `起子进程没起成：${reason}`);
  }
  clearTimeout(killTimer);
  // 引擎要走了、会话脱开接着跑（#2238）：没有结局，开跑那一行不收、不落盘，交回编号和起的时刻给下一个引擎接回
  if (spawnResult.detached) throw new OneShotDetached(runId, startedAt);

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
        ? { failureReason: failureWithTail(spawnResult.exitCode, spawnResult.killed, spawnResult.stderr) }
        : {}),
    runsNotWired: false,
    ...(spawnResult.facts !== undefined ? { facts: spawnResult.facts } : {}),
  };
  await settle(runDir, input, result, deps.runs);
  return result;
}

/** 会话没跑成：退出码和是不是被杀，后面接上脱敏后的报错尾巴。没有尾巴就只留前半句。 */
function failureWithTail(exitCode: number | null, killed: boolean, stderr: string): string {
  const base = `exit=${String(exitCode)} killed=${String(killed)}`;
  const tail = sessionErrorTail(stderr);
  return tail === '' ? base : `${base}；${tail}`;
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
    // 内存峰值（#948）：读到的数，或没读到的原因（runs 那一列没数时在这里看得到为什么）
    memoryPeakMb: result.facts?.memoryPeakMb,
    memoryPeakWhy: result.facts?.memoryPeakWhy,
    cpuSeconds: result.facts?.cpuSeconds,
    cpuWhy: result.facts?.cpuWhy,
    scopeOom: result.facts?.scopeOom,
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
  const marked = resumeMarkerOf(input.routeWhy);
  const routeWhy = marked?.routeWhy ?? input.routeWhy;
  return {
    runId,
    segment: input.segment,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
    model: input.modelId,
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.routeId !== undefined ? { routeId: input.routeId } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(routeWhy?.trim() ? { routeWhy: routeWhy.trim() } : {}),
    ...(input.resumeSessionId?.trim() ? { resumeSessionId: input.resumeSessionId.trim() } : {}),
    ...(input.resumeReason?.trim() || marked?.reason
      ? { resumeReason: input.resumeReason?.trim() ?? marked?.reason }
      : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
    ...(input.causeSummary?.trim() ? { causeSummary: clipCauseSummary(input.causeSummary) } : {}),
    ...(input.roundSeq !== undefined ? { roundSeq: input.roundSeq } : {}),
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
    ...(input.temporalRunId !== undefined ? { temporalRunId: input.temporalRunId } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.cwd ? { worktreePath: input.cwd } : {}),
    startedAt,
  };
}

const RESUME_NEW_MARKER = 'fleet-resume-new:';

function resumeMarkerOf(routeWhy: string | undefined): { reason: string; routeWhy?: string } | undefined {
  if (!routeWhy?.startsWith(RESUME_NEW_MARKER)) return undefined;
  try {
    const parsed = JSON.parse(routeWhy.slice(RESUME_NEW_MARKER.length)) as {
      reason?: unknown;
      routeWhy?: unknown;
    };
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return undefined;
    return {
      reason: parsed.reason.trim(),
      ...(typeof parsed.routeWhy === 'string' && parsed.routeWhy.trim() ? { routeWhy: parsed.routeWhy } : {}),
    };
  } catch {
    return undefined;
  }
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
    ...usageFields(result),
  };
  await runs.record(record);
}

/** 大于 0 的整数秒才记；0 和认不出的不写，免得整笔记账被拒。 */
function isCpuSeconds(v: number | undefined): v is number {
  return v !== undefined && Number.isSafeInteger(v) && v > 0;
}

/**
 * 执行体读到的用量和花费记进这一笔；读不到的字段不写，不当成 0（#216）。
 * 例外（#2689）：确定没发出模型调用的（总开关关、内存不够、起会话失败）四样和花费记 0，并写原因。
 * 没有会话号、又读不准起没起的，数留空，usage_note 写「会话号没拿到，用量读不到」。
 */
function usageFields(result: OneShotResult): Partial<RunRecord> {
  const facts = result.facts;
  const u = facts?.usage;
  const recorded: Partial<RunRecord> = facts
    ? {
        ...(u?.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
        ...(u?.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
        ...(u?.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
        ...(u?.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
        ...(facts.costUsd !== undefined ? { costUsd: facts.costUsd } : {}),
        ...(facts.memoryPeakMb !== undefined ? { memoryPeakMb: facts.memoryPeakMb } : {}),
        ...(isCpuSeconds(facts.cpuSeconds) ? { cpuSeconds: facts.cpuSeconds } : {}),
        ...(facts.sessionId !== undefined ? { sessionId: facts.sessionId } : {}),
        ...(() => {
          const notes = [facts.usageWhy, facts.sessionIdWhy].filter((note): note is string =>
            Boolean(note?.trim()),
          );
          return notes.length > 0 ? { usageNote: notes.join('；') } : {};
        })(),
      }
    : {};
  const decision = sessionlessUsage({
    outcome: result.outcome,
    ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
    hasSessionId: facts?.sessionId !== undefined,
    hasUsageWhy: Boolean(facts?.usageWhy?.trim() || facts?.sessionIdWhy?.trim()),
    hasToken:
      u?.inputTokens !== undefined ||
      u?.outputTokens !== undefined ||
      u?.cacheReadTokens !== undefined ||
      u?.cacheWriteTokens !== undefined,
  });
  if (decision.kind === 'leave') return recorded;
  if (decision.kind === 'zero') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      usageNote: decision.note,
      ...(recorded.memoryPeakMb !== undefined ? { memoryPeakMb: recorded.memoryPeakMb } : {}),
      ...(recorded.cpuSeconds !== undefined ? { cpuSeconds: recorded.cpuSeconds } : {}),
    };
  }
  return { ...recorded, usageNote: decision.note };
}

/** 类型导出方便外部用 brief 的类型参数。 */
export type { AnyBrief };
