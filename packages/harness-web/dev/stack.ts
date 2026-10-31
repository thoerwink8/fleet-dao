// 本机开发和 e2e 用的整套后端：PGlite（跑 fleet2 的真迁移，外加一张最小的 public.users）+ 真的驾驶舱口（harness-api 的 createCockpitApi，
// 部署用的就是这份代码）+ 一个只做两件事的前门（相当于香港 nginx）：/next/api/* 原样转给驾驶舱口，dist/ 存在时把打包好的前端放在 /next/ 下。
// 前门不带任何凭据、不认识会话令牌：浏览器带的是登录 Cookie，由驾驶舱口自己验。e2e 用测试密钥签一个 Cookie 塞进浏览器。
// 生产代码不要 import 这里。
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  appendToSession,
  appendToStream,
  type CockpitApi,
  createCockpitApi,
  type SessionClaims,
  signSessionCookie,
} from '@fleet-dao/harness-api';
import { type Db, MIGRATION_OPTIONS } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

/** 测试密钥和测试用户：只在开发和 e2e 的临时库里存在。 */
export const DEV_SESSION_SECRET = 'dev-only-session-secret-0123456789abcdef';
export const DEV_FOUNDER_ID = '00000000-0000-4000-8000-0000000000f1';
/** 本机 http 下没法用 __Host- 前缀（要 Secure），所以开发和 e2e 用不带前缀的名字；线上默认的名字由驾驶舱口的默认值管。 */
export const DEV_COOKIE_NAME = 'fleet_session';

export interface StackOptions {
  /** 持久化目录；不给就是内存库，进程退出即没。 */
  dataDir?: string;
  /** 前门端口；0 = 随机。 */
  port?: number;
  /** 驾驶舱口端口；0 = 随机（重启时沿用上一次的端口）。 */
  apiPort?: number;
  /** 打包好的前端目录；存在就在 /next/ 下放出来。 */
  distDir?: string;
  /** SSE 轮询间隔、心跳间隔（e2e 里调小）。 */
  pollMs?: number;
  heartbeatMs?: number;
  replayCap?: number;
}

export interface Stack {
  db: Db;
  url: string;
  apiUrl(): string;
  /** 往会话追加一条事件（和真工人走同一个 appendToSession）。 */
  emit(sessionId: string, type: string, payload: Record<string, unknown>): Promise<number>;
  /** 往任意一条流追加一条（工人过程流 transcript:<runId> 的样例用）。 */
  emitStream(streamId: string, type: string, payload: Record<string, unknown>): Promise<number>;
  /** 签一个创始人的登录 Cookie（e2e 塞进浏览器）；overrides 造过期、版本不对等。 */
  cookie(overrides?: Partial<SessionClaims>): { name: string; value: string };
  /** 退出：把创始人的 session_version 加 1（已签发的 Cookie 作废）。 */
  logoutAll(): Promise<void>;
  /** 停掉驾驶舱口（模拟后端挂了）；前门还在，对 /next/api 回 502。 */
  stopApi(): Promise<void>;
  /** 在原端口重新拉起驾驶舱口。 */
  startApi(): Promise<void>;
  stats: {
    /** 前门收到的 SSE 连接请求（含失败的）。每个元素是到达时刻（ms）。 */
    sseAttempts: number[];
    /** 现在开着的 SSE 连接数。 */
    openSse: number;
    historyFetches: number;
  };
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
};

