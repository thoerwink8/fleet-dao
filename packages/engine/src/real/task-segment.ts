// 任务工作流的动手会话（runSegment，#632 S2-4b-2）：备树 → 拼提示词 → 起一次性会话（runner/one-shot.ts + 生产 Spawner）→
// 把结局整理成工作流要的形状。一个活动＝一次会话尝试：Temporal 不自动重来（会话贵又不幂等），换谁、等多久由工作流的失败分流定。
//
// 改这里之前必须知道：
// - 执行编号（runs 表主键）由这里生成，每次尝试一个：工作流里不生成编号（重放要确定）。
// - 内存放不下新会话（准入）不是失败也不进失败分流：隔一会儿再试，最多等 ADMISSION_WAIT_MS；等到顶才回 memory_busy 交工作流。
//   每次试都换新的执行编号（runs 主键），被拦的那几次在 runs 里各记一笔 admission_blocked。
// - 叫停（工作流放弃、活动被取消）：ctx.signal 接进会话的看守，会话被杀；这里随后把取消原样抛出去，不回「没跑成」。
// - 切号叫停（#59）不是叫停：这一段交回 ok:false、结局和原因码都是 org_switch（失败分流 OS1：不算失败、不记账），工作流切完
//   在原分支上重跑这一段。定了路由就登记（sessions.enter），建树、等内存、起会话都算在内，收场才走。
// - 成败只认 adapters 的 judgeRun（经 Spawner 变成退出码）：不是 done 就带着原因码回 ok:false；原因码（quota_exhausted、
//   model_mismatch、relay_unknown……）就是失败分流认的码，不改写；没有原因码的才按 one-shot 的结局给一个（runner/evidence.ts
//   的 segmentEvidence：熔断认的「算不算路由的账」也出自它，两边一份证据）。
// - 起不来（路由不可用、树备不好、Spawner 抛错）一律抛 PortError，不当成「会话没跑成」：前者重试没用，要人修配置。
//   开跑那一行写不进 runs（#157，one-shot 不起会话）抛 SEGMENT_RUNS_UNWRITABLE，可以重试：是库一时不通，不是配置。
// - runs 里这一段记到这张单名下（#216）：tasks.id、单号、派工档、工作流编号（和起工作流、驾驶舱读的是同一个 taskWorkflowId）、
//   分支，开了 PR 的轮次再带 PR 号；记账的字段对不上 runs 的约束，one-shot 不起会话（BAD_RUN_INPUT，按起不来处理）。
// - 选路时预占的池的名额（input.route.reservationId，#757）：开跑那一行写进去时 runs 那边换掉；没开跑就收场的（路由用不了、
//   建树失败、内存一直放不下、被叫停、切号停下）收场时在这里放掉，不让池一直显得满。放不掉只记日志：预占最多占
//   RESERVATION_TTL_MS，到点自己不算。开跑时名额已经没了（预占过期、空位给了别的单）抛 SEGMENT_NO_SLOT，可以重试：重新选路就行。
// - one-shot 的落盘目录（brief.txt、stdout.txt……）24 小时后由这里顺手清；清不掉只记日志。

