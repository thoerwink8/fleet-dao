// 主页（GET /api/home）和环境页（GET /api/env）的拼法：这一台环境此刻的两份快照，路由处理函数只管调它、按契约回。
// 抽出来是为了复用（全仓审查第 1 路 PR-1）：以后别的环境把自己的快照推给正式环境的看板，调的就是这同一份拼法，
// 收的那头按同一份 schema（HomeResponseSchema、EnvResponseSchema）校验，不另造一套数据形状。
// 改这里之前必须知道：
// - 引擎探针由调用方给（engineProbe）：它带 15 秒缓存，每次调都新建一个就白缓存了；cockpitRoutes 建一次、两页共用。
// - 主页库读不到就任它抛（errorHandler 回 500），不拿「空主页」顶——主页那个形状没有「这块没查成」的位置。
// - 环境页一项一个「查成了 / 没查成 + 原因」，一项读失败不连累别的项（env-view.ts 的 envFacts 各自包一层）。

import type { EnvResponseSchema, HomeHealthSchema, HomeResponseSchema } from '@fleet-dao/shared';
import { DEPLOY_LAG_NOT_HERE } from '@fleet-dao/store';
import type { z } from 'zod';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import {
  engineFact,
  engineOffFact,
  envFacts,
  poolsFact,
  readHealth,
  scheduleFact,
  versionFact,
} from './env-view.ts';
import { buildHome, buildPools } from './views.ts';

type EngineHealth = z.input<typeof HomeHealthSchema>['engine'];

/** 拼两份快照要的依赖：后端装配好的 Deps 里取几样，外加调用方建好的引擎探针（home-engine.ts 的 engineHealthProbe）。 */
export type SnapshotDeps = Pick<Deps, 'config' | 'store' | 'log' | 'now' | 'health' | 'deployLag'> & {
  engineProbe: () => Promise<EngineHealth>;
};

/**
 * 新主页（/）的一屏三块 + 持续状态条，一个往返聚齐（#589）。
 * 为了「要你拍的」「做完的」反查标题，tasks 用全量（不是看板那份 7 天窗口）：各仓的看板需求合起来去重。
 */
export async function readHomeSnapshot(deps: SnapshotDeps): Promise<z.input<typeof HomeResponseSchema>> {
  const { config, store } = deps;
  const repos = await store.listRepos();
  const taskLists = await Promise.all(repos.map((r) => store.listBoardTasks(r.id)));
  const tasks = [...new Map(taskLists.flat().map((t) => [t.id, t])).values()];
  // 「做完的」里的单可能早已进了终态、掉出了看板的 7 天窗口：按主页最多用得到的（镜像里 merged PR 挂的单）补回来。
  // 缺的一次查回（不在循环里一张一张查库）；补回的按 PR 列表里出现的先后排，和原来逐张补的顺序一样。
  const merged = await store.listPullRequests({ state: 'merged', limit: 10 });
  const have = new Set(tasks.map((t) => `${t.repoId}#${t.issueNumber}`));
  const wanted = new Map<string, { repoId: string; issueNumber: number }>();
  for (const p of merged) {
    for (const issue of p.issueRefs ?? []) {
      const key = `${p.repoId}#${issue}`;
      if (!have.has(key)) wanted.set(key, { repoId: p.repoId, issueNumber: issue });
    }
  }
  if (wanted.size > 0) {
    const found = new Map(
      (await store.findTasksByIssues([...wanted.values()])).map((t) => [`${t.repoId}#${t.issueNumber}`, t]),
    );
    for (const key of wanted.keys()) {
      const task = found.get(key);
      if (task) {
        tasks.push(task);
      } else {
        deps.log.warn('主页「做完的」反查不到挂的单，只显示 PR 号', { issue: key });
      }
    }
  }
  const taskIds = tasks.map((t) => t.id);
  const [
    notifications,
    activeRuns,
    pools,
    channels,
    windows,
    routes,
    models,
    segmentRuns,
    occupancy,
    engine,
  ] = await Promise.all([
    store.listNotifications({ status: 'open', limit: 200 }),
    store.listRuns({ taskIds, active: true }),
    store.listPools(),
    store.listChannels(),
    store.listQuotaWindows(),
    store.listRoutes(),
    store.listModels(),
    // 三段流水线图的数（在哪一段、谁在做、平均耗时）：看板窗口里全部单的流水一次读完
    store.listSegmentRunsForTasks(taskIds),
    // 在跑数、池占用：和法国页、额度页同一份
    store.poolOccupancy(),
    // 引擎那一格读真实健康（#902 D7）：开着的要真探到在线的工人，不只看配置里开没开
    deps.engineProbe(),
  ]);
  const now = deps.now();
  const poolViews = buildPools({ pools, channels, windows, occupancy }, now, config.quotaStaleAfterMs);
  return buildHome({
    notifications: notifications.items,
    tasks,
    activeRuns,
    merged,
    repos,
    pools: poolViews,
    routes,
    engine,
    segmentRuns,
    models,
    channels,
    now,
  });
}

/**
 * 环境页（#820 片 1）：这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」，一项读失败不连累别的项。
 * 只读：读的全是现成的（主页、额度页、定时任务页、/healthz 用的是同一份）。
 * 引擎那一格沿用主页那一格的探针（开着才真探），不另写一份判法。
 */
export async function readEnvSnapshot(deps: SnapshotDeps): Promise<z.input<typeof EnvResponseSchema>> {
  const { config, store } = deps;
  const now = deps.now();
  const engineProbeResult = await deps.engineProbe();
  const engine = engineProbeResult.state === 'off' ? engineOffFact() : engineFact(engineProbeResult);
  // 在跑的会话和池占用要的是同一份池占用（store.poolOccupancy，和主页、额度页、路由页同源）：只读一次、两项共用。
  // 读失败两项都照实写「没查成」（本来就是同一处没读到）
  let occupancyRead: ReturnType<typeof store.poolOccupancy> | undefined;
  const readOccupancy = () => {
    occupancyRead ??= store.poolOccupancy();
    return occupancyRead;
  };
  // 版本那一项只在正式环境（main.ts 的 production）装配：别处 deps.deployLag 没有，照实写「没查成」
  const readDeployLag = deps.deployLag;
  const facts = await envFacts({
    engine,
    readSessions: readOccupancy,
    readPools: async () => {
      const [pools, channels, windows, occupancy] = await Promise.all([
        store.listPools(),
        store.listChannels(),
        store.listQuotaWindows(),
        readOccupancy(),
      ]);
      return poolsFact({
        pools,
        channels,
        windows,
        occupancy,
        now,
        staleAfterMs: config.quotaStaleAfterMs,
      });
    },
    readSchedule: async () => scheduleFact(await store.listJobs(), now),
    readMaster: () => readEngineMaster(store),
    readVersion: readDeployLag ? async () => versionFact(readDeployLag(), now) : null,
    versionNotWired: DEPLOY_LAG_NOT_HERE,
    readHealth: () => readHealth(deps.health, deps.log),
  });
  return {
    name: config.machineName
      ? { name: config.machineName }
      : { name: '认不出', problem: '这台后端没配环境名（api.env 的 FLEET_MACHINE_NAME）' },
    asOf: now.toISOString(),
    facts,
  };
}
