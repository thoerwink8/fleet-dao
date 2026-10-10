const STEPS: readonly [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
  ['ms', 1],
];

/** 毫秒数写成 `1h30m` 这样的短写法：从大到小、为 0 的单位不写；0 写成 `0ms`；负数、非整数抛 RangeError。 */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`bad duration: ${ms}`);
  if (ms === 0) return '0ms';
  let rest = ms;
  let out = '';
  for (const [unit, size] of STEPS) {
    const n = Math.floor(rest / size);
    if (n > 0) out += `${n}${unit}`;
    rest -= n * size;
  }
  return out;
}
