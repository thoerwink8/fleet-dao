// 任务工作流（task.ts）的无状态小零件：放弃的异常、失败分流计数、选路时要避开的东西。全是纯函数，不碰活动、不取时间。
// 这里是工作流代码，会被重放：别加随机数、Date、Node 自带模块（test/structure.test.ts 会拦）。

import type { AvoidScope, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { RouteChoice } from '../ports.ts';
import type { AbandonCommand, PauseCommand, RepinCommand } from '../task-contract.ts';

/** 放弃：从各处抛到最外层收尾。 */
export class Abandoned extends Error {
  readonly command: AbandonCommand;
  constructor(command: AbandonCommand) {
    super(`被 ${command.by} 放弃：${command.reason}`);
    this.name = 'Abandoned';
    this.command = command;
  }
}

/** hard 暂停把正在跑的动手会话取消了（#820 片 3）：从 cancellable 抛到动手会话那一段，那里按「被人暂停」接着停、等继续后重跑。 */
export class PausedInterrupt extends Error {
  readonly command: PauseCommand;
  constructor(command: PauseCommand) {
    super(`被 ${command.by} 暂停`);
    this.name = 'PausedInterrupt';
    this.command = command;
  }
}

/** 「现在就换」把正在跑的动手会话取消了（#1216）：从 cancellable 抛到动手会话那一段，那里不停下等人，直接回选路、按新指定的模型原分支重跑。 */
export class RepinInterrupt extends Error {
  readonly command: RepinCommand;
  constructor(command: RepinCommand) {
    super(`${command.by} 要求现在就换模型`);
    this.name = 'RepinInterrupt';
    this.command = command;
  }
}

export const ZERO: LadderCounters = { retries: 0, reworks: 0, routeSwaps: 0, modelSwaps: 0 };

export interface Avoid {
  routeIds: string[];
  poolIds: string[];
  modelIds: string[];
}
export const NO_AVOID: Avoid = { routeIds: [], poolIds: [], modelIds: [] };

/** 一轮 CI 等下来该干什么。 */
export type CiStep =
  | { kind: 'green' }
  | { kind: 'merged'; mergeCommit?: string | undefined }
  | { kind: 'rework' };

/** 头被别人改了，停下等人时写的话：点「继续」之后引擎对新的头重跑 CI 和验收，不是原样接着等。 */
export function headMovedDetail(now: string, pushed: string): string {
  return `现在的头是 ${now}，不是引擎验过、推上去的 ${pushed}。看过之后点「继续」：引擎会对新的头重跑 CI 和验收；不要这个 PR 了点「放弃」。`;
}

export function bump(counters: LadderCounters, next: NextAction): LadderCounters {
  const key =
    next.counter === undefined
      ? ({ retry: 'retries', swapRoute: 'routeSwaps', swapModel: 'modelSwaps', park: null } as const)[
          next.action
        ]
      : next.counter;
  return key ? { ...counters, [key]: (counters[key] ?? 0) + 1 } : counters;
}

export function widen(avoid: Avoid, route: RouteChoice, scope: AvoidScope): Avoid {
  const add = (list: string[], id: string) => (list.includes(id) ? list : [...list, id]);
  if (scope === 'pool') return { ...avoid, poolIds: add(avoid.poolIds, route.poolId) };
  if (scope === 'model') return { ...avoid, modelIds: add(avoid.modelIds, route.modelId) };
  return { ...avoid, routeIds: add(avoid.routeIds, route.routeId) };
}

export function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
