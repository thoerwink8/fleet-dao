// 路由探针的工作流（#129）：Temporal Schedule 每 15 分钟起一条，只调一个活动跑一轮；结论和结局都由活动写库。
// 工作流里不取时刻、不碰库和会话：探哪些路由、几点探，由活动按当时的库和时刻定。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { RouteProbeInput, RouteProbeRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { probeRoutes } = proxyActivities<EngineActivities>(activityOptions('probeRoutes', DEFAULT_LIMITS));

export async function routeProbeWorkflow(input: RouteProbeInput): Promise<RouteProbeRun> {
  return probeRoutes(input ?? { schemaVersion: 1 });
}
