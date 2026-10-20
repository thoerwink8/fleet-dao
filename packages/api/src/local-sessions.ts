// 本机会话（#1991，母单 #1990）的收和读。
// 收：POST /api/nodes/sessions，挂在 node-report.ts 那个登录门前面的小应用里，认人和快照同一个头（X-Fleet-Node-Token）、
//     同一套钥匙（FLEET_NODE_KEYS）；环境编号取对上的那把钥匙，载荷里自报什么都不信。
// 读：GET /api/nodes/sessions，在登录门后面（cockpit.ts），看板「本机会话」一块用。
// 改这里之前必须知道：
// - 只收元信息：schema 是 strict，多带一个字段（提示词、命令参数……）整份拒收 400，什么都不写。
// - 超 128KB 回 413；同一个环境 20 秒内只收一次（429，槽位没收成就还回去）；reportedAt 比这台快 5 分钟以上回 400。
// - 没配 FLEET_NODE_KEYS：收回 503；读的时候写 notWired，不当成「没有本机会话」。
// - 读：每个推过的环境一项；配了钥匙、一次都没推过本机会话的也列出来（never）。收到超过 5 分钟的是 stale——页面写「没上报」。
// - 日志只记环境编号和原因，不记通行证和载荷。
import {
  LOCAL_SESSIONS_FRESH_MS,
  LOCAL_SESSIONS_MAX_BYTES,
  LOCAL_SESSIONS_PATH,
  type LocalSessionsNode,
  LocalSessionsReportSchema,
  type LocalSessionsResponse,
  localSessionState,
  NODE_REPORT_MAX_AHEAD_MS,
  NODE_REPORT_MIN_GAP_MS,
  NodeReportAckSchema,
} from '@fleet-dao/shared';
import { InvalidNodeReportError } from '@fleet-dao/store';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { ApiError, errorBody, readJson, reply } from './http.ts';
import { readNodeKeys } from './node-keys.ts';

type NodeEnv = { Variables: { nodeId: string } };

/** 这台没配钥匙时，读口写的原因。 */
export const LOCAL_SESSIONS_NOT_WIRED =
  '法国还没发过机器通行证（库里没有、FLEET_NODE_KEYS 也没配），不收本机推来的会话（见 docs/ops.md「本机会话上报」）';

const oversize = bodyLimit({
  maxSize: LOCAL_SESSIONS_MAX_BYTES,
  onError: (c) =>
    c.json(errorBody('too_large', `本机会话超过 ${LOCAL_SESSIONS_MAX_BYTES / 1024} KB，没收`), 413),
});

export function registerLocalSessionsReceiver(
  app: Hono<NodeEnv>,
  deps: Deps,
  authenticate: MiddlewareHandler<NodeEnv>,
): void {
  const { store, log } = deps;
  const lastAccepted = new Map<string, number>();

  app.post(LOCAL_SESSIONS_PATH, authenticate, oversize, async (c) => {
    const nodeId = c.get('nodeId');
    const now = deps.now();
    const before = lastAccepted.get(nodeId);
    if (before !== undefined && now.getTime() - before < NODE_REPORT_MIN_GAP_MS) {
      const waitS = Math.ceil((NODE_REPORT_MIN_GAP_MS - (now.getTime() - before)) / 1000);
      c.header('Retry-After', String(waitS));
      log.warn('本机会话没收', { nodeId, code: 'too_frequent' });
      throw new ApiError(
        429,
        'too_frequent',
        `同一个环境 ${NODE_REPORT_MIN_GAP_MS / 1000} 秒内只收一次本机会话，${waitS} 秒后再推`,
      );
    }
    lastAccepted.set(nodeId, now.getTime());
    try {
      const report = await readJson(c, LocalSessionsReportSchema);
      if (Date.parse(report.reportedAt) > now.getTime() + NODE_REPORT_MAX_AHEAD_MS) {
        throw new ApiError(
          400,
          'reported_at_in_future',
          `reportedAt（${report.reportedAt}）比这台的钟快了 ${NODE_REPORT_MAX_AHEAD_MS / 60_000} 分钟以上：推送方的钟不对，没收`,
        );
      }
      let saved: { receivedAt: string };
      try {
        saved = await store.putNodeSessions({ nodeId, report });
      } catch (err) {
        if (err instanceof InvalidNodeReportError) throw new ApiError(400, 'invalid_sessions', err.message);
        throw err;
      }
      return reply(c, NodeReportAckSchema, { ok: true, receivedAt: saved.receivedAt });
    } catch (err) {
      if (before === undefined) lastAccepted.delete(nodeId);
      else lastAccepted.set(nodeId, before);
      if (err instanceof ApiError && err.status < 500) log.warn('本机会话没收', { nodeId, code: err.code });
      throw err;
    }
  });
}

/** 收到这么久以内算在上报。时刻读不出抛错，不猜。 */
function freshnessOf(receivedAt: string, now: Date): 'fresh' | 'stale' {
  const at = Date.parse(receivedAt);
  if (Number.isNaN(at)) throw new Error(`收到本机会话的时刻读不出：${receivedAt}`);
  return now.getTime() - at < LOCAL_SESSIONS_FRESH_MS ? 'fresh' : 'stale';
}

/** GET /nodes/sessions。库里那份认不出回 500 写明，不当成没有会话。 */
export async function readLocalSessions(
  deps: Pick<Deps, 'config' | 'store' | 'now' | 'log'>,
): Promise<LocalSessionsResponse> {
  const now = deps.now();
  const { keys, configured } = await readNodeKeys(deps);
  let records: Awaited<ReturnType<Deps['store']['listNodeSessions']>>;
  try {
    records = await deps.store.listNodeSessions();
  } catch (err) {
    if (err instanceof InvalidNodeReportError)
      throw new ApiError(500, 'local_sessions_unreadable', err.message);
    throw err;
  }
  const nodes = new Map<string, LocalSessionsNode>();
  for (const r of records) {
    const times = { reportedAt: r.report.reportedAt, receivedAt: r.receivedAt };
    nodes.set(r.nodeId, {
      id: r.nodeId,
      freshness: freshnessOf(r.receivedAt, now),
      machine: r.report.machine,
      receivedAt: r.receivedAt,
      reportedAt: r.report.reportedAt,
      sessions: r.report.sessions
        .map((s) => ({ ...s, ...localSessionState(s, times, now) }))
        .sort((a, b) => a.idleMs - b.idleMs),
      problems: r.report.problems,
    });
  }
  for (const id of Object.keys(keys)) {
    if (!nodes.has(id)) nodes.set(id, { id, freshness: 'never', sessions: [], problems: [] });
  }
  const notWired = !configured;
  return {
    asOf: now.toISOString(),
    ...(notWired ? { notWired: LOCAL_SESSIONS_NOT_WIRED } : {}),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
