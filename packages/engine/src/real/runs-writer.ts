// 三段（对题 / 动手 / 验收）每跑一次记一笔 runs（#556-6）：和 packages/engine/src/runner/not-wired.ts
// 同一个合约（RunsWriter），装配处起 runOneShot 时把 notWiredRuns() 换成它。
// 开跑先写一行没结束的（start），收场按同一个编号整行补完（record）：切号数带组织类型的池上还没结束的会话靠开跑那一行（#157）。
import type { Db } from '@fleet-dao/db';
import { startRun as startRunDb } from '@fleet-dao/db';
import type { RunRecord, RunStart, RunsWriter } from '../runner/not-wired.ts';

export type { RunsWriter };

export function realRuns(deps: { db: Db }): RunsWriter {
  return {
    async start(run: RunStart) {
      if (run.runId === '') throw new RunInputError('runId 是空的');
      if (!run.startedAt) throw new RunInputError('startedAt 是空的');
      try {
        await startRunDb(deps.db, {
          id: run.runId,
          segment: run.segment,
          model: run.model,
          channel: run.channel,
          routeId: run.routeId,
          issueNumber: run.issueNumber,
          startedAt: new Date(run.startedAt),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RunInputError(`runs 开跑那一行写入失败：${message}`, { cause: error });
      }
    },
    async record(run: RunRecord) {
      if (run.runId === '') throw new RunInputError('runId 是空的');
      if (!run.startedAt) throw new RunInputError('startedAt 是空的');
      if (run.outcome != null && !run.endedAt) throw new RunInputError('失败的要 ended_at');
      if (run.endedAt != null && run.outcome == null) throw new RunInputError('结束的要 outcome');
      try {
        await startRunDb(deps.db, {
          id: run.runId,
          segment: run.segment,
          model: run.model,
          channel: run.channel,
          routeId: run.routeId,
          issueNumber: run.issueNumber,
          startedAt: new Date(run.startedAt),
          endedAt: new Date(run.endedAt),
          outcome: run.outcome,
          inputTokens: run.inputTokens ?? null,
          outputTokens: run.outputTokens ?? null,
          cacheReadTokens: run.cacheReadTokens ?? null,
          cacheWriteTokens: run.cacheWriteTokens ?? null,
          costUsd: run.costUsd ?? null,
          memoryPeakMb: run.memoryPeakMb ?? null,
          failureReason: run.failureReason ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RunInputError(`runs 写入失败：${message}`, { cause: error });
      }
    },
  };
}

export class RunInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunInputError';
  }
}
