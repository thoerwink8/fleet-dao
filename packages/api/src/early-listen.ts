// 进程入口先听上、再去加载装配（main.ts 调 openEarly，然后才 import boot.ts）。
// 发布每次切版本都重启这个进程。端口归 fleet-api.socket 攥着：停 accept 到新进程听上之前，
// 内核照样完成 TCP 握手，HTTP 请求堆在队列里，外面看就是「端口通、/healthz 挂起」。
// 所以一进来就听，装配完成前 /healthz 立刻回「还在启动」；boot.ts 装配完用 setFetch 换成正式处理。
import type { ServerType } from '@hono/node-server';
import { type Config, loadConfig } from './config.ts';
import { COCKPIT_KEEP_ALIVE_MS, type Fetch } from './keep-alive.ts';
import { startListeners } from './listen.ts';

/** 还没先听上就去装配：入口不是 main.ts，或者 openEarly 没成功。 */
export class EarlyListenError extends Error {}

const STARTUP_HEALTH = JSON.stringify({
  ok: false,
  checks: { startup: { ok: false, code: 'starting', message: '还在启动' } },
});

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return new URL(url, 'http://127.0.0.1').pathname;
  }
}

/** 装配完成前的应答：/healthz 是健康报告的样子（503），别的路径也立刻 503，不挂起。 */
export function startupResponse(url: string): Response {
  if (pathnameOf(url) === '/healthz') {
    return new Response(STARTUP_HEALTH, { status: 503, headers: JSON_HEADERS });
  }
  return new Response(JSON.stringify({ error: { code: 'starting', message: '还在启动' } }), {
    status: 503,
    headers: JSON_HEADERS,
  });
}

export interface EarlyListeners {
  /** loadConfig 的结果，boot 不用再读一遍环境。 */
  config: Config;
  servers: ServerType[];
  setFetch: (which: 'cockpit' | 'agent', fetch: Fetch) => void;
}

let held: EarlyListeners | undefined;

/** serve() 一返回，listening 事件多半还在下一拍。已经听上就直接过。 */
function untilListening(server: ServerType): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onError = (err: unknown) => {
      server.off('listening', onListening);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

/** boot.ts 取 main.ts 已经听上的那一对。没听上就抛，不自己再 bind 一次。 */
export function takeEarly(): EarlyListeners {
  if (!held) throw new EarlyListenError('还没先听上（入口是 packages/api/src/main.ts）');
  return held;
}

/**
 * 按配置把两个监听听上，处理函数先是 startupResponse。env 默认 process.env；测试传一份假的，不碰真环境。
 * 调用两次会把前一次的句柄盖掉（正式进程只调一次）。
 */
export async function openEarly(env: NodeJS.ProcessEnv = process.env): Promise<EarlyListeners> {
  const config = loadConfig(env);
  let cockpit: Fetch = (req) => Promise.resolve(startupResponse(req.url));
  let agent: Fetch = (req) => Promise.resolve(startupResponse(req.url));
  const servers = await startListeners(
    [
      {
        name: '驾驶舱接口',
        at: config.cockpitListen,
        fetch: (req, fetchEnv) => cockpit(req, fetchEnv),
        keepAliveMs: COCKPIT_KEEP_ALIVE_MS,
      },
      {
        name: 'fleet 命令接口',
        at: config.agentListen,
        fetch: (req, fetchEnv) => agent(req, fetchEnv),
      },
    ],
    env,
  );
  // serve() 返回时监听可能还没起来。等听上再交回去，调用方立刻来的 /healthz 不会撞上「还没 bind」。
  await Promise.all(servers.map((server) => untilListening(server)));
  held = {
    config,
    servers,
    setFetch(which, fetch) {
      if (which === 'cockpit') cockpit = fetch;
      else agent = fetch;
    },
  };
  return held;
}
