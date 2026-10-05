// 主页顶上「引擎」那一格读真实健康（#902 D7）：开着的机器要真探到任务队列上有在拉活的工人才写「正常」。
// 探法就是 /healthz 的 engine 项（health.ts 的 HealthCheck，名字 engine），不另写一份；这里只管把结果翻成主页的四种状态。
// 改这里之前必须知道：
// - 引擎没开（FLEET_SERVICES 没写它，或 engine 项带「未接」）是 off = 「已停用」，不是 down，不标红：法国引擎 2026-09-29 起临时关着。
// - 探不到在线工人、连不上调度服务、探针超时都是 down（真没连上）；只有这台后端压根没有引擎探针（开发、内存版）才是 unknown，
//   不冒充 on。
// - 每次开主页都去问一遍 Temporal 太重（推送一来就重拉），所以结果留 ttlMs；缓存只管「开着」这一支，改配置要重启进程本来就会换新。

import type { HomeHealthSchema } from '@fleet-dao/shared';
import type { z } from 'zod';
import { runHealthChecks } from './health.ts';
import type { HealthCheck, Logger } from './ports.ts';

type EngineHealth = z.input<typeof HomeHealthSchema>['engine'];

export const ENGINE_OFF_DETAIL = '这台机器按 release.env 的 FLEET_SERVICES 没开引擎（临时调整）';

/** 默认缓存多久：主页隔几秒就可能重拉，引擎起落不需要比这更及时。 */
export const ENGINE_PROBE_TTL_MS = 15_000;

export function engineHealthProbe(input: {
  health: readonly HealthCheck[];
  engineOff: boolean;
  log: Logger;
  now: () => Date;
  ttlMs?: number;
}): () => Promise<EngineHealth> {
  const ttlMs = input.ttlMs ?? ENGINE_PROBE_TTL_MS;
  const check = input.health.find((h) => h.name === 'engine');
  let cached: { at: number; value: EngineHealth } | undefined;
  return async () => {
    if (input.engineOff || check?.notWired !== undefined) return { state: 'off', detail: ENGINE_OFF_DETAIL };
    if (!check) return { state: 'unknown', detail: '这台后端没有接引擎探针，没查成' };
    const now = input.now().getTime();
    if (cached && now - cached.at < ttlMs) return cached.value;
    const report = await runHealthChecks([check], input.log);
    const r = report.checks.engine;
    let value: EngineHealth;
    if (r === undefined || r.ok) {
      value = r === undefined ? { state: 'unknown', detail: '引擎探针没给结果，没查成' } : { state: 'on' };
    } else if (r.code === 'engine_offline') {
      value = { state: 'down', detail: '任务队列上没有在拉活的引擎工人（没起来或卡住了）' };
    } else {
      value = { state: 'down', detail: '连不上调度服务（Temporal）或它没回应' };
    }
    cached = { at: now, value };
    return value;
  };
}
