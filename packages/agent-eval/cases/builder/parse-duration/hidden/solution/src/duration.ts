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

/** 反过来：`1h 30m`、`500ms` 读成毫秒。单位 d h m s ms，顺序随意、不许重复，之间可有空白。 */
export function parseDuration(text: string): number {
  const bad = () => new RangeError(`bad duration: ${text}`);
  const src = text.trim();
  if (!src) throw bad();
  const sizes = new Map(STEPS);
  const seen = new Set<string>();
  let total = 0;
  let pos = 0;
  const re = /(\d+)(ms|d|h|m|s)\s*/y;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw bad();
    const unit = m[2] as string;
    if (seen.has(unit)) throw bad();
    seen.add(unit);
    total += Number(m[1]) * (sizes.get(unit) as number);
    pos = re.lastIndex;
  }
  return total;
}
