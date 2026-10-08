// 定时读额度的真接线（#76）：配置读额度配置文件（adapters 的 loadQuotaConfig，路径可由环境变量换），读各池用 adapters 的
// readAllQuotas，读成的经 savePoolQuota 写库（额度账的唯一写入口），提醒走 upsertAlert / resolveAlertByKey，结局记进 schedule_runs。
// 改这里之前必须知道：
// - 读取用的是引擎进程自己的身份和家目录（productionQuotaIo）。例外都在 asUser（real/index.ts 的 quotaAsUser）里：
//   Cursor、Grok 的登录文件经 exec 以会话用户 cat（#1195）；Mirasim 经桥接以会话用户连（#1284）；独享组织的 reclaude
//   装在会话用户家里，经同一条 exec 起（引擎用户直接 spawn 是 EACCES），工作目录也建在它家里。起不来读取器报明确原因。
//   当前挂的不是这个组织时报 not_current（不报警）。其余池（拼车的 Key 文件）照旧用引擎自己的身份。
// - 估算类的池的用量记录（usageRecords）读这个池路由上的会话，Fusion 的（session_runs）和三段的一次性会话（runs）都算（db 的
//   pool-runs.ts，#758）；runs 读不了照抛（这个池没读成），不拿 Fusion 那一半当全部。没记到花费的会话不进记录（不拿 0 冒充），
//   估算读取器对「一条记录都没有」自己写「0 只是下限」。池自己配了日账目录（usage）的不走这里。
import type { MirasimWire } from '@fleet-dao/adapters';
import { readChannelModelRosters } from '@fleet-dao/adapters/model-roster';
import {
  loadQuotaConfig,
  productionQuotaIo,
  type QuotaDeps,
  type QuotaIo,
  type RunCommand,
  readAllQuotas,
  type UsageRecord,
  type UsageSource,
} from '@fleet-dao/adapters/quota';
import {
  type Db,
  finishScheduleRun,
  MODEL_ROSTER_CHANNELS,
  modelRosterDue,
  type PoolRunUsage,
  poolLastReadOk,
  poolRunUsage,
  resolveAlertByKey,
  saveChannelModelReads,
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
  /** 测试用：换掉引擎自己的外部能力（真进程、真网络、真文件）。 */
  io?: QuotaIo;
  /** 凭据在会话用户家里的读取器改经它读文件（real/index.ts 的 quotaAsUser）。不给就都用引擎自己的身份读。 */
  asUser?: QuotaDeps['asUser'];
  /**
   * 渠道模型名册（#1302）。给了才在额度这一轮里顺手读；命令是各家执行体的启动前缀，读取器自己在后面加 models。
   * 不给就只读额度（测试、还没接线的进程）。
   */
  modelRoster?: {
    commands: {
      cursor: readonly string[];
      grok: readonly string[];
    };
    runCommand: RunCommand;
    env?: Record<string, string | undefined>;
    workDir?: () => Promise<string>;
    connectMirasim?: () => Promise<MirasimWire>;
  };
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
  const roster = w.modelRoster;
  return () => ({
    loadConfig: w.loadConfig ?? (() => loadQuotaConfig()),
    read: (config) =>
      readAllQuotas(
        config,
        w.quotaDeps ?? {
          ...(w.io ?? productionQuotaIo()),
          now,
          usageRecords: sessionUsageSource(w.db),
          ...(w.asUser ? { asUser: w.asUser } : {}),
        },
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
    ...(roster
      ? {
          modelRoster: {
            due: (at: Date) => modelRosterDue(w.db, at),
            read: () =>
              readChannelModelRosters({
                channels: MODEL_ROSTER_CHANNELS,
                commands: roster.commands,
                runCommand: roster.runCommand,
                ...(roster.env ? { env: roster.env } : {}),
                ...(roster.workDir ? { workDir: roster.workDir } : {}),
                ...(roster.connectMirasim ? { connectMirasim: roster.connectMirasim } : {}),
              }),
            save: (results, at) => saveChannelModelReads(w.db, results, at),
            // 普通通知（daily），不是要人拍的 decision / alert
            notifyNewModels: (notice) =>
              upsertAlert(w.db, {
                dedupeKey: notice.key,
                level: 'daily',
                taskId: null,
                title: notice.title,
                body: notice.body,
              }).then(() => undefined),
          },
        }
      : {}),
  });
}
