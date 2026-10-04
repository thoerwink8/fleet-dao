// 定时读额度的真接线（#76）：配置读额度配置文件（adapters 的 loadQuotaConfig，路径可由环境变量换），读各池用 adapters 的
// readAllQuotas，读成的经 savePoolQuota 写库（额度账的唯一写入口），提醒走 upsertAlert / resolveAlertByKey，结局记进 schedule_runs。
// 改这里之前必须知道：
// - 读取用的是引擎进程自己的身份和家目录（productionQuotaIo）：要会话用户的登录态才读得到的池（独享组织的 /usage）读不到时
//   报 not_current / no_credentials，由 jobs/quota-read.ts 按规矩处理（not_current 不报警、凭据类当场报），不在这里绕。
// - 估算类的池的用量记录（usageRecords）读这个池路由上的会话，Fusion 的（session_runs）和三段的一次性会话（runs）都算（db 的
//   pool-runs.ts，#758）；runs 读不了照抛（这个池没读成），不拿 Fusion 那一半当全部。没记到花费的会话不进记录（不拿 0 冒充），
//   估算读取器对「一条记录都没有」自己写「0 只是下限」。池自己配了日账目录（usage）的不走这里。
import {
  loadQuotaConfig,
  productionQuotaIo,
  type QuotaDeps,
  readAllQuotas,
  type UsageRecord,
  type UsageSource,
} from '@fleet-dao/adapters/quota';
import {
  type Db,
  finishScheduleRun,
  type PoolRunUsage,
  poolLastReadOk,
  poolRunUsage,
  resolveAlertByKey,
  savePoolQuota,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import type { QuotaReadJobDeps } from '../jobs/quota-read.ts';

export interface QuotaReadWiring {
  db: Db;
  now?: () => Date;
  log?: QuotaReadJobDeps['log'];
  /** 测试用：换掉读配置、读额度的外部能力。 */
  loadConfig?: QuotaReadJobDeps['loadConfig'];
  quotaDeps?: QuotaDeps;
}

/** 会话用量转成估算读取器要的记录：花费为空的会话跳过（它没记到钱，按 0 算就是编数）。 */
export function usageRecordsFrom(poolId: string, rows: readonly PoolRunUsage[]): UsageRecord[] {
  return rows.flatMap((r) =>
    r.costUsd === null
      ? []
      : [
          {
            poolId,
            at: r.startedAt.toISOString(),
            modelId: r.modelId,
            ...(r.inputTokens !== null ? { inputTokens: r.inputTokens } : {}),
            ...(r.outputTokens !== null ? { outputTokens: r.outputTokens } : {}),
            ...(r.cacheReadTokens !== null ? { cacheReadTokens: r.cacheReadTokens } : {}),
            ...(r.cacheWriteTokens !== null ? { cacheWriteTokens: r.cacheWriteTokens } : {}),
            costUsd: r.costUsd,
          },
        ],
  );
}

export function sessionUsageSource(db: Db): UsageSource {
  return async (q) => usageRecordsFrom(q.poolId, await poolRunUsage(db, q));
}

/** 给 EngineJobs.quotaRead 用的工厂。 */
export function quotaReadJob(w: QuotaReadWiring): () => QuotaReadJobDeps {
  const now = w.now ?? (() => new Date());
  const log: QuotaReadJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return () => ({
    loadConfig: w.loadConfig ?? (() => loadQuotaConfig()),
    read: (config) =>
      readAllQuotas(
        config,
        w.quotaDeps ?? { ...productionQuotaIo(), now, usageRecords: sessionUsageSource(w.db) },
      ),
    save: (snapshot, at) => savePoolQuota(w.db, snapshot, { now: at }),
    lastReadOk: (ids) => poolLastReadOk(w.db, ids),
    raise: (a) =>
      upsertAlert(w.db, {
        dedupeKey: a.key,
        level: 'alert',
        taskId: null,
        title: a.title,
        body: a.body,
      }).then(() => undefined),
    resolve: (key) => resolveAlertByKey(w.db, { dedupeKey: key, by: 'engine' }).then(() => undefined),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
