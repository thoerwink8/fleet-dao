// 需求开出的单子现在到哪一步了（#2060，母单 #2047 第 B 片；方案第六节「进度」）：在做 / 已合并 / 已上线 / 关掉。
// 判法只有这一份：后端的进度同步（packages/api 的 request-progress.ts）读到 GitHub 和引擎任务表的事实后调它，
// 写进 recordRequestIssueState，并拼对话里的进度卡。
// 改这里之前必须知道：
// - 引擎任务表（tasks）比 GitHub 的开关更能说明做到哪了：任务 done = 子任务都合了；引擎做完自己会关单，所以「任务 done」要排在
//   「单子关了」前面判，不然合并了的会被说成「关掉」。
// - 已上线 = 任务做完的时刻不晚于当前在用那版切上去的时刻（发布目录的记录）。读不到发布时刻（deployedAt 是 undefined / 读不出）
//   不猜：停在「已合并」，由调用方照实写「没读到上线时刻」。
// - 单子被关成「不做」（not_planned）一律是关掉，不管任务表怎么说。
import type { TaskState } from './domain.ts';
import type { RequestIssueState } from './web-api/requests.ts';

export interface IssueProgressFacts {
  /** GitHub 上这张单此刻开没开着、关的原因。 */
  github: { state: 'open' | 'closed'; stateReason: string | null };
  /** 引擎任务表里这张单的任务行；引擎还没接是 null。 */
  task: null | {
    state: TaskState;
    /** 子任务总数、已合并数（还没拆方案是 0 / 0）。 */
    subtasks: { total: number; merged: number };
    /** 任务最后一次变化的时刻（ISO）：done 的任务就是做完的时刻。 */
    updatedAt: string;
    /** 停下等人的原因（stalled 的 last_problem），有就写进进度卡。 */
    why?: string | undefined;
  };
  /** 当前在用那版切上去的时刻（ISO）；null / undefined = 读不到，不猜。 */
  deployedAt?: string | null | undefined;
}

export interface IssueProgress {
  state: RequestIssueState;
  /** 进度卡上「#12 」后面那一句，例如「动手中 · 已合并 3/6 个子任务」。 */
  words: string;
}

const TASK_WORDS: Record<TaskState, string> = {
  queued: '排队中，引擎还没开始',
  triaging: '对题中',
  asking: '引擎在等人回答',
  planning: '拆方案中',
  running: '动手中',
  merging: '合并中',
  done: '已做完',
  stopped: '被叫停了',
  failed: '失败了',
  stalled: '停下等人',
};

export function deriveIssueProgress(f: IssueProgressFacts): IssueProgress {
  const { github, task } = f;
  if (github.state === 'closed' && github.stateReason === 'not_planned') {
    return { state: 'closed', words: '单子被关成「不做了」' };
  }
  if (task?.state === 'done') {
    const done = Date.parse(task.updatedAt);
    const live = f.deployedAt ? Date.parse(f.deployedAt) : Number.NaN;
    if (Number.isFinite(done) && Number.isFinite(live) && live >= done) {
      return { state: 'deployed', words: '已上线' };
    }
    return { state: 'merged', words: '已合并，等上线' };
  }
  if (github.state === 'closed') return { state: 'closed', words: '单子关掉了' };
  if (!task) return { state: 'open', words: '已开单，引擎还没接' };
  const steps =
    task.subtasks.total > 0 ? ` · 已合并 ${task.subtasks.merged}/${task.subtasks.total} 个子任务` : '';
  const why = task.state === 'stalled' && task.why ? `：${task.why}` : '';
  return { state: 'open', words: `${TASK_WORDS[task.state]}${steps}${why}` };
}

/** 对话里的进度卡正文：「#12 动手中 · 已合并 3/6 个子任务」。同一张单、同一句话不重复追加（按整句比）。 */
export function progressCardBody(issueNumber: number, p: IssueProgress): string {
  return `#${issueNumber} ${p.words}`;
}

/** 这条系统消息是不是 #N 的进度卡（用来找上一张，判这次有没有变）。 */
export function isProgressCardOf(issueNumber: number, body: string): boolean {
  return body.startsWith(`#${issueNumber} `);
}
