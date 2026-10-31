// HTTP 入口（node http）：POST /mcp 是 Streamable HTTP MCP，GET /sessions/<号>/events 是 SSE。
// 令牌只认请求头 X-Fleet-Session-Token 或 cookie，网址里带令牌一律 400，不往下走。
// 历史页和 SSE 的实现在 session-http.ts，驾驶舱口（cockpit.ts）共用。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '@fleet-dao/harness-store';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sessionStream } from './events.ts';
import { reply, serveHistory, serveSse } from './session-http.ts';
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

export function hasTokenInQuery(url: URL): boolean {
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

/** 把 node 服务包成 listen / close：close 先收开着的 SSE。 */
export function wrapServer(server: Server, open: Set<() => void>): Pick<HarnessApi, 'listen' | 'close'> {
  return {
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

export function createHarnessApi(options: HarnessApiOptions): HarnessApi {
  const { db } = options;
  const shadow = options.shadow ?? false;
  const replayCap = options.replayCap ?? 1000;
  const pollMs = options.pollMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const open = new Set<() => void>();
  const sseOptions = { db, replayCap, pollMs, heartbeatMs, open };

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

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (hasTokenInQuery(url)) return reply(res, 400, '令牌只能放请求头或 cookie，不能放网址');
        const sse = /^\/sessions\/([^/]+)\/events$/.exec(url.pathname);
        const history = /^\/sessions\/([^/]+)\/history$/.exec(url.pathname);
        if (url.pathname !== '/mcp' && !sse && !history) return reply(res, 404, '没有这个路径');
        const token = readTokenFromRequest(req.headers);
        const claims = await verifyToken(db, token);
        if (!claims || token === undefined) return reply(res, 401, '令牌无效');
        if (history) {
          if (req.method !== 'GET') return reply(res, 405, '只收 GET');
          if (claims.sessionId !== decodeURIComponent(history[1] ?? '')) {
            return reply(res, 403, '令牌不属于这个会话');
          }
          return await serveHistory(db, url, res, sessionStream(claims.sessionId));
        }
        if (sse) {
          if (req.method !== 'GET') return reply(res, 405, '只收 GET');
          if (claims.sessionId !== decodeURIComponent(sse[1] ?? '')) {
            return reply(res, 403, '令牌不属于这个会话');
          }
          return await serveSse(
            sseOptions,
            req,
            res,
            sessionStream(claims.sessionId),
            async () => (await verifyToken(db, token)) !== null,
          );
        }
        return await handleMcp(req, res, claims);
      } catch {
        reply(res, 500, '内部错误');
      }
    })();
  });

  return { server, ...wrapServer(server, open) };
}
