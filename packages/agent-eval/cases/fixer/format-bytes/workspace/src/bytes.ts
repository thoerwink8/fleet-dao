const UNITS = ['B', 'KB', 'MB', 'GB'];

/** 字节数写成人看的样子：1024 进制；B 是整数，KB 及以上保留一位小数；负数、NaN、无穷抛 RangeError。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`bad byte count: ${bytes}`);
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
