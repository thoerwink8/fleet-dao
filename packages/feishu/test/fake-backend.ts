// 假后端：真的 HTTP 服务（网关的请求照样走 fetch、带通行证），按测试给的路由回，记下每个请求。
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  /** 去掉 /api 前缀、不带查询串的路径，例如 /feishu/messages。 */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
  /** 收到的时刻（Date.now）。 */
  at: number;
}

/** hang = 一直不回（让网关超时）；否则照写的状态码和 JSON 回，可先等 delayMs。 */
export type Reply = { status?: number; body?: unknown; delayMs?: number } | 'hang';
export type Handler = (req: Recorded, params: Record<string, string>) => Reply | Promise<Reply>;

export interface FakeBackend {
  url: string;
  requests: Recorded[];
  /** 路径里 :xxx 是参数；同一条路由后设的覆盖先设的。 */
  on(method: string, path: string, handler: Handler | Reply): void;
  calls(method: string, path: string): Recorded[];
  close(): Promise<void>;
}

export function apiError(status: number, code: string, message: string, details?: unknown): Reply {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const routes: Array<{ method: string; pattern: RegExp; names: string[]; path: string; handler: Handler }> =
    [];
  const requests: Recorded[] = [];
  const hung = new Set<import('node:http').ServerResponse>();

  function match(method: string, path: string) {
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (!r || r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.names.forEach((name, j) => {
        params[name] = decodeURIComponent(m[j + 1] ?? '');
      });
      return { route: r, params };
    }
    return null;
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: Recorded = {
        method: req.method ?? '',
        path: url.pathname.replace(/^\/api/, ''),
        query: url.searchParams,
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
        at: Date.now(),
      };
      requests.push(recorded);
      const found = match(recorded.method, recorded.path);
      const reply: Reply = found
        ? await found.route.handler(recorded, found.params)
        : { status: 404, body: { error: { code: 'not_found', message: '没有这个接口' } } };
      if (reply === 'hang') {
        hung.add(res);
        return;
      }
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      const payload = reply.body === undefined ? '' : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, payload ? { 'content-type': 'application/json' } : {});
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method, path, handler) {
      const names: string[] = [];
      const pattern = new RegExp(
        `^${path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
          names.push(name);
          return '([^/]+)';
        })}$`,
      );
      routes.push({
        method,
        pattern,
        names,
        path,
        handler: typeof handler === 'function' ? handler : () => handler,
      });
    },
    calls: (method, path) => requests.filter((r) => r.method === method && r.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hung) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
