// 看门狗的真装配（#203）：登记表和跑记录、提醒、这一轮的结局都是同一个库（@fleet-dao/db）；新不新鲜的判法就是驾驶舱
// 「定时任务」页读的那份 scheduleHealth，这里不另写。提醒写进 notifications，驾驶舱后端照推送规则推飞书（packages/api 的 feishu-push.ts）。
// 看门狗本来就该管 ENGINE_JOBS 以外的登记（备份脚本这类外部注册的），不能按「是不是在 ENGINE_JOBS 里」筛——那样会把
// 这些正常任务也当成「不该看」而漏管。只按名字剔除明确退役了的那几个（jobs/retired-schedules.ts 的共用名单，引擎起来时
// 删 Temporal 上的 Schedule 用的也是它，见 real/retire-schedules.ts）：退役的任务不会再有新的跑记录，不剔除就会被
// 永远判成「停了」——它不会再跑，也没人能去处理，只会白占一条卡住报警。#1140 起引擎起来时还会把它们的登记行从
// scheduled_jobs 里摘掉（real/jobs.ts），这里的筛选是引擎还没来得及起新版本时的兑底。
// 「主线 N 小时没合 PR」（决定 0093）读同一个库的 mergeStallFacts（PR 镜像、任务、拉单记下的等空位单数）。
// 「在用的账号池额度读数不超过 30 分钟」（决定 0093 从每小时对账搬来）读同一个库的 quotaTable，加当前版本额度配置
// 加载后有效 notRead 里的池（包括 deploy/france/mirasim-retired 触发的退役池）。
// 「提醒真的推到飞书了」读同一个库的 feishuPushFacts（后端写的推送状态、送达记录）。
// 拼车池整池暂停时 carpool-watch 不要求新鲜（和盯读、引擎起来时的登记同一句，pool-holds.ts 的 carpoolPoolsHeldReason）：
// 摘登记行挡不住启动时 registerEngineJobs 把它写回来，单看登记行会误报「停了」。暂停读不到照抛，看门狗这一轮不当成暂停。
import { readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadQuotaConfig } from '@fleet-dao/adapters/quota';
import {
  alertByKey,
  clearHealthzBadSince,
  type Db,
  dailyBriefStatus,
  feishuPushFacts,
  finishScheduleRun,
  latestAlertByPrefix,
  listCommanderStalledTasks,
  listRunningEngineTasks,
  listStalledEngineTasks,
  mergeStallFacts,
  openAlertsByPrefix,
  poolRouteFacts,
  quotaSamplesSince,
  quotaTable,
  readHealthzBadSince,
  resolveAlertWithReason,
  scheduleHealth,
  scheduleRedStreaks,
  startScheduleRun,
  upsertAlert,
  writeHealthzBadSince,
} from '@fleet-dao/db';
import { RELEASES_DIR } from '@fleet-dao/store';
import type { Client } from '@temporalio/client';
import { isLegacyModelMismatchStall } from '../failure/model-mismatch-stall.ts';
import { CARPOOL_WATCH_JOB } from '../jobs/carpool-watch.ts';
import { type HealthzProbe, parseHealthzResponse, type ReleaseFacts } from '../jobs/release-watch.ts';
import { RETIRED_SCHEDULE_IDS } from '../jobs/retired-schedules.ts';
import { WATCHDOG_ACTOR, type WatchdogDeps } from '../jobs/watchdog.ts';
import type { CommanderWatchTask } from '../jobs/watchdog-commander.ts';
import { taskContinueSignal, taskStatusQuery } from '../task-contract.ts';
import { carpoolPoolsHeldReason } from './pool-holds.ts';
import { isWorkflowGone } from './route-wake.ts';

export interface WatchdogWiring {
  db: Db;
  /** 额度配置里写明不读的池；不给就读 deploy/quota.json（loadQuotaConfig）。读不到要抛，不许回空列表。 */
  quotaNotRead?: () => Promise<readonly string[]>;
  /** 发布目录（法国 /srv/fleet-dao-releases）；目录不在 = 这台不是法国，发版和健康页两项不看。测试给临时目录。 */
  releasesDir?: string;
  /** 驾驶舱接口的 /healthz 地址（法国是隧道地址上的 8787，同 release.sh 的 COCKPIT）。 */
  healthzUrl?: string;
  /** 换掉真去问 /healthz（测试用）。 */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: WatchdogDeps['log'];
  /**
   * 发 taskContinue 用的 Temporal 客户端。不给就不叫醒点名和读回不一致的旧挂起（单测）。
   * 没这种挂起时不会去连。
   */
  temporal?: {
    use<T>(fn: (client: Pick<Client, 'workflow' | 'connection'>) => Promise<T>): Promise<T>;
  };
}

/** 法国驾驶舱接口的 /healthz（deploy/release.sh 的 COCKPIT、docs/ops.md 端口表的 8787）。 */
export const DEFAULT_HEALTHZ_URL = 'http://10.99.0.2:8787/healthz';
const HEALTHZ_TIMEOUT_MS = 10_000;

