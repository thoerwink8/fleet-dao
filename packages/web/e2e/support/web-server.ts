// e2e 的前端门面：照线上 nginx（deploy/hk/nginx-http.conf 的 `try_files $uri $uri/ /index.html`）伺候正式构建的产物
// （packages/web/dist/client），/api、/auth 转给后端（经开关代理）。和线上一样是打包好的页面，不是 Vite 开发服务器：
// 开发服务器第一次遇到依赖要「优化、重载页面」，每个 worker 各起一个要一分多钟暖机，几个 worker 并着跑就吃不消。
// 改这里之前必须知道：
// - 转发不改 Host、Origin：后端按 FLEET_PUBLIC_URL（http://localhost:<本门面端口>）核对写请求来源，和原来 Vite 代理一样原样转。
// - /api/events 是长连接（服务器推送）：按流原样转，客户端断了就断上游。
// - 只认 dist/client 里面的文件：路径解出来跑到目录外一律当没有（回落 index.html），不读仓里别的东西。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** 请求路径 → dist 里的文件；不是文件、跑出目录、解不开回 undefined（调用方回落 index.html）。 */
export function fileFor(root: string, urlPath: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return undefined;
  }
  const full = normalize(join(root, path));
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
  try {
    if (statSync(full).isFile()) return full;
    const index = join(full, 'index.html');
    if (statSync(full).isDirectory() && existsSync(index)) return index;
  } catch {
    return undefined;
  }
  return undefined;
}

export const proxied = (url: string): boolean =>
  url === '/api' || url.startsWith('/api/') || url === '/auth' || url.startsWith('/auth/');

export interface WebServer {
  port: number;
  close: () => void;
}

/** 起门面：listen 在 localhost 的随机端口（0），返回实际端口；/api、/auth 转给 backendPort（开关代理）。 */
export async function startWebServer(distDir: string, backendPort: number): Promise<WebServer> {
  const root = normalize(distDir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) throw new Error(`前端没打包：找不到 ${index}（global-setup 会先打包）`);
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (proxied(url)) {
      const upstream = httpRequest(
        { host: '127.0.0.1', port: backendPort, method: req.method, path: url, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => req.socket.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const file = fileFor(root, url) ?? index;
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // 线上 nginx 不给 index.html 长缓存；e2e 每个上下文都是新的，干脆都不缓存
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, 'localhost', () => ok());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
