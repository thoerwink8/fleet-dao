// 状态的颜色、名字和白话句子。看板上颜色只表达状态，七种，全在这里定义。
import type { LucideIcon } from 'lucide-react';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleStop,
  CircleX,
  Hourglass,
  MessageCircleQuestion,
} from 'lucide-react';
import type {
  Activity,
  BoardSubtask,
  BoardTask,
  Me,
  NotificationLevel,
  Run,
  SubtaskState,
  TaskState,
} from '../api/types';
import { formatDuration, span } from './format';

export type Tone = 'run' | 'wait' | 'human' | 'stall' | 'fail' | 'done' | 'stop';

export const TONES: Tone[] = ['run', 'wait', 'human', 'stall', 'fail', 'done', 'stop'];

export const toneLabel: Record<Tone, string> = {
  run: '在跑',
  wait: '在等',
  human: '等你',
  stall: '停滞',
  fail: '失败',
  done: '完成',
  stop: '叫停',
};

// Tailwind 只认完整类名，所以逐个写全，不拼接。
export const toneText: Record<Tone, string> = {
  run: 'text-ink-run',
  wait: 'text-ink-wait',
  human: 'text-ink-human',
  stall: 'text-ink-stall',
  fail: 'text-ink-fail',
  done: 'text-ink-done',
  stop: 'text-ink-stop',
};
export const toneBg: Record<Tone, string> = {
  run: 'bg-st-run',
  wait: 'bg-st-wait',
  human: 'bg-st-human',
  stall: 'bg-st-stall',
  fail: 'bg-st-fail',
  done: 'bg-st-done',
  stop: 'bg-st-stop',
};
export const toneSoft: Record<Tone, string> = {
  run: 'bg-st-run/12',
  wait: 'bg-st-wait/12',
  human: 'bg-st-human/14',
  stall: 'bg-st-stall/14',
  fail: 'bg-st-fail/14',
  done: 'bg-st-done/12',
  stop: 'bg-st-stop/14',
};
export const toneBorder: Record<Tone, string> = {
  run: 'border-st-run/45',
  wait: 'border-st-wait/35',
  human: 'border-st-human/50',
  stall: 'border-st-stall/55',
  fail: 'border-st-fail/55',
  done: 'border-st-done/40',
  stop: 'border-st-stop/40',
};
export const toneVar: Record<Tone, string> = {
  run: 'var(--st-run)',
  wait: 'var(--st-wait)',
  human: 'var(--st-human)',
  stall: 'var(--st-stall)',
  fail: 'var(--st-fail)',
  done: 'var(--st-done)',
  stop: 'var(--st-stop)',
};
export const toneIcon: Record<Tone, LucideIcon> = {
  run: CircleDot,
  wait: CircleDashed,
  human: MessageCircleQuestion,
  stall: Hourglass,
  fail: CircleX,
  done: CircleCheck,
  stop: CircleStop,
};

export const taskStateLabel: Record<TaskState, string> = {
  queued: '排队中',
  triaging: '分诊中',
  asking: '等你回答',
  planning: '写方案',
  running: '在干活',
  merging: '合并中',
  done: '已完成',
  stopped: '已叫停',
  failed: '失败',
  stalled: '停滞',
};

export const subtaskStateLabel: Record<SubtaskState, string> = {
  pending: '未开始',
  waiting_deps: '等前置',
  waiting_slot: '等空位',
  running: '在写码',
  verifying: '验证中',
  in_merge_queue: '排队合并',
  merged: '已合并',
  stopped: '已叫停',
  failed: '失败',
  stalled: '停滞',
};

/** 提醒三级的名字和颜色。 */
export const noticeLevelMeta: Record<NotificationLevel, { label: string; tone: Tone }> = {
  decision: { label: '要你拍', tone: 'human' },
  alert: { label: '卡住报警', tone: 'stall' },
  daily: { label: '日报', tone: 'wait' },
};

