// 驾驶舱 e2e 的整套真环境（母单 #902）：真 Postgres 上的 fleet_e2e 库（备库 packages/api/test/e2e/prepare.ts）
// + 真后端（packages/api/src/main.ts，和线上同一个入口，不是测试装配）+ 真前端（Vite 开发服务器，/api、/auth 照常代理）。
// 唯一多出来的一环是后端前面的「开关代理」：e2e 要验「后端读不到、报错时页面怎么显示」，不能真把后端杀了再拉起
// （端口、进程清理都不稳），所以后端前面放一个 TCP 层的小代理，平时原样转发，测试一句话让它「断开」或「回 500」。
// 改这里之前必须知道：
// - 要一台真 Postgres：E2E_PG_ADMIN_URL 没设就明确失败，不退回内存库冒充（备库那一步同样）。
// - 端口都可以用环境变量改（E2E_WEB_PORT、E2E_API_PORT、E2E_PROXY_PORT），默认选了一组不撞开发默认值（5173/8787/8788）的。
// - 后端按 FLEET_PUBLIC_URL 核对写请求的来源，所以浏览器必须开 http://localhost:<E2E_WEB_PORT>（不是 127.0.0.1）。

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { type E2eFacts, parseFacts } from './facts.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..', '..', '..');
export const WEB_DIR = resolve(here, '..', '..');
export const OUT_DIR = join(REPO_ROOT, '_tmp', 'e2e');

export interface StackEnv {
  webOrigin: string;
  /** 浏览器和测试直连后端用的地址（经开关代理）。 */
  apiOrigin: string;
  /** 开关代理的控制口：POST /mode/<up|down|error>。 */
  controlOrigin: string;
  facts: E2eFacts;
}

const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`${name} 要是 1–65535 的整数，现在是「${v}」`);
  return n;
};

function runPrepare(): E2eFacts {
  const r = spawnSync(process.execPath, ['packages/api/test/e2e/prepare.ts'], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`备库没成（退出码 ${r.status}）：\n${r.stderr}`);
  const lastLine = r.stdout.trim().split('\n').at(-1) ?? '';
  return parseFacts(lastLine);
}

