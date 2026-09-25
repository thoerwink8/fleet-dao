// 给人看的字：状态、时间窗一律先过这里换成白话，卡片上不出现内部代号（stalled、in_merge_queue 这类）。
import type { QuotaWindowKind, SubtaskState, TaskState } from '@fleet-dao/shared';

export const TASK_STATE_WORDS: Record<TaskState, string> = {
  queued: '排队中',
  triaging: '在看需求',
  asking: '在等你们回答',
  planning: '在写方案',
  running: '在干活',
  merging: '在合并',
  done: '做完了',
  stopped: '已叫停',
  failed: '没做成',
  stalled: '卡住了',
};

export const SUBTASK_STATE_WORDS: Record<SubtaskState, string> = {
  pending: '还没开始',
  waiting_deps: '等前面的做完',
  waiting_slot: '排队等空位',
  running: '在干活',
  verifying: '在验证',
  in_merge_queue: '排队合并',
  merged: '已合并',
  stopped: '已叫停',
  failed: '没做成',
  stalled: '卡住了',
};

export const QUOTA_WINDOW_WORDS: Record<QuotaWindowKind, string> = {
  '5h': '5 小时额度',
  '7d': '周额度',
  '7d_model': '周额度（单个模型）',
  month_usd: '月度额度',
  points: '点数',
  period_usd: '本期额度',
  // 上游新出、还归不了类的窗口；快照带了原名（label）时卡片显示原名，这里只是没带时的兜底。
  other: '其它额度',
};

const TZ = 'Asia/Shanghai';
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 北京时间的日期，例如 2026-09-25。 */
export function beijingDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

/** 北京时间的「时:分」，例如 14:02。 */
export function beijingClock(ms: number): string {
  return clockFmt.format(new Date(ms));
}

/** 今天的只写时刻，别的日子带上月日：「14:02」「09-24 14:02」。 */
export function when(iso: string | number, nowMs: number): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间不明';
  const day = beijingDay(ms);
  return day === beijingDay(nowMs) ? beijingClock(ms) : `${day.slice(5)} ${beijingClock(ms)}`;
}

/** 「3 分钟」「2 小时」「5 天」。 */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** 截断给人看的长文字，保证卡片不超 30 KB。 */
export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
