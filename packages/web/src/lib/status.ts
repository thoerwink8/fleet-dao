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
import type { Me, NotificationLevel, Run, TaskState } from '../api/types';
import { span } from './format';

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
  asking: '卡在旧追问',
  planning: '写方案',
  running: '在干活',
  merging: '合并中',
  done: '已完成',
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

/** 做完、叫停、失败：后端不再接受暂停、叫停、换路由。已叫停仍可以重做。 */
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
