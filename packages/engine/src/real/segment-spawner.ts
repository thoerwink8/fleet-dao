// 三段无头会话的生产 Spawner（#632 S2-3）：runner/one-shot.ts 的 OneShotSpawner，真起 Claude Code / cursor-agent / grok。
//
// 不另写一套启动命令：执行方式的驱动（hosts.ts）已经管着各家的参数、会话用户、scope 资源上限、调工具前的钩子、模型核对、
// 额度读数和终帧，生产里跑了很久。这里只做三件事：按路由编号查出执行方式和会话用户（和 Fusion 的 startSession 同一个查法，
// sessionUserOf）→ 备好会话自己的临时目录 → 起驱动、等它收场，把驱动的报告整理成 OneShotSpawner 的结局（退出码、回答正文当
// stdout、用量花费额度当 facts）。
//
// 改这里之前必须知道：
// - 开新还是续按入参：带了 resumeSessionId（动手段续上一段，决定 0088；驾驶舱「提需求」的指挥官会话，#2061）就
//   session.mode = 'resume' 续那个号，不带就开新的。不 fork。续不续由调用方判（planSegmentResume），这里不再判一遍。
// - 脱开引擎跑（cmd.detach，#2238，动手段和一家验的冷验收给（#2848）；session-handoff.ts 讲为什么）：执行方式是命令行那几家、装了 handoff，就把收发目录
//   交给驱动（io），会话的输入输出走文件；引擎要走（handoff.signal）时驱动放手、这里写上放手标记交回 detached——会话的临时目录、
//   收发目录都留着给下一个引擎。attach 是接回：清掉标记，驱动不起进程、从头重读输出等它收场。正常收场的连收发目录一起删。
//   Mirasim（#2815）同样走：收发目录里只放交接单（会话号、轮次号、run 号），放手时插头只断开 ws、不发 stop，这里写放手标记；
//   接回时驱动凭交接单重新订阅。没给 detach 的（两家都验的验收、整理、指挥官会话）照旧走管道、被停就发 stop。
// - 成败只认 adapters 的 judgeRun（和 Fusion 同一份判法）：它不是 ok，退出码就不会是 0。「终帧报错」「没有终帧」这些，
//   即使进程自己退出码是 0，这里也报 1，不让 one-shot 把它判成 done。
// - 读不到、认不出一律抛错（路由没给、库里没有这条路由、执行方式没接上、会话用户定不下来），runOneShot 把它记成
//   spawn_failed；不落到某个默认执行体上。
// - 中转路由（Mirasim）的账本没读成时 judgeRun 判 relay_unknown：活可能已经交了，要对账、不能重跑会话——reason 原样带在
//   facts 里，调用方（任务工作流）见到它停下报人，不走自动重试。
// - Mirasim 不采本机 scope 的 CPU/内存。模型会话在 Mirasim 服务里；本机只有每次连接各起的短命桥接
//   （fleet-agent-mirasim-<随机>.scope，不是 fleet-agent-<runId>.scope），里面只有桥接进程。那个用量不是这一段的，
//   不写数。会话事实里写明记不到（MIRASIM_MEMORY_UNREAD / MIRASIM_CPU_UNREAD），不说成「没有 cgroup」。
// - 总时长比 one-shot 的时限早一分钟到（驱动自己的 wallClock），驱动先收场、报 wall_clock_timeout；one-shot 的时限信号
//   晚一点到，是兜底（驱动卡死了）。
// - 会话的临时目录（TMPDIR）：起之前交给会话用户，收场后删；删不掉只记日志（占盘，下次引擎起来的清理会收），不改结局。

