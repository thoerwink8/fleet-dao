// 两个 Hono 应用，分开监听：
// - cockpit：驾驶舱接口 /api（含飞书网关的 /api/feishu/*）、登录 /auth、GitHub 事件 /github/webhook。
//   生产上听 WireGuard 地址，香港经加密通道转进来。
// - agent：fleet 命令接口 /agent/v1。只听本机回环地址，AI 会话在同一台机器上调；外面够不着。
import { AGENT_API_PREFIX, AUTH_PREFIX, WEB_API_PREFIX } from '@fleet-dao/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { agentRoutes } from './agent.ts';
import { authRoutes } from './auth.ts';
import { createAskWaiters } from './changes.ts';
import { cockpitRoutes } from './cockpit.ts';
import type { Deps } from './deps.ts';
import { feishuRoutes } from './feishu-routes.ts';
import { createGitHubIntake, githubRoutes } from './github.ts';
import { healthHandler } from './health.ts';
import { errorBody, errorHandler, notFound } from './http.ts';
import { createIntakeRunner, type IntakeRunner } from './intake.ts';
import { createSseRelay, type SseRelay } from './sse.ts';

/** 驾驶舱和 fleet 命令的请求体都很小；GitHub 事件另有自己的上限。 */
const MAX_JSON_BYTES = 1024 * 1024;

const jsonLimit = bodyLimit({
  maxSize: MAX_JSON_BYTES,
  onError: (c) => c.json(errorBody('too_large', '请求体超过 1 MB'), 413),
});

export interface Apps {
  cockpit: Hono;
  agent: Hono;
  /** SSE 的中转（带补发缓冲）：看在线连接数用。 */
  relay: SseRelay;
  /** 飞书确认的草稿去开单；main.ts 用它起定时补开。 */
  intake: IntakeRunner;
}

export function buildApps(deps: Deps): Apps {
  const waiters = createAskWaiters(deps.changes);
  const relay = createSseRelay(deps.changes);
  const intake = createIntakeRunner({ store: deps.store, intake: deps.intake, log: deps.log, now: deps.now });

  const cockpit = new Hono();
  cockpit.onError(errorHandler(deps.log));
  cockpit.notFound(notFound);
  cockpit.get('/healthz', healthHandler(deps.health, deps.log));
  cockpit.use(`${WEB_API_PREFIX}/*`, jsonLimit);
  cockpit.use(`${AUTH_PREFIX}/*`, jsonLimit);
  cockpit.route(AUTH_PREFIX, authRoutes(deps));
  // 飞书接口挂在驾驶舱接口前面：它们只认网关通行证、按各自的 acting 放行，不走驾驶舱的登录门。
  cockpit.route(WEB_API_PREFIX, feishuRoutes(deps, waiters, intake));
  cockpit.route(WEB_API_PREFIX, cockpitRoutes(deps, waiters, relay));
  cockpit.route('/github', githubRoutes(deps, createGitHubIntake(deps)));

  const agent = new Hono();
  agent.onError(errorHandler(deps.log));
  agent.notFound(notFound);
  agent.use(`${AGENT_API_PREFIX}/*`, jsonLimit);
  agent.route(AGENT_API_PREFIX, agentRoutes(deps, waiters));

  return { cockpit, agent, relay, intake };
}
