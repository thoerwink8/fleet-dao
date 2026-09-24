// 策略参数（上限、时长、比例）的读法：缺的取默认值；给了但不对的直接报错，不悄悄换成默认值——
// 一个 0 次的连败门槛、超过 1 的错开比例，会让熔断一上来就开、或冷却变成负数。

export interface Bound {
  min: number;
  /** min 本身不算（要严格大于）。 */
  minExclusive?: true;
  max?: number;
  maxExclusive?: true;
  integer?: true;
}

/** 次数：不小于 min 的整数。 */
export const count = (min: number): Bound => ({ min, integer: true });
/** 时长：不小于 0。 */
export const nonNegative: Bound = { min: 0 };
/** 时长：大于 0。 */
export const positive: Bound = { min: 0, minExclusive: true };
/** 比例或把握度：0 到 1。 */
export const fraction: Bound = { min: 0, max: 1 };

export function resolvePolicy<T extends { [K in keyof T]: number }>(
  name: string,
  defaults: Readonly<T>,
  bounds: { readonly [K in keyof T]: Bound },
  partial: Partial<T> | undefined,
): T {
  const out = { ...defaults } as T;
  if (!partial) return out;
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value: unknown = partial[key];
    if (value === undefined) continue;
    const bound = bounds[key];
    if (typeof value !== 'number' || !within(value, bound)) {
      throw new Error(`${name}的 ${key} 不对：要${describe(bound)}，给的是 ${String(value)}`);
    }
    out[key] = value as T[typeof key];
  }
  return out;
}

function within(value: number, b: Bound): boolean {
  if (!Number.isFinite(value)) return false;
  if (b.integer && !Number.isInteger(value)) return false;
  if (b.minExclusive ? value <= b.min : value < b.min) return false;
  if (b.max !== undefined && (b.maxExclusive ? value >= b.max : value > b.max)) return false;
  return true;
}

function describe(b: Bound): string {
  const kind = b.integer ? '整数' : '数';
  if (b.max === undefined) return `${b.minExclusive ? '大于' : '不小于'} ${b.min} 的${kind}`;
  const open = [b.minExclusive ? b.min : undefined, b.maxExclusive ? b.max : undefined].filter(
    (v) => v !== undefined,
  );
  return `在 ${b.min} 到 ${b.max} 之间${open.length > 0 ? `（不含 ${open.join('、')}）` : ''}`;
}