import { judgeRun, type RateLimitReading, type SessionUser, type TranscriptEntry } from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import type { Db, RouteLaunchFacts } from '@fleet-dao/db';
import {
  appendRunTranscript,
  ensureRunForTranscript,
  finishRun,
  routeLaunchFacts,
  savePoolQuota,
  type TranscriptRow,
} from '@fleet-dao/db';
import { routeEffortProblem } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { CarpoolRejection } from '../jobs/carpool-outage.ts';
import { hostName } from '../routing/names.ts';
import type { RunsWriter } from '../runner/not-wired.ts';
import type { OneShotSpawner, SpawnFacts, SpawnOutcome } from '../runner/one-shot.ts';
import { type CpuUsageDeps, type CpuUsageResult, sampleCpuUsage } from './cpu-usage.ts';
import {
  type HostDriver,
  type HostReport,
  type HostRunSpec,
  isWiredHost,
  sessionUserOf,
  type WiredHost,
  wiredHostNames,
} from './hosts.ts';
import { type MemoryPeakDeps, type MemoryPeakResult, sampleMemoryPeak } from './memory-peak.ts';
import {
  clearDetached,
  DETACHABLE_HOSTS,
  ensureIoRoot,
  ioDirOf,
  markDetached,
  readMirasimHandle,
  removeIo,
  type SessionHandoff,
  writeMirasimHandle,
} from './session-handoff.ts';
import { dbWriteFailure, TranscriptRecorder } from './transcript-recorder.ts';
import type { WorkTrees } from './worktrees.ts';

/** 总时长比 one-shot 的时限早多久到（毫秒）：驱动先收场，one-shot 的时限信号是兜底。 */
export const SEGMENT_WALL_MARGIN_MS = 60_000;

/** 驱动自己的总时长至少给这么久，免得时限很短（测试）时算出个负数。 */
const MIN_WALL_MS = 10_000;

/**
 * Mirasim 不采本机 scope：模型会话在 Mirasim 服务里，本机每次连接各起一个短命桥接
 * （fleet-agent-mirasim-<随机>.scope），里面只有桥接进程，不是这一段的用量。
 * 写进会话事实和日志。两句都带着同一句原因，免得日志还说成「这台没有 cgroup」。
 */
export const MIRASIM_MEMORY_UNREAD =
  'Mirasim 路不经本机 scope，资源用量记不到：内存峰值不采（模型会话在 Mirasim 服务里，本机只有短命桥接）';
export const MIRASIM_CPU_UNREAD =
  'Mirasim 路不经本机 scope，资源用量记不到：CPU 秒数不采（模型会话在 Mirasim 服务里，本机只有短命桥接）';

