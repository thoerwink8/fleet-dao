type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把 override 合进 base 得到新配置：对象逐层合并，数组和其他值整个替换；不该改 base。 */
export function mergeConfig<T extends Plain>(base: T, override: Plain): T {
  const result: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlain(current) && isPlain(value)) {
      Object.assign(current, mergeConfig(current, value));
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
