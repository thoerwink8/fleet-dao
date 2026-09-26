// 驾驶舱接口的空闲连接：比香港 nginx 留得久（空闲连接由 nginx 先关，不然 POST 偶尔 502），见 src/keep-alive.ts。
// 起真的监听、用裸 TCP 连接看后端什么时候关；再读 deploy/hk/nginx-https.conf 核对两边的先后。
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COCKPIT_KEEP_ALIVE_MS, serveCockpit } from '../src/keep-alive.ts';

const NGINX_CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'deploy',
  'hk',
  'nginx-https.conf',
);

/**
 * nginx 配置里某个 upstream 的 keepalive_timeout，换成毫秒。认不出（没有这个 upstream、没写、单位不认得）返回原因，
 * 不拿默认值顶上——没读到就当「没问题」，两边的先后就等于没核对。
 */
function upstreamIdleMs(conf: string, name = 'fleet_dao_api'): number | string {
  const text = conf.replace(/#.*$/gm, '');
  const block = new RegExp(String.raw`upstream\s+${name}\s*\{([^}]*)\}`).exec(text);
  if (!block) return `没有 upstream ${name}`;
  const line = /(?:^|[;{\s])keepalive_timeout\s+([^;\s]+)\s*;/.exec(block[1] ?? '');
  if (!line) return `upstream ${name} 里没写 keepalive_timeout`;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(line[1] ?? '');
  if (!m) return `keepalive_timeout 的值认不出：${line[1]}`;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Number(m[1]) * unit;
}

/** 后端比 nginx 至少多留这么久：两边的定时器各有误差，贴着同一个点关就又有撞车的窗口。 */
const MARGIN_MS = 10_000;

/** 两边的先后对不对：不对、读不出都返回原因。 */
function idleOrderProblem(backendMs: number, conf: string): string | null {
  const nginxMs = upstreamIdleMs(conf);
  if (typeof nginxMs === 'string') return `读不出香港 nginx 的空闲超时：${nginxMs}`;
  if (backendMs < nginxMs + MARGIN_MS) {
    return `后端空闲 ${backendMs} 毫秒就关连接，nginx 要 ${nginxMs} 毫秒：后端得比 nginx 至少多留 ${MARGIN_MS} 毫秒`;
  }
  return null;
}

const servers: { close(): unknown }[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

async function listen(keepAliveMs?: number) {
  const server = serveCockpit(() => new Response('ok'), { host: '127.0.0.1', port: 0 }, keepAliveMs);
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

/** 一条裸 TCP 连接：发一个请求、等到响应；closed 是后端关连接的时刻。 */
async function openConn(port: number) {
  const sock = connect(port, '127.0.0.1');
  sockets.push(sock);
  let data = '';
  let closedAt: number | undefined;
  sock.on('data', (d) => {
    data += d;
  });
  sock.on('close', () => {
    closedAt = Date.now();
  });
  await once(sock, 'connect');
  const get = async () => {
    const before = data.length;
    sock.write('GET /x HTTP/1.1\r\nHost: t\r\n\r\n');
    const deadline = Date.now() + 2000;
    while (!data.slice(before).includes('\r\n\r\nok') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return data.slice(before).split('\r\n')[0];
  };
  return { get, closed: () => closedAt !== undefined };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('驾驶舱接口的空闲连接', () => {
  it('默认留 COCKPIT_KEEP_ALIVE_MS，比 Node 默认的 5 秒长得多', async () => {
    const { server } = await listen();
    expect(server.keepAliveTimeout).toBe(COCKPIT_KEEP_ALIVE_MS);
    expect(COCKPIT_KEEP_ALIVE_MS).toBeGreaterThan(60_000);
  });

  it('设的值真管用：同样空闲 1.4 秒，留 2 秒的还能接着发请求，留 0.1 秒的已经被后端关了', async () => {
    const long = await listen(2000);
    const short = await listen(100);
    const a = await openConn(long.port);
    const b = await openConn(short.port);
    expect(await a.get()).toBe('HTTP/1.1 200 OK');
    expect(await b.get()).toBe('HTTP/1.1 200 OK');
    // Node 在设的值上再加 keepAliveTimeoutBuffer（1 秒）才关
    await sleep(1400);
    expect(a.closed()).toBe(false);
    expect(await a.get()).toBe('HTTP/1.1 200 OK');
    expect(b.closed()).toBe(true);
  });
});

describe('和香港 nginx 的先后：后端比 nginx 留得久', () => {
  it('仓里的 nginx-https.conf：upstream fleet_dao_api 的 keepalive_timeout 读得出来，后端留得更久', () => {
    const conf = readFileSync(NGINX_CONF, 'utf8');
    const nginxMs = upstreamIdleMs(conf);
    expect(typeof nginxMs).toBe('number');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, conf)).toBeNull();
  });

  it('故意造错：nginx 留得比后端久、贴得太近，都查得出', () => {
    const conf = (t: string) =>
      `upstream fleet_dao_api {\n    server 10.0.0.1:1;\n    keepalive 16;\n    keepalive_timeout ${t};\n}\n`;
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, conf('7m'))).toContain('后端得比 nginx 至少多留');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, conf('355s'))).toContain('后端得比 nginx 至少多留');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, conf('60'))).toBeNull();
    expect(upstreamIdleMs(conf('1500ms'))).toBe(1500);
    expect(upstreamIdleMs(conf('1h'))).toBe(3_600_000);
  });

  it('读不出来就说读不出来，不当成没问题', () => {
    const noTimeout = 'upstream fleet_dao_api {\n    server 10.0.0.1:1;\n    keepalive 16;\n}\n';
    const commented = 'upstream fleet_dao_api {\n    keepalive 16;\n    # keepalive_timeout 5m;\n}\n';
    const otherName = 'upstream api {\n    keepalive_timeout 5m;\n}\n';
    const weird = 'upstream fleet_dao_api {\n    keepalive_timeout 1m30s;\n}\n';
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, noTimeout)).toContain('没写 keepalive_timeout');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, commented)).toContain('没写 keepalive_timeout');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, otherName)).toContain('没有 upstream fleet_dao_api');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, weird)).toContain('认不出');
    expect(idleOrderProblem(COCKPIT_KEEP_ALIVE_MS, '')).toContain('没有 upstream fleet_dao_api');
  });
});
