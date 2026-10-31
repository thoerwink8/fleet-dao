// 影子驱动（#3808）：把冻结批次里的单变成派工请求，写进 `shadow-<批次>` 这条会话流，派工器照常收、照常起工人。
// 请求里带 shadow（批次、仓、单号、基线），指挥官的 spawn_worker 入参里没有它；同一张单只派一次：
// 回执和请求在同一个事务里写，重跑、两个驱动并发都只出一条。影子的同时在跑数、池紧先停由派工器的队列限速和部署管，这里只排。
import { randomUUID } from 'node:crypto';
import { appendToSession } from '@fleet-dao/harness-api';
import type { SpawnWorkerInput } from '@fleet-dao/harness-contract';
import {
  type BatchItem,
  commandReceipts,
  type Db,
  listBatchItems,
  onceByReceipt,
} from '@fleet-dao/harness-store';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { ShadowTarget } from './prompt.ts';

type Six = { [K in keyof typeof SpawnWorkerInput]: z.infer<(typeof SpawnWorkerInput)[K]> };

/** 影子派工请求所在的会话号；派工器把交回记进同一条流。 */
export const shadowSessionId = (batchId: string) => `shadow-${batchId}`;

export interface ShadowEnqueueResult {
  requested: number;
  already: number;
}

/**
 * 给一批里还没派过的单各写一条派工请求。taskFor 把单变成六项指示（读单的快照由部署做，只读 GitHub），
 * 只对没派过的单调；它抛错就整轮停下照抛，这张单没记回执，下一轮再来。
 */
export async function enqueueShadowBatch(
  db: Db,
  batchId: string,
  taskFor: (item: BatchItem) => Promise<Six>,
  opts: { pageSize?: number } = {},
): Promise<ShadowEnqueueResult> {
  const out: ShadowEnqueueResult = { requested: 0, already: 0 };
  const sessionId = shadowSessionId(batchId);
  const pageSize = opts.pageSize ?? 50;
  let after: { repo: string; issue: number } | undefined;
  for (;;) {
    const page = await listBatchItems(db, batchId, after, pageSize);
    for (const item of page) {
      const key = `shadow-spawn:${batchId}:${item.repo}#${item.issue}`;
      const [seen] = await db
        .select({ key: commandReceipts.key })
        .from(commandReceipts)
        .where(eq(commandReceipts.key, key));
      if (seen) {
        out.already++;
        continue;
      }
      const six = await taskFor(item);
      const shadow: ShadowTarget = { batchId, repo: item.repo, issue: item.issue, baseSha: item.baseSha };
      const { replayed } = await onceByReceipt(db, key, 'shadow-spawn', async (tx) => {
        const ev = await appendToSession(tx, sessionId, 'worker.spawn.requested', {
          taskId: randomUUID(),
          ...six,
          shadow,
        });
        return { eventId: ev.id };
      });
      if (replayed) out.already++;
      else out.requested++;
    }
    const last = page.at(-1);
    if (!last || page.length < pageSize) return out;
    after = { repo: last.repo, issue: last.issue };
  }
}
