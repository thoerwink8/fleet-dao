// 两个 Hono 应用，分开监听：
// - cockpit：驾驶舱接口 /api（含飞书网关的 /api/feishu/*、别的环境推快照的 /api/nodes/report）、登录 /auth、GitHub 事件 /github/webhook。
//   生产上听 WireGuard 地址，香港经加密通道转进来。
// - agent：fleet 命令接口 /agent/v1。只听本机回环地址，AI 会话在同一台机器上调；外面够不着。
import { AGENT_API_PREFIX, AUTH_PREFIX, WEB_API_PREFIX } from '@fleet-dao/shared';
import { createGitHubIntake } from '@fleet-dao/store';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { agentRoutes } from './agent.ts';
import { authRoutes } from './auth.ts';
import { cockpitRoutes } from './cockpit.ts';
import type { Deps } from './deps.ts';
import { externalWatchHealthItem, noteExternalWatch, WATCH_HEADER } from './external-watch.ts';
import { githubRoutes } from './github.ts';
import { healthHandler } from './health.ts';
import { errorBody, errorHandler, notFound } from './http.ts';
import { intentRoutes } from './intent-routes.ts';
import { nodeReportRoutes } from './node-report.ts';
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
}

export function buildApps(deps: Deps): Apps {
  const relay = createSseRelay(deps.changes);

  const cockpit = new Hono();
  cockpit.onError(errorHandler(deps.log));
  cockpit.notFound(notFound);
  cockpit.get('/healthz', async (c) => {
    // 每来一次现读：测试会在装配之后才把「记一轮」接上。
    await noteExternalWatch({
      watchId: deps.config.edgeWatchId,
      header: c.req.header(WATCH_HEADER),
      record: deps.recordExternalWatchRound,
      log: deps.log,
    });
    return healthHandler([...deps.health, externalWatchHealthItem(deps.config.edgeWatchId)], deps.log)(c);
  });
  cockpit.use(`${WEB_API_PREFIX}/*`, jsonLimit);
  cockpit.use(`${AUTH_PREFIX}/*`, jsonLimit);
  cockpit.route(AUTH_PREFIX, authRoutes(deps));
  // 飞书网关的意图接口（五条）挂在驾驶舱接口前面：它们只认网关通行证、按各自的 acting 放行，不走驾驶舱的登录门。
  cockpit.route(WEB_API_PREFIX, intentRoutes(deps));
  // 别的环境推快照的写口（POST /api/nodes/report）：只认专用通行证（X-Fleet-Node-Token）、不认 Cookie，同样挂在登录门前面；
  // 登录门后面的 GET /api/nodes 不认这个通行证。
  cockpit.route(WEB_API_PREFIX, nodeReportRoutes(deps));
  cockpit.route(WEB_API_PREFIX, cockpitRoutes(deps, relay));
  cockpit.route('/github', githubRoutes(deps, createGitHubIntake(deps)));

  const agent = new Hono();
  agent.onError(errorHandler(deps.log));
  agent.notFound(notFound);
  // #1795：和驾驶舱同一份 /healthz。只听本机回环（8788），会话用户被 nft 拦住连不了 8787 时仍能旁证 canary。
  // 公网本来就打得开驾驶舱那份，这里不另加鉴权、不带令牌。
  agent.get('/healthz', async (c) => {
    await noteExternalWatch({
      watchId: deps.config.edgeWatchId,
      header: c.req.header(WATCH_HEADER),
      record: deps.recordExternalWatchRound,
      log: deps.log,
    });
    return healthHandler([...deps.health, externalWatchHealthItem(deps.config.edgeWatchId)], deps.log)(c);
  });
  agent.use(`${AGENT_API_PREFIX}/*`, jsonLimit);
  agent.route(AGENT_API_PREFIX, agentRoutes(deps));

  return { cockpit, agent, relay };
}