import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { abortableSleep, errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { EngineTasks } from '../activities.ts';
import { type PortContext, PortError } from '../ports.ts';
import { segmentEvidence } from '../runner/evidence.ts';
import type { RunsWriter } from '../runner/not-wired.ts';
import { OneShotError, type OneShotResult, runOneShot, SESSION_ARTIFACT_TTL_MS } from '../runner/one-shot.ts';
import { renderSegmentPrompt } from '../runner/segment-prompt.ts';
import { manualBriefOf } from '../runner/task-brief.ts';
import { type RunSegmentInput, type RunSegmentResult, SEGMENT_STAGE } from '../task-contract.ts';
import type { MemoryAdmissionDeps } from './memory-admission.ts';
import type { OneShotSessions, OneShotTicket } from './one-shot-sessions.ts';
import type { ChannelAttempts, SegmentReservations } from './runs-writer.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { prepareSegmentTree, type SegmentTreeDeps } from './segment-tree.ts';

/** 内存放不下时最多等多久（毫秒）、多久再试一次。 */
export const ADMISSION_WAIT_MS = 10 * 60_000;
export const ADMISSION_POLL_MS = 30_000;
/**
 * 选路给一段预占的池的名额最多占多久（#757，选路时照它写 pool_reservations.expires_at）：要盖住选完路到开跑之间的建树、等内存
 * （最多 ADMISSION_WAIT_MS），再给排活动、建树留 10 分钟。卡得比这还久就让出来，别的单派得进去；这一段后来真开跑了，
 * 开跑时按那时的空位重新排，满了不起（NO_SLOT）。
 */
export const RESERVATION_TTL_MS = ADMISSION_WAIT_MS + 10 * 60_000;
/** 会话跑着时多久报一次活着（远小于心跳超时）。 */
export const SEGMENT_HEARTBEAT_MS = 15_000;

export interface RunSegmentDeps {
  tree: SegmentTreeDeps;
  spawner: SegmentSpawnerDeps;
  runs: RunsWriter;
  /** 选路时预占的名额（#757）：没开跑就收场的这一段在收场时放掉（runs-writer.ts 的 realReservations）。 */
  reservations: SegmentReservations;
  /** 每一次起会话的尝试落库（channel_attempts，#1118）。 */
  attempts: ChannelAttempts;
  memoryAdmission?: MemoryAdmissionDeps;
  /** one-shot 落盘的根（<引擎状态目录>/runs）。 */
  runsDir: string;
  /**
   * 一次性会话的登记（#59，real/one-shot-sessions.ts）：切号照它停下跑在 Claude 池上的这一段，这一段交回 org_switch，工作流切完
   * 在原分支上重跑。不给 = 切号停不下它，只能等它跑完（#157）。
   */
  sessions?: OneShotSessions;
  now?: () => Date;
  /** 以下测试用。 */
  newRunId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  admissionWaitMs?: number;
  admissionPollMs?: number;
  heartbeatEveryMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 删 runsDir 下超过 ttl 的执行目录。不抛：清不掉只记日志，下次再清。 */
export async function sweepRunDirs(
  runsDir: string,
  now: Date,
  ttlMs: number,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('一次性会话的落盘目录读不了，没清', { runsDir, error: errMessage(error) });
    }
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = join(runsDir, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || now.getTime() - info.mtimeMs < ttlMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      log('一次性会话的落盘目录没清掉（下次再清）', { dir, error: errMessage(error) });
    }
  }
  return removed;
}

