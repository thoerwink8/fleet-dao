// 本机开发和 e2e 用的整套后端：PGlite（跑 fleet2 的真迁移）+ harness-api（真接口层）+ 一个很薄的前端后端（BFF）。
// BFF 做三件事：列会话（接口层按令牌只认一个会话，没有“列全部”）、按会话代带令牌（浏览器里没有令牌）、
// 在 dist/ 存在时顺带把打包好的前端放在 /next/ 下。它只在开发和 e2e 里用，不是部署形态——部署怎么接见 PR 里的后续单。
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
import { appendToSession, createHarnessApi, type HarnessApi, issueToken } from '@fleet-dao/harness-api';
import { type Db, MIGRATION_OPTIONS } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

export interface StackOptions {
  /** 持久化目录；不给就是内存库，进程退出即没。 */
  dataDir?: string;
  /** BFF 端口；0 = 随机。 */
  port?: number;
  /** 接口层端口；0 = 随机（重启时沿用上一次的端口）。 */
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
  /** 停掉接口层（模拟后端挂了）；BFF 还在，对 /events 和 /history 回 502。 */
  stopApi(): Promise<void>;
  /** 在原端口重新拉起接口层。 */
  startApi(): Promise<void>;
  stats: {
    /** BFF 收到的 SSE 连接请求（含失败的）。每个元素是到达时刻（ms）。 */
    sseAttempts: number[];
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

type Row = Record<string, unknown>;
function rowsOf(r: unknown): Row[] {
  return Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] }).rows ?? []);
}

export async function createDb(dataDir?: string): Promise<{ db: Db; pg: PGlite }> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, MIGRATION_OPTIONS);
  return { db: db as unknown as Db, pg };
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const { db, pg } = await createDb(options.dataDir);
  const stats: Stack['stats'] = { sseAttempts: [], historyFetches: 0 };
  const tokens = new Map<string, string>();
  let api: HarnessApi | null = null;
  let apiPort = options.apiPort ?? 0;

  const makeApi = () =>
    createHarnessApi({
      db,
      pollMs: options.pollMs ?? 500,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      ...(options.replayCap !== undefined ? { replayCap: options.replayCap } : {}),
    });
  const startApi = async (): Promise<void> => {
    if (api) return;
    api = makeApi();
    apiPort = await api.listen(apiPort);
  };
  const stopApi = async (): Promise<void> => {
    const a = api;
    api = null;
    if (a) await a.close();
  };
  await startApi();

  async function tokenFor(sessionId: string): Promise<string> {
    let t = tokens.get(sessionId);
    if (!t) {
      t = (await issueToken(db, sessionId, 'commander')).token;
      tokens.set(sessionId, t);
    }
    return t;
  }

  async function listSessions(): Promise<unknown> {
    const rows = rowsOf(
      await db.execute(sql`
        select s.stream_id, s.n, s.last_id, s.last_at, e.type as last_type, e.payload as last_payload
        from (
          select stream_id, count(*)::int as n, max(id) as last_id, max(created_at) as last_at
          from fleet2.events where stream_id like 'session:%' group by stream_id
        ) s join fleet2.events e on e.id = s.last_id
        order by s.last_at desc, s.last_id desc limit 100`),
    );
    return {
      sessions: rows.map((r) => ({
        id: String(r.stream_id).slice('session:'.length),
        eventCount: Number(r.n),
        lastEventId: Number(r.last_id),
        lastAt: new Date(r.last_at as string | Date).toISOString(),
        lastType: String(r.last_type),
        lastPayload: (r.last_payload ?? {}) as Record<string, unknown>,
      })),
    };
  }

  function proxy(req: IncomingMessage, res: ServerResponse, path: string, token: string): void {
    const up = httpRequest(
      {
        host: '127.0.0.1',
        port: apiPort,
        path,
        method: 'GET',
        headers: {
          'x-fleet-session-token': token,
          accept: String(req.headers.accept ?? '*/*'),
          ...(req.headers['last-event-id'] ? { 'last-event-id': String(req.headers['last-event-id']) } : {}),
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

  const SESSION_ID = /^[A-Za-z0-9._:-]{1,80}$/;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p === '/next/api/sessions' && req.method === 'GET') {
      return void res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify(await listSessions()));
    }
    const m = /^\/next\/api\/sessions\/([^/]+)\/(events|history)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1] ?? '');
      if (!SESSION_ID.test(id)) return void res.writeHead(404).end('没有这个会话');
      const kind = m[2];
      if (kind === 'events') stats.sseAttempts.push(Date.now());
      else stats.historyFetches++;
      if (!api)
        return void res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('后端暂时连不上');
      return proxy(req, res, `/sessions/${encodeURIComponent(id)}/${kind}${url.search}`, await tokenFor(id));
    }
    if (p.startsWith('/next/api/')) return void res.writeHead(404).end('没有这个路径');
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
