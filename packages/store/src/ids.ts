// 编号与翻页游标：两个 Store 用同一份判法，契约测试才对得上。
import { InvalidCursorError } from './ports.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

/** 操作记录的编号是库里的自增数。 */
export const isSerial = (s: string): boolean => /^\d{1,18}$/.test(s);

/**
 * 翻页游标是上一页最后一条的 `时刻|编号`。看不懂（被改过、拼错、别的列表的游标）就抛 InvalidCursorError，
 * 接口回 400——不能回空页，空页会被当成「后面没有了」。idOk 按这张列表的编号格式把关。
 */
export function parseCursor(
  raw: string | undefined,
  idOk: (id: string) => boolean = (id) => id.length > 0,
): { at: string; id: string } | null {
  if (raw === undefined) return null;
  const sep = raw.lastIndexOf('|');
  const at = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (sep <= 0 || Number.isNaN(Date.parse(at)) || !idOk(id)) throw new InvalidCursorError();
  return { at: new Date(at).toISOString(), id };
}
