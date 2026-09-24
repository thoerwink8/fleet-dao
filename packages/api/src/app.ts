// 两个 Hono 应用，分开监听：
// - cockpit：驾驶舱接口 /api、登录 /auth、GitHub 事件 /github/webhook。生产上听 WireGuard 地址，香港经加密通道转进来。
// - agent：fleet 命令接口 /agent/v1。只听本机回环地址，AI 会话在同一台机器上调；外面够不着。
import { AGENT_API_PREFIX, AUTH_PREFIX, WEB_API_PREFIX } from '@fleet-dao/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { agentRoutes } from './agent.ts';
import { authRoutes } from './auth.ts';
import { createAskWaiters } from './changes.ts';
import { cockpitRoutes } from './cockpit.ts';
import type { Deps } from './deps.ts';
import { createGitHubIntake, githubRoutes } from './github.ts';
import { errorBody, errorHandler, notFound } from './http.ts';

/** 驾驶舱和 fleet 命令的请求体都很小；GitHub 事件另有自己的上限。 */
const MAX_JSON_BYTES = 1024 * 1024;

const jsonLimit = bodyLimit({
  maxSize: MAX_JSON_BYTES,
  onError: (c) => c.json(errorBody('too_large', '请求体超过 1 MB'), 413),
});

export interface Apps {
  cockpit: Hono;
  agent: Hono;
}

export function buildApps(deps: Deps): Apps {
  const waiters = createAskWaiters(deps.changes);

  const cockpit = new Hono();
  cockpit.onError(errorHandler(deps.log));
  cockpit.notFound(notFound);
  cockpit.get('/healthz', (c) => c.json({ ok: true }));
  cockpit.use(`${WEB_API_PREFIX}/*`, jsonLimit);
  cockpit.use(`${AUTH_PREFIX}/*`, jsonLimit);
  cockpit.route(AUTH_PREFIX, authRoutes(deps));
  cockpit.route(WEB_API_PREFIX, cockpitRoutes(deps, waiters));
  cockpit.route('/github', githubRoutes(deps, createGitHubIntake(deps)));

  const agent = new Hono();
  agent.onError(errorHandler(deps.log));
  agent.notFound(notFound);
  agent.use(`${AGENT_API_PREFIX}/*`, jsonLimit);
  agent.route(AGENT_API_PREFIX, agentRoutes(deps, waiters));

  return { cockpit, agent };
}
