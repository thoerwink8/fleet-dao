import type { JobView } from '../api/types';

/** 上次运行的白话：查过没事 / 查到几条 / 没查成 / 失败 / 还在跑——分开写，不混成「没问题」。 */
export function outcomeText(j: JobView): string {
  const r = j.lastRun;
  if (!r) return '还没跑过';
  switch (r.outcome) {
    case undefined:
      return '正在跑';
    case 'ok':
      if (r.found === undefined) return '跑成了';
      return r.found === 0 ? '跑成了 · 查了，0 个问题' : `跑成了 · 查到 ${r.found} 条`;
    case 'unscanned':
      return `没查成：${r.why ?? '原因没记下'}`;
    case 'failed':
      return `失败：${r.why ?? '原因没记下'}`;
  }
}

/** 后端按「期望多久成功一次」判的新鲜度（允许错过一次，超过两个周期没成功才算不新鲜）。 */
export const jobStatusLabel: Record<JobView['status'], string> = {
  fresh: '按期成功',
  overdue: '不新鲜：超过两个周期没成功',
  never: '从没成功过',
};

/** 期望的成功间隔，说成人话。 */
export function everyText(minutes: number): string {
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes < 1440) return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  const days = minutes / 1440;
  return Number.isInteger(days) ? `每 ${days} 天` : `每 ${Math.round(minutes / 60)} 小时`;
}
