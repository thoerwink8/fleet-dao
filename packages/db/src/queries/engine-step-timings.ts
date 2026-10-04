// 执行计时：工作流里每次活动、每段等待记一笔，重复的一笔（活动重试重写）不报错。
import { sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { stepTimings } from '../schema/index.ts';

export type StepTimingInput =
  | {
      kind: 'activity';
      workflowId: string;
      temporalRunId: string;
      workflowType: string;
      activity: string;
      attempt: number;
      taskId?: string;
      subtaskId?: string;
      subtaskKey?: string;
      scheduledAt: Date;
      startedAt: Date;
      endedAt: Date;
      queueMs: number;
      runMs: number;
      outcome: 'ok' | 'failed' | 'cancelled';
      errorCode?: string;
    }
  | {
      kind: 'wait';
      workflowId: string;
      temporalRunId: string;
      workflowType: string;
      waitFor: string;
      detail: string;
      taskId?: string;
      subtaskId?: string;
      subtaskKey?: string;
      startedAt: Date;
      endedAt: Date;
      waitMs: number;
    };

/** 重复的一笔（活动重试重写）返回 'duplicate'，不报错。 */
export async function recordStepTiming(db: Db, input: StepTimingInput): Promise<'written' | 'duplicate'> {
  const common = {
    kind: input.kind,
    workflowId: input.workflowId,
    temporalRunId: input.temporalRunId,
    workflowType: input.workflowType,
    taskId: input.taskId ?? null,
    subtaskId: input.subtaskId ?? null,
    subtaskKey: input.subtaskKey ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
  const [row] =
    input.kind === 'activity'
      ? await db
          .insert(stepTimings)
          .values({
            ...common,
            activity: input.activity,
            attempt: input.attempt,
            scheduledAt: input.scheduledAt,
            queueMs: input.queueMs,
            runMs: input.runMs,
            outcome: input.outcome,
            errorCode: input.errorCode ?? null,
          })
          .onConflictDoNothing({
            target: [
              stepTimings.workflowId,
              stepTimings.temporalRunId,
              stepTimings.activity,
              stepTimings.attempt,
              stepTimings.scheduledAt,
            ],
            where: sql`kind = 'activity'`,
          })
          .returning({ id: stepTimings.id })
      : await db
          .insert(stepTimings)
          .values({ ...common, waitFor: input.waitFor, detail: input.detail, waitMs: input.waitMs })
          .onConflictDoNothing({
            target: [
              stepTimings.workflowId,
              stepTimings.temporalRunId,
              stepTimings.waitFor,
              stepTimings.startedAt,
            ],
            where: sql`kind = 'wait'`,
          })
          .returning({ id: stepTimings.id });
  return row ? 'written' : 'duplicate';
}
