// 引擎续停（#3294）的真装配：列 stalled 的引擎任务读库（和看门狗叫醒点名不一致同一个 listStalledEngineTasks），
// 停法、编号现问工作流（taskStatus 查询），法国在用版本读发布目录的 current 链接（链接本身的修改时刻就是切过去的时刻：
// deploy/release.sh 每次切版本都是新建链接再 mv -T 换上），现读 PR 用任务活动的 mergeReady（和停在合并这一步自己复核同一份），
// 「继续」经 Temporal 发，操作记录经 Store.appendAudit 写成引擎那一类；这一次停下的提醒（工作流报的 <编号>:park:<第几次>）一并撤掉。
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Db,
  finishScheduleRun,
  listStalledEngineTasks,
  resolveAlertWithReason,
  startScheduleRun,
} from '@fleet-dao/db';
import { RELEASES_DIR, type Store } from '@fleet-dao/store';
import type { Client } from '@temporalio/client';
import { PARKED_RETRY_AUDIT, type ParkedRetryDeps, type ReleaseFact } from '../jobs/parked-retry.ts';
import { PARKED_RETRY_ACTOR, taskContinueSignal, taskStatusQuery } from '../task-contract.ts';
import { isWorkflowGone } from './route-wake.ts';

// 新 worker 的首次查询会重放停着的历史（#3659）；只读查询给 30 秒，发继续仍限 5 秒。
const QUERY_TIMEOUT_MS = 30_000;
const SIGNAL_TIMEOUT_MS = 5_000;

const errno = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/** 法国在用的版本：current 指向的提交号和链接切过去的时刻。目录或链接不在（这台不是法国）回 null；别的错照抛。 */
export async function readCurrentRelease(dir: string): Promise<ReleaseFact | null> {
  const link = join(dir, 'current');
  try {
    const target = await readlink(link);
    const sha = target.split('/').pop() ?? target;
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    return { sha, at: (await lstat(link)).mtime };
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'EINVAL') return null;
    throw e;
  }
}

export interface ParkedRetryWiring {
  db: Db;
  temporal: { use<T>(fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>): Promise<T> };
  store: Pick<Store, 'appendAudit'>;
  mergeReady: ParkedRetryDeps['mergeReady'];
  releasesDir?: string;
  now?: () => Date;
  log?: ParkedRetryDeps['log'];
}

export function parkedRetryJob(w: ParkedRetryWiring): () => ParkedRetryDeps {
  const now = w.now ?? (() => new Date());
  const log: ParkedRetryDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const withDeadline = <T>(
    timeoutMs: number,
    fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>,
  ) => w.temporal.use((client) => client.connection.withDeadline(Date.now() + timeoutMs, () => fn(client)));
  return () => ({
    tasks: () => listStalledEngineTasks(w.db),
    async status(workflowId) {
      try {
        const s = await withDeadline(QUERY_TIMEOUT_MS, (client) =>
          client.workflow.getHandle(workflowId).query(taskStatusQuery),
        );
        return { phase: s.phase, prNumber: s.prNumber, park: s.park };
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
    release: () => readCurrentRelease(w.releasesDir ?? RELEASES_DIR),
    mergeReady: w.mergeReady,
    async continueTask(workflowId, command) {
      try {
        await withDeadline(SIGNAL_TIMEOUT_MS, (client) =>
          client.workflow.getHandle(workflowId).signal(taskContinueSignal, command),
        );
        return 'sent';
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
    async audit({ row, workflowId, park, why }) {
      const ref = `${row.owner}/${row.name}#${row.issueNumber}`;
      await w.store.appendAudit({
        actor: { kind: 'engine', id: PARKED_RETRY_ACTOR },
        action: PARKED_RETRY_AUDIT,
        target: `issue:${ref}`,
        after: { taskId: row.taskId, workflowId, parkKind: park.kind, parkSeq: park.seq, title: park.title },
        reason: why,
        via: 'engine',
        ok: true,
      });
    },
    async resolveAlert({ workflowId, park, why }) {
      await resolveAlertWithReason(w.db, {
        dedupeKey: `${workflowId}:park:${park.seq}`,
        by: PARKED_RETRY_ACTOR,
        why,
        at: now(),
      });
    },
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
