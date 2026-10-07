// 每周刷新 CI 测试耗时表（#921）的定时登记。#1078 起引擎不再建 Temporal Schedule，钟点由 jobs/timers.ts 按这里的格子跑，
// engine-timers.ts 把这一格装进进程内定时器。单子点名的登记文件就是这个。
import {
  CI_TIMINGS_EVERY_MINUTES,
  CI_TIMINGS_JOB,
  CI_TIMINGS_OFFSET_MINUTES,
  CI_TIMINGS_OVERDUE_MINUTES,
} from './ci-timings.ts';
import type { TimerJob } from './timers.ts';

/**
 * 周一 06:00（北京时间）一轮。不标 needsMaster：总开关每次发版都会关（#1086），标了每周这一轮几乎跑不上。
 * 这一轮不拉单、不起会话。
 */
export function ciTimingsSchedule(run: () => Promise<unknown>): TimerJob {
  return {
    id: CI_TIMINGS_JOB.id,
    everyMinutes: CI_TIMINGS_EVERY_MINUTES,
    offsetMinutes: CI_TIMINGS_OFFSET_MINUTES,
    catchupMinutes: CI_TIMINGS_EVERY_MINUTES,
    overdueMinutes: CI_TIMINGS_OVERDUE_MINUTES,
    run,
  };
}
