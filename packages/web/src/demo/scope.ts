// 演示版的可见范围：游客能看哪些模块、细节看到哪一级。正式驾驶舱发链接时，后端把范围发布成静态文件
// （<范围目录>/<口令的 SHA-256>.json，默认范围是 default.json），这里只读它：不带任何凭据、不连后端，
// 所以正式版的后端停了照样能看。读不到、读不懂、过期了，一律退回默认范围；默认范围也读不到就用内置的最严范围。
import {
  DEMO_DEFAULT_SCOPE_FILE,
  DEMO_STRICT_DEFAULT,
  type DemoScope,
  DemoScopeSchema,
} from '@fleet-dao/shared';

export type DemoModule = DemoScope['modules'][number];
export type DemoDetail = DemoScope['detail'];

export interface LoadedScope {
  scope: DemoScope;
  /** link = 按链接发的范围；default = 发布了的默认范围；builtin = 默认范围也没读到，用内置的最严范围。 */
  source: 'link' | 'default' | 'builtin';
  /** 给游客看的一句话：链接过期了、作废了、没读到……没事就没有。 */
  notice?: string;
}

/** 口令的样子：后端发的是 32 字节的 base64url（43 个字符）；别的一律不认，也不拿去拼地址。 */
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

/** 从地址里取口令：?k=… 或 #k=…；没有或样子不对就是 null。 */
export function tokenFrom(search: string, hash: string): string | null {
  for (const part of [search, hash]) {
    const k = new URLSearchParams(part.replace(/^[?#]/, '')).get('k');
    if (k && TOKEN.test(k)) return k;
  }
  return null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Read = { ok: true; scope: DemoScope } | { ok: false; why: 'missing' | 'broken'; detail: string };

/**
 * 读一个范围文件。没有这个文件（404，或者门面把查不到的路径回落成了单页的 index.html）算 missing；
 * 读到了却不是约定的样子、或者根本没连上，算 broken——两者给游客的说法不一样。
 */
async function readScope(url: string, fetchFn: typeof fetch): Promise<Read> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    return { ok: false, why: 'broken', detail: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 404) return { ok: false, why: 'missing', detail: '404' };
  if (!res.ok) return { ok: false, why: 'broken', detail: `HTTP ${res.status}` };
  if (!(res.headers.get('content-type') ?? '').includes('json')) {
    return { ok: false, why: 'missing', detail: '回来的不是 JSON' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: 'broken', detail: '不是合法的 JSON' };
  }
  const parsed = DemoScopeSchema.safeParse(body);
  if (!parsed.success) return { ok: false, why: 'broken', detail: '内容不合约定' };
  return { ok: true, scope: parsed.data };
}

function expired(scope: DemoScope, now: Date): boolean {
  return scope.expiresAt !== undefined && Date.parse(scope.expiresAt) <= now.getTime();
}

/**
 * 定下这次按哪份范围展示。base 是范围目录的地址（以 / 结尾）。
 * 链接的范围过期了也退回默认范围：后端会撤掉过期的文件，但游客的电脑时钟、缓存都不可信，这里再挡一道。
 */
export async function resolveScope(opts: {
  token: string | null;
  base: string;
  now: Date;
  fetch?: typeof fetch;
}): Promise<LoadedScope> {
  const fetchFn = opts.fetch ?? fetch;
  let notice: string | undefined;
  if (opts.token) {
    const link = await readScope(`${opts.base}${await sha256Hex(opts.token)}.json`, fetchFn);
    if (link.ok && !expired(link.scope, opts.now)) return { scope: link.scope, source: 'link' };
    notice = link.ok
      ? '这条演示链接已过期，下面按默认范围展示。'
      : link.why === 'missing'
        ? '这条演示链接已作废或不存在，下面按默认范围展示。'
        : `这条演示链接的范围没读到（${link.detail}），下面按默认范围展示。`;
  }
  const fallback = await readScope(`${opts.base}${DEMO_DEFAULT_SCOPE_FILE}`, fetchFn);
  if (fallback.ok && !expired(fallback.scope, opts.now)) {
    return notice
      ? { scope: fallback.scope, source: 'default', notice }
      : { scope: fallback.scope, source: 'default' };
  }
  return notice
    ? { scope: DEMO_STRICT_DEFAULT, source: 'builtin', notice }
    : { scope: DEMO_STRICT_DEFAULT, source: 'builtin' };
}
