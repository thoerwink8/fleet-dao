// 驾驶舱接口的监听：香港 nginx 经隧道转来的请求都进这里（生产上是法国的隧道地址，FLEET_COCKPIT_LISTEN）。
// nginx 往这里的连接留着复用（deploy/hk/nginx-https.conf 的 upstream fleet_dao_api，空闲 5 分钟就关）：香港到法国一趟往返
// 约 0.2 秒，每个请求都新建连接就要多付这一趟。
// 改这里之前必须知道：空闲超时必须比 nginx 那边的 keepalive_timeout 长，空闲连接要由 nginx 先关。反过来的话，后端刚关掉的
// 连接 nginx 还当成好的拿去发请求：GET 它会换一条新连接重发，POST 这类不能重发的直接回 502。
// Node 默认 5 秒（再加 keepAliveTimeoutBuffer 1 秒）就关空闲连接，所以要设。test/keep-alive.test.ts 读 nginx 的配置核对两边。
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';

/** 驾驶舱接口的空闲连接留多久：比香港 nginx 的 keepalive_timeout（5 分钟）长。 */
export const COCKPIT_KEEP_ALIVE_MS = 6 * 60_000;

type Fetch = Parameters<typeof serve>[0]['fetch'];

export function serveCockpit(
  fetch: Fetch,
  at: { host: string; port: number },
  keepAliveMs: number = COCKPIT_KEEP_ALIVE_MS,
): Server {
  const server = serve({ fetch, hostname: at.host, port: at.port }) as Server;
  server.keepAliveTimeout = keepAliveMs;
  return server;
}
