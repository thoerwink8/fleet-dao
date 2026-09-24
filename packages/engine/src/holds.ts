// 人闸：这几类事合并前要人点头（design 第四条：只有对外发布、花钱、删数据停下等人）。
// 标记是字符串：认得的三种有白话名字；认不得的照样拦（宁可多问一次，不可漏拦），原样给人看。
// 规整规则也在工作流里用（人工加人闸的信号）：改它等于改流程走向，在途任务要用 patched()。

export const HOLD_LABELS: Readonly<Record<string, string>> = {
  release: '对外发布',
  spend: '花钱',
  delete: '删数据',
};

/** 只要非空字符串：小写、去重、排序。 */
export function normalizeHolds(raw: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const h of raw ?? []) {
    if (typeof h !== 'string') continue;
    const hold = h.trim().toLowerCase();
    if (hold) out.add(hold);
  }
  return [...out].sort();
}

export function describeHolds(holds: readonly string[]): string {
  return holds.map((h) => HOLD_LABELS[h] ?? h).join('、');
}
