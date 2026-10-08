// 定时任务的格子登记。每周刷新 CI 测试耗时表（#921）和判断题自检（#1365）的格子在这里，
// engine-timers.ts 把它们装进进程内定时器。钟点由 jobs/timers.ts 按这里的格子跑。单子点名的登记文件就是这个。
import {
  CI_TIMINGS_EVERY_MINUTES,
  CI_TIMINGS_JOB,
  CI_TIMINGS_OFFSET_MINUTES,
  CI_TIMINGS_OVERDUE_MINUTES,
} from './ci-timings.ts';
import {
  JUDGE_SELF_CHECK_EVERY_MINUTES,
  JUDGE_SELF_CHECK_JOB,
  JUDGE_SELF_CHECK_OFFSET_MINUTES,
} from './judge-self-check.ts';
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

/**
 * 每 30 分钟一轮（每小时 17、47 分）。不标 needsMaster：总开关关着也要能把判断题的红灯探回来。
 * 这一轮不拉单、不起会话。超时线和其余看家检查一样，15 分钟。
 */
export function judgeSelfCheckSchedule(run: () => Promise<unknown>): TimerJob {
  return {
    id: JUDGE_SELF_CHECK_JOB.id,
    everyMinutes: JUDGE_SELF_CHECK_EVERY_MINUTES,
    offsetMinutes: JUDGE_SELF_CHECK_OFFSET_MINUTES,
    catchupMinutes: JUDGE_SELF_CHECK_EVERY_MINUTES,
    overdueMinutes: 15,
    run,
  };
}