async function waitFor(
  url: string,
  what: string,
  timeoutMs = 90_000,
  ok = (s: number) => s < 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '还没连上';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (ok(res.status)) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = String((err as Error).cause ?? err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等不到${what}（${url}，${Math.round(timeoutMs / 1000)} 秒，最后一次：${last}）`);
}

function startProcess(name: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  mkdirSync(OUT_DIR, { recursive: true });
  const log = createWriteStream(join(OUT_DIR, `${name}.log`));
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on('exit', (code, signal) => log.write(`\n[${name} 退出：code=${code} signal=${signal}]\n`));
  return child;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else process.kill(-child.pid, 'SIGKILL');
}

type Mode = 'up' | 'down' | 'error';

/** 后端前面的开关代理：up 原样转发；down 直接断开连接（像后端没了）；error 对 /api 请求回 500。 */
function startSwitchProxy(listenPort: number, controlPort: number, backendPort: number) {
  let mode: Mode = 'up';
  const proxy = createHttpServer((req, res) => {
    if (mode === 'down') {
      req.socket.destroy();
      return;
    }
    if (mode === 'error' && req.url?.startsWith('/api/') && req.url !== '/api/events') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: '（e2e 模拟）后端出错了' } }));
      return;
    }
    const upstream = httpRequest(
      { host: '127.0.0.1', port: backendPort, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => req.socket.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  const control = createHttpServer((req, res) => {
    const m = /^\/mode\/(up|down|error)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) {
      res.writeHead(404).end();
      return;
    }
    mode = m[1] as Mode;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
  });
  const listen = (s: ReturnType<typeof createHttpServer>, port: number) =>
    new Promise<void>((ok, fail) => {
      s.once('error', fail);
      s.listen(port, '127.0.0.1', () => ok());
    });
  return {
    start: () => Promise.all([listen(proxy, listenPort), listen(control, controlPort)]).then(() => undefined),
    stop: () => {
      proxy.closeAllConnections();
      control.closeAllConnections();
      proxy.close();
      control.close();
    },
  };
}

/**
 * Vite 开发服务器第一次遇到某个依赖会「优化依赖、重载页面」：不先走一遍，第一个用例会撞上这次重载而超时。
 * 登录后把每个页面都打开一遍，让依赖一次优化完。
 */
async function warmUp(webOrigin: string, facts: E2eFacts): Promise<void> {
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL?.trim() || 'chrome' });
  try {
    const ctx = await browser.newContext();
    const login = await ctx.request.post(`${webOrigin}/auth/password/login`, {
      headers: { origin: webOrigin },
      data: { username: facts.username, password: facts.password },
    });
    if (login.status() !== 204) throw new Error(`暖机登录没成：HTTP ${login.status()}`);
    const page = await ctx.newPage();
    const paths = [
      '/login',
      '/',
      '/quota',
      '/settings',
      '/notifications',
      '/routing',
      '/efforts',
      '/schedules',
      '/audit',
      '/changelog',
      '/demo-links',
      `/tasks/${facts.tasks.done}`,
    ];
    for (const p of paths) {
      await page.goto(`${webOrigin}${p}`);
      await page.waitForLoadState('networkidle');
    }
  } finally {
    await browser.close();
  }
}

/** 额度页的烧速只认离现在 15 分钟内的读数（见 prepare.ts 的 writeLedger）：用例开跑前重写一遍读数时刻。 */
export function refreshLedgerNow(dbUrl: string): void {
  const r = spawnSync(process.execPath, ['packages/api/test/e2e/prepare.ts', '--refresh-ledger'], {
    cwd: REPO_ROOT,
    env: { ...process.env, E2E_DB_URL: dbUrl },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`重写切号账本的读数时刻没成（退出码 ${r.status}）：\n${r.stderr}`);
}

export interface Stack {
  env: StackEnv;
  stop: () => void;
}

export async function startStack(): Promise<Stack> {
  if (!process.env.E2E_PG_ADMIN_URL?.trim()) {
    throw new Error(
      'E2E_PG_ADMIN_URL 没设：驾驶舱 e2e 要一台真 Postgres（例如 postgres://postgres:<密码>@127.0.0.1:55432/postgres），不退回内存库。起法见 packages/web/e2e/README.md',
    );
  }
  const webPort = num('E2E_WEB_PORT', 15173);
  const apiPort = num('E2E_API_PORT', 18787);
  const proxyPort = num('E2E_PROXY_PORT', 18786);
  const controlPort = num('E2E_CONTROL_PORT', 18785);
  const agentPort = num('E2E_AGENT_PORT', 18788);
  const webOrigin = `http://localhost:${webPort}`;

  const facts = runPrepare();

  const api = startProcess(
    'api',
    ['packages/api/src/main.ts'],
    {
      ...process.env,
      FLEET_ENV: 'development',
      // 环境页和顶栏徽标读它（#820 片 1）：e2e 这套在后端前面架上，等于「本机」那一档（deploy/local 的值）
      FLEET_MACHINE_NAME: '本机',
      DATABASE_URL: facts.dbUrl,
      FLEET_PUBLIC_URL: webOrigin,
      FLEET_COCKPIT_LISTEN: `127.0.0.1:${apiPort}`,
      FLEET_AGENT_LISTEN: `127.0.0.1:${agentPort}`,
      FLEET_SESSION_SECRET: randomBytes(24).toString('hex'),
      FLEET_AGENT_TOKEN_SECRET: randomBytes(24).toString('hex'),
    },
    REPO_ROOT,
  );
  const sw = startSwitchProxy(proxyPort, controlPort, apiPort);
  await sw.start();

  const reactRouterBin = join(
    dirname(createRequire(join(WEB_DIR, 'package.json')).resolve('@react-router/dev/package.json')),
    'bin.cjs',
  );
  if (!existsSync(reactRouterBin)) throw new Error(`找不到 react-router 的命令行：${reactRouterBin}`);
  const web = startProcess(
    'vite',
    [reactRouterBin, 'dev', '--port', String(webPort), '--host', 'localhost'],
    { ...process.env, FLEET_API_ORIGIN: `http://127.0.0.1:${proxyPort}` },
    WEB_DIR,
  );
  const stop = () => {
    sw.stop();
    killTree(web);
    killTree(api);
  };
  try {
    await waitFor(`http://127.0.0.1:${apiPort}/auth/config`, '后端', 60_000);
    await waitFor(`${webOrigin}/login`, '前端', 120_000);
    // 前端开发服务器第一次编译慢：先把首页的路由模块都请求一遍，免得第一个用例吃超时。
    await waitFor(`${webOrigin}/auth/config`, '前端到后端的代理', 30_000);
  } catch (err) {
    stop();
    throw err;
  }
  try {
    await warmUp(webOrigin, facts);
  } catch (err) {
    stop();
    throw err;
  }
  return {
    env: {
      webOrigin,
      apiOrigin: `http://127.0.0.1:${proxyPort}`,
      controlOrigin: `http://127.0.0.1:${controlPort}`,
      facts,
    },
    stop,
  };
}
