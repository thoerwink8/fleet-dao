// 「继续」要发的两下。taskContinue 解开停下等人、暂停；taskRouteWake 解开 pauseForRoute。
// 等选路的那一觉不看 taskContinue（在途重放不能改那个条件）。换路由续之后睡在里面、任务行冻住的，只靠叫醒醒（#2392）。

import { CONTINUE_ROUTE_WAKE_REASON, TASK_SIGNAL_NAMES } from '@fleet-dao/shared';
import type { TaskSignal } from './ports.ts';

/** 先继续、再叫醒。先叫醒的话，工作流可能在继续到达之前就重新停下，这一下继续就用不上了。 */
export function continueSignals(by: string, note?: string): TaskSignal[] {
  return [
    { name: TASK_SIGNAL_NAMES.continue, by, ...(note ? { note } : {}) },
    { name: TASK_SIGNAL_NAMES.routeWake, by, reason: CONTINUE_ROUTE_WAKE_REASON },
  ];
}
