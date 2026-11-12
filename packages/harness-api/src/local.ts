// 本机装法的单口服务（#3858，决定 0125 第 1 条 local 档案）：驾驶舱口、本机状态口、静态页同一个口，只听 127.0.0.1。
// 鉴权是本机令牌文件：令牌是随机 32 字节，存用户数据目录里（文件只有本用户读得了），不在安装目录。
// 浏览器拿令牌的办法有两个，令牌本身都不进网址：`fleet2 up` 打印的一次性登录码（5 分钟、用一次就废）换 Cookie；
// 或者在页面上粘贴令牌，POST /api/local/login 换 Cookie。Cookie 是 HttpOnly + SameSite=Strict。
// 为防 DNS 重绑，Host 头不是回环名一律 421。静态页不要令牌（里面没有机密），/api 下全要。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import type { CockpitApi, CockpitVerdict } from './cockpit.ts';
import { hasTokenInQuery } from './server.ts';
import { reply } from './session-http.ts';

export const LOCAL_COOKIE = 'fleet_local';
export const LOCAL_TOKEN_HEADER = 'x-fleet-local-token';
const LOGIN_CODE_TTL_MS = 5 * 60_000;

/**
 * 读本机令牌文件；没有就生成（随机 32 字节，十六进制），文件权限收紧到仅当前用户：
 * posix 用 0600；Windows 没有 posix 权限位，由调用方给 `restrictWindows`（装配档案里用 icacls 去继承、只授本用户），没给就拒绝，不假装收紧了。
 * 本包不起子进程（新内核起子进程只走 harness-runner），所以收紧动作由调用方传进来。
 */
export async function ensureLocalToken(
  file: string,
  restrictWindows?: (file: string) => Promise<void>,
): Promise<string> {
  const restrict = async (): Promise<void> => {
    if (process.platform !== 'win32') return void chmodSync(file, 0o600);
    if (!restrictWindows)
      throw new Error('Windows 上要给 restrictWindows 才能把令牌文件收紧到只有本用户可读');
    await restrictWindows(file);
  };
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(token)) {
      await restrict();
      return token;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  await restrict();
  return token;
}

function sameToken(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** 请求带的令牌（请求头优先，其次 Cookie）对不对。 */
export function localTokenOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers[LOCAL_TOKEN_HEADER];
  const given = typeof h === 'string' ? h : cookieOf(req.headers.cookie, LOCAL_COOKIE);
  return given !== undefined && sameToken(given, token);
}

export function localAuthorize(token: string) {
  return async (req: IncomingMessage): Promise<CockpitVerdict> =>
    localTokenOk(req, token) ? { ok: true } : { ok: false, status: 401, message: '没登录：缺本机令牌' };
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

/** 本机状态口 /api/local/status 的载荷；由装配档案填，页面照着显示。 */
export interface LocalStatus {
  profile: 'local';
  version: string;
  listen: string;
  dataDir: string;
  /** 隔离档位：读回事实，不自称。 */
  isolation: { level: 'strong' | 'medium' | 'weak'; facts: string[] };
  /** 对外写：本机装法全是 false。 */
  externalWrites: { github: boolean; egressGateway: boolean };
  hosts: { id: string; kind: 'local' | 'ssh'; label: string; isolation: 'strong' | 'medium' | 'weak' }[];
  settings: { key: string; value: string; note: string }[];
  /** 本机 ADE 接口挂上了没有（#3914）。香港那份没有这个字段。 */
  ade?: boolean;
}

export interface LocalGatewayOptions {
  cockpit: CockpitApi;
  token: string;
  /** 打包好的页面目录（base=/）。不存在就只有接口。 */
  distDir?: string;
  status: () => LocalStatus | Promise<LocalStatus>;
  /** /api/ade：本机会话。返回 true 表示已经写完响应。不传就 404。 */
  ade?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

export interface LocalGateway {
  server: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  /** 发一个一次性登录码（5 分钟、用一次就废），拼成 /local-login?code=… 打给人。 */
  issueLoginCode(): string;
}

export function createLocalGateway(o: LocalGatewayOptions): LocalGateway {
  const codes = new Map<string, number>();
  const dist = o.distDir ? resolve(o.distDir) : undefined;

  const setCookie = (res: ServerResponse, status: number, extra: Record<string, string> = {}) =>
    res
      .writeHead(status, {
        'set-cookie': `${LOCAL_COOKIE}=${o.token}; Path=/; HttpOnly; SameSite=Strict`,
        'cache-control': 'no-store',
        ...extra,
      })
      .end();

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > 4096) throw new Error('请求体太大');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    if (!dist) return void reply(res, 404, '没有这个路径');
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.[/\\])+/, '');
    let file = resolve(dist, rel);
    if (!(file === dist || file.startsWith(dist + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      // 带扩展名的缺文件回 404，别的（前端路由）回首页
      if (extname(rel) !== '') return void reply(res, 404, '没有这个文件');
      file = join(dist, 'index.html');
      if (!existsSync(file)) return void reply(res, 404, '页面还没构建');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(host))
      return reply(res, 421, 'Host 不是回环地址');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (p === '/local-login') {
      const code = url.searchParams.get('code') ?? '';
      const exp = codes.get(code);
      codes.delete(code);
      if (exp === undefined || exp < Date.now())
        return reply(res, 401, '登录码无效或已用过，重新运行 fleet2 up 拿新的');
      setCookie(res, 302, { location: '/' });
      return;
    }
    // 存活探针：桌面外壳等它回 200 才打开窗口。不要令牌，也不带任何内容（没有版本、路径），只说「口已经通了」。
    if (p === '/health') {
      if (req.method !== 'GET') return reply(res, 405, '只收 GET');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"ok":true}');
      return;
    }
    if (hasTokenInQuery(url)) return reply(res, 400, '令牌只能放请求头或 cookie，不能放网址');

    if (p === '/api/local/login') {
      if (req.method !== 'POST') return reply(res, 405, '只收 POST');
      let given = '';
      try {
        given = (JSON.parse(await readBody(req)) as { token?: unknown }).token as string;
      } catch {
        return reply(res, 400, '请求体不对');
      }
      if (typeof given !== 'string' || !sameToken(given.trim(), o.token)) return reply(res, 401, '令牌不对');
      setCookie(res, 204);
      return;
    }
    if (p === '/api/local/status') {
      if (req.method !== 'GET') return reply(res, 405, '只收 GET');
      if (!localTokenOk(req, o.token)) return reply(res, 401, '没登录：缺本机令牌');
      res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify(await o.status()));
      return;
    }
    if (p === '/api/ade' || p.startsWith('/api/ade/')) {
      if (!o.ade) return reply(res, 404, '没有这个接口');
      const handled = await o.ade(req, res);
      if (!handled && !res.headersSent) reply(res, 404, '没有这个接口');
      return;
    }
    if (p.startsWith('/api/')) return await o.cockpit.handler(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, '只收 GET');
    serveStatic(res, p);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, '内部错误');
      else res.destroy();
    });
  });

  return {
    server,
    listen: (port = 0) =>
      new Promise((resolveListen, reject) => {
        server.once('error', reject);
        // 只听回环：写死，不收 host 参数
        server.listen(port, '127.0.0.1', () => resolveListen((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((done) => {
        o.cockpit.endStreams();
        server.close(() => done());
        server.closeAllConnections();
      }),
    issueLoginCode() {
      const code = randomBytes(24).toString('base64url');
      codes.set(code, Date.now() + LOGIN_CODE_TTL_MS);
      return code;
    },
  };
}