const errno = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/** 读一份可以不在的文件：不在是 null，别的错照抛。 */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (errno(e) === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 读发布目录里的发版进度。目录不在 = 这台不是法国（null）。
 * 进度记录不在是正常的（null）；在但不是 JSON 照抛，不当成没事。
 */
export async function readReleaseFacts(dir: string): Promise<ReleaseFacts | null> {
  try {
    await stat(dir);
  } catch (e) {
    if (errno(e) === 'ENOENT') return null;
    throw e;
  }
  const train = await readOptional(join(dir, '.train', 'release-train.json'));
  let trainStatus: string | null = null;
  let trainSince: string | null = null;
  let trainSha: string | null = null;
  if (train !== null) {
    // 写的是 deploy/france/release-request/lib.mjs（newState + writeState：startedAt、每次写盘刷 updatedAt、target.value）；
    // 老格式只有 status，起点时间、提交号缺着是 null（判法照旧当要人看，见 jobs/release-watch.ts 的 trainVerdict）
    const v = JSON.parse(train) as {
      status?: unknown;
      startedAt?: unknown;
      updatedAt?: unknown;
      target?: { value?: unknown } | null;
    } | null;
    if (typeof v?.status !== 'string') throw new Error('发版进度记录认不出（没有 status）');
    trainStatus = v.status;
    const since = typeof v.startedAt === 'string' ? v.startedAt : v.updatedAt;
    trainSince = typeof since === 'string' ? since : null;
    trainSha = typeof v.target?.value === 'string' ? v.target.value : null;
  }
  return {
    trainStatus,
    trainSince,
    trainSha,
    currentSha: await readCurrentSha(dir),
    mainline: await readMainline(dir),
  };
}

/** current 链接指向的提交号。不在、不是符号链接、指的不是提交号：null。别的错照抛。 */
async function readCurrentSha(dir: string): Promise<string | null> {
  try {
    const target = await readlink(join(dir, 'current'));
    const base = target.split('/').pop() ?? target;
    return /^[0-9a-f]{7,40}$/.test(base) ? base : null;
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'EINVAL') return null;
    throw e;
  }
}

/** 自动发布状态里的主线顺序（从新到旧）。文件不在、认不出：null，不当成「current 更新」。 */
async function readMainline(dir: string): Promise<string[] | null> {
  const text = await readOptional(join(dir, '.auto', 'state.json'));
  if (text === null) return null;
  try {
    const commits = (JSON.parse(text) as { main?: { commits?: unknown } } | null)?.main?.commits;
    if (!Array.isArray(commits)) return null;
    const shas = commits.flatMap((row) => (Array.isArray(row) && typeof row[0] === 'string' ? [row[0]] : []));
    return shas.length > 0 ? shas : null;
  } catch {
    return null;
  }
}

/** 发布目录在不在（在 = 这台是法国）。不在是 false，别的错照抛。 */
export async function releasesDirExists(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch (e) {
    if (errno(e) === 'ENOENT') return false;
    throw e;
  }
}

/** 问 /healthz：200 才算好；连不上、超时是 { ok: false, status: null }，不抛。 */
export async function probeHealthz(url: string, fetchImpl: typeof fetch = fetch): Promise<HealthzProbe> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) });
    return parseHealthzResponse(res.status, await res.text());
  } catch (e) {
    return {
      ok: false,
      status: null,
      reason: String(e instanceof Error ? e.message : e).slice(0, 200),
      failing: [],
    };
  }
}

const MISMATCH_SIGNAL_TIMEOUT_MS = 5_000;
const MISMATCH_CONTINUE_NOTE = '点名和读回的模型不一致，不再挂着等：按点名路由开新会话重派';

/**
 * 工作流还停在旧的 model_mismatch 挂起上才发继续，并撤掉这一挂的提醒。
 * 库里的字过时、工作流已经在干别的：skipped，不把别人的挂起解开。
 */
async function releaseLegacyModelMismatch(
  temporal: NonNullable<WatchdogWiring['temporal']>,
  db: Db,
  workflowId: string,
  at: Date,
): Promise<'sent' | 'gone' | 'skipped'> {
  try {
    const status = await temporal.use((client) =>
      client.connection.withDeadline(Date.now() + MISMATCH_SIGNAL_TIMEOUT_MS, () =>
        client.workflow.getHandle(workflowId).query(taskStatusQuery),
      ),
    );
    const still =
      status.phase === 'parked' &&
      (isLegacyModelMismatchStall(status.lastProblem) || isLegacyModelMismatchStall(status.doing));
    if (!still) return 'skipped';
    await temporal.use((client) =>
      client.connection.withDeadline(Date.now() + MISMATCH_SIGNAL_TIMEOUT_MS, () =>
        client.workflow.getHandle(workflowId).signal(taskContinueSignal, {
          by: WATCHDOG_ACTOR,
          note: MISMATCH_CONTINUE_NOTE,
        }),
      ),
    );
  } catch (err) {
    if (isWorkflowGone(err)) return 'gone';
    throw err;
  }
  for (const row of await openAlertsByPrefix(db, `${workflowId}:park:`)) {
    await resolveAlertWithReason(db, {
      dedupeKey: row.dedupeKey,
      by: WATCHDOG_ACTOR,
      why: MISMATCH_CONTINUE_NOTE,
      at,
    });
  }
  return 'sent';
}