export interface SegmentSpawnerDeps {
  /** 路由编号 → 执行方式、池、会话用户、上游模型串。不给就用库里的（routeLaunchFacts）。 */
  routeFacts?: (routeId: string) => Promise<RouteLaunchFacts | null>;
  db?: Db;
  /** 流里提前拿到真会话号时写回 runs；测试和未接库的调用方可以不传。 */
  runs?: Pick<RunsWriter, 'observeSessionId'>;
  drivers: Record<WiredHost, HostDriver>;
  /** 会话临时目录的管理（real/worktrees.ts）：只用这三样。 */
  trees: Pick<WorkTrees, 'tmpFor' | 'adopt' | 'remove'>;
  /** 宿主环境，一般传 process.env；只会抄白名单里的键（adapters 的 buildSessionEnv），凭据类的键进不去。 */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** 一个会话的内存软上限、硬上限、swap 上限（MB）：照 limits.ts 的 SESSION_MEMORY_*，swap 一般给 0。 */
  resources: { memoryHighMb: number; memoryMaxMb: number; swapMaxMb: number };
  /**
   * 拼车池上的会话没成（退出码不是 0、不是我们叫停的）：被拒的证据当场交出去（#194 方案 4.3），由切号判是不是「拼车用不了」、
   * 要不要当场切独享。只发出去、不等：切号要等这一个会话收场，等它会互相卡住。抛了只记日志。
   */
  onCarpoolRejection?: (rejection: CarpoolRejection) => void;
  /**
   * 会话 scope 的内存峰值怎么读（real/memory-peak.ts 的 productionMemoryPeak）：给了就采、写进 runs.memory_peak_mb（#948）；
   * 不给（测试、没有 cgroup 的开发机）就不采，那一列留空。Mirasim 给了也不采，事实里写 MIRASIM_MEMORY_UNREAD。
   */
  memoryPeak?: MemoryPeakDeps;
  /**
   * 会话 scope 的 CPU 秒数怎么读（real/cpu-usage.ts 的 productionCpuUsage）：给了就采、收场时把 cpu.stat 的
   * usage_usec 折成秒写进 runs.cpu_seconds（#1980）。读不到留空，不写 0。不给（测试、没有 cgroup 的开发机）就不采。
   * Mirasim 给了也不采，事实里写 MIRASIM_CPU_UNREAD。
   */
  cpuUsage?: CpuUsageDeps;
  /**
   * 会话过程记录怎么写（#1640，run_transcript）：不给就用 db 的 appendRunTranscript（有 db 才记）；测试换假的。
   * 写不进只记日志，不影响这一段的结局。
   */
  transcriptWrite?: (runId: string, rows: TranscriptRow[]) => Promise<void>;
  /** 过程记录攒批的节拍（毫秒）；测试调小。不给用 transcript-recorder.ts 的默认。 */
  transcriptFlushMs?: number;
  /**
   * 动手会话脱开引擎跑（#2238，session-handoff.ts）：收发目录的根和「引擎要走了」的信号。不给 = 一律走管道（测试、开发机）。
   */
  handoff?: SessionHandoff;
  /** 帮手脚本、sudo 前缀（测试里给假帮手）。 */
  helper?: string;
  sudo?: readonly string[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

function sizeArg(name: string, mb: number): string {
  if (!Number.isSafeInteger(mb) || mb < 0) {
    throw new Error(`会话的资源上限 ${name} 要是非负整数（MB）：${mb}`);
  }
  return mb === 0 ? '0' : `${mb}M`;
}

/**
 * 驱动的报告 → one-shot 要的结局。判法只有 adapters 的 judgeRun 一份：不是 ok 就不是 0。
 * 我们自己的看守杀掉的（killed）：one-shot 按它自己的信号分是超时还是被叫停。
 */
export function outcomeOfReport(report: HostReport): SpawnOutcome {
  const verdict = judgeRun(report.facts);
  const ok = verdict.outcome === 'ok';
  const killed = report.facts.killed !== undefined;
  const facts: SpawnFacts = {
    usage: report.usage,
    ...(report.usageWhy !== undefined ? { usageWhy: report.usageWhy } : {}),
    ...(report.costUsd !== undefined
      ? { costUsd: report.costUsd }
      : report.sessionCostUsd !== undefined
        ? { costUsd: report.sessionCostUsd }
        : {}),
    ...(report.actualModel !== undefined ? { actualModel: report.actualModel } : {}),
    // 只记真号：起会话前的临时号（cursor-pending: / mirasim-pending:）不是执行体的会话，拿它补读不到用量
    ...(report.sessionId !== undefined && !/^[a-z]+-pending:/.test(report.sessionId)
      ? { sessionId: report.sessionId }
      : {}),
    quotaExhausted: report.facts.quotaExhausted,
    ...(report.resetsAt !== undefined ? { resetsAt: report.resetsAt } : {}),
    ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
    reason: verdict.reason,
    detail: verdict.detail,
    ...(report.rawError !== undefined ? { rawError: report.rawError } : {}),
  };
  const nonzero =
    typeof report.facts.exitCode === 'number' && report.facts.exitCode !== 0 ? report.facts.exitCode : 1;
  return {
    exitCode: killed ? null : ok ? 0 : nonzero,
    stdout: report.answer ?? '',
    stderr: [ok ? '' : verdict.detail, report.stderrTail].filter(Boolean).join('\n'),
    killed,
    facts,
  };
}

/**
 * 路由编号 → 库里的路由、执行方式的驱动、会话用户。Spawner 起会话和调用方起会话之前备工作树（要知道树归谁）用同一个查法。
 * 查不到、没接上、定不下会话用户、配的思考档位这家起不了，一律抛错（带白话原因），不落到某个默认执行体、默认档位上。
 */
export async function resolveSegmentRoute(
  deps: Pick<SegmentSpawnerDeps, 'routeFacts' | 'db' | 'drivers'>,
  routeId: string | undefined,
): Promise<{ route: RouteLaunchFacts; driver: HostDriver; user: SessionUser }> {
  if (!routeId) {
    throw new Error('这一段没给路由编号（routeId）：生产 Spawner 不知道该起哪家执行体，也不落到默认的上');
  }
  const lookup =
    deps.routeFacts ??
    (deps.db
      ? (id: string) => routeLaunchFacts(deps.db as Db, id)
      : () => {
          throw new Error('生产 Spawner 没装路由查询：要给 routeFacts 或 db');
        });
  const route = await lookup(routeId);
  if (!route) throw new Error(`库里没有路由 ${routeId}`);
  if (!isWiredHost(route.hostId)) {
    throw new Error(
      `执行方式 ${route.hostId} 引擎还没接上（现在接了 ${wiredHostNames()}）：路由 ${route.routeId}`,
    );
  }
  const driver = deps.drivers[route.hostId];
  const who = sessionUserOf(driver, route.runAsUser);
  if ('missing' in who) throw new Error(`账号池 ${route.poolId} ${who.missing}，起不了会话`);
  if (route.effort !== null) {
    // 起会话时驱动照同一份判法再判一次（applySessionEffort）；这里先挡，配错了不备树、不在 runs 记一笔
    const problem = routeEffortProblem(
      route.hostId,
      route.upstreamModel ?? route.modelId,
      route.effort,
      hostName(route.hostId),
    );
    if (problem)
      throw new Error(`路由 ${route.routeId} 配的思考档位起不了会话（驾驶舱改了再派）：${problem}`);
  }
  return { route, driver, user: who.user };
}

export function hostSegmentSpawner(deps: SegmentSpawnerDeps): OneShotSpawner {
  const log = deps.log ?? (() => undefined);

  /**
   * 会话流里顺带读到的额度（被拒的那一帧带着清零时刻）记到这条路由的池上：和 Fusion 的会话、路由探针同一个写入口、同一个做法
   * （complete=false：只是几个窗口，不标别的窗口过期）。切号、选路判拼车用满靠它——不记，一次性会话被拒了引擎也不知道（#59）。
   * 交回写库那一下：插头收场前等它落定（adapters 的 CallbackGate），这一段交回「额度用满」时读数已经在库里，工作流马上
   * 重新选路不会又派回这个池。记不上只记日志，不改这一段的结局（所以这个 promise 不会 reject）。
   */
  const saveReading = (
    db: Db,
    route: RouteLaunchFacts,
    reading: RateLimitReading,
  ): Promise<void> | undefined => {
    const windows = readingsFromRateLimit(reading, { poolId: route.poolId });
    if (!windows?.length) return undefined;
    return savePoolQuota(db, {
      poolId: route.poolId,
      readAt: reading.observedAt,
      complete: false,
      windows,
    }).then(
      () => undefined,
      (err: unknown) => log('一次性会话读到的额度没记上', { poolId: route.poolId, error: errMessage(err) }),
    );
  };

  return async (cmd) => {
    const { input } = cmd;
    const runId = input.runId;
    const { route, driver, user } = await resolveSegmentRoute(deps, input.routeId);
    const handoff = deps.handoff;
    const detach = cmd.detach && handoff && DETACHABLE_HOSTS.has(driver.hostId) ? handoff : undefined;
    const attach = cmd.detach?.attach === true;
    if (attach && !detach) {
      throw new Error(
        `接回会话 ${runId} 没接成：${handoff ? `执行方式 ${driver.hostId} 不走文件` : '这个引擎没装收发目录'}，读不到它的输出`,
      );
    }
    const io = detach
      ? { dir: ioDirOf(detach.root, runId), release: detach.signal, ...(attach ? { attach: true } : {}) }
      : undefined;

    const tmpDir = deps.trees.tmpFor(runId);
    // 接回的临时目录还归会话在用：不重新交接
    if (!attach) await deps.trees.adopt(tmpDir, user);
    if (detach && !attach) await ensureIoRoot(detach.root);
    // 接回：先删放手标记——删了收孤儿就不会再当它没人接
    if (io && attach) await clearDetached(io.dir);
    const spec: HostRunSpec = {
      runId,
      user,
      cwd: cmd.cwd,
      prompt: cmd.stdin,
      // 一次性段不用 fleet 命令（只认 stdout / 退出码 / 提交）：不发通行证，命令连不上后端是预期
      env: { base: deps.baseEnv, fleetApi: '', fleetToken: '', pathPrepend: [], tmpDir },
      limits: { wallClockMs: Math.max(MIN_WALL_MS, cmd.timeoutMs - SEGMENT_WALL_MARGIN_MS) },
      testCommands: [],
      // 命令行那几家用这个 id 起 fleet-agent-<runId>.scope。Mirasim 的驱动不用它，也不按它采样。
      cgroup: {
        id: runId,
        user,
        limits: {
          memoryHigh: sizeArg('memoryHighMb', deps.resources.memoryHighMb),
          memoryMax: sizeArg('memoryMaxMb', deps.resources.memoryMaxMb),
          memorySwapMax: sizeArg('swapMaxMb', deps.resources.swapMaxMb),
        },
        ...(deps.helper ? { helper: deps.helper } : {}),
        ...(deps.sudo ? { sudo: deps.sudo } : {}),
      },
      model: route.upstreamModel ?? route.modelId,
      ...(route.executor ? { executor: route.executor } : {}),
      // 两个来源原样交给驱动，合成哪一档只在 hosts.ts 的 sessionEffortFor：路由配的是上限，分档只往下压
      ...(route.effort !== null ? { effort: route.effort } : {}),
      ...(input.effort !== undefined ? { tierEffort: input.effort } : {}),
      // 给了会话号就续它（动手段续上一段、指挥官会话），不给开新的。接回时新会话的号照执行编号算回当初命令行上那个
      // （hosts.ts 的 sessionUuidOf），核对会话号、记账才对得上
      session: cmd.resumeSessionId
        ? { mode: 'resume', id: cmd.resumeSessionId }
        : { mode: 'new', id: driver.newSessionId(runId).id },
      purpose: 'work',
    };
    // 内存峰值（#948）：会话跑着时采它 scope 的 memory.peak，收场后交结果；scope 一收场 cgroup 就没了，只能边跑边读
    // 会话过程记录（#1640）：提示词记第一条，插头交来的接着记；收场前等写完。
    // 外键要求 runs 里先有这一行。三段会话由 runOneShot 先写开跑那一行（有了就不改）。
    // 提需求、临时指挥官不走 runOneShot：补一行没有 route_id 的锚点（不占池的名额），收场再补结局。
    const db = deps.db;
    const write =
      deps.transcriptWrite ??
      (db ? (id: string, rows: TranscriptRow[]) => appendRunTranscript(db, id, rows) : undefined);
    let transcriptAnchor = false;
    if (write && db && deps.transcriptWrite === undefined) {
      try {
        transcriptAnchor = await ensureRunForTranscript(db, {
          id: runId,
          segment: input.segment,
          model: input.modelId,
        });
      } catch (err) {
        log('会话过程记录的锚点行没写上（过程记录可能整批写不进）', { runId, ...dbWriteFailure(err) });
      }
    }
    // Mirasim 接回（#2815）：重读订阅回的快照拼不出和放手前一模一样的条目，不能靠重复编号去重；接回的记录员从交接单里记的序号
    // 接着编，订阅回的旧内容（meta.replay）不记
    const mirasimAttach = attach && driver.hostId === 'mirasim' && io !== undefined;
    const attachHandle = mirasimAttach ? await readMirasimHandle(io.dir).catch(() => undefined) : undefined;
    const recorder = write
      ? new TranscriptRecorder({
          runId,
          write,
          log,
          ...(attachHandle?.transcriptNext === undefined ? {} : { startSeq: attachHandle.transcriptNext }),
          ...(deps.transcriptFlushMs === undefined ? {} : { flushEveryMs: deps.transcriptFlushMs }),
        })
      : undefined;
    const sessionWrites: Promise<void>[] = [];
    const observeSessionId = (sessionId: string): void => {
      if (/^[a-z]+-pending:/.test(sessionId)) return;
      const observe = deps.runs?.observeSessionId;
      if (!observe) return;
      sessionWrites.push(
        observe(runId, sessionId).catch((error: unknown) => {
          log('流里拿到的会话号没提前写回 runs', { runId, sessionId, error: errMessage(error) });
        }),
      );
    };
    let anchorOutcome: 'done' | 'failed' | 'killed' | undefined;
    // 接回时提示词那一条（编号 0）上一个引擎记过了：占住编号，后面重读出来的条目编号和原来一样，库里按编号跳过重复的
    if (!(mirasimAttach && attachHandle?.transcriptNext !== undefined))
      recorder?.prompt(attach ? '' : cmd.stdin);
    // Mirasim 的模型会话不在 fleet-agent-<runId>.scope 里（那个目录根本不会建）。本机 scope 是桥接自己起的
    // fleet-agent-mirasim-<随机>.scope，一次会话还不止一个，读到的也只是桥接。不拿它填用量。
    const sampleLocalScope = driver.hostId !== 'mirasim';
    const peak = sampleLocalScope && deps.memoryPeak ? sampleMemoryPeak(deps.memoryPeak, runId) : undefined;
    let peakResult: MemoryPeakResult | undefined;
    const finishPeak = async (): Promise<MemoryPeakResult | undefined> => {
      if (peakResult) return peakResult;
      if (!sampleLocalScope) {
        peakResult = { why: MIRASIM_MEMORY_UNREAD };
        log('会话内存峰值没读到', { runId, why: peakResult.why });
        return peakResult;
      }
      if (!peak) return undefined;
      peakResult = await peak.stop();
      if (peakResult.why !== undefined) log('会话内存峰值没读到', { runId, why: peakResult.why });
      return peakResult;
    };
    // CPU 秒数（#1980）：和内存峰值同一段时间采这个 scope 的 cpu.stat；收场那一读在 stop() 里。scope 一收场 cgroup 就没了。
    const cpu = sampleLocalScope && deps.cpuUsage ? sampleCpuUsage(deps.cpuUsage, runId) : undefined;
    let cpuResult: CpuUsageResult | undefined;
    const finishCpu = async (): Promise<CpuUsageResult | undefined> => {
      if (cpuResult) return cpuResult;
      if (!sampleLocalScope) {
        cpuResult = { why: MIRASIM_CPU_UNREAD };
        log('会话 CPU 没读到', { runId, why: cpuResult.why });
        return cpuResult;
      }
      if (!cpu) return undefined;
      cpuResult = await cpu.stop();
      if (cpuResult.why !== undefined) log('会话 CPU 没读到', { runId, why: cpuResult.why });
      return cpuResult;
    };
    // 过程记录和调用方的流（指挥官会话推给页面）都要：调用方的抛了只记日志
    const listen = cmd.onTranscript;
    const onTranscript =
      recorder || listen
        ? (entry: TranscriptEntry, meta?: { replay: boolean }) => {
            if (!(mirasimAttach && meta?.replay)) recorder?.record(entry);
            if (!listen) return;
            try {
              listen(entry);
            } catch (err) {
              log('会话过程的流没交出去', { runId, error: errMessage(err) });
            }
          }
        : undefined;
    let detached = false;
    const cleanup = async (): Promise<void> => {
      if (io) {
        await removeIo(io.dir).catch((err: unknown) => {
          log('动手会话的收发目录没删掉（引擎下次起来时的清理会收）', {
            runId,
            dir: io.dir,
            error: errMessage(err),
          });
        });
      }
      await deps.trees.remove(tmpDir).catch((err: unknown) => {
        log('一次性段会话的临时目录没删掉（引擎下次起来时的清理会收）', {
          runId,
          tmpDir,
          error: errMessage(err),
        });
      });
    };
    const leaveHandoff = io && detach ? detach.enter(runId) : undefined;
    try {
      if (io) cmd.detach?.detachable?.();
      const running = driver.run(spec, {
        signal: cmd.signal,
        ...(onTranscript ? { onTranscript } : {}),
        ...(io ? { io } : {}),
        ...(deps.db
          ? { onRateLimit: (reading: RateLimitReading) => saveReading(deps.db as Db, route, reading) }
          : {}),
        onSessionId: observeSessionId,
      });
      // 放手：写标记、交回 detached（会话和收发目录都留给下一个引擎）
      const letGo = async (dir: string): Promise<SpawnOutcome> => {
        detached = true;
        const at = new Date();
        try {
          await markDetached(dir, at);
        } catch (err) {
          // 标记没写上：新引擎收孤儿时会把它当没人接的收掉，接回那一步读不到输出、照实报
          log('放手标记没写上（新引擎起来可能把这个会话当孤儿收掉）', { runId, error: errMessage(err) });
        }
        log(`引擎要走了：${input.segment === 'verify' ? '验收' : '动手'}会话脱开接着跑，下一个引擎接回`, {
          runId,
          dir,
        });
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          killed: false,
          detached: { at: at.toISOString() },
        };
      };
      let report: HostReport;
      if (io && detach && driver.hostId !== 'mirasim') {
        // 引擎要走了：命令行那几家的驱动放手以后这次调用永远不落定（detached.ts），所以和放手信号赛跑；放手先到就交回 detached
        const released = new Promise<null>((resolve) => {
          if (detach.signal.aborted) resolve(null);
          else detach.signal.addEventListener('abort', () => resolve(null), { once: true });
        });
        const first = await Promise.race([running, released]);
        if (first === null) {
          running.catch(() => undefined);
          return await letGo(io.dir);
        }
        report = first;
      } else {
        report = await running;
        // Mirasim（#2815）：插头放手以后会交回一份「放手了」的报告（不赛跑：它要等到服务端接下、有了会话号才放手，
        // 交接单在那一刻已经写好）。交接单不在就接不回，日志里明说
        if (report.detached && io) {
          const handle = await readMirasimHandle(io.dir).catch(() => undefined);
          if (!handle) {
            log('Mirasim 会话放手了，可交接单没有（新引擎接不回，会话要等孤儿清扫收）', {
              runId,
              dir: io.dir,
            });
          }
          return await letGo(io.dir);
        }
      }
      await Promise.all(sessionWrites);
      const outcome = outcomeOfReport(report);
      const measured = await finishPeak();
      if (measured) {
        outcome.facts = {
          ...outcome.facts,
          ...(measured.mb !== undefined ? { memoryPeakMb: measured.mb } : { memoryPeakWhy: measured.why }),
        };
      }
      const measuredCpu = await finishCpu();
      if (measuredCpu) {
        outcome.facts = {
          ...outcome.facts,
          ...(measuredCpu.seconds !== undefined
            ? { cpuSeconds: measuredCpu.seconds }
            : { cpuWhy: measuredCpu.why }),
        };
      }
      if (
        deps.onCarpoolRejection &&
        route.orgKind === 'carpool' &&
        !outcome.killed &&
        outcome.exitCode !== 0
      ) {
        const resets = outcome.facts?.resetsAt ? new Date(outcome.facts.resetsAt) : undefined;
        try {
          deps.onCarpoolRejection({
            at: new Date(),
            ...(outcome.facts?.quotaExhausted ? { code: 'quota_exhausted' } : {}),
            ...(outcome.facts?.httpStatus !== undefined ? { httpStatus: outcome.facts.httpStatus } : {}),
            ...(resets && !Number.isNaN(resets.getTime()) ? { resetsAt: resets } : {}),
            // 执行体报的原话（reclaude 的「拼车 5 小时额度已用完，约 N 分钟后重置」在终帧里）排在前面：判是哪一种、几点恢复靠它
            text: [
              report.facts.terminal?.detail,
              outcome.facts?.detail,
              outcome.facts?.rawError,
              outcome.stderr,
            ]
              .filter(Boolean)
              .join('\n'),
          });
        } catch (err) {
          log('拼车被拒的证据没交给切号', { runId, error: errMessage(err) });
        }
      }
      anchorOutcome = outcome.killed ? 'killed' : outcome.exitCode === 0 ? 'done' : 'failed';
      return outcome;
    } finally {
      leaveHandoff?.();
      await recorder?.close();
      // Mirasim 放手：交接单里记下过程记录写到了第几条，接回的记录员从这里接着编
      if (detached && recorder && io && driver.hostId === 'mirasim') {
        try {
          const handle = await readMirasimHandle(io.dir);
          if (handle) writeMirasimHandle(io.dir, { ...handle, transcriptNext: recorder.nextSeq });
        } catch (err) {
          log('Mirasim 交接单没补上过程记录的序号（接回后的过程记录可能和放手前的编号重了）', {
            runId,
            error: errMessage(err),
          });
        }
      }
      // 只收自己补的那一行。三段会话的开跑行留给 runOneShot 收场，带着用量；脱开引擎跑的还没结束，留着。
      if (transcriptAnchor && !detached && db) {
        const settled = anchorOutcome ?? 'failed';
        try {
          await finishRun(db, {
            runId,
            outcome: settled,
            ...(settled === 'done'
              ? {}
              : { failureReason: settled === 'killed' ? '会话被叫停或超时' : '会话没成功收场' }),
          });
        } catch (err) {
          log('会话过程记录的锚点行没收到场', { runId, ...dbWriteFailure(err) });
        }
      }
      await finishPeak().catch(() => undefined);
      await finishCpu().catch(() => undefined);
      // 放手了：临时目录、收发目录都留给接回的那个引擎
      if (!detached) await cleanup();
    }
  };
}
