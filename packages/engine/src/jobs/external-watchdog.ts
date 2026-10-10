// 外部看门狗（#292）在 scheduled_jobs 上的登记行。Cloudflare 定时 Worker 每 5 分钟从外面查两台机器；
// 它自己停了由引擎看门狗按这一行报（期限 15 分钟），不另写一套。没有进程内定时器：一轮由外部来记（第 3 片）。
// 要不要写入登记表由 real/jobs.ts 看 FLEET_EDGE_WATCH_ID，不在这里。

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const EXTERNAL_WATCHDOG_JOB = {
  id: 'external-watchdog',
  name: '外部看门狗',
  schedule: '每 5 分钟',
  // 每 5 分钟来一次。漏两轮不报，超过 15 分钟没来才算停了。
  expectEveryMinutes: 15,
} as const;
