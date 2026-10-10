// 任务工作流挂起提醒（task:<仓>#<号>:park:<第几次>，重做后的 :rN 夹在中间也算）。
// 收尾写「做完」和对账补撤用同一句原因，处理人各写各的模块。

/** 是不是任务工作流的挂起提醒。req:、sub: 的旧键不算。 */
export function isTaskParkAlertKey(dedupeKey: string): boolean {
  return /^task:.+:park:\d+$/.test(dedupeKey);
}

/** 撤掉时正文「已撤：」后面这一句。 */
export const TASK_DONE_PARK_WHY = '任务已经做完了，这条挂起不再成立';

/** 任务被叫停时撤的：只撤这一代报的挂起，重做出来的别的代不动。 */
export const TASK_STOPPED_PARK_WHY = '任务已经叫停了，这条挂起不再成立';

/** 收尾或叫停时写快照当时撤的，处理人都是它。对账补撤仍记 engine:hourly-reconcile。 */
export const TASK_DONE_PARK_ACTOR = 'engine:task-workflow';
