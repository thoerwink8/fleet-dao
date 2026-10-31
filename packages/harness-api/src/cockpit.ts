// 驾驶舱口（#3818）：新驾驶舱（packages/harness-web，公网 /next/）读新内核会话的只读接口。
// 浏览器带的是旧驾驶舱签发的登录 Cookie，这里自己验，不经旧后端、不发不存不转任何会话令牌：
//   签名对（HMAC-SHA256，purpose fleet-session/v1，密钥 FLEET_SESSION_SECRET）、没过期、public.users 里 active 且 role=founder、
//   Cookie 里的 v 等于 users.session_version。开着的 SSE 每个周期重核一次，退出或摘掉白名单最晚一个周期后断开。
// 这个口只有三条 GET：会话列表、历史页、SSE。不认会话令牌（请求头或 cookie 里带了就 401），没有 /mcp，不回 CORS 头。
// Cookie 格式从旧驾驶舱 packages/api 的 tokens.ts / session.ts 拷来（决定 0124：新包不依赖旧包），固定向量见 AGENTS.md 和测试。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { transcriptStream } from '@fleet-dao/harness-contract';
import { countStuck, type TailEvent } from '@fleet-dao/harness-contract/worker-state';
import { advanceStreamHeads, type Db, events, streamHeads } from '@fleet-dao/harness-store';
import { and, desc, eq, lt, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sessionStream } from './events.ts';
import { type HarnessApi, hasTokenInQuery, wrapServer } from './server.ts';
import { reply, serveHistory, serveSse } from './session-http.ts';
import { TOKEN_COOKIE, TOKEN_HEADER } from './tokens.ts';

/** https 下的登录 Cookie 名（旧驾驶舱 session.ts 的 cookieNames）。 */
export const COCKPIT_COOKIE = '__Host-fleet_session';
const SESSION_PURPOSE = 'fleet-session/v1';
/** 比香港 nginx 的 5 分钟长，免得代理复用刚被这边关掉的连接（旧后端踩过，packages/api/src/keep-alive.ts）。 */
export const COCKPIT_KEEP_ALIVE_MS = 6 * 60_000;
/** 工人过程历史页的载荷字节上限：每条最多约 4KB，行数上限之外再加一道，一页最多读 limit+1 行、给回不超过这么多字节。 */
export const TRANSCRIPT_PAGE_BYTES = 256 * 1024;
const LIST_DEFAULT = 30;
const LIST_MAX = 100;