export async function createDb(dataDir?: string): Promise<{ db: Db; pg: PGlite }> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, MIGRATION_OPTIONS);
  // 旧库的 public.users：驾驶舱口只读 id、role、active、session_version，这里建最小的一张，放一位创始人
  await pg.exec(`
    create table if not exists public.users (
      id uuid primary key, role text not null, active boolean not null default true,
      session_version integer not null default 0
    );
    insert into public.users (id, role) values ('${DEV_FOUNDER_ID}', 'founder') on conflict do nothing;
  `);
  return { db: db as unknown as Db, pg };
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const { db, pg } = await createDb(options.dataDir);
  const stats: Stack['stats'] = { sseAttempts: [], openSse: 0, historyFetches: 0 };
  let api: CockpitApi | null = null;
  let apiPort = options.apiPort ?? 0;

  const startApi = async (): Promise<void> => {
    if (api) return;
    api = createCockpitApi({
      db,
      sessionSecret: DEV_SESSION_SECRET,
      cookieName: DEV_COOKIE_NAME,
      pollMs: options.pollMs ?? 500,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      ...(options.replayCap !== undefined ? { replayCap: options.replayCap } : {}),
    });
    apiPort = await api.listen(apiPort);
  };
  const stopApi = async (): Promise<void> => {
    const a = api;
    api = null;
    if (a) await a.close();
  };
  await startApi();

  function cookie(overrides: Partial<SessionClaims> = {}): { name: string; value: string } {
    const iat = Math.floor(Date.now() / 1000);
    return {
      name: DEV_COOKIE_NAME,
      value: signSessionCookie(DEV_SESSION_SECRET, {
        uid: DEV_FOUNDER_ID,
        sid: 'dev-sid',
        iat,
        exp: iat + 3600,
        m: 'dev-login',
        v: 0,
        ...overrides,
      }),
    };
  }

  /** 原样转给驾驶舱口，只带 cookie / accept / last-event-id 三个头。 */
  function proxy(req: IncomingMessage, res: ServerResponse, path: string): void {
    const h = req.headers;
    const up = httpRequest(
      {
        host: '127.0.0.1',
        port: apiPort,
        path,
        method: req.method ?? 'GET',
        headers: {
          ...(h.cookie ? { cookie: String(h.cookie) } : {}),
          accept: String(h.accept ?? '*/*'),
          ...(h['last-event-id'] ? { 'last-event-id': String(h['last-event-id']) } : {}),
        },
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        res.flushHeaders();
        ur.pipe(res);
        ur.on('error', () => res.destroy());
      },
    );
    up.on('error', () => {
      if (!res.headersSent)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('后端暂时连不上');
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    up.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    // 本机开发免登录入口：打开它就拿到创始人的登录 Cookie（线上的登录在旧驾驶舱）
    if (p === '/next/dev-login') {
      const c = cookie();
      return void res
        .writeHead(302, {
          'set-cookie': `${c.name}=${c.value}; Path=/; HttpOnly; SameSite=Lax`,
          location: '/next/',
        })
        .end();
    }
    if (p.startsWith('/next/api/')) {
      const events = /^\/next\/api\/sessions\/[^/]+\/events$/.test(p);
      if (events) {
        stats.sseAttempts.push(Date.now());
        stats.openSse++;
        res.on('close', () => {
          stats.openSse--;
        });
      } else if (/\/history$/.test(p)) stats.historyFetches++;
      if (!api)
        return void res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('后端暂时连不上');
      return proxy(req, res, `${p}${url.search}`);
    }
    // 静态文件（打包好的前端）
    if (options.distDir && p.startsWith('/next/')) {
      const rel = normalize(decodeURIComponent(p.slice('/next/'.length))).replace(/^(\.\.[\\/])+/, '');
      let file = resolve(options.distDir, rel);
      if (!file.startsWith(resolve(options.distDir)) || !existsSync(file) || !statSync(file).isFile()) {
        file = join(options.distDir, 'index.html');
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      return void createReadStream(file).pipe(res);
    }
    res.writeHead(404).end('没有这个路径');
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('内部错误');
      else res.destroy();
    });
  });
  const port = await new Promise<number>((r) =>
    server.listen(options.port ?? 0, '127.0.0.1', () => r((server.address() as AddressInfo).port)),
  );

  return {
    db,
    url: `http://127.0.0.1:${port}`,
    apiUrl: () => `http://127.0.0.1:${apiPort}`,
    async emit(sessionId, type, payload) {
      const ev = await appendToSession(db, sessionId, type as never, payload);
      return ev.id;
    },
    async emitStream(streamId, type, payload) {
      const ev = await appendToStream(db, streamId, type as never, payload);
      return ev.id;
    },
    cookie,
    async logoutAll() {
      await pg.exec(
        `update public.users set session_version = session_version + 1 where id = '${DEV_FOUNDER_ID}'`,
      );
    },
    stopApi,
    startApi,
    stats,
    async close() {
      await stopApi();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await pg.close();
    },
  };
}
