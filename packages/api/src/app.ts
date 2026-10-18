// cockpit：驾驶舱接口 /api（含别的环境推快照的 /api/nodes/report）、登录 /auth、GitHub 事件 /github/webhook。
// 生产上听 WireGuard 地址，香港经加密通道转进来。
import { AUTH_PREFIX, WEB_API_PREFIX } from '@fleet-dao/shared';
import { createGitHubIntake } from '@fleet-dao/store';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { acceptancePublicRoutes } from './acceptance-public.ts';
import { authRoutes } from './auth.ts';
import { ciPolicyPublicRoutes } from './ci-policy-public.ts';
import { cockpitRoutes } from './cockpit.ts';
import type { Deps } from './deps.ts';
import { githubRoutes } from './github.ts';
import { healthHandler } from './health.ts';
import { errorBody, errorHandler, notFound } from './http.ts';
import { nodeReportRoutes } from './node-report.ts';
import { createSseRelay, type SseRelay } from './sse.ts';

/** 驾驶舱的请求体都很小；GitHub 事件另有自己的上限。 */
const MAX_JSON_BYTES = 1024 * 1024;

const jsonLimit = bodyLimit({
  maxSize: MAX_JSON_BYTES,
  onError: (c) => c.json(errorBody('too_large', '请求体超过 1 MB'), 413),
});

export interface Apps {
  cockpit: Hono;
  /** SSE 的中转（带补发缓冲）：看在线连接数用。 */
  relay: SseRelay;
}

export function buildApps(deps: Deps): Apps {
  const relay = createSseRelay(deps.changes);

  const cockpit = new Hono();
  cockpit.onError(errorHandler(deps.log));
  cockpit.route('/', acceptancePublicRoutes(deps));
  cockpit.notFound(notFound);
  cockpit.get('/healthz', (c) => healthHandler(deps.health, deps.log)(c));
  cockpit.use(`${WEB_API_PREFIX}/*`, jsonLimit);
  cockpit.use(`${AUTH_PREFIX}/*`, jsonLimit);
  cockpit.route(AUTH_PREFIX, authRoutes(deps));
  // 别的环境推快照的写口（POST /api/nodes/report）：只认专用通行证（X-Fleet-Node-Token）、不认 Cookie，同样挂在登录门前面；
  // 登录门后面的 GET /api/nodes 不认这个通行证。
  cockpit.route(WEB_API_PREFIX, nodeReportRoutes(deps));
  cockpit.route('/', ciPolicyPublicRoutes(deps));
  cockpit.route(WEB_API_PREFIX, cockpitRoutes(deps, relay));
  cockpit.route('/github', githubRoutes(deps, createGitHubIntake(deps)));

  return { cockpit, relay };
}
