// 环境页的事实（#820 片 1）：这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」。
// 只读、不跨环境、不开口子：读的全是现成的（/healthz 同一份健康检查、主页同一个引擎探针、额度页同一个 buildPools、
// 定时任务页同一个 jobView、发布对账同一个 deploy-lag）。一项读失败只让那一项写「没查成」，不连累别的项。
// 改这里之前必须知道：
// - 引擎那一格沿用主页那一格的判法（home-engine.ts）：off（按配置没开引擎）不是红，down（开着却
//   没连上）才是红，unknown（没有探针）不冒充正常。
// - 版本那一项只在正式环境有（main.ts 按 production 装配；法国和本机档都是）：别的环境读不到发布目录，照实报「没查成 + 原因」，
//   不拿空或 0 顶。
// - 每一项都自己包 try/catch：库、Temporal、发布目录任何一处抛，都只让这一项红，页面照常显示别的项。

import type {
  EnvEngine,
  EnvHealth,
  EnvPools,
  EnvSchedule,
  EnvSessions,
  EnvVersion,
  HomeHealthSchema,
  PoolViewSchema,
  SessionRun,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type DeployLagInput, type JobRecord, judgeDeployLag } from '@fleet-dao/store';
import type { z } from 'zod';
import { type HealthReport, runHealthChecks } from './health.ts';
import { ENGINE_OFF_DETAIL } from './home-engine.ts';
import type { HealthCheck, Logger } from './ports.ts';
import { buildPools, jobView } from './views.ts';

/** 引擎那一格的形状：和主页状态条同一份（home-engine.ts 的探针返回值）。 */
type EngineHealth = z.input<typeof HomeHealthSchema>['engine'];

/** 一项的成败：ok 带值，没查成带一句给人的原因（不拿空顶）。 */
export type EnvFact<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * 把可能抛的一步包成一项事实：抛了就这一项写「没查成 + 原因」，别的项不受影响（#820 片 1 做完的标准 2）。
 * 每一项都经它包一层，所以任何一处（库、Temporal、发布目录）抛都只让那一项红。
 */
export async function fact<T>(what: string, read: () => Promise<T> | T): Promise<EnvFact<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, reason: `读${what}没成：${errMessage(err)}` };
  }
}

/** 没接上的那一项（比如版本只在正式环境有）：写「没查成 + 原因」，不当成「没有」。 */
export function notWired<T>(reason: string): EnvFact<T> {
  return { ok: false, reason };
}

/**
 * 引擎那一格（在跑 / 关着 / 挂了 / 认不出）：和主页同一个探针的结果，原样翻成这一页的形状。
 * 探针自己已经会兜（探不到写 down、没探针写 unknown），这里只是换个形状，不再包一层。
 */
export function engineFact(engine: EngineHealth): EnvFact<EnvEngine> {
  return {
    ok: true,
    value: { state: engine.state, ...(engine.detail === undefined ? {} : { detail: engine.detail }) },
  };
}

/**
 * 引擎关着的固定说法（和主页那一格同一句）：这台按配置（release.env 的 FLEET_SERVICES）没开引擎，是「关着」，不是红。
 * 为什么关、关多久不在代码里写死（那是进度文件里的临时调整，会变），这里只说按配置没开。
 */
export function engineOffFact(): EnvFact<EnvEngine> {
  return { ok: true, value: { state: 'off', detail: ENGINE_OFF_DETAIL } };
}

/** 在跑几个会话、各自在哪一段。stage 不在认识的几段里也照数（不丢），页面按 StageKind 显示。 */
export function sessionsFact(activeRuns: readonly SessionRun[]): EnvSessions {
  const byStage: Record<string, number> = {};
  for (const run of activeRuns) byStage[run.stage] = (byStage[run.stage] ?? 0) + 1;
  return { total: activeRuns.length, byStage };
}

/** 池占用：现成的 buildPools，不另算一份；只取这一页要的几个数。 */
export function poolsFact(input: {
  pools: Parameters<typeof buildPools>[0]['pools'];
  channels: Parameters<typeof buildPools>[0]['channels'];
  windows: Parameters<typeof buildPools>[0]['windows'];
  routes: Parameters<typeof buildPools>[0]['routes'];
  activeRuns: readonly SessionRun[];
  now: Date;
  staleAfterMs: number;
}): EnvPools {
  const views: z.input<typeof PoolViewSchema>[] = buildPools(
    {
      pools: input.pools,
      channels: input.channels,
      windows: input.windows,
      routes: input.routes,
      activeRuns: [...input.activeRuns],
    },
    input.now,
    input.staleAfterMs,
  );
  return {
    count: views.length,
    running: views.reduce((n, p) => n + p.running, 0),
    unread: views.filter((p) => p.quotaStatus === 'unread').length,
    stale: views.filter((p) => p.quotaStatus === 'stale').length,
  };
}

