// Read<T>：一次读取的结果，读成了带值，没读成带原因（方案第四节「三种数据状态」）。
// Stat、Progress、Descriptions 这类件的值收 Read<T>：没读到由组件自己写「没读到」，
// 页面拿不到裸的 undefined 去 `?? 0`，读失败也就不会被画成 0 或「正常」。

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 读成了。 */
export function readOk<T>(value: T): Read<T> {
  return { ok: true, value };
}

/** 没读成，写明原因。 */
export function readFail<T = never>(reason: string): Read<T> {
  return { ok: false, reason };
}

/** 值可能已经是 Read，也可能是裸值；裸值当读成了。给还没接 Read 的老调用方过渡用。 */
export function isRead<T>(v: Read<T> | T): v is Read<T> {
  return typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean';
}

/** 读成了就换一下值，没读成原样带回原因。 */
export function mapRead<T, U>(r: Read<T>, f: (v: T) => U): Read<U> {
  return r.ok ? { ok: true, value: f(r.value) } : r;
}

/** 没读到时组件写的字。 */
export const UNREAD_TEXT = '没读到';
