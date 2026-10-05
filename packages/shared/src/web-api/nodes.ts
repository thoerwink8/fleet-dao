// 驾驶舱接口约定（web-api）：别的环境推来的快照（看板多机，全仓审查第 1 路第四节）。
// 每个环境的库还是自己的权威；非主环境每分钟把自己的主页（HomeResponse）和环境页（EnvResponse）原样推给法国，法国落进
// node_reports（一个环境一行、覆盖写），看板按环境切着看。快照只用来展示，不当作停止、确认的依据。
// 推送方和接收方都照这份校验：内容就是现成的两份契约，不另造一套数据形状。
import { z } from 'zod';
import { EnvEngineSchema, EnvResponseSchema } from './env.ts';
import { HomeResponseSchema } from './home.ts';
import { Time } from './internal.ts';

/** 现在认得的快照格式版本。认不出的版本拒收（接收方回 400），不猜着读。 */
export const NODE_REPORT_SCHEMA_VERSION = 1;

/** 收到后多久以内算「新鲜」：推送方每 60 秒一轮加抖动，错过两轮才算失联。 */
export const NODE_FRESH_MS = 3 * 60_000;

/** 环境编号（node_reports.node_id）：收的一方按对上的那把通行证认定（例如 local），不取载荷里自报的名字。 */
export const NodeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const NodeReportSchema = z.object({
  schemaVersion: z.literal(NODE_REPORT_SCHEMA_VERSION),
  /** 推送方的时钟。只用来显示；新不新鲜按收到的时刻算，不信对方时钟。 */
  reportedAt: Time,
  /** 推送方在用的提交号；读不到就不给这个键，不写假值。 */
  codeSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  home: HomeResponseSchema,
  env: EnvResponseSchema,
});

export type NodeReport = z.infer<typeof NodeReportSchema>;

/** 落表的那份快照（node_reports.payload）。 */
export type NodeSnapshot = Pick<NodeReport, 'home' | 'env'>;

/** fresh = 收到不到 NODE_FRESH_MS；stale = 收到过、但已经过了；never = 一次都没收到过。 */
export const NodeFreshnessSchema = z.enum(['fresh', 'stale', 'never']);
export type NodeFreshness = z.infer<typeof NodeFreshnessSchema>;

/** 按收到的时刻（node_reports.received_at）判新鲜，不看推送方自报的 reportedAt。时刻读不出就抛错，不猜成哪一种。 */
export function nodeFreshness(receivedAt: string | undefined, now: Date): NodeFreshness {
  if (receivedAt === undefined) return 'never';
  const at = Date.parse(receivedAt);
  if (Number.isNaN(at)) throw new Error(`收到快照的时刻读不出：${receivedAt}`);
  return now.getTime() - at < NODE_FRESH_MS ? 'fresh' : 'stale';
}

// —— 接收方（法国）的接口形状 ——

/** 收快照的路径（在 /api 下）和认通行证看的头。写口不在 WebRoutes 里：只有别的环境的后端调，浏览器不调，也不认 Cookie。 */
export const NODE_REPORT_PATH = '/nodes/report';
export const NODE_REPORT_HEADER = 'X-Fleet-Node-Token';
/** 一份快照最多这么大（字节）：超了回 413。 */
export const NODE_REPORT_MAX_BYTES = 256 * 1024;
/** 推送方的时钟最多比收的一方快这么多，超了回 400（不收「来自未来」的快照）。 */
export const NODE_REPORT_MAX_AHEAD_MS = 5 * 60_000;
/** 同一个环境两次被收下之间至少隔这么久，快了回 429。 */
export const NODE_REPORT_MIN_GAP_MS = 20_000;

export const NodeReportAckSchema = z.object({
  ok: z.literal(true),
  /** 收的一方记下的时刻（新不新鲜按它算）。 */
  receivedAt: Time,
});
export type NodeReportAck = z.infer<typeof NodeReportAckSchema>;

/**
 * 看板列环境的一项（不带快照本体）。配了通行证、却一次都没收到过的环境也列出来（freshness=never，没有时刻），
 * 不把它从列表里抹掉；name 用库里收到过的环境名，没收到过就是环境编号。
 */
export const NodeListItemSchema = z.object({
  id: NodeIdSchema,
  name: z.string().min(1),
  freshness: NodeFreshnessSchema,
  receivedAt: Time.optional(),
  reportedAt: Time.optional(),
  codeSha: z.string().optional(),
});
export type NodeListItem = z.infer<typeof NodeListItemSchema>;

/** GET /nodes：本台（现算）和每个远程环境。本台不是 node_reports 里的一行，不占环境编号。 */
export const NodesResponseSchema = z.object({
  self: z.object({
    /** 本台的名字（FLEET_MACHINE_NAME）；没配是 null。 */
    name: z.string().nullable(),
    engine: EnvEngineSchema,
  }),
  nodes: z.array(NodeListItemSchema),
});
export type NodesResponse = z.infer<typeof NodesResponseSchema>;

/** GET /nodes/:nodeId：一个远程环境最近一次推来的主页、环境页快照加新鲜度。只用来展示，不当作停止、确认的依据。 */
export const NodeDetailResponseSchema = z.object({
  id: NodeIdSchema,
  name: z.string().min(1),
  freshness: NodeFreshnessSchema,
  receivedAt: Time,
  reportedAt: Time,
  codeSha: z.string().optional(),
  home: HomeResponseSchema,
  env: EnvResponseSchema,
});
export type NodeDetailResponse = z.infer<typeof NodeDetailResponseSchema>;