/** 健康：红几项、哪几项（真没连上）；「未接」单列（这台机器没有这一项功能，不算坏）。 */
export function healthFact(report: HealthReport): EnvHealth {
  const failing: string[] = [];
  const notWired: string[] = [];
  for (const [name, r] of Object.entries(report.checks)) {
    if (r.ok && 'status' in r && r.status === 'not_wired') notWired.push(name);
    else if (!r.ok) failing.push(name);
  }
  return { ok: report.ok, total: Object.keys(report.checks).length, failing, notWired };
}

/** 按 /healthz 同一份检查跑一遍，翻成这一页要的几个数。 */
export async function readHealth(checks: readonly HealthCheck[], log: Logger): Promise<EnvHealth> {
  return healthFact(await runHealthChecks(checks, log));
}

/** 最近一轮拉单（scheduled_jobs 的 intake 那一行）：现成的 jobView，不另写判法。 */
export function scheduleFact(jobs: readonly JobRecord[], now: Date): EnvSchedule {
  const intake = jobs.find((j) => j.id === 'intake');
  if (!intake) return { status: 'never' };
  const view = jobView(intake, now);
  return {
    status: view.status,
    ...(view.lastSuccessAt === undefined ? {} : { lastSuccessAt: view.lastSuccessAt }),
    ...(view.lastRun?.outcome === undefined ? {} : { outcome: view.lastRun.outcome }),
    ...(view.lastRun?.scanned === undefined ? {} : { scanned: view.lastRun.scanned }),
    ...(view.lastRun?.why === undefined ? {} : { why: view.lastRun.why }),
  };
}

/**
 * 在用版本、落后主线没有（只正式环境读得到）。读不到发布目录 / 状态文件时 judgeDeployLag 会判「没查成」，
 * 那也照实带进 problems；current/behind 读不出就是 null，页面写「没查成」不写 0。
 */
export function versionFact(input: DeployLagInput, now: Date): EnvVersion {
  const verdict = judgeDeployLag(input, now);
  const current = 'error' in input.current ? null : input.current.sha;
  let behind: number | null = null;
  const st = input.state;
  if (current && !('error' in st) && st.main?.commits.some(([s]) => s === current)) {
    behind = st.main.commits.findIndex(([s]) => s === current);
  }
  const detail =
    current === null
      ? verdict.problems.length > 0
        ? (verdict.problems[0]?.message ?? '还没发布过')
        : '还没发布过'
      : `在用 ${current.slice(0, 12)}${behind === null ? '' : `，落后主线 ${behind} 个提交`}`;
  return {
    current,
    behind,
    detail,
    problems: verdict.problems.map((p) => p.message),
  };
}

/**
 * 把上面几步拼成一份环境页的事实清单。每一项各自包一层：这里任何一步抛都只让那一项红，别的项照常（#820 片 1 做完的标准 2）。
 * 引擎那一项由调用方给（探针已经在别处兜过），这里不重复探。
 */
export async function envFacts(input: {
  engine: EnvFact<EnvEngine>;
  /** 库读法（现成）：在跑的会话、池占用、定时任务。 */
  readSessions: () => Promise<SessionRun[]>;
  readPools: () => Promise<EnvPools>;
  readSchedule: () => Promise<EnvSchedule>;
  /** 版本那一项：正式机器给读法，别的环境给 null（写「没查成 + 原因」）。 */
  readVersion: (() => Promise<EnvVersion>) | null;
  /** 版本项没接上时的原因（比如「只在正式环境查」）。 */
  versionNotWired: string;
  readHealth: () => Promise<EnvHealth>;
}): Promise<{
  engine: EnvFact<EnvEngine>;
  version: EnvFact<EnvVersion>;
  sessions: EnvFact<EnvSessions>;
  pools: EnvFact<EnvPools>;
  health: EnvFact<EnvHealth>;
  schedule: EnvFact<EnvSchedule>;
}> {
  const [version, sessions, pools, health, schedule] = await Promise.all([
    input.readVersion
      ? fact('版本', input.readVersion)
      : Promise.resolve(notWired<EnvVersion>(input.versionNotWired)),
    fact('在跑的会话', async () => sessionsFact(await input.readSessions())),
    fact('池占用', input.readPools),
    fact('健康', input.readHealth),
    fact('定时任务', input.readSchedule),
  ]);
  return { engine: input.engine, version, sessions, pools, health, schedule };
}
