// 任务工作流的动手会话（runSegment，#632 S2-4b-2）：备树 → 拼提示词 → 起一次性会话（runner/one-shot.ts + 生产 Spawner）→
// 把结局整理成工作流要的形状。一个活动＝一次会话尝试：Temporal 不自动重来（会话贵又不幂等），换谁、等多久由工作流的失败分流定。
//
// 改这里之前必须知道：
// - 执行编号（runs 表主键）由这里生成，每次尝试一个：工作流里不生成编号（重放要确定）。
// - 内存放不下新会话（准入）不是失败也不进失败分流：隔一会儿再试，最多等 ADMISSION_WAIT_MS；等到顶才回 memory_busy 交工作流。
//   每次试都换新的执行编号（runs 主键），被拦的那几次在 runs 里各记一笔 admission_blocked。
// - 叫停（工作流放弃、活动被取消）：ctx.signal 接进会话的看守，会话被杀；这里随后把取消原样抛出去，不回「没跑成」。
// - 成败只认 adapters 的 judgeRun（经 Spawner 变成退出码）：不是 done 就带着原因码回 ok:false；原因码（quota_exhausted、
//   model_mismatch、relay_unknown……）就是失败分流认的码，不改写；没有原因码的才按 one-shot 的结局给一个。
// - 起不来（路由不可用、树备不好、Spawner 抛错）一律抛 PortError，不当成「会话没跑成」：前者重试没用，要人修配置。
// - one-shot 的落盘目录（brief.txt、stdout.txt……）24 小时后由这里顺手清；清不掉只记日志。

import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineTasks } from '../activities.ts';
import { type PortContext, PortError } from '../ports.ts';
import type { RunsWriter } from '../runner/not-wired.ts';
import { OneShotError, type OneShotResult, runOneShot, SESSION_ARTIFACT_TTL_MS } from '../runner/one-shot.ts';
import { renderSegmentPrompt } from '../runner/segment-prompt.ts';
import { manualBriefOf } from '../runner/task-brief.ts';
import type { RunSegmentInput, RunSegmentResult, SegmentEvidence } from '../task-contract.ts';
import type { MemoryAdmissionDeps } from './memory-admission.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { prepareSegmentTree, type SegmentTreeDeps } from './segment-tree.ts';

/** 内存放不下时最多等多久（毫秒）、多久再试一次。 */
export const ADMISSION_WAIT_MS = 10 * 60_000;
export const ADMISSION_POLL_MS = 30_000;
/** 会话跑着时多久报一次活着（远小于心跳超时）。 */
export const SEGMENT_HEARTBEAT_MS = 15_000;

