// 真执行驱动（#3783，第 7 片）：把冻结的真执行批次里的单变成派工请求，写进 `real-<批次>` 会话流，派工器照常收、照常起工人。
// 和影子驱动（shadow-driver.ts）的差别只有两处：派之前先在旧库认领这张单（acquireTask，owner = harness，拿所有权令牌），
// 请求里带 real（批次、仓、单号、基线、令牌、PR 标题）。认领不到（旧系统手上有）就不派，也不记回执，下一轮再看。
// 同一张单只派一次：回执和请求在同一个事务里写，重跑、两个驱动并发都只出一条。
import { randomUUID } from 'node:crypto';
import { appendToSession } from '@fleet-dao/harness-api';
import type { SpawnWorkerInput, TaskRef } from '@fleet-dao/harness-contract';
import {
  type BatchItem,
  commandReceipts,
  type Db,
  listRealBatchItems,
  onceByReceipt,
} from '@fleet-dao/harness-store';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { RealTarget } from './prompt.ts';
import type { AcquireResult } from './task-claim.ts';

type Six = { [K in keyof typeof SpawnWorkerInput]: z.infer<(typeof SpawnWorkerInput)[K]> };

/** 真执行派工请求所在的会话号；派工器把交回记进同一条流。 */
export const realSessionId = (batchId: string) => `real-${batchId}`;

export interface RealEnqueueResult {
  requested: number;
  already: number;
  /** 认领不到、这一轮没派的：旧系统手上有、仓不认识。 */
  skipped: { repo: string; issue: number; why: string }[];
}

/** 单标题：taskFor 给的 task 是「做 owner/仓#号：标题」，PR 标题用冒号后面那段。 */
export function titleOf(six: Pick<Six, 'task'>): string {
  const m = /^做 [^：]+：(.+)$/s.exec(six.task.trim());
  return (m?.[1] ?? six.task).trim().slice(0, 200) || six.task.slice(0, 200);
}

export async function enqueueRealBatch(
  db: Db,
  batchId: string,
  taskFor: (item: BatchItem) => Promise<Six>,
  acquire: (ref: TaskRef, title: string) => Promise<AcquireResult>,
  opts: {
    pageSize?: number;
    /**
     * 认领不到的单歇一会儿再看，免得旧系统一直占着时每个节拍都去读一遍 GitHub 的单（旧坑 E1）。
     * until 是进程内的「几点之前别再试」，重启就清零，不是状态。
     */
    pause?: { until: Map<string, number>; ms: number; now?: () => number };
  } = {},
): Promise<RealEnqueueResult> {
  const out: RealEnqueueResult = { requested: 0, already: 0, skipped: [] };
  const sessionId = realSessionId(batchId);
  const pageSize = opts.pageSize ?? 50;
  let after: { repo: string; issue: number } | undefined;
  for (;;) {
    const page = await listRealBatchItems(db, batchId, after, pageSize);
    for (const item of page) {
      const key = `real-spawn:${batchId}:${item.repo}#${item.issue}`;
      const [seen] = await db
        .select({ key: commandReceipts.key })
        .from(commandReceipts)
        .where(eq(commandReceipts.key, key));
      if (seen) {
        out.already++;
        continue;
      }
      const now = opts.pause?.now?.() ?? Date.now();
      if ((opts.pause?.until.get(key) ?? 0) > now) continue;
      const six = await taskFor(item);
      const title = titleOf(six);
      const got = await acquire({ repo: item.repo, issue: item.issue }, title);
      if (!got.ok) {
        out.skipped.push({ repo: item.repo, issue: item.issue, why: got.why });
        opts.pause?.until.set(key, now + opts.pause.ms);
        continue;
      }
      opts.pause?.until.delete(key);
      const real: RealTarget = {
        batchId,
        repo: item.repo,
        issue: item.issue,
        baseSha: item.baseSha,
        fencing: got.fencing,
        title,
      };
      const { replayed } = await onceByReceipt(db, key, 'real-spawn', async (tx) => {
        const ev = await appendToSession(tx, sessionId, 'worker.spawn.requested', {
          taskId: randomUUID(),
          ...six,
          real,
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
