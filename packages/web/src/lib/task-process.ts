// 任务页「概览」和「过程」的说法（#3140）：数都是后端算好的（shared 的 task-process.ts），这里只管怎么说。
// 读到的照数写；读不到的由组件写「没读到」和原因，这里不出 0。
import { type ProcessCounts, type ProcessStep, toolClass } from '@fleet-dao/shared';
import type { TaskDetail } from '../api/types';
import type { LayoutTone } from '../components/layout/tone';

export type TaskPr = NonNullable<TaskDetail['overview']>['prs'][number];

/** PR 横条上的状态：字和状态色（横条底色固定是 PR 的紫，状态色只给那颗标签）。 */
export const PR_STATE: Record<TaskPr['state'], { label: string; tone: LayoutTone; hint?: string }> = {
  merged: { label: '已合并', tone: 'done' },
  open: { label: '开着', tone: 'run' },
  failed: { label: '失败', tone: 'fail', hint: 'PR 还开着，但 CI 红了' },
  closed: { label: '已关闭', tone: 'stop', hint: '关了，没合并' },
  unknown: { label: '没读到状态', tone: 'doubt' },
};

/** 文件路径拆成「目录/」和文件名，行里文件名加粗、目录灰字。 */
export function fileParts(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** 命令计数：已完成（成了的）、失败、在跑、没读到结果。 */
export function commandTally(
  c: Pick<ProcessCounts, 'commands' | 'commandsFailed' | 'commandsRunning' | 'commandsUnknown'>,
) {
  const done = Math.max(0, c.commands - c.commandsFailed - c.commandsRunning - c.commandsUnknown);
  return { done, failed: c.commandsFailed, running: c.commandsRunning, unknown: c.commandsUnknown };
}

/** 一笔里改了的文件数、合计增删；增删有一次没记就在 partial 里说（合计少了几次）。 */
export function changeTotals(c: Pick<ProcessCounts, 'files' | 'added' | 'removed' | 'uncounted'>) {
  return {
    files: c.files.length,
    added: c.added,
    removed: c.removed,
    partial: c.uncounted,
  };
}

/** 增删小徽标的悬停话：有几次编辑没记行数，合计少了。 */
export function uncountedHint(uncounted: number): string | undefined {
  return uncounted > 0 ? `有 ${uncounted} 次编辑没记行数，+/- 合计比实际少` : undefined;
}

/** 单个调用一行的动词（灰字）：已运行 / 已读取 / 已编辑 / 创建……；还没结果是进行时，没成的写「没成」。 */
export function callVerb(tool: string | undefined, state: 'pending' | 'ok' | 'failed' | 'unknown'): string {
  const cls = toolClass(tool);
  const name = tool ?? '工具';
  if (state === 'failed') {
    return cls === 'command'
      ? '运行失败'
      : cls === 'read'
        ? '读取失败'
        : cls === 'edit'
          ? '编辑失败'
          : `${name} 没成`;
  }
  if (state === 'pending') {
    return cls === 'command'
      ? '正在运行'
      : cls === 'read'
        ? '正在读取'
        : cls === 'edit'
          ? '正在编辑'
          : cls === 'search'
            ? '正在搜索'
            : cls === 'agent'
              ? '正在派子代理'
              : `正在调用 ${name}`;
  }
  switch (cls) {
    case 'command':
      return '已运行';
    case 'read':
      return '已读取';
    case 'edit':
      return (tool ?? '').toLowerCase() === 'write' ? '创建' : '已编辑';
    case 'search':
      return '已搜索';
    case 'agent':
      return '已派';
    default:
      return `已调用 ${name}`;
  }
}

/** 时间条：每步一段，宽度按用时比例（在跑的按现在算），最窄给一点宽度，免得几秒的步骤看不见。 */
export function barWeights(steps: readonly ProcessStep[], now: number): number[] {
  const ms = steps.map((s) =>
    s.durationMs !== undefined ? s.durationMs : Math.max(0, now - Date.parse(s.startedAt)),
  );
  const total = ms.reduce((a, b) => a + b, 0);
  if (total <= 0) return ms.map(() => 1);
  const floor = total * 0.015;
  return ms.map((v) => Math.max(v, floor));
}

/** 一步的用时（毫秒）：结束了用算好的，在跑的按现在算。 */
export function stepDurationMs(step: ProcessStep, now: number): number {
  return step.durationMs ?? Math.max(0, now - Date.parse(step.startedAt));
}

/** 缺标题的步骤写什么（先调工具、没说话）。 */
export const UNTITLED_STEP = '（没有说明，直接调用了工具）';
