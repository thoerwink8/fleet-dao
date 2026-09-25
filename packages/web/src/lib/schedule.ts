import type { JobView } from '../api/types';

/** 上次运行的白话：查过没事 / 查到几条 / 没查成 / 失败 / 还在跑——分开写，不混成「没问题」。 */
export function outcomeText(j: JobView): string {
  const r = j.lastRun;
  if (!r) return '还没跑过';
  const scanned = r.scanned === undefined ? '' : `扫了 ${r.scanned} 个，`;
  switch (r.outcome) {
    case undefined:
      return '正在跑';
    case 'ok':
      if (r.found === undefined) return r.scanned === undefined ? '跑成了' : `跑成了 · 扫了 ${r.scanned} 个`;
      return r.found === 0
        ? `跑成了 · ${scanned || '查了，'}0 个问题`
        : `跑成了 · ${scanned}查到 ${r.found} 条`;
    case 'partial':
      // 跑完了但有一部分没查成：查到的照说，没查成的那部分原因照写，不能当「全查过没事」。
      return `只查了一部分${r.found === undefined ? '' : ` · ${scanned}查到 ${r.found} 条`}：${r.why ?? '没查成的原因没记下'}`;
    case 'unscanned':
      return `没查成：${r.why ?? '原因没记下'}`;
    case 'failed':
      return `失败：${r.why ?? '原因没记下'}`;
  }
}

/** 后端判的新鲜度：上次跑成（ok 或 partial）距今是否在 expectEveryMinutes 之内（登记时已含周期、抖动和一轮耗时）。 */
export const jobStatusLabel: Record<JobView['status'], string> = {
  fresh: '按期跑成',
  overdue: '过期：超过期望间隔没跑成',
  never: '从没跑成过',
};

/** 期望的成功间隔，说成人话。 */
export function everyText(minutes: number): string {
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes < 1440) return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  const days = minutes / 1440;
  return Number.isInteger(days) ? `每 ${days} 天` : `每 ${Math.round(minutes / 60)} 小时`;
}
