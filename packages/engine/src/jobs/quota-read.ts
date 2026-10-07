// 定时读额度入库（#76，design 第十节）：一轮 = 记下开始 → 读配置（这一版自带的 deploy/quota.json）→ 每个池读一遍额度
// （adapters 的 readAllQuotas）→ 读成的按池写进 quota_windows（savePoolQuota，唯一写入口）→ 读失败的按规矩报警 → 结局记进 schedule_runs。
// 改这里之前必须知道：
// - 读失败的池什么都不写：最近读成时刻不动、旧读数留着（「没读成」不能写成「额度是 0」或「没事」）。
// - 报警不另存状态，读时现算：这个池这一轮没读成，且库里「最近读成」比两轮之前还早（或从没读成过）→ 连着两轮没读成，报；
//   这一轮读成了就撤。凭据读不到、登录失效、配置写错这几种要人动手的，当场报，不等第二轮。
// - 「这台机器当前挂的不是这个组织」（not_current）不算失败：Claude 额度只能读当前挂着的那个组织，读取器不切号，
//   另一个池本来就读不到。照旧留着旧读数、不报警，但这一轮记 partial 写明哪几个池没读，不记成全读到了。
// - 配置读不到、认不出：这一轮整个没跑成，当场报（key 单独一个），不拿上一次的配置顶。
// - 配置 notRead 里的池不读（没有这种数据）。每轮撤掉它们的 quota-read 提醒，不留着报错。
// - 读到的窗口里被读取器丢过的（notes 里写着「没收」）不算读全：只写收到的窗口，不标别的窗口过期、不算一次读成。

import type { PoolQuotaResult, QuotaConfig, QuotaReport } from '@fleet-dao/adapters/quota';
import type { PoolQuotaSnapshot, ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { QuotaReadRun } from '../contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const QUOTA_READ_JOB = {
  id: 'quota-read',
  name: '额度读取',
  schedule: '每 15 分钟（每小时 4、19、34、49 分）',
  // 连着三轮没跑成才算过期。
  expectEveryMinutes: 45,
} as const;

export const QUOTA_READ_EVERY_MINUTES = 15;
/** 和路由探针（7 分起）、对账补漏（整点起）错开：几样都要连库、连上游。 */
export const QUOTA_READ_OFFSET_MINUTES = 4;
/**
 * 「连着两轮没读成」的线：一轮间隔 15 分钟，上一轮读成过则最近读成离现在不到 20 分钟（含读取耗时）；比这更早，说明上一轮也没读成。
 */
export const QUOTA_REPEAT_FAIL_MS = 20 * 60_000;

/** 当场报、不等第二轮的错：要人动手（补凭据、重新登录、改配置、查为什么花了钱），不会自己好。 */
const IMMEDIATE_CODES = new Set(['no_credentials', 'auth', 'config', 'read_cost', 'bad_response']);

export const configAlertKey = () => 'quota-read:config';
export const poolAlertKey = (poolId: string) => `quota-read:${poolId}`;

export interface QuotaReadJobDeps {
  /** 读额度配置（真实现是 adapters 的 loadQuotaConfig）。读不到、认不出必须抛，不许回空配置。 */
  loadConfig(): Promise<QuotaConfig>;
  /** 读一遍所有池（真实现是 readAllQuotas + productionQuotaIo）。 */
  read(config: QuotaConfig): Promise<QuotaReport>;
  /** 写一个池读成的结果（真实现是 savePoolQuota）。 */
  save(snapshot: PoolQuotaSnapshot, now: Date): Promise<unknown>;
  /** 这些池最近一次读成的时刻（pools.last_read_ok_at），在写之前读；没有的池给 null。 */
  lastReadOk(poolIds: readonly string[]): Promise<Map<string, Date | null>>;
  /** 推一条提醒（同一个 key 只留一条）。 */
  raise(alert: { key: string; title: string; body: string }): Promise<void>;
  /** 撤掉这个 key 的提醒（没有就什么都不做）。 */
  resolve(key: string): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮整个没跑成（配置读不到、读取整体抛了）：结局已记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class QuotaReadFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'QuotaReadFailedError';
    this.runId = runId;
  }
}

/** 读取器丢过窗口（notes 里写着「没收」）就不算读全。 */
export const isCompleteRead = (r: Extract<PoolQuotaResult, { ok: true }>): boolean =>
  !r.notes.some((n) => n.includes('没收'));

