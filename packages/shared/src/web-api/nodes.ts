// 驾驶舱接口约定（web-api）：别的环境推来的快照（看板多机，全仓审查第 1 路第四节）。
// 每个环境的库还是自己的权威；非主环境每分钟把自己的主页（HomeResponse）和环境页（EnvResponse）原样推给法国，法国落进
// node_reports（一个环境一行、覆盖写），看板按环境切着看。快照只用来展示，不当作停止、确认的依据。
// 推送方和接收方都照这份校验：内容就是现成的两份契约，不另造一套数据形状。
import { z } from 'zod';
import { EnvResponseSchema } from './env.ts';
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
