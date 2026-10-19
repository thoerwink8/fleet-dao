import { type Db, taskExecutionOperations } from '@fleet-dao/db';
import type { ExecutionOperation } from '../src/task-execution.ts';

export async function readExecutionOperations(db: Db): Promise<ExecutionOperation[]> {
  return (await db.select().from(taskExecutionOperations)).map(
    ({ id, createdAt, updatedAt, dispatchedAt, admittedAt, resolvedAt, ...row }) => ({
      ...row,
      operationId: id,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      dispatchedAt: dispatchedAt?.toISOString() ?? null,
      admittedAt: admittedAt?.toISOString() ?? null,
      resolvedAt: resolvedAt?.toISOString() ?? null,
    }),
  );
}