type Round = { result: ScheduleResult };

async function round(deps: QuotaReadJobDeps): Promise<Round> {
  const now = deps.now();
  let config: QuotaConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    const why = errMessage(err);
    await deps.raise({
      key: configAlertKey(),
      title: '额度读取没跑：配置读不到',
      body: `额度读取每轮要先读这一版自带的 deploy/quota.json，这一轮读不到、认不出：${why}。在它修好之前所有池的额度都不会更新。`,
    });
    return { result: { outcome: 'failed', why: `额度配置读不到：${why}` } };
  }
  await deps.resolve(configAlertKey());
  for (const skip of config.notRead ?? []) await deps.resolve(poolAlertKey(skip.poolId));

  if (config.pools.length === 0) {
    return { result: { outcome: 'unscanned', why: '额度配置里一个池都没有' } };
  }

  const before = await deps.lastReadOk(config.pools.map((p) => p.poolId));
  const report = await deps.read(config);
  const notCurrent: string[] = [];
  const problems: string[] = [];
  let toAlert = 0;

  for (const r of report.results) {
    if (r.ok) {
      await deps.save(
        {
          poolId: r.poolId,
          readAt: r.startedAt,
          complete: isCompleteRead(r),
          windows: r.windows.map((w) => ({
            ...w,
            window: w.window,
          })),
          ...(r.subscription?.expiresAt ? { expiresAt: r.subscription.expiresAt } : {}),
          ...(r.scopeModels ? { scopeModels: r.scopeModels } : {}),
        } as PoolQuotaSnapshot,
        now,
      );
      await deps.resolve(poolAlertKey(r.poolId));
      if (!isCompleteRead(r))
        problems.push(`${r.poolId} 有窗口被丢掉（${r.notes.filter((n) => n.includes('没收')).join('；')}）`);
      continue;
    }
    if (r.error.code === 'not_current') {
      notCurrent.push(r.poolId);
      continue;
    }
    const last = before.get(r.poolId) ?? null;
    const repeated = last === null || now.getTime() - last.getTime() > QUOTA_REPEAT_FAIL_MS;
    const immediate = IMMEDIATE_CODES.has(r.error.code);
    problems.push(`${r.poolId} 没读成（${r.error.code}）：${r.error.message}`);
    if (immediate || repeated) {
      toAlert += 1;
      await deps.raise({
        key: poolAlertKey(r.poolId),
        title: `额度读不到：${r.poolId}`,
        body: `${r.poolId}（${r.reader}）这一轮没读成：${r.error.code}——${r.error.message}。${
          immediate
            ? '这种要人动手（补凭据、重新登录、改配置），不会自己好。'
            : last
              ? `上次读成是 ${last.toISOString()}，连着两轮没读成了。`
              : '库里从没读成过这个池。'
        }旧读数留着、没改；读不到的池选路按「额度没读成」排在后面。`,
      });
    }
  }

  if (notCurrent.length > 0) {
    problems.push(`${notCurrent.join('、')} 当前没挂着这个组织，读不到（读取器不切号），旧读数留着`);
  }
  const scanned = config.pools.length;
  if (problems.length > 0) {
    return { result: { outcome: 'partial', why: problems.join('；'), scanned, found: toAlert } };
  }
  return { result: { outcome: 'ok', scanned, found: 0 } };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗看得见。
 * 没跑成（配置读不到、读取整体抛了）：记成 failed 再抛 QuotaReadFailedError。
 */
export async function runQuotaReadJob(deps: QuotaReadJobDeps): Promise<QuotaReadRun> {
  const runId = await deps.runs.start(QUOTA_READ_JOB.id, deps.now());
  let r: Round;
  try {
    r = await round(deps);
  } catch (err) {
    r = { result: { outcome: 'failed', why: `额度读取没跑成：${errMessage(err)}` } };
  }
  const { result } = r;
  await deps.runs.finish(runId, result, deps.now());
  const run: QuotaReadRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found };
  if (run.outcome === 'failed') {
    deps.log('error', '额度读取这一轮没跑成', { ...fields, why: run.why });
    throw new QuotaReadFailedError(runId, run.why ?? '额度读取没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', '额度读取跑完了', fields);
  else deps.log('warn', '额度读取这一轮没读全', { ...fields, why: run.why });
  return run;
}
