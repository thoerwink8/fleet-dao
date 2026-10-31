// 事件的分类和一句话标题：展示层（卡片）和筛选条共用。读不懂的类型归「其他」，照样显示，不丢。
import { outcomeLabel, TYPE_LABEL, verdictLabel } from './labels';
import type { FeedEvent } from './types';

export type Category = 'turn' | 'dispatch' | 'worker' | 'process' | 'handback' | 'other';

export const CATEGORY_LABEL: Record<Category, string> = {
  turn: '会话轮次',
  dispatch: '派工',
  worker: '工人',
  process: '工人过程',
  handback: '交回核验',
  other: '其他',
};

export function categoryOf(type: string): Category {
  if (type.startsWith('transcript.')) return 'process';
  if (type.startsWith('session.turn.')) return 'turn';
  if (type === 'worker.spawn.requested' || type === 'worker.stop.requested') return 'dispatch';
  if (type === 'worker.spawned' || type === 'worker.settled' || type.startsWith('worker.')) return 'worker';
  if (type === 'handback.recorded') return 'handback';
  return 'other';
}

// 事件类型的中文名在 labels.ts（枚举的中文映射只有那一处）；这里转出去，老的导入不用改。
export { TYPE_LABEL };

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** 这条事件属于哪个任务（派工请求的 taskId）；没有返回 undefined。 */
export function taskIdOf(ev: FeedEvent): string | undefined {
  return str(ev.payload.taskId) ?? str(ev.payload.runId);
}

/** 一句话摘要（列表、折叠态用）。 */
export function summaryOf(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case 'worker.spawn.requested':
      return str(p.task) ?? '派工请求';
    case 'worker.stop.requested':
      return str(p.reason) ?? '叫停请求';
    case 'worker.progress.reported':
      return str(p.summary) ?? '进度';
    case 'worker.result.submitted':
      return str(p.summary) ?? '交结果';
    case 'handback.recorded': {
      const first = strList(p.reasons)[0];
      return (
        first ??
        `${outcomeLabel(str(p.outcome))?.text ?? '交回'} / ${verdictLabel(str(p.verdict))?.text ?? '—'}`
      );
    }
    case 'worker.spawned':
      return `工人启动 ${str(p.model) ?? ''}`.trim();
    case 'worker.settled':
      return `工人结束 退出码 ${num(p.exitCode) ?? '—'}`;
    case 'session.turn.started':
    case 'session.turn.settled':
      return str(p.text) ?? str(p.summary) ?? TYPE_LABEL[type] ?? type;
    default:
      return TYPE_LABEL[type] ?? type;
  }
}
