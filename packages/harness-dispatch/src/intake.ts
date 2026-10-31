// 收派工请求：从检查点往后分页读 worker.spawn.requested，每条排一件活到队列 worker。
// 活的键由事件号定（spawn:<事件号>），再来一遍排不出第二件；同一个会话里同一个 taskId 再来也只算一次（命令回执）。
// 读页、排活、推检查点在同一个事务里：中途崩了下次从检查点接着走，检查点丢了也靠键挡住重复。
import { readSessionByTask } from '@fleet-dao/harness-api';
import {
  cancelJob,
  type Db,
  events,
  onceByReceipt,
  PAGE_MAX,
  projectionCheckpoints,
  schedule,
  setQueueLimit,
} from '@fleet-dao/harness-store';
import { and, asc, eq, gt } from 'drizzle-orm';
import { parseSpawnRequest, type SpawnRequest } from './prompt.ts';

export const WORKER_QUEUE = 'worker';
export const SPAWN_CHECKPOINT = 'dispatch.spawn.requested';
export const STOP_CHECKPOINT = 'dispatch.stop.requested';

export const spawnJobKey = (eventId: number): string => `spawn:${eventId}`;

/** 排进活里的内容：够起一个工人，不依赖再读原事件。 */
export interface DispatchPayload extends Record<string, unknown> {
  sessionId: string;
  eventId: number;
  taskId: string;
  request: SpawnRequest;
}

export interface IntakeOptions {
  pageSize?: number;
  maxAttempts?: number;
  /** 活从排进去起多久后截止（毫秒），含排队等位的时间；默认 12 小时。 */
  jobTtlMs?: number;
}

export interface IntakeResult {
  scheduled: number;
  /** 键或 taskId 已经排过，没再排。 */
  duplicate: number;
  /** 载荷不合契约、流名不是会话流，跳过。 */
  skipped: number;
}

export async function registerWorkerQueue(db: Db, maxInflight: number, perMinute: number): Promise<void> {
  await setQueueLimit(db, WORKER_QUEUE, maxInflight, perMinute);
}

async function pageOfType(
  tx: Db,
  checkpoint: string,
  type: string,
  pageSize: number,
): Promise<(typeof events.$inferSelect)[]> {
  const [cp] = await tx
    .select({ last: projectionCheckpoints.lastEventId })
    .from(projectionCheckpoints)
    .where(eq(projectionCheckpoints.name, checkpoint))
    .for('update');
  return tx
    .select()
    .from(events)
    .where(and(eq(events.type, type), gt(events.id, cp?.last ?? 0)))
    .orderBy(asc(events.id))
    .limit(Math.min(pageSize, PAGE_MAX));
}

async function moveCheckpoint(tx: Db, name: string, lastEventId: number): Promise<void> {
  await tx
    .insert(projectionCheckpoints)
    .values({ name, lastEventId })
    .onConflictDoUpdate({
      target: projectionCheckpoints.name,
      set: { lastEventId, updatedAt: new Date() },
    });
}

const sessionOf = (streamId: string): string | null =>
  streamId.startsWith('session:') && streamId.length > 'session:'.length
    ? streamId.slice('session:'.length)
    : null;

/** 读到没有新请求为止。 */
export async function intakeSpawnRequests(db: Db, opts: IntakeOptions = {}): Promise<IntakeResult> {
  const total: IntakeResult = { scheduled: 0, duplicate: 0, skipped: 0 };
  const pageSize = opts.pageSize ?? 100;
  for (;;) {
    const n = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const page = await pageOfType(tx, SPAWN_CHECKPOINT, 'worker.spawn.requested', pageSize);
      for (const e of page) {
        const sessionId = sessionOf(e.streamId);
        const request = parseSpawnRequest(e.payload);
        if (!sessionId || !request) {
          total.skipped++;
          continue;
        }
        const payload: DispatchPayload = { sessionId, eventId: e.id, taskId: request.taskId, request };
        const { result, replayed } = await onceByReceipt(
          tx,
          `dispatch:${e.streamId}:${request.taskId}`,
          'schedule-worker',
          async (t) => {
            const r = await schedule(t, {
              queue: WORKER_QUEUE,
              key: spawnJobKey(e.id),
              payload,
              deadlineInMs: opts.jobTtlMs ?? 12 * 3_600_000,
              maxAttempts: opts.maxAttempts ?? 3,
            });
            return { kind: r.kind };
          },
        );
        // 命令回执重放时回的是第一次存下的结果（kind 还是 created），所以要先看 replayed，不然重复提交会被算成又排了一件
        if (!replayed && result.kind === 'created') total.scheduled++;
        else total.duplicate++;
      }
      const last = page.at(-1)?.id;
      if (last !== undefined) await moveCheckpoint(tx, SPAWN_CHECKPOINT, last);
      return page.length;
    });
    if (n < pageSize) return total;
  }
}

/** 读指挥官的叫停请求：找到对应的活取消，领着的工人下次心跳拿到 cancelled 就停手。回取消了几件。 */
export async function intakeStopRequests(
  db: Db,
  opts: Pick<IntakeOptions, 'pageSize'> = {},
): Promise<number> {
  let cancelled = 0;
  const pageSize = opts.pageSize ?? 100;
  for (;;) {
    const n = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const page = await pageOfType(tx, STOP_CHECKPOINT, 'worker.stop.requested', pageSize);
      for (const e of page) {
        const sessionId = sessionOf(e.streamId);
        const taskId = (e.payload as { taskId?: unknown }).taskId;
        if (!sessionId || typeof taskId !== 'string') continue;
        const spawn = (await readSessionByTask(tx, sessionId, taskId)).find(
          (r) => r.type === 'worker.spawn.requested',
        );
        if (!spawn) continue;
        const reason = String((e.payload as { reason?: unknown }).reason ?? '');
        cancelled += await cancelJob(tx, spawnJobKey(spawn.id), `指挥官叫停：${reason}`.slice(0, 500));
      }
      const last = page.at(-1)?.id;
      if (last !== undefined) await moveCheckpoint(tx, STOP_CHECKPOINT, last);
      return page.length;
    });
    if (n < pageSize) return cancelled;
  }
}
