// 任务工作流（taskWorkflow）听哪些信号、每个信号带什么参数：引擎（defineSignal 注册）和驾驶舱后端（发信号）共用这一份。
// 信号名进了在途任务的历史：改名要在引擎里用 patched()，并同时改后端；以前两边各写各的字符串，后端写的 pause/resume/stop
// 引擎里根本没人听（#901），所以名字只许从这里拿，不许在两边各拼一遍。
// 这里不引任何东西：工作流代码也从这里拿（@fleet-dao/shared/task-signals），打进工作流沙箱的只有这几行。

export const TASK_SIGNAL_NAMES = {
  /** 「继续」：停着等人的任务接着走。 */
  continue: 'taskContinue',
  /** 「放弃」：工作流收尾退出（工作树存档后删，PR 和单子不动，由人处理）。 */
  abandon: 'taskAbandon',
  /** 「叫醒」等路由的活（#194）：只有引擎进程自己发，驾驶舱后端不发。 */
  routeWake: 'taskRouteWake',
  /** 「暂停」（#820 片 3）：这一张单停在下一个检查点，不起新会话；点「继续」（taskContinue）接着走。 */
  pause: 'taskPause',
  /** 「现在就换」模型（#1216）：动手会话马上停下，指定的模型（task_route_pins，驾驶舱已写库）在原分支原树上重跑这一段。 */
  repin: 'taskRepin',
} as const;

/**
 * 「现在就换」（#1216）：借「hard 暂停」同一条路把正在跑的动手会话停下，不停在检查点等人，直接回选路、按新指定的模型原分支重跑；
 * 已做的在分支上接着做，已花的 token 不退。只有动手段（manual）能当场换：验收是冷调用，不在这条路上。
 * 信号到的时候没有在跑的动手会话（已经收场、在等 CI……）就不理它：新指定本来就在库里，下一次选路照它。
 */
export interface RepinCommand {
  by: string;
  segment: 'manual';
  reason?: string;
}

/**
 * 「暂停」（#820 片 3）：只停这一张单，之后能「继续」（和「放弃」不同，放弃是终局）。by 写谁点的，reason 是为什么停。
 * mode：soft（默认）＝手上这一段做完，下一个检查点停，不起新会话；hard＝动手的会话马上停下（树里留着的改动，继续后原树原分支接着干）。
 */
export interface PauseCommand {
  by: string;
  reason?: string;
  mode?: 'soft' | 'hard';
}

/** 「继续」：停着等人的任务接着走。by 写谁点的，note 是留给下一个看的人的话。 */
export interface ContinueCommand {
  by: string;
  note?: string;
}

/** 「放弃」：工作流收尾退出（工作树存档后删，PR 和单子不动，由人处理）。reason 必填，工作流用它写状态。 */
export interface AbandonCommand {
  by: string;
  reason: string;
}

/**
 * 「叫醒」（#194 方案 4.3）：路由那边变了（切号切完、切过去的池探通了），等路由的活不用睡满 MAX_ROUTE_WAIT_SECONDS，
 * 当场重新选一次。只叫醒「等路由」那一种等待；停下等人、等 CI、等合并都不理它。
 */
export interface RouteWakeCommand {
  by: string;
  reason: string;
}