export function createRunSegment(deps: RunSegmentDeps): NonNullable<EngineTasks['runSegment']> {
  const now = deps.now ?? (() => new Date());
  const newRunId = deps.newRunId ?? randomUUID;
  const sleep = deps.sleep ?? abortableSleep;
  const admissionWaitMs = deps.admissionWaitMs ?? ADMISSION_WAIT_MS;
  const admissionPollMs = deps.admissionPollMs ?? ADMISSION_POLL_MS;
  const heartbeatEveryMs = deps.heartbeatEveryMs ?? SEGMENT_HEARTBEAT_MS;
  const log = deps.log ?? (() => undefined);
  const spawner = hostSegmentSpawner(deps.spawner);

  /**
   * 记一次起会话的尝试（channel_attempts，#1118）。会话已经跑完了：这笔记账写不进只记日志、不让跑成的会话白跑
   * （失败分流照样用 runSegment 回的结局，不靠这张表）。
   */
  const noteAttempt = async (
    input: RunSegmentInput,
    routeInfo: Awaited<ReturnType<typeof resolveSegmentRoute>>,
    fact: { runId?: string; startedAt: Date; error?: { code: string; message: string } },
  ) => {
    try {
      await deps.attempts.record({
        ...(fact.runId === undefined ? {} : { runId: fact.runId }),
        taskId: input.taskId,
        modelId: input.route.modelId,
        routeId: input.route.routeId,
        channelId: routeInfo.route.channelId,
        ...(fact.error ? { errorType: fact.error.code, message: fact.error.message } : {}),
        startedAt: fact.startedAt,
        endedAt: now(),
      });
    } catch (error) {
      log('这一次起会话的尝试没记进 channel_attempts（会话本身的结局照常交给工作流）', {
        taskId: input.taskId,
        routeId: input.route.routeId,
        error: errMessage(error),
      });
    }
  };

  /** 放掉选路时预占的名额：开跑了的已经换成开跑那一行，放一次什么都不做。放不掉只记日志（到点自己过期）。 */
  const releaseReservation = async (reservationId: string | undefined) => {
    if (reservationId === undefined) return;
    try {
      await deps.reservations.release(reservationId);
    } catch (error) {
      log('选路时预占的池的名额没放掉（最多占到预占过期，到点自己不算）', {
        reservationId,
        error: errMessage(error),
      });
    }
  };

  const runSegment = async (input: RunSegmentInput, ctx: PortContext): Promise<RunSegmentResult> => {
    try {
      ctx.heartbeat();
      // 1. 路由 → 会话用户（树要归它）。查不到、没接上都是配置问题，重试没用。
      let routeInfo: Awaited<ReturnType<typeof resolveSegmentRoute>>;
      try {
        routeInfo = await resolveSegmentRoute(deps.spawner, input.route.routeId);
      } catch (error) {
        throw new PortError('SEGMENT_ROUTE_UNUSABLE', errMessage(error), { retryable: false });
      }
      // 定了路由就登记（#59）：从这里到收场（建树、等内存、起会话），切号都看得见这一段、停得下它
      const ticket = deps.sessions?.enter({
        poolId: routeInfo.route.poolId,
        stage: SEGMENT_STAGE.manual,
        taskId: input.taskId,
      });
      try {
        return await run(input, ctx, routeInfo, ticket);
      } finally {
        ticket?.leave();
      }
    } finally {
      await releaseReservation(input.route.reservationId);
    }
  };

  async function run(
    input: RunSegmentInput,
    ctx: PortContext,
    routeInfo: Awaited<ReturnType<typeof resolveSegmentRoute>>,
    ticket: OneShotTicket | undefined,
  ): Promise<RunSegmentResult> {
    const treeRunId = newRunId();
    // 每一次起会话的编号（runs 主键）都先交给登记再干等的事（建树、等内存）：这时被切号停下，操作记录 stopped 里写的就是
    // 随后记成 org_switch 的那一行，查得到
    let runId = newRunId();
    ticket?.attempt(runId);
    // 2. 树（切号叫停不打断建树：建完了下面起会话那一步当场回 org_switch）
    await prepareSegmentTree(
      deps.tree,
      {
        repo: input.repo,
        worktreePath: input.worktreePath,
        branch: input.branch,
        baseSha: input.baseSha,
        user: routeInfo.user,
        runId: treeRunId,
      },
      ctx,
    );
    // 3. 提示词
    const prompt = renderSegmentPrompt({
      brief: manualBriefOf(input.brief, { branch: input.branch, baseSha: input.baseSha }),
      specDir: input.brief.specDir,
      feedback: input.feedback,
      ...(input.interrupted ? { interrupted: input.interrupted } : {}),
    });
    // 4. 起会话。叫停（ctx.signal）接进会话的看守；切号叫停（ticket）交给 one-shot，结局记 org_switch。
    const stopSignal = ctx.signal;
    const beat = setInterval(() => ctx.heartbeat(), heartbeatEveryMs);
    const started = now().getTime();
    let result: OneShotResult;
    let attemptStartedAt = now();
    try {
      for (;;) {
        attemptStartedAt = now();
        try {
          result = await runOneShot(
            {
              runId,
              segment: 'manual',
              modelId: input.route.modelId,
              channel: routeInfo.route.channelId,
              issueNumber: input.issueNumber,
              taskId: input.taskId,
              tier: input.tier.tier,
              workflowId: ctx.workflowId ?? taskWorkflowId(input.repo, input.issueNumber),
              branch: input.branch,
              ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
              prompt,
              cwd: input.worktreePath,
              timeoutMinutes: input.timeoutMinutes,
              routeId: input.route.routeId,
              effort: input.tier.effort,
              ...(input.route.reservationId ? { reservationId: input.route.reservationId } : {}),
            },
            {
              spawn: (cmd) => {
                ticket?.running();
                return spawner({ ...cmd, signal: AbortSignal.any([cmd.signal, stopSignal]) });
              },
              ...(deps.memoryAdmission ? { memoryAdmission: deps.memoryAdmission } : {}),
              tmpDir: deps.runsDir,
              runs: deps.runs,
              now,
              ...(ticket ? { stop: ticket.signal } : {}),
            },
          );
        } catch (error) {
          if (stopSignal.aborted) throw stopSignal.reason ?? error;
          if (error instanceof OneShotError && error.code === 'RUN_START_FAILED') {
            // 库一时写不进：会话没起，过一会儿再来就行
            throw new PortError('SEGMENT_RUNS_UNWRITABLE', error.message, { retryable: true });
          }
          if (error instanceof OneShotError && error.code === 'NO_SLOT') {
            // 预占的名额过期了、空位已经给了别的单：会话没起，重新选路就行（不是库写不进）
            throw new PortError('SEGMENT_NO_SLOT', error.message, { retryable: true });
          }
          if (error instanceof OneShotError) {
            await noteAttempt(input, routeInfo, {
              startedAt: attemptStartedAt,
              error: { code: 'spawn_failed', message: error.message },
            });
            throw new PortError('SEGMENT_SPAWN_FAILED', error.message, { retryable: false });
          }
          throw error;
        }
        if (stopSignal.aborted) throw stopSignal.reason ?? new Error('被叫停了');
        if (result.outcome !== 'admission_blocked') break;
        if (now().getTime() - started >= admissionWaitMs) break;
        ctx.heartbeat();
        runId = newRunId();
        ticket?.attempt(runId);
        // 等内存时切号叫停了：不再等，下一次 one-shot 当场回 org_switch（不起会话）
        try {
          await sleep(admissionPollMs, ticket ? AbortSignal.any([stopSignal, ticket.signal]) : stopSignal);
        } catch (error) {
          if (stopSignal.aborted || !ticket?.signal.aborted) throw error;
        }
      }
    } finally {
      clearInterval(beat);
    }
    void sweepRunDirs(deps.runsDir, now(), SESSION_ARTIFACT_TTL_MS, log);

    // 内存放不下没开跑（admission_blocked）不算一次尝试：没轮到任何渠道
    if (result.outcome !== 'admission_blocked') {
      const evidence = result.outcome === 'done' ? undefined : segmentEvidence(result);
      await noteAttempt(input, routeInfo, {
        runId: result.runId,
        startedAt: attemptStartedAt,
        ...(evidence
          ? {
              error: {
                code: evidence.code ?? result.outcome,
                message: evidence.message ?? `会话没跑成（${result.outcome}）`,
              },
            }
          : {}),
      });
    }
    if (result.outcome === 'done') {
      return {
        ok: true,
        runId: result.runId,
        answer: result.stdout,
        ...(result.facts?.costUsd === undefined ? {} : { costUsd: result.facts.costUsd }),
        ...(result.facts?.actualModel === undefined ? {} : { actualModel: result.facts.actualModel }),
      };
    }
    return { ok: false, runId: result.runId, outcome: result.outcome, evidence: segmentEvidence(result) };
  }

  return runSegment;
}
