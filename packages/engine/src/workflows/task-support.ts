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

/** 推分支并主线撞上冲突，交回会话去解（不在 push 这一步里原地重试）。 */
export class ConflictHandoff extends Error {
  readonly files: readonly string[];
  /** false：合并没开始，树里没有这次的冲突标记。instruction 是原反馈（含要并的提交）。 */
  readonly pending: boolean;
  readonly instruction: string | null;
  constructor(files: readonly string[], options: { pending?: boolean; instruction?: string | null } = {}) {
    super(`有冲突没解：${files.join('、') || '（没读到冲突文件名）'}`);
    this.name = 'ConflictHandoff';
    this.files = files;
    this.pending = options.pending ?? true;
    this.instruction = options.instruction ?? null;
  }
}

/**
 * 交回会话的那一句。
 * 树里留着标记：冲突文件名，加上「解完 git add 并提交」。
 * 合并还没开始（blocked 是原反馈）：原句留着，里面有要并的提交。不改写成「树里留着冲突标记」。
 * 上一轮已经交过同一句还没解，补上「上一轮没解」。和上一轮原文一样就由调用方挂起。
 */
export function conflictHandoffLine(
  files: readonly string[],
  previous: readonly string[],
  blocked?: string | null,
): string {
  const names =
    files
      .map((f) => f.trim())
      .filter(Boolean)
      .join('、') || '（没读到冲突文件名）';
  if (blocked != null) {
    const base =
      blocked.trim() ||
      `有冲突没解：${names}。合并还没开始，树里没有冲突标记。在树里 git merge 目标提交，解掉冲突、提交后再交`;
    const noted = `${base}。上一轮没解`;
    return previous.includes(base) || previous.includes(noted) ? noted : base;
  }
  const base = `有冲突没解：${names}。树里留着冲突标记，解完 \`git add\` 并提交`;
  return previous.some((line) => line.includes('解完')) ? `${base}。上一轮没解` : base;
}
