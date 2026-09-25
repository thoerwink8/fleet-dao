// 用量怎么算：只影响记账数字，不影响流程走向，所以工作流里直接算（不走 decide）。

/**
 * 这一次的花费 = 这次报的会话累计 − 上一轮的累计（和插头的 costOfThisRun 一个算法）。
 * 这个会话头一回跑：累计就是这一次的；有一边没读到：求不了差，不给（不记 0）。
 * previous：undefined = 这个会话之前没跑过；null = 上一轮没读到。
 */
export function costOfRun(
  previous: number | null | undefined,
  total: number | undefined,
): number | undefined {
  if (total === undefined) return undefined;
  if (previous === undefined) return total;
  if (previous === null) return undefined;
  return Math.max(0, Math.round((total - previous) * 1e6) / 1e6);
}
