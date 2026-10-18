// 私有原话链路的零依赖协议；conventions 开场脚本在未安装 workspace 时也能使用。
export interface PrivateQuote {
  id: string;
  spokenAt: string;
  text: string;
  machine: string;
  lineage: string;
  remote: string | null;
  directiveId: string | null;
}
export const quoteIdValid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const quoteTimeValid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
/** 只校验不转写，首尾空白属于原文；错误不回显输入。 */
export function parsePrivateQuotes(raw: unknown): PrivateQuote[] {
  const bad = () => {
    throw new Error('私有原话数据格式不对（内容不回显）。');
  };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 1000) return bad();
  return raw.map((q: unknown) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return bad();
    const o = q as Record<string, unknown>;
    const keys = ['id', 'spokenAt', 'text', 'machine', 'lineage', 'remote', 'directiveId'];
    const str = (key: string, max: number) =>
      typeof o[key] === 'string' && (o[key] as string).length > 0 && (o[key] as string).length <= max;
    if (
      Object.keys(o).length !== keys.length ||
      Object.keys(o).some((k) => !keys.includes(k)) ||
      !quoteIdValid(o.id) ||
      !quoteTimeValid(o.spokenAt) ||
      !str('text', 1_000_000) ||
      !(o.text as string).trim() ||
      !str('machine', 256) ||
      !str('lineage', 1024) ||
      !(o.remote === null || (typeof o.remote === 'string' && o.remote.length <= 8192)) ||
      !(o.directiveId === null || (typeof o.directiveId === 'string' && /^\d{6,20}$/.test(o.directiveId)))
    )
      return bad();
    return {
      id: o.id,
      spokenAt: o.spokenAt,
      text: o.text as string,
      machine: o.machine as string,
      lineage: o.lineage as string,
      remote: o.remote as string | null,
      directiveId: o.directiveId as string | null,
    };
  });
}
