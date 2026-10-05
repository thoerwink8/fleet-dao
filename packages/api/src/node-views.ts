// 看板多机的读口（登录门后面的 GET /api/nodes、GET /api/nodes/:nodeId）：把 node_reports 里收到的快照和 FLEET_NODE_KEYS 里
// 配了钥匙的环境拼成看板要的样子。写口在 node-report.ts，只认专用通行证；这里读，认登录。
// 改这里之前必须知道：
// - 新不新鲜按收到的时刻（received_at）算（shared 的 nodeFreshness），不信推送方自报的 reportedAt；时刻读不出就抛错，不猜。
// - 配了钥匙、却一次都没收到过的环境照样列出来（freshness=never）；收到过、钥匙后来撤了的也还列着（会变 stale），
//   都不把环境从列表里抹掉。
// - 库里存的那份快照认不出（版本对不上、形状坏了）回 500 写明是哪个环境，不当成「没推过」。
import {
  type EnvEngine,
  type NodeDetailResponse,
  NodeIdSchema,
  type NodeListItem,
  type NodesResponse,
  nodeFreshness,
} from '@fleet-dao/shared';
import { InvalidNodeReportError, type NodeReportSummary } from '@fleet-dao/store';
import type { Deps } from './deps.ts';
import { ApiError } from './http.ts';

type ViewDeps = Pick<Deps, 'config' | 'store' | 'now'>;

const listItem = (r: NodeReportSummary, now: Date): NodeListItem => ({
  id: r.nodeId,
  name: r.displayName,
  freshness: nodeFreshness(r.receivedAt, now),
  receivedAt: r.receivedAt,
  reportedAt: r.reportedAt,
  ...(r.codeSha === undefined ? {} : { codeSha: r.codeSha }),
});

/** GET /nodes：本台（名字现读配置、引擎调用方给）加每个远程环境。 */
export async function readNodes(deps: ViewDeps, selfEngine: EnvEngine): Promise<NodesResponse> {
  const now = deps.now();
  const reports = await deps.store.listNodeReports();
  const items = new Map<string, NodeListItem>(reports.map((r) => [r.nodeId, listItem(r, now)]));
  for (const id of Object.keys(deps.config.nodeKeys)) {
    if (!items.has(id)) items.set(id, { id, name: id, freshness: nodeFreshness(undefined, now) });
  }
  return {
    self: { name: deps.config.machineName, engine: selfEngine },
    nodes: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** GET /nodes/:nodeId：一个远程环境最近一次推来的快照。认不出的编号、没配钥匙也没收到过的 404；配了钥匙但没推过的 404 写明白。 */
export async function readNodeDetail(deps: ViewDeps, nodeId: string): Promise<NodeDetailResponse> {
  if (!NodeIdSchema.safeParse(nodeId).success) throw new ApiError(404, 'node_not_found', '没有这个环境');
  let record: Awaited<ReturnType<Deps['store']['getNodeReport']>>;
  try {
    record = await deps.store.getNodeReport(nodeId);
  } catch (err) {
    if (err instanceof InvalidNodeReportError)
      throw new ApiError(500, 'node_snapshot_unreadable', err.message);
    throw err;
  }
  if (record === null) {
    if (Object.hasOwn(deps.config.nodeKeys, nodeId)) {
      throw new ApiError(404, 'node_never_reported', `环境 ${nodeId} 配了通行证，但一次快照都没推来过`);
    }
    throw new ApiError(404, 'node_not_found', '没有这个环境');
  }
  return {
    id: record.nodeId,
    name: record.displayName,
    freshness: nodeFreshness(record.receivedAt, deps.now()),
    receivedAt: record.receivedAt,
    reportedAt: record.reportedAt,
    ...(record.codeSha === undefined ? {} : { codeSha: record.codeSha }),
    home: record.snapshot.home,
    env: record.snapshot.env,
  };
}
