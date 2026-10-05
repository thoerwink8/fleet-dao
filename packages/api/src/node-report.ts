// 接收方（看板多机，全仓审查第 1 路 PR-3）：别的环境（本机 WSL）把自己的主页、环境页快照推到这一台，这里按通行证认人、校验、落表。
// 这是对公网新开的一个写口（香港 nginx 的 /api/* 转进来），改这里之前必须知道：
// - 认人只看请求头 X-Fleet-Node-Token：把它算 sha256，和 FLEET_NODE_KEYS（{"<环境编号>":"<sha256 十六进制>"}）里每一把定长比较，
//   一把都不留空档地比完；node_id 取对上的那把钥匙的编号，载荷里自报什么都不信。库里不存明文、环境文件里只有哈希。
// - 挂在登录门之前（app.ts，和飞书网关的意图接口同一个位置），不认 Cookie、不认 Authorization（香港 nginx 会清掉它）；
//   反过来，登录门后面的接口（GET /api/nodes …）不认这个头——通行证只能写这一个口子。
// - 先认人、再看大小、再校验：认不出的人回 401、一个字节的请求体也不读；超 256KB 回 413；坏 schema（含不认识的版本）回 400；
//   reportedAt 比收的钟快 5 分钟以上回 400；同一个环境 20 秒内只收一次，快了回 429（槽位在认完人当场占、没收成就还回去，
//   并发的两份也只放一份过）。
// - 这台没配 FLEET_NODE_KEYS 就是不收：回 503 写明原因，不回 401 冒充「通行证不对」（发布读回那条「假通行证要回 401」也因此能红）。
// - 收下的快照只用来展示（看板按 received_at 判新不新鲜），不当作停止、确认的依据；写口只写 node_reports 这一张表。
// - 日志只记环境编号、原因，不记通行证和载荷。
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  NODE_REPORT_HEADER,
  NODE_REPORT_MAX_AHEAD_MS,
  NODE_REPORT_MAX_BYTES,
  NODE_REPORT_MIN_GAP_MS,
  NODE_REPORT_PATH,
  NodeReportAckSchema,
  NodeReportSchema,
} from '@fleet-dao/shared';
import { InvalidNodeReportError } from '@fleet-dao/store';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { ApiError, errorBody, readJson, reply } from './http.ts';

/** 通行证明文的哈希（和 fleet-api node-key new 打印的、FLEET_NODE_KEYS 里贴的同一个算法）。 */
export const nodeKeyHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** 通行证明文长到这个字符数以上就一定不是我们发的（node-key new 发的是 43 个字符），不用算哈希就拒。 */
const MAX_TOKEN_CHARS = 256;

/**
 * 通行证对上了哪个环境：每一把钥匙都比一遍（不在第一个对上时就返回），对不上回 null。
 * keys 的值是 64 位十六进制哈希（config.ts 启动时核过格式）。
 */
export function nodeIdForToken(keys: Readonly<Record<string, string>>, token: string): string | null {
  if (token === '' || token.length > MAX_TOKEN_CHARS) return null;
  const presented = createHash('sha256').update(token).digest();
  let found: string | null = null;
  for (const [id, hex] of Object.entries(keys)) {
    const stored = Buffer.from(hex, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) found ??= id;
  }
  return found;
}

export const NODE_KEYS_NOT_WIRED =
  '这台没配 FLEET_NODE_KEYS，不收别的环境推来的快照（要收就在 api.env 里放通行证的哈希，见 docs/ops.md「接上法国看板」）';

const oversize = bodyLimit({
  maxSize: NODE_REPORT_MAX_BYTES,
  onError: (c) => c.json(errorBody('too_large', `快照超过 ${NODE_REPORT_MAX_BYTES / 1024} KB，没收`), 413),
});

/** POST /api/nodes/report。只有这一条；读（GET /api/nodes …）在 cockpit.ts 的登录门后面。 */
export function nodeReportRoutes(deps: Deps): Hono<{ Variables: { nodeId: string } }> {
  const { config, store, log } = deps;
  const app = new Hono<{ Variables: { nodeId: string } }>();
  /** 每个环境上次被收下（或正在收）的时刻。 */
  const lastAccepted = new Map<string, number>();

  const reject = (nodeId: string | null, status: 401 | 429 | 503, code: string, message: string) => {
    log.warn('快照没收', { nodeId, code });
    return new ApiError(status, code, message);
  };

  app.post(
    NODE_REPORT_PATH,
    async (c, next) => {
      if (Object.keys(config.nodeKeys).length === 0) {
        throw reject(null, 503, 'node_keys_not_wired', NODE_KEYS_NOT_WIRED);
      }
      const token = c.req.header(NODE_REPORT_HEADER);
      if (token === undefined) {
        throw reject(null, 401, 'node_token_missing', `要带通行证：请求头 ${NODE_REPORT_HEADER}`);
      }
      const nodeId = nodeIdForToken(config.nodeKeys, token.trim());
      if (nodeId === null) throw reject(null, 401, 'node_token_invalid', '通行证不对');
      c.set('nodeId', nodeId);
      await next();
    },
    oversize,
    async (c) => {
      const nodeId = c.get('nodeId');
      const now = deps.now();
      const before = lastAccepted.get(nodeId);
      if (before !== undefined && now.getTime() - before < NODE_REPORT_MIN_GAP_MS) {
        const waitS = Math.ceil((NODE_REPORT_MIN_GAP_MS - (now.getTime() - before)) / 1000);
        c.header('Retry-After', String(waitS));
        throw reject(
          nodeId,
          429,
          'too_frequent',
          `同一个环境 ${NODE_REPORT_MIN_GAP_MS / 1000} 秒内只收一次，${waitS} 秒后再推`,
        );
      }
      lastAccepted.set(nodeId, now.getTime());
      try {
        const report = await readJson(c, NodeReportSchema);
        if (Date.parse(report.reportedAt) > now.getTime() + NODE_REPORT_MAX_AHEAD_MS) {
          throw new ApiError(
            400,
            'reported_at_in_future',
            `reportedAt（${report.reportedAt}）比这台的钟快了 ${NODE_REPORT_MAX_AHEAD_MS / 60_000} 分钟以上：推送方的钟不对，快照没收`,
          );
        }
        let saved: Awaited<ReturnType<typeof store.putNodeReport>>;
        try {
          saved = await store.putNodeReport({ nodeId, report });
        } catch (err) {
          if (err instanceof InvalidNodeReportError) throw new ApiError(400, 'invalid_snapshot', err.message);
          throw err;
        }
        return reply(c, NodeReportAckSchema, { ok: true, receivedAt: saved.receivedAt });
      } catch (err) {
        // 没收成：把槽位还回去，推送方改好了马上能再推
        if (before === undefined) lastAccepted.delete(nodeId);
        else lastAccepted.set(nodeId, before);
        if (err instanceof ApiError && err.status < 500) log.warn('快照没收', { nodeId, code: err.code });
        throw err;
      }
    },
  );
  return app;
}