export interface RunSegmentDeps {
  tree: SegmentTreeDeps;
  spawner: SegmentSpawnerDeps;
  runs: RunsWriter;
  memoryAdmission?: MemoryAdmissionDeps;
  /** one-shot 落盘的根（<引擎状态目录>/runs）。 */
  runsDir: string;
  now?: () => Date;
  /** 以下测试用。 */
  newRunId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  admissionWaitMs?: number;
  admissionPollMs?: number;
  heartbeatEveryMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const MESSAGE_MAX = 4000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('被叫停了'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('被叫停了'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** one-shot 的结局 → 失败分流要的证据：原因码原样带过去，没有才按结局给一个。 */
export function evidenceOf(result: OneShotResult): SegmentEvidence {
  const facts = result.facts;
  const reason =
    facts?.reason && facts.reason !== 'delivered' && facts.reason !== 'answered' ? facts.reason : undefined;
  const code =
    reason ??
    (result.outcome === 'timeout'
      ? 'wall_clock_timeout'
      : result.outcome === 'admission_blocked'
        ? 'memory_busy'
        : result.outcome);
  const text = [facts?.detail, facts?.rawError, result.failureReason, result.stderrTail]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join('\n');
  return {
    code,
    message: (text || `会话没跑成（${result.outcome}）`).slice(0, MESSAGE_MAX),
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    ...(facts?.httpStatus === undefined ? {} : { httpStatus: facts.httpStatus }),
    ...(facts?.resetsAt === undefined ? {} : { resetsAt: facts.resetsAt }),
    quotaExhausted: facts?.quotaExhausted === true,
  };
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
      log('一次性会话的落盘目录读不了，没清', { runsDir, error: message(error) });
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
      log('一次性会话的落盘目录没清掉（下次再清）', { dir, error: message(error) });
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

  return async (input: RunSegmentInput, ctx: PortContext): Promise<RunSegmentResult> => {
    ctx.heartbeat();
    // 1. 路由 → 会话用户（树要归它）。查不到、没接上都是配置问题，重试没用。
    let routeInfo: Awaited<ReturnType<typeof resolveSegmentRoute>>;
    try {
      routeInfo = await resolveSegmentRoute(deps.spawner, input.route.routeId);
    } catch (error) {
      throw new PortError('SEGMENT_ROUTE_UNUSABLE', message(error), { retryable: false });
    }
    // 2. 树
    await prepareSegmentTree(
      deps.tree,
      {
        repo: input.repo,
        worktreePath: input.worktreePath,
        branch: input.branch,
        baseSha: input.baseSha,
        user: routeInfo.user,
        runId: newRunId(),
      },
      ctx,
    );
    // 3. 提示词
    const prompt = renderSegmentPrompt({
      brief: manualBriefOf(input.brief, { branch: input.branch, baseSha: input.baseSha }),
      specDir: input.brief.specDir,
      feedback: input.feedback,
    });
    // 4. 起会话。叫停（ctx.signal）接进会话的看守。
    const stopSignal = ctx.signal;
    const beat = setInterval(() => ctx.heartbeat(), heartbeatEveryMs);
    const started = now().getTime();
    let result: OneShotResult;
    try {
      for (;;) {
        const runId = newRunId();
        try {
          result = await runOneShot(
            {
              runId,
              segment: 'manual',
              modelId: input.route.modelId,
              channel: routeInfo.route.channelId,
              issueNumber: input.issueNumber,
              prompt,
              cwd: input.worktreePath,
              timeoutMinutes: input.timeoutMinutes,
              routeId: input.route.routeId,
              effort: input.tier.effort,
            },
            {
              spawn: (cmd) => spawner({ ...cmd, signal: AbortSignal.any([cmd.signal, stopSignal]) }),
              ...(deps.memoryAdmission ? { memoryAdmission: deps.memoryAdmission } : {}),
              tmpDir: deps.runsDir,
              runs: deps.runs,
              now,
            },
          );
        } catch (error) {
          if (stopSignal.aborted) throw stopSignal.reason ?? error;
          if (error instanceof OneShotError) {
            throw new PortError('SEGMENT_SPAWN_FAILED', error.message, { retryable: false });
          }
          throw error;
        }
        if (stopSignal.aborted) throw stopSignal.reason ?? new Error('被叫停了');
        if (result.outcome !== 'admission_blocked') break;
        if (now().getTime() - started >= admissionWaitMs) break;
        ctx.heartbeat();
        await sleep(admissionPollMs, stopSignal);
      }
    } finally {
      clearInterval(beat);
    }
    void sweepRunDirs(deps.runsDir, now(), SESSION_ARTIFACT_TTL_MS, log);

    if (result.outcome === 'done') {
      return {
        ok: true,
        runId: result.runId,
        answer: result.stdout,
        ...(result.facts?.costUsd === undefined ? {} : { costUsd: result.facts.costUsd }),
        ...(result.facts?.actualModel === undefined ? {} : { actualModel: result.facts.actualModel }),
      };
    }
    return { ok: false, runId: result.runId, outcome: result.outcome, evidence: evidenceOf(result) };
  };
}
