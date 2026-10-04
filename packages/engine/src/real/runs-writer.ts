// 三段（对题 / 动手 / 验收）每跑一次记一笔 runs（#556-6）：和 packages/engine/src/runner/not-wired.ts
// 同一个合约（RunsWriter），装配处起 runOneShot 时把 notWiredRuns() 换成它。
// 开跑先写一行没结束的（start），收场按同一个编号整行补完（record）：切号数带组织类型的池上还没结束的会话靠开跑那一行（#157）。
//
// 改这里之前必须知道：
// - 写之前照合约的 zod 形状挡一道（和 NotWired 占位同一份）：形状不对的不碰库，抛 RunInputError。
// - 收场是整行覆盖（db 的 startRun 按编号整行写）：记到谁名下的那几列（单子、单号、派工档、工作流、PR、分支，#216）
//   开跑、收场两次都要写，漏一样就被冲成空。没给的写 NULL，不拿 0、空串顶。
import type { Db, RunInsert } from '@fleet-dao/db';
import { startRun as startRunDb } from '@fleet-dao/db';
import type { z } from 'zod';
import {
  type RunRecord,
  RunRecordSchema,
  type RunStart,
  RunStartSchema,
  type RunsWriter,
} from '../runner/not-wired.ts';

export type { RunsWriter };

export function realRuns(deps: { db: Db }): RunsWriter {
  return {
    async start(input: RunStart) {
      const run = parsed(RunStartSchema.safeParse(input), 'runs 开跑那一行');
      await write(deps.db, columns(run), 'runs 开跑那一行写入失败');
    },
    async record(input: RunRecord) {
      const run = parsed(RunRecordSchema.safeParse(input), 'runs 这一笔');
      await write(
        deps.db,
        {
          ...columns(run),
          endedAt: new Date(run.endedAt),
          outcome: run.outcome,
          inputTokens: run.inputTokens ?? null,
          outputTokens: run.outputTokens ?? null,
          cacheReadTokens: run.cacheReadTokens ?? null,
          cacheWriteTokens: run.cacheWriteTokens ?? null,
          costUsd: run.costUsd ?? null,
          memoryPeakMb: run.memoryPeakMb ?? null,
          failureReason: run.failureReason ?? null,
        },
        'runs 写入失败',
      );
    },
  };
}

/** 开跑、收场都写的那几列。 */
function columns(run: RunStart): RunInsert {
  return {
    id: run.runId,
    segment: run.segment,
    taskId: run.taskId,
    issueNumber: run.issueNumber,
    model: run.model,
    channel: run.channel,
    routeId: run.routeId,
    tier: run.tier,
    workflowId: run.workflowId,
    prNumber: run.prNumber,
    branch: run.branch,
    startedAt: new Date(run.startedAt),
  };
}

function parsed<T>(result: z.ZodSafeParseResult<T>, what: string): T {
  if (result.success) return result.data;
  const why = result.error.issues.map((i) => `${i.path.join('.') || '整行'}：${i.message}`).join('；');
  throw new RunInputError(`${what}形状不对，没写进库：${why}`, { cause: result.error });
}

async function write(db: Db, row: RunInsert, failed: string): Promise<void> {
  try {
    await startRunDb(db, row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunInputError(`${failed}：${message}`, { cause: error });
  }
}

export class RunInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunInputError';
  }
}
