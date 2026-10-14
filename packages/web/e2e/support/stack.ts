// 驾驶舱 e2e 的整套真环境（母单 #902）：真 Postgres 上的 fleet_e2e* 库（备库 packages/api/test/e2e/prepare.ts）
// + 真后端（packages/api/src/main.ts，和线上同一个入口，不是测试装配）+ 打包好的前端（dist/client，门面照线上 nginx 伺候，/api、/auth 转后端）。
// 唯一多出来的一环是后端前面的「开关代理」：e2e 要验「后端读不到、报错时页面怎么显示」，不能真把后端杀了再拉起
// （端口、进程清理都不稳），所以后端前面放一个 TCP 层的小代理，平时原样转发，测试一句话让它「断开」或「回 500」。
// 每个 Playwright worker 一整套（决定 0093，support/fixtures.ts 的 stack 夹具）：各自的库（fleet_e2e_w<worker 号>，收工时删掉）、各自的端口，
// 互不干扰，所以能开多个 worker 并着跑；前端只在 global-setup 打包一次，各套共用同一份产物。
// 改这里之前必须知道：
// - 要一台真 Postgres：E2E_PG_ADMIN_URL 没设就明确失败，不退回内存库冒充（备库那一步同样）。
// - 门面、开关代理在本进程里 listen 0（端口一直攥着）；后端和 fleet 命令口按 worker 号排（stackPorts），不撞别的 worker、不撞开发默认值。
// - 后端按 FLEET_PUBLIC_URL 核对写请求的来源，所以浏览器必须开 http://localhost:<门面端口>（不是 127.0.0.1）。

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { type AddressInfo, connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type E2eFacts, parseFacts } from './facts.ts';
import { E2E_NODE_KEYS } from './node-keys.ts';
import { startWebServer, type WebServer } from './web-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..', '..', '..');
export const WEB_DIR = resolve(here, '..', '..');
export const OUT_DIR = join(REPO_ROOT, '_tmp', 'e2e');
/** 正式构建的产物（react-router build，ssr: false）：门面伺候的就是它。 */
export const WEB_DIST = join(WEB_DIR, 'dist', 'client');

export interface StackEnv {
  webOrigin: string;
  /** 浏览器和测试直连后端用的地址（经开关代理）。 */
  apiOrigin: string;
  /** 开关代理的控制口：POST /mode/<up|down|error>。 */
  controlOrigin: string;
  facts: E2eFacts;
}

function reactRouterBin(): string {
  const bin = join(
    dirname(createRequire(join(WEB_DIR, 'package.json')).resolve('@react-router/dev/package.json')),
    'bin.cjs',
  );
  if (!existsSync(bin)) throw new Error(`找不到 react-router 的命令行：${bin}`);
  return bin;
}

/**
 * 打包前端（每轮 e2e 一次，global-setup 调）：react-router build → dist/client。打不出来就抛，不拿旧产物凑。
 * E2E_SKIP_BUILD=1 跳过（调用例时反复跑、确认产物是新的才用）。
 */
