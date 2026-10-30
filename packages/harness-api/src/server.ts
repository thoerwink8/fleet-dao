// HTTP 入口（node http）：POST /mcp 是 Streamable HTTP MCP，GET /sessions/<号>/events 是 SSE。
// 令牌只认请求头 X-Fleet-Session-Token 或 cookie，网址里带令牌一律 400，不往下走。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Db, PAGE_MAX } from '@fleet-dao/harness-store';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { gapExceeds, latestSessionEventId, readSessionAfter } from './events.ts';
import { readTokenFromRequest, type TokenClaims, verifyToken } from './tokens.ts';
import { toolsFor } from './tools.ts';

export interface HarnessApiOptions {
  db: Db;
  /** 影子模式：会引起外部写的工具不注册。 */
  shadow?: boolean;
  /** 断线太久落后超过这么多条就发 resync 不补发。默认 1000。 */
  replayCap?: number;
  /** SSE 每隔多久读一次新事件、核一次令牌（撤销最晚这么久后连接断开）。默认 1000ms。 */
  pollMs?: number;
  /** 空闲时多久发一次心跳。默认 15000ms。 */
  heartbeatMs?: number;
}

export interface HarnessApi {
  server: Server;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
}

function hasTokenInQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) if (/token/i.test(key)) return true;
  return false;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('请求体太大');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

export function createHarnessApi(options: HarnessApiOptions): HarnessApi {
  const { db } = options;
  const shadow = options.shadow ?? false;
  const replayCap = options.replayCap ?? 1000;
  const pollMs = options.pollMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const open = new Set<() => void>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse, claims: TokenClaims): Promise<void> {
    if (req.method !== 'POST') return reply(res, 405, '只收 POST');
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return reply(res, 400, '请求体不是合法 JSON 或太大');
    }
    // 无状态：每个请求按令牌的角色现建一份服务，只注册该角色能用的工具。
    const server = new McpServer({ name: 'fleet-harness', version: '0.0.0' });
    const ctx = { db, sessionId: claims.sessionId, role: claims.role };
    for (const tool of toolsFor(claims.role, shadow)) tool.register(server, ctx);
    // SDK 的类型和本仓 exactOptionalPropertyTypes 对不上：无状态模式就是 sessionIdGenerator 给 undefined，在这里收口。
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
    await transport.handleRequest(req, res, body);
  }

  async function handleSse(
    req: IncomingMessage,
    res: ServerResponse,
    claims: TokenClaims,
    token: string,
    sessionId: string,
  ): Promise<void> {
    if (claims.sessionId !== sessionId) return reply(res, 403, '令牌不属于这个会话');
    const header = req.headers['last-event-id'];
    const lastRaw = Array.isArray(header) ? header[0] : header;
    let cursor = 0;
    let resync = false;
    if (lastRaw === undefined || lastRaw === '') {
      cursor = await latestSessionEventId(db, sessionId);
    } else if (!/^\d{1,15}$/.test(lastRaw)) {
      resync = true;
      cursor = await latestSessionEventId(db, sessionId);
    } else {
      cursor = Number(lastRaw);
      if (await gapExceeds(db, sessionId, cursor, replayCap)) {
        resync = true;
        cursor = await latestSessionEventId(db, sessionId);
      }
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      open.delete(finish);
      res.end();
    };
    open.add(finish);
    res.on('close', () => {
      closed = true;
      if (timer) clearTimeout(timer);
      open.delete(finish);
    });
    if (resync) res.write(`id: ${cursor}\nevent: resync\ndata: {}\n\n`);
    else if (lastRaw === undefined || lastRaw === '') res.write(`id: ${cursor}\nevent: ready\ndata: {}\n\n`);
    let lastWrite = Date.now();
    const tick = async (): Promise<void> => {
      try {
        // 令牌撤销后最晚下一次 tick 就断。
        if ((await verifyToken(db, token)) === null) return finish();
        for (;;) {
          const page = await readSessionAfter(db, sessionId, cursor, PAGE_MAX);
          for (const ev of page) {
            if (closed) return;
            res.write(
              `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify({ seq: ev.seq, payload: ev.payload, createdAt: ev.createdAt })}\n\n`,
            );
            cursor = ev.id;
            lastWrite = Date.now();
          }
          if (page.length < PAGE_MAX) break;
        }
        if (!closed && Date.now() - lastWrite >= heartbeatMs) {
          res.write(': ping\n\n');
          lastWrite = Date.now();
        }
      } catch {
        return finish();
      }
      if (!closed) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (hasTokenInQuery(url)) return reply(res, 400, '令牌只能放请求头或 cookie，不能放网址');
        const sse = /^\/sessions\/([^/]+)\/events$/.exec(url.pathname);
        if (url.pathname !== '/mcp' && !sse) return reply(res, 404, '没有这个路径');
        const token = readTokenFromRequest(req.headers);
        const claims = await verifyToken(db, token);
        if (!claims || token === undefined) return reply(res, 401, '令牌无效');
        if (sse) {
          if (req.method !== 'GET') return reply(res, 405, '只收 GET');
          return await handleSse(req, res, claims, token, decodeURIComponent(sse[1] ?? ''));
        }
        return await handleMcp(req, res, claims);
      } catch {
        reply(res, 500, '内部错误');
      }
    })();
  });

  return {
    server,
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const end of [...open]) end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
