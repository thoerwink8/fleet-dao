// 任务详情每一段的「会话内容」（#1640）：GET /tasks/:taskId/runs/:runId/transcript?after=<seq>&limit=<n>。
// 引擎在三段会话跑的时候按条记进 run_transcript（db 的 queries/run-transcript.ts），这里按序号往后读，在跑的段页面拿 nextAfter 增量刷新。
// 改这里之前必须知道：
// - 只给登录的创始人读：路由在驾驶舱的登录门后面，飞书网关通行证只放 shared 的 FEISHU_GATEWAY_WEB_ROUTES 里列的，这条不在其中。
// - runId 必须是这张单自己的一段（store.listSegmentRuns 里有），串到别的单的 runId 回 404，不泄漏别的单的过程。
// - 「这一段没有记录」和「读不到」分开：段已经结束、库里一条都没有 = 200 + noRecord:true（它跑在记录之前）；
//   库读不了、这里没接上（开发环境的内存版没有那张表）= 503 写明原因，页面写「没读成」，不拿空列表顶。
// - 在跑的段 done 恒为 false，entries 空也不算 noRecord（引擎攒批最多隔一两秒才写，页面等下一次刷新）。

import {
  type Db,
  listTaskEngineSteps,
  listTaskRounds,
  readLatestPrHeadFiles,
  readRunLastSay,
  readRunProcessRows,
  readRunTallies,
  readRunTranscript,
} from '@fleet-dao/db';
import {
  cutSteps,
  RunStepsResponse,
  RunTranscriptQuery,
  RunTranscriptResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, fullStack, readQuery, reply } from './http.ts';
import type { CockpitEnv } from './session.ts';
import { isTaskFinished } from './views.ts';

export interface RunTranscriptPort {
  /** seq 大于 after 的条目（不给从头）；读不到抛。 */
  read(
    runId: string,
    opts: { after?: number | undefined; limit: number },
  ): ReturnType<typeof readRunTranscript>;
  /** 一笔的轻量行（切步用，#3140）；一条都没有返回空数组；读不到抛。 */
  processRows(runId: string): ReturnType<typeof readRunProcessRows>;
  /** 几笔的小计，一条 GROUP BY run_id；没记录的笔不在结果里；读不到抛。 */
  tallies(runIds: readonly string[]): ReturnType<typeof readRunTallies>;
  /** 一笔最后一条主会话助手的话（最新汇报）；没有返回 null；读不到抛。 */
  lastSay(runId: string): ReturnType<typeof readRunLastSay>;
  /** 这张单的回合（task_rounds）；读不到抛。 */
  rounds(taskId: string): ReturnType<typeof listTaskRounds>;
  /** 引擎在会话外做的事和等待（step_timings）；读不到抛。 */
  engineSteps(taskId: string): ReturnType<typeof listTaskEngineSteps>;
  /** 这个 PR 最新一个头的文件清单（pr_head_files，按头记的 numstat）；一次都没记过返回 null；读不到抛。 */
  prFiles(repoId: string, prNumber: number): ReturnType<typeof readLatestPrHeadFiles>;
}

export function pgRunTranscript(db: Db): RunTranscriptPort {
  return {
    read: (runId, opts) => readRunTranscript(db, runId, opts),
    processRows: (runId) => readRunProcessRows(db, runId),
    tallies: (runIds) => readRunTallies(db, runIds),
    lastSay: (runId) => readRunLastSay(db, runId),
    rounds: (taskId) => listTaskRounds(db, taskId),
    engineSteps: (taskId) => listTaskEngineSteps(db, taskId),
    prFiles: (repoId, prNumber) => readLatestPrHeadFiles(db, repoId, prNumber),
  };
}

/** 开发环境、内存版：没有这张表。 */
export const RUN_TRANSCRIPT_NOT_HERE =
  '会话内容没接上：这里是开发环境的内存版，没有 run_transcript 这张表，真库上才有';

export function registerRunTranscriptRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  app.get(WebRoutes.runTranscript.path, async (c) => {
    const taskId = c.req.param('taskId');
    const runId = c.req.param('runId');
    const query = readQuery(c, RunTranscriptQuery);
    const task = await deps.store.getTask(taskId);
    if (!task) throw new ApiError(404, 'task_not_found', '没有这个任务');
    const segment = (await deps.store.listSegmentRuns(task.id)).find((r) => r.id === runId);
    if (!segment) throw new ApiError(404, 'run_not_found', '这张单下没有这一段');
    if (!deps.runTranscript) throw new ApiError(503, 'run_transcript_not_wired', RUN_TRANSCRIPT_NOT_HERE);
    let page: Awaited<ReturnType<RunTranscriptPort['read']>>;
    try {
      page = await deps.runTranscript.read(runId, { after: query.after, limit: query.limit });
    } catch (err) {
      deps.log.error('会话内容没读成', { taskId, runId, error: fullStack(err) });
      throw new ApiError(
        503,
        'run_transcript_unreadable',
        `没读成：${(err instanceof Error && err.message) || String(err)}`,
      );
    }
    const ended = segment.endedAt !== undefined;
    const last = page.entries.at(-1);
    return reply(c, RunTranscriptResponse, {
      entries: page.entries.map((e) => ({
        seq: e.seq,
        at: e.at.toISOString(),
        kind: e.kind,
        text: e.text,
        ...(e.tool === undefined ? {} : { tool: e.tool }),
        ...(e.ok === undefined ? {} : { ok: e.ok }),
        ...(e.meta === undefined ? {} : { meta: e.meta }),
      })),
      nextAfter: last ? last.seq : (query.after ?? null),
      done: ended && !page.more,
      noRecord: ended && !page.any,
    });
  });

  // 一笔切好的步骤和小计（#3140）：由这一笔的轻量行现算（shared 的 cutSteps），不建步骤表。权限、归属、503 的口径和上面一致。
  app.get(WebRoutes.runProcess.path, async (c) => {
    const taskId = c.req.param('taskId');
    const runId = c.req.param('runId');
    const task = await deps.store.getTask(taskId);
    if (!task) throw new ApiError(404, 'task_not_found', '没有这个任务');
    const segment = (await deps.store.listSegmentRuns(task.id)).find((r) => r.id === runId);
    if (!segment) throw new ApiError(404, 'run_not_found', '这张单下没有这一段');
    if (!deps.runTranscript) throw new ApiError(503, 'run_transcript_not_wired', RUN_TRANSCRIPT_NOT_HERE);
    let rows: Awaited<ReturnType<RunTranscriptPort['processRows']>>;
    try {
      rows = await deps.runTranscript.processRows(runId);
    } catch (err) {
      deps.log.error('这一笔的步骤没读成', { taskId, runId, error: fullStack(err) });
      throw new ApiError(
        503,
        'run_steps_unreadable',
        `没读成：${(err instanceof Error && err.message) || String(err)}`,
      );
    }
    // 在跑：没结束、单子也没结束（和任务详情里 segmentRuns 的 running 同一个判法）
    const running = segment.endedAt === undefined && !isTaskFinished(task);
    if (rows.length === 0 && !running) return reply(c, RunStepsResponse, { state: 'noRecord' });
    return reply(c, RunStepsResponse, {
      state: 'ok',
      running,
      process: cutSteps(rows, { running, endedAt: segment.endedAt }),
    });
  });
}