export function buildWeb(): void {
  if (process.env.E2E_SKIP_BUILD === '1') {
    if (!existsSync(join(WEB_DIST, 'index.html')))
      throw new Error(`E2E_SKIP_BUILD=1 但 ${WEB_DIST} 里没有打包好的前端`);
    return;
  }
  const started = Date.now();
  const r = spawnSync(process.execPath, [reactRouterBin(), 'build'], {
    cwd: WEB_DIR,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`前端打包没成（退出码 ${r.status}）：\n${r.stdout}\n${r.stderr}`);
  console.log(`[e2e] 前端打包 ${Math.round((Date.now() - started) / 1000)} 秒`);
}

function runPrepare(dbName: string): E2eFacts {
  const r = spawnSync(process.execPath, ['packages/api/test/e2e/prepare.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, E2E_DB_NAME: dbName },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`备库 ${dbName} 没成（退出码 ${r.status}）：\n${r.stderr}`);
  const lastLine = r.stdout.trim().split('\n').at(-1) ?? '';
  return parseFacts(lastLine);
}

/** 等 url 通（回 500 以下）。owner 给了：它一退出就不等了——端口被别人占着时，连上的是别人的服务，不能当成自己的起好了。 */
async function waitFor(url: string, what: string, timeoutMs: number, owner?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '还没连上';
  while (Date.now() < deadline) {
    if (owner && owner.exitCode !== null)
      throw new Error(`${what}进程退出了（退出码 ${owner.exitCode}，端口被占着或起不来，看日志）`);
    try {
      const res = await fetch(url, { redirect: 'manual' });
      // 通了再看一眼自己的进程还在：端口被占时别人的服务也会回 200
      if (res.status < 500 && (!owner || owner.exitCode === null)) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = String((err as Error).cause ?? err);
    }
    await new Promise((r) => setTimeout(r, 200));
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

const listen = (s: Server) =>
  new Promise<number>((ok, fail) => {
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port));
  });

/**
 * 后端和 fleet 命令口的端口：按 worker 号排（E2E_PORT_BASE 起，默认 21000，每个 worker 两个），不用「先占一个空闲端口再放掉交给子进程」：
 * 放掉到子进程占上之间，别的 worker 的 listen(0) 可能正好拿走它，两套就串到同一个后端、同一个库上（本机实测撞过：A 的用例登进了 B 的库）。
 * 端口被别的程序占着时后端起不来、进程退出，startStack 认这个、明说，不会连上别人的服务。
 */
export function stackPorts(slot: number): { api: number; agent: number } {
  const raw = process.env.E2E_PORT_BASE?.trim() || '21000';
  const base = Number(raw);
  if (!Number.isInteger(base) || base < 1024 || base > 60000)
    throw new Error(`E2E_PORT_BASE 要是 1024–60000 的整数，现在是「${raw}」`);
  const offset = (slot % 2000) * 2;
  return { api: base + offset, agent: base + offset + 1 };
}

/** 连接串加 statement_timeout=60000（见 startStack 里 DATABASE_URL 那段的说明）。 */
export function withTimeout(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.searchParams.set('statement_timeout', '60000');
  return url.toString();
}

type Mode = 'up' | 'down' | 'error';

/** 后端前面的开关代理：up 原样转发；down 直接断开连接（像后端没了）；error 对 /api 请求回 500。两个口都现分。 */
async function startSwitchProxy(backendPort: number) {
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
  const proxyPort = await listen(proxy);
  const controlPort = await listen(control);
  return {
    proxyPort,
    controlPort,
    stop: () => {
      proxy.closeAllConnections();
      control.closeAllConnections();
      proxy.close();
      control.close();
    },
  };
}

/** 收工删库（后端已经杀了）：删不掉只打一行，不让收尾把用例结果盖成红（库名下次备库会先删再建）。 */
function dropDb(dbName: string): void {
  const r = spawnSync(process.execPath, ['packages/api/test/e2e/prepare.ts', '--drop'], {
    cwd: REPO_ROOT,
    env: { ...process.env, E2E_DB_NAME: dbName },
    encoding: 'utf8',
  });
  if (r.status !== 0) console.error(`[e2e] 删库 ${dbName} 没成（退出码 ${r.status}）：${r.stderr.trim()}`);
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

export interface StackOptions {
  /** 这一套的库名（fleet_e2e 开头；备库会先删同名库再建）。 */
  dbName: string;
  /** 这一套占第几组端口（stackPorts）：同一时刻跑着的几套必须各不相同（用 worker 号）。 */
  slot: number;
  /** 日志文件名前缀（_tmp/e2e/<tag>-api.log），分得清是哪个 worker 的。 */
  tag: string;
}

/**
 * E2E_PG_ADMIN_URL 指着本机（127.0.0.1、localhost）又连不上时，起栈前就停下、说怎么起（pnpm pg:local start，
 * packages/db/src/local-pg.ts）——不然要等备库那一步报一串连接错。指着别的机器的不在这里查。
 */
export async function assertLocalPgUp(adminUrl: string | undefined): Promise<void> {
  if (!adminUrl) return;
  let host: string;
  let port: number;
  try {
    const u = new URL(adminUrl);
    host = u.hostname;
    port = Number(u.port || 5432);
  } catch {
    return;
  }
  if (host !== '127.0.0.1' && host !== 'localhost') return;
  const up = await new Promise<boolean>((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  if (!up) {
    throw new Error(
      `E2E_PG_ADMIN_URL 指着本机 127.0.0.1:${port}，连不上：本机的 Postgres 没起。起：pnpm pg:local start（端口不是 55432 的加 FLEET_LOCAL_PG_PORT=${port}，见 packages/web/e2e/README.md）`,
    );
  }
}

/** 起一整套：备库 → 开关代理 → 门面 → 后端，等后端和门面都通了才返回。前端要先打包好（buildWeb）。 */
export async function startStack({ dbName, slot, tag }: StackOptions): Promise<Stack> {
  if (!process.env.E2E_PG_ADMIN_URL?.trim()) {
    throw new Error(
      'E2E_PG_ADMIN_URL 没设：驾驶舱 e2e 要一台真 Postgres（例如 postgres://postgres:<密码>@127.0.0.1:55432/postgres），不退回内存库。本机（Windows）起：pnpm pg:local start，起好照它打出的那行设；别的起法见 packages/web/e2e/README.md',
    );
  }
  await assertLocalPgUp(process.env.E2E_PG_ADMIN_URL);
  const facts = runPrepare(dbName);
  const { api: apiPort, agent: agentPort } = stackPorts(slot);
  const sw = await startSwitchProxy(apiPort);
  let web: WebServer;
  try {
    web = await startWebServer(WEB_DIST, sw.proxyPort);
  } catch (err) {
    sw.stop();
    throw err;
  }
  const webOrigin = `http://localhost:${web.port}`;
  const api = startProcess(
    `${tag}-api`,
    ['packages/api/src/main.ts'],
    {
      ...process.env,
      FLEET_ENV: 'development',
      // 环境页和顶栏徽标读它（#820 片 1）：e2e 这套在后端前面架上，名字用「本机」（开发机上的样子）
      FLEET_MACHINE_NAME: '本机',
      // 看板多机（07c）：两个远程环境的通行证哈希，一个推快照、一个配了钥匙从不推（见 support/node-keys.ts）
      FLEET_NODE_KEYS: E2E_NODE_KEYS,
      // 语句超时放宽到 60 秒（线上 5 秒，pg-store.ts 的 withStatementTimeout 见连接串里写了就不加）：后端后台量磁盘时查所有库的大小
      //（db-sizes.ts 的 pg_database_size），别的 worker 正在建库、删库时它要等锁，5 秒就超时；本机实测那一下超时后，同一后端里
      // 并着的别的查询拿到错乱的结果（repo_missing、拼出「in (, , $1)」的 SQL），用例红在别处。超时放宽，等锁的那条等完就好。
      DATABASE_URL: withTimeout(facts.dbUrl),
      FLEET_PUBLIC_URL: webOrigin,
      FLEET_COCKPIT_LISTEN: `127.0.0.1:${apiPort}`,
      FLEET_AGENT_LISTEN: `127.0.0.1:${agentPort}`,
      FLEET_SESSION_SECRET: randomBytes(24).toString('hex'),
      FLEET_AGENT_TOKEN_SECRET: randomBytes(24).toString('hex'),
    },
    REPO_ROOT,
  );
  const stop = () => {
    web.close();
    sw.stop();
    killTree(api);
    dropDb(dbName);
  };
  try {
    const apiWhat = `后端（${tag}，端口 ${apiPort}，日志在 _tmp/e2e/${tag}-api.log）`;
    await waitFor(`http://127.0.0.1:${apiPort}/auth/config`, apiWhat, 60_000, api);
    await waitFor(`${webOrigin}/auth/config`, `门面到后端的转发（${tag}）`, 30_000, api);
  } catch (err) {
    stop();
    throw err;
  }
  return {
    env: {
      webOrigin,
      apiOrigin: `http://127.0.0.1:${sw.proxyPort}`,
      controlOrigin: `http://127.0.0.1:${sw.controlPort}`,
      facts,
    },
    stop,
  };
}
