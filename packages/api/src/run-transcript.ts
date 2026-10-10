// 任务详情每一段的「会话内容」（#1640）：GET /tasks/:taskId/runs/:runId/transcript?after=<seq>&limit=<n>。
// 引擎在三段会话跑的时候按条记进 run_transcript（db 的 queries/run-transcript.ts），这里按序号往后读，在跑的段页面拿 nextAfter 增量刷新。
// 改这里之前必须知道：
// - 只给登录的创始人读：路由在驾驶舱的登录门后面，飞书网关通行证只放 shared 的 FEISHU_GATEWAY_WEB_ROUTES 里列的，这条不在其中。
// - runId 必须是这张单自己的一段（store.listSegmentRuns 里有），串到别的单的 runId 回 404，不泄漏别的单的过程。
// - 「这一段没有记录」和「读不到」分开：段已经结束、库里一条都没有 = 200 + noRecord:true（它跑在记录之前）；
//   库读不了、这里没接上（开发环境的内存版没有那张表）= 503 写明原因，页面写「没读成」，不拿空列表顶。
// - 在跑的段 done 恒为 false，entries 空也不算 noRecord（引擎攒批最多隔一两秒才写，页面等下一次刷新）。

import { type Db, readRunTranscript } from '@fleet-dao/db';
import { RunTranscriptQuery, RunTranscriptResponse, WebRoutes } from '@fleet-dao/shared';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, fullStack, readQuery, reply } from './http.ts';
import type { CockpitEnv } from './session.ts';

export interface RunTranscriptPort {
  /** seq 大于 after 的条目（不给从头）；读不到抛。 */
  read(
    runId: string,
    opts: { after?: number | undefined; limit: number },
  ): ReturnType<typeof readRunTranscript>;
}

export function pgRunTranscript(db: Db): RunTranscriptPort {
  return { read: (runId, opts) => readRunTranscript(db, runId, opts) };
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
}
