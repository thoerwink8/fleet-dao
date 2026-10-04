// 三段（对题 / 动手 / 验收）每跑一次记一笔 runs（#556-6）：和 packages/engine/src/runner/not-wired.ts
// 同一个合约（RunsWriter），装配处起 runOneShot 时把 notWiredRuns() 换成它。
// 开跑先写一行没结束的（start），收场按同一个编号整行补完（record）：切号数带组织类型的池上还没结束的会话靠开跑那一行（#157）。
//
// 改这里之前必须知道：
// - 写之前照合约的 zod 形状挡一道（和 NotWired 占位同一份）：形状不对的不碰库，抛 RunInputError。
// - 收场是整行覆盖（db 的 startRun 按编号整行写）：记到谁名下的那几列（单子、单号、派工档、工作流、PR、分支，#216）
//   开跑、收场两次都要写，漏一样就被冲成空。没给的写 NULL，不拿 0、空串顶。
// - 带路由的开跑那一行就是占上池的名额（#757）：经 db 的 admitRun 写（锁住池、把选路时预占的名额换成这一行；没预占着、池又满了
//   抛 PoolFullError，这里换成合约的 NoSlotError）。不带路由的（不经选路）照老样子直接写，不数名额——它连不到池。
// - 预占谁来放：没开跑就收场的那一段（runSegment、coldVerify 收场时调 realReservations 的 release）；开跑了的已经在 start 里
//   换掉了，放一次什么都不做。
import type { Db, RunInsert } from '@fleet-dao/db';
import { admitRun, PoolFullError, releaseReservation, startRun as startRunDb } from '@fleet-dao/db';
import type { z } from 'zod';
import {
  NoSlotError,
  type RunRecord,
  RunRecordSchema,
  type RunStart,
  RunStartSchema,
  type RunsWriter,
} from '../runner/not-wired.ts';

export type { RunsWriter };

export function realRuns(deps: { db: Db }): RunsWriter {
  return {
    async start(input: RunStart, options: { reservationId?: string } = {}) {
      const run = parsed(RunStartSchema.safeParse(input), 'runs 开跑那一行');
      const row = columns(run);
      if (run.routeId === undefined) {
        await write(deps.db, row, 'runs 开跑那一行写入失败');
        return;
      }
      try {
        await admitRun(
          deps.db,
          { ...row, id: run.runId, routeId: run.routeId, startedAt: new Date(run.startedAt) },
          options.reservationId === undefined ? {} : { reservationId: options.reservationId },
        );
      } catch (error) {
        if (error instanceof PoolFullError) throw new NoSlotError(error.message, { cause: error });
        const message = error instanceof Error ? error.message : String(error);
        throw new RunInputError(`runs 开跑那一行写入失败：${message}`, { cause: error });
      }
    },
    async record(input: RunRecord) {
      const run = parsed(RunRecordSchema.safeParse(input), 'runs 这一笔');
      await write(
        deps.db,
        {
          ...columns(run),
          endedAt: new Date(run.endedAt),
          outcome: run.outcome,
          routeOutcome: run.routeOutcome,
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

/** 选路时给一段预占的池的名额（#757）：这一段没开跑就收场了，放掉。 */
export interface SegmentReservations {
  /** 放掉这个预占；已经换成开跑那一行的、过期被收掉的，什么都不做。放不掉（库不通）照常抛，调用方记日志。 */
  release(reservationId: string): Promise<void>;
}

export function realReservations(deps: { db: Db }): SegmentReservations {
  return {
    async release(reservationId) {
      await releaseReservation(deps.db, reservationId);
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