/** 看板上收起来的需求：做完了或叫停了。 */
export function isTaskClosed(t: { state: TaskState }): boolean {
  return t.state === 'done' || t.state === 'stopped';
}

/** 后端不再接受暂停、叫停、换路由的需求（和后端的 isTaskFinished 一致：做完、叫停、失败）。 */
export function isTaskFinished(t: { state: TaskState }): boolean {
  return t.state === 'done' || t.state === 'stopped' || t.state === 'failed';
}

export function taskTone(t: { state: TaskState }): Tone {
  switch (t.state) {
    case 'queued':
      return 'wait';
    case 'asking':
      return 'human';
    case 'done':
      return 'done';
    case 'stopped':
      return 'stop';
    case 'failed':
      return 'fail';
    case 'stalled':
      return 'stall';
    default:
      return 'run';
  }
}

export function subtaskTone(s: { state: SubtaskState }): Tone {
  switch (s.state) {
    case 'pending':
    case 'waiting_deps':
    case 'waiting_slot':
      return 'wait';
    case 'merged':
      return 'done';
    case 'stopped':
      return 'stop';
    case 'failed':
      return 'fail';
    case 'stalled':
      return 'stall';
    default:
      return 'run';
  }
}

/** 子任务的字母编号：A、B、C…… */
export function letterOf(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

export function isRunning(run: Pick<Run, 'startedAt' | 'endedAt'>): boolean {
  return Boolean(run.startedAt) && !run.endedAt;
}

/** 排队时长：从进队列到开干；还没开干就算到现在。 */
export function queueMs(run: Pick<Run, 'queuedAt' | 'startedAt' | 'endedAt'>, now: number): number {
  return span(run.queuedAt, run.startedAt ?? run.endedAt, now);
}

/** 干活时长：从开干到结束；还在干就算到现在。 */
export function workMs(run: Pick<Run, 'startedAt' | 'endedAt'>, now: number): number {
  return run.startedAt ? span(run.startedAt, run.endedAt, now) : 0;
}

/**
 * 这个需求是不是我提的。契约里 requestedBy 是一个字符串（后端现在填用户编号），
 * 编号和显示名都算，免得后端换成填名字时「只看我提的」悄悄变成空。
 */
export function isMine(requestedBy: string, me: Me | undefined): boolean {
  if (!me) return false;
  return requestedBy === me.user.id || requestedBy === me.user.displayName;
}

/** 一组会话里「当前那个」：还没结束的优先，其次最后进队的。subtaskId 不填 = 需求级的会话。 */
export function latestRun(runs: Run[], subtaskId: string | undefined): Run | undefined {
  let best: Run | undefined;
  for (const r of runs) {
    if (r.subtaskId !== subtaskId) continue;
    if (!best) best = r;
    else if (Boolean(best.endedAt) !== Boolean(r.endedAt)) best = r.endedAt ? best : r;
    else if (r.queuedAt > best.queuedAt) best = r;
  }
  return best;
}

/** 需要人看一眼：等人、卡住、失败。 */
export function needsAttention(t: BoardTask): boolean {
  if (t.state === 'asking' || t.state === 'stalled' || t.state === 'failed') return true;
  return t.subtasks.some((s) => s.state === 'stalled' || s.state === 'failed');
}

/** 真在干活（不是排队）的会话才算「在跑」：卡片和连线的动效只给它们。 */
export function isWorking(a: Activity | undefined): boolean {
  return Boolean(a && !a.queued);
}

/** 需求在跑：自己的会话在干活，或者有子任务在干活。 */
export function taskLive(t: BoardTask): boolean {
  return taskTone(t) === 'run' && (isWorking(t.activity) || t.subtasks.some((s) => isWorking(s.activity)));
}

export function subLive(s: BoardSubtask): boolean {
  return subtaskTone(s) === 'run' && isWorking(s.activity);
}

/** 「Opus 5.5 正在写方案，已 4 分钟」——后端给前半句，时长由前端按 since 实时算。 */
export function activityPhrase(a: Activity, now: number): string {
  const d = formatDuration(now - Date.parse(a.since));
  return a.queued ? `${a.text}，已排 ${d}` : `${a.text}，已 ${d}`;
}

/** 每张子任务卡上那一句白话。siblings 用来把「等前置」写成「等子任务 A 先合并」。 */
export function describeSubtask(s: BoardSubtask, now: number, siblings: BoardSubtask[] = []): string {
  if (s.state === 'stalled') {
    return s.activity?.step ? `卡在「${s.activity.step}」没有进展，已交帅位诊断` : '没有进展，已交帅位诊断';
  }
  if (s.activity && (s.state === 'running' || s.state === 'verifying'))
    return activityPhrase(s.activity, now);
  switch (s.state) {
    case 'running':
      return '在写码';
    case 'verifying':
      return '在最新主线上重跑测试';
    case 'in_merge_queue':
      return '排队合并：在最新主线上重测通过就合';
    case 'waiting_slot':
      return '等空位或额度';
    case 'waiting_deps': {
      const deps = s.dependsOn
        .map((d) => siblings.find((x) => x.id === d))
        .filter((x): x is BoardSubtask => Boolean(x))
        .map((x) => letterOf(x.index));
      return deps.length ? `等子任务 ${deps.join('、')} 先合并` : '等前面的子任务先合并';
    }
    case 'pending':
      return '还没开始';
    case 'merged':
      return s.prNumber ? `已合并 · PR #${s.prNumber}` : '已合并';
    case 'failed':
      return '失败了，等人处理';
    case 'stopped':
      return '已叫停';
  }
}

function countPhrase(t: BoardTask): string {
  const counts = new Map<string, number>();
  for (const s of t.subtasks) {
    const key =
      s.state === 'merged'
        ? '已合并'
        : s.state === 'running'
          ? '在写码'
          : s.state === 'verifying'
            ? '在验证'
            : s.state === 'in_merge_queue'
              ? '排队合并'
              : s.state === 'failed'
                ? '失败'
                : s.state === 'stalled'
                  ? '停滞'
                  : s.state === 'stopped'
                    ? '叫停'
                    : '在等';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([k, n]) => `${n} 个${k}`);
  return `${t.subtasks.length} 个子任务：${parts.join(' · ')}`;
}

/** 每张需求卡上那一句白话。 */
export function describeTask(t: BoardTask, now: number): string {
  if (t.activity && (t.state === 'triaging' || t.state === 'planning' || t.state === 'queued')) {
    return activityPhrase(t.activity, now);
  }
  switch (t.state) {
    case 'queued':
      return '排队中，等分诊';
    case 'triaging':
      return '在分诊：判断是哪类活、说没说清';
    case 'asking':
      return '在等你回答追问';
    case 'planning':
      return '在写方案';
    case 'running':
    case 'merging':
      return t.subtasks.length ? countPhrase(t) : '在干活';
    case 'stalled': {
      const s = t.subtasks.find((x) => x.state === 'stalled');
      return s ? `子任务 ${letterOf(s.index)} 没有进展，已交帅位诊断` : '没有进展，已交帅位诊断';
    }
    case 'failed': {
      const s = t.subtasks.find((x) => x.state === 'failed');
      return s ? `子任务 ${letterOf(s.index)} 失败了，等人处理` : '失败了，等人处理';
    }
    case 'done':
      return '已完成';
    case 'stopped':
      return '已叫停';
  }
}

/** 需求的整体进度：已合并的子任务 / 全部子任务；还没拆子任务时按走到第几段算。 */
export function taskProgress(t: BoardTask): { done: number; total: number } {
  if (t.progress.total) return t.progress;
  const order: TaskState[] = ['queued', 'triaging', 'planning'];
  const i = order.indexOf(t.state);
  if (t.state === 'done') return { done: 1, total: 1 };
  return { done: Math.max(0, i), total: 4 };
}