/** 给 EngineJobs.watchdog 用的工厂。 */
export function watchdogJob(w: WatchdogWiring): () => WatchdogDeps {
  const now = w.now ?? (() => new Date());
  const log: WatchdogDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const temporal = w.temporal;
  return () => {
    // 同一轮的 freshness 和 waste 共用这次加载出的有效 notRead，避免两个监控各读一遍、看到不同版本。
    let effectiveNotRead: Promise<readonly string[]> | undefined;
    const quotaNotRead =
      w.quotaNotRead ??
      (() => {
        effectiveNotRead ??= loadQuotaConfig().then((config) => config.notRead?.map((p) => p.poolId) ?? []);
        return effectiveNotRead;
      });
    return {
      health: async (at) =>
        (await scheduleHealth(w.db, at)).filter((h) => !RETIRED_SCHEDULE_IDS.has(h.job.id)),
      alerts: {
        openByPrefix: async (prefix) =>
          (await openAlertsByPrefix(w.db, prefix)).map((a) => ({
            dedupeKey: a.dedupeKey,
            title: a.title,
            body: a.body,
          })),
        latestByPrefix: (prefix) => latestAlertByPrefix(w.db, prefix),
        byKey: (key) => alertByKey(w.db, key),
        async raise(x) {
          // 要你拍的选项、原因由报的那一处自己给（#2729：不再替它补只留言的选项凑数），缺了落库时照抛
          await upsertAlert(w.db, {
            dedupeKey: x.dedupeKey,
            level: x.level ?? 'alert',
            taskId: null,
            title: x.title,
            body: x.body,
            link: x.link,
            ...(x.options ? { options: x.options } : {}),
            ...(x.reason ? { reason: x.reason } : {}),
          });
        },
        resolve: (x) =>
          resolveAlertWithReason(w.db, { dedupeKey: x.dedupeKey, by: WATCHDOG_ACTOR, why: x.why, at: now() }),
      },
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      mergeStall: () => mergeStallFacts(w.db),
      redStreaks: (at) => scheduleRedStreaks(w.db, at),
      quota: {
        quotaPools: (at) => quotaTable(w.db, { now: at }),
        // 额度快作废（#2737）：额度历史算速度，路由列「接得住的」（关着的也列）
        quotaSamples: (since) => quotaSamplesSince(w.db, since),
        poolRoutes: () => poolRouteFacts(w.db),
        // 配置写明不读的池（jev 没有日账，退役标记也会在这里生效）。读不到配置要抛，不许当成「都要读」。
        quotaNotRead,
      },
      releaseWatch: {
        facts: () => readReleaseFacts(w.releasesDir ?? RELEASES_DIR),
        probe: () => probeHealthz(w.healthzUrl ?? DEFAULT_HEALTHZ_URL, w.fetchImpl),
        badSince: {
          read: () => readHealthzBadSince(w.db),
          write: (since) => writeHealthzBadSince(w.db, { since, by: WATCHDOG_ACTOR }),
          clear: () => clearHealthzBadSince(w.db),
        },
      },
      // 「提醒真的推到飞书了」：后端记的推送状态和送达记录，同一个库
      push: { facts: (at) => feishuPushFacts(w.db, at) },
      // 「今天的每日简报送到了」：简报那一行提醒、它的送达记录和定时任务这一轮的结局，同一个库
      brief: {
        status: (day, since) => dailyBriefStatus(w.db, day, since),
        here: () => releasesDirExists(w.releasesDir ?? RELEASES_DIR),
      },
      // 「在干活但没有开着的会话」（#2392）：只读库。过期判据在 jobs/idle-running.ts，这里不另写一个阈值。
      idleRunning: {
        tasks: async () =>
          (await listRunningEngineTasks(w.db)).map((row) => ({
            ...row,
            state: 'running' as const,
            executor: 'engine' as const,
          })),
      },
      // 点名和读回不一致的旧挂起（#2742）：只读库列 stalled，真要叫醒才连 Temporal。
      ...(temporal
        ? {
            modelMismatch: {
              tasks: () => listStalledEngineTasks(w.db),
              release: (workflowId: string) => releaseLegacyModelMismatch(temporal, w.db, workflowId, now()),
            },
          }
        : {}),
      commander: {
        tasks: (): Promise<CommanderWatchTask[]> => listCommanderStalledTasks(w.db),
      },
      // 拼车池整池暂停：carpool-watch 登记行还在也不报「停了」，开着的撤掉。读不到照抛（不当成没暂停）。
      pausedJobs: async () => {
        const why = await carpoolPoolsHeldReason(w.db, now());
        return why ? new Map([[CARPOOL_WATCH_JOB.id, why]]) : new Map();
      },
      now,
      log,
    };
  };
}