const SessionClaims = z.object({
  uid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  sid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  m: z.string().max(40).optional(),
  v: z.number().int().min(0).optional(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;

// ---- 以下三个函数拷自 packages/api/src/tokens.ts（签名小工具），改动只有去掉没用到的 ----
function mac(secret: string, purpose: string, body: string): Buffer {
  return createHmac('sha256', secret).update(purpose).update('\n').update(body).digest();
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** 签名对才返回载荷；格式不对、签名不对一律 null。 */
function verifyPayload(secret: string, purpose: string, token: string): unknown {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.') || token.length > 8192) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(secret, purpose, body).toString('base64url'))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 签一个会话 Cookie 的值（`<载荷 base64url>.<签名 base64url>`）。线上只有旧驾驶舱会签；
 * 这里给测试和 e2e 用，purpose 可以换成别的来造「拿别的用途的值冒充」。
 */
export function signSessionCookie(secret: string, claims: SessionClaims, purpose = SESSION_PURPOSE): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${body}.${mac(secret, purpose, body).toString('base64url')}`;
}

export interface CockpitOptions {
  db: Db;
  /** 旧驾驶舱的 FLEET_SESSION_SECRET。 */
  sessionSecret: string;
  /** Cookie 名，默认 __Host-fleet_session；只有本机 http 开发和 e2e 才改。 */
  cookieName?: string;
  /** 取当前时间（秒级判过期用），测试可换。 */
  now?: () => Date;
  /** 断线太久落后超过这么多条就发 resync 不补发。默认 1000。 */
  replayCap?: number;
  /** SSE 每隔多久读一次新事件、核一次登录。默认 1000ms。 */
  pollMs?: number;
  heartbeatMs?: number;
}

export type CockpitApi = HarnessApi;

type Verdict = { ok: true } | { ok: false; status: 401 | 403; message: string };

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

/** 会话号：和 harness 事件流的 session:<号> 对应；不许带 /、..、空白、控制字符，最长 128。 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !id.includes('..');
}

interface UserRow {
  role: string;
  active: boolean;
  session_version: number;
}

async function loadUser(db: Db, uid: string): Promise<UserRow | null> {
  // 旧库 public.users：主键查 1 行；role 是枚举，转成文本比
  const result = (await db.execute(
    sql`select role::text as role, active, session_version from public.users where id = ${uid}::uuid limit 1`,
  )) as unknown as UserRow[] | { rows: UserRow[] };
  const rows = Array.isArray(result) ? result : result.rows;
  return rows[0] ?? null;
}

function parseLimitAndBefore(url: URL): { limit: number; before?: number } | null {
  const limitRaw = url.searchParams.get('limit');
  const beforeRaw = url.searchParams.get('before');
  let limit = LIST_DEFAULT;
  if (limitRaw !== null) {
    if (!/^\d{1,4}$/.test(limitRaw)) return null;
    limit = Number(limitRaw);
    if (limit < 1 || limit > LIST_MAX) return null;
  }
  if (beforeRaw === null) return { limit };
  if (!/^\d{1,15}$/.test(beforeRaw)) return null;
  return { limit, before: Number(beforeRaw) };
}

// 近期事件的瘦身版 TailEvent：只带判工人状态用得上的几个字段（不带大文本），形状和判读规则都在 harness-contract。
export type { TailEvent };

export interface SessionListItem {
  id: string;
  eventCount: number;
  lastEventId: number;
  lastAt: string;
  lastType: string;
  lastPayload: unknown;
  /** 这个会话最近 TAIL_EVENTS 条事件的瘦身版，最旧在前。 */
  tail: TailEvent[];
}

/** 每个会话带多少条近期事件：页大小 × 这个数 = 状态判读最多多读的行数。 */
export const TAIL_EVENTS = 24;

interface TailRow {
  stream_id: string;
  type: string;
  slim: Record<string, unknown> | string;
}

/**
 * 一页会话的近期事件：对页里每个会话走 (stream_id, id) 索引倒着取 TAIL_EVENTS 条，所以读的行数 ≤ 页大小 × TAIL_EVENTS，
 * 和流多长无关。只摘判状态要的字段，大文本（证据、错误输出）留在库里。
 */
async function loadTails(db: Db, streamIds: string[]): Promise<Map<string, TailEvent[]>> {
  const out = new Map<string, TailEvent[]>();
  if (streamIds.length === 0) return out;
  const ids = sql.join(
    streamIds.map((s) => sql`${s}`),
    sql`, `,
  );
  const result = (await db.execute(sql`
    select s.stream_id, t.type, t.slim
    from unnest(array[${ids}]::text[]) as s(stream_id)
    cross join lateral (
      select e.id, e.type, jsonb_build_object(
        'outcome', e.payload->'outcome',
        'final', e.payload->'final',
        'status', e.payload->'status',
        'exitCode', e.payload->'exitCode',
        'killed', e.payload->'killed',
        'spawnError', e.payload->'spawnError',
        'deadline', e.payload->'deadline'
      ) as slim
      from ${events} e
      where e.stream_id = s.stream_id
      order by e.id desc
      limit ${TAIL_EVENTS}
    ) t
    order by s.stream_id, t.id asc
  `)) as unknown as TailRow[] | { rows: TailRow[] };
  for (const r of Array.isArray(result) ? result : result.rows) {
    const slim = (typeof r.slim === 'string' ? JSON.parse(r.slim) : r.slim) as Record<string, unknown>;
    const ev: Record<string, unknown> = { type: r.type };
    for (const [k, v] of Object.entries(slim)) if (v !== null) ev[k] = v;
    const list = out.get(r.stream_id);
    if (list) list.push(ev as unknown as TailEvent);
    else out.set(r.stream_id, [ev as unknown as TailEvent]);
  }
  return out;
}

/**
 * 全库卡住的会话数：对每个会话流取近期事件，按 harness-contract 的 deriveWorkerState 同一套规则判，
 * 不受分页影响（前端翻没翻页数都一样）。读的行数 ≤ 会话数 × TAIL_EVENTS。
 */
async function countStuckSessions(db: Db, now: number): Promise<number> {
  const heads = await db
    .select({ streamId: streamHeads.streamId })
    .from(streamHeads)
    .where(sql`${streamHeads.streamId} like 'session:%'`);
  const tails = await loadTails(
    db,
    heads.map((h) => h.streamId),
  );
  return countStuck(tails.values(), now);
}

/** 会话列表：先把投影推到最新，再按最后事件号倒序取一页；读的行数和页大小成正比（stuckCount 另算，见上）。 */
export async function listSessions(
  db: Db,
  opts: { limit: number; before?: number; now?: number },
): Promise<{ sessions: SessionListItem[]; nextBefore: number | null; stuckCount: number }> {
  await advanceStreamHeads(db);
  const stuckCount = await countStuckSessions(db, opts.now ?? Date.now());
  const conds: SQL[] = [sql`${streamHeads.streamId} like 'session:%'`];
  if (opts.before !== undefined) conds.push(lt(streamHeads.lastEventId, opts.before));
  const rows = await db
    .select({
      streamId: streamHeads.streamId,
      eventCount: streamHeads.events,
      lastEventId: streamHeads.lastEventId,
      lastAt: streamHeads.lastAt,
      lastType: streamHeads.lastType,
      lastPayload: events.payload,
    })
    .from(streamHeads)
    .innerJoin(events, eq(events.id, streamHeads.lastEventId))
    .where(and(...conds))
    .orderBy(desc(streamHeads.lastEventId))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const tails = await loadTails(
    db,
    page.map((r) => r.streamId),
  );
  return {
    sessions: page.map((r) => ({
      id: r.streamId.slice('session:'.length),
      eventCount: r.eventCount,
      lastEventId: r.lastEventId,
      lastAt: r.lastAt.toISOString(),
      lastType: r.lastType,
      lastPayload: r.lastPayload,
      tail: tails.get(r.streamId) ?? [],
    })),
    nextBefore: rows.length > opts.limit ? (page.at(-1)?.lastEventId ?? null) : null,
    stuckCount,
  };
}

export function createCockpitApi(options: CockpitOptions): CockpitApi {
  const { db, sessionSecret } = options;
  if (sessionSecret.length < 16) throw new Error('sessionSecret 太短');
  const cookieName = options.cookieName ?? COCKPIT_COOKIE;
  const clock = options.now ?? (() => new Date());
  const open = new Set<() => void>();
  const sseOptions = {
    db,
    replayCap: options.replayCap ?? 1000,
    pollMs: options.pollMs ?? 1000,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    open,
  };

  /** 核登录。会话令牌（请求头、cookie）、Authorization 一概不认：带了就 401，哪怕登录 Cookie 是好的。 */
  async function authorize(req: IncomingMessage): Promise<Verdict> {
    if (req.headers[TOKEN_HEADER] !== undefined || req.headers.authorization !== undefined) {
      return { ok: false, status: 401, message: '这个口只认登录 Cookie' };
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.has(TOKEN_COOKIE)) return { ok: false, status: 401, message: '这个口只认登录 Cookie' };
    const raw = cookies.get(cookieName);
    if (!raw) return { ok: false, status: 401, message: '没登录或登录已过期' };
    const parsed = SessionClaims.safeParse(verifyPayload(sessionSecret, SESSION_PURPOSE, raw));
    if (!parsed.success || parsed.data.exp <= Math.floor(clock().getTime() / 1000)) {
      return { ok: false, status: 401, message: '没登录或登录已过期' };
    }
    const user = await loadUser(db, parsed.data.uid);
    if (!user || !user.active || user.role !== 'founder') {
      return { ok: false, status: 403, message: '这个账号不在白名单里' };
    }
    if ((parsed.data.v ?? 0) !== (user.session_version ?? 0)) {
      return { ok: false, status: 401, message: '这个登录已失效，请重新登录' };
    }
    return { ok: true };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (hasTokenInQuery(url)) return reply(res, 400, '令牌只能放请求头或 cookie，不能放网址');
    // /sessions/<号>/(history|events) 读会话流；/transcripts/<runId>/(history|events) 读工人过程流 transcript:<runId>（#3781）
    const m =
      /^\/next\/api\/(?:sessions(?:\/([^/]+)\/(history|events))?|transcripts\/([^/]+)\/(history|events))$/.exec(
        url.pathname,
      );
    if (!m) return reply(res, 404, '没有这个路径');
    const isTranscript = m[3] !== undefined;
    const rawId = isTranscript ? m[3] : m[1];
    const sessionId = rawId === undefined ? undefined : decodeURIComponent(rawId);
    const action = isTranscript ? m[4] : m[2];
    if (sessionId !== undefined && !isValidSessionId(sessionId)) return reply(res, 404, '没有这个路径');
    if (req.method !== 'GET') return reply(res, 405, '只收 GET');
    const verdict = await authorize(req);
    if (!verdict.ok) return reply(res, verdict.status, verdict.message);

    if (sessionId === undefined) {
      const q = parseLimitAndBefore(url);
      if (!q) return reply(res, 400, 'limit 要是 1 到 100 的整数，before 要是非负整数');
      const body = await listSessions(db, q);
      res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify(body));
      return;
    }
    const streamId = isTranscript ? transcriptStream(sessionId) : sessionStream(sessionId);
    if (action === 'history') {
      return await serveHistory(db, url, res, streamId, isTranscript ? TRANSCRIPT_PAGE_BYTES : undefined);
    }
    // 每个周期把同一个 Cookie 重核一遍：退出（session_version 加 1）或 active=false 之后最晚一个周期断开
    return await serveSse(sseOptions, req, res, streamId, async () => (await authorize(req)).ok);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, '内部错误'));
  });
  server.keepAliveTimeout = COCKPIT_KEEP_ALIVE_MS;
  server.headersTimeout = COCKPIT_KEEP_ALIVE_MS + 5000;
  return { server, ...wrapServer(server, open) };
}
