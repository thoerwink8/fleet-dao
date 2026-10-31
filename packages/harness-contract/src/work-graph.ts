// 任务波次图的快照形状（#3784）：驾驶舱 `/next/work` 的画布吃这一份。
// 现在由影子批次推出（一张单一个节点、没有依赖、全在第 0 波）；编排做出来后同一个形状喂多波依赖图，画布不用改。
// 形状借 OmO 桌面端 `dagRuns` 的思路（整份快照整体替换；node 瘦身；波和边由服务端给）：
// 节点自己不带类别、模型的大段内容，只带一句话说明；点进去的详情走工人会话（`worker-<runId>`）。
// 不依赖 zod，前端打包不会因此变大，所以单独放子路径 `@fleet-dao/harness-contract/work-graph`。

/** 节点状态。读者要容忍不认识的值（前向兼容）：当灰色、原样显示。 */
export const NODE_STATES = [
  'pending',
  'scheduled',
  'running',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** 已经有结局、不会再动的状态；「活跃波」＝第一个还有不在这里的节点的波。 */
export const SETTLED_STATES: readonly string[] = ['completed', 'failed', 'cancelled', 'skipped'];

export const isSettled = (state: string): boolean => SETTLED_STATES.includes(state);

/** 影子打分（旧 PR 合并后评的），只带画卡片用的两个数。 */
export interface NodeScore {
  lineJaccard: number;
  fileJaccard: number;
}

export interface WorkNode {
  /** 节点号：影子批次里是 `<仓>#<单号>`，同一批内唯一。 */
  id: string;
  /** 显示名：`仓#单号`（仓只留名字，不带 owner）。 */
  label: string;
  state: NodeState | (string & {});
  /** 当前第几次尝试，从 1 起；还没开始是 0。 */
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  model: string | null;
  category: string | null;
  /** 一句话说明：最近一句进度，退到交回的原因、出错原因、任务标题。 */
  headline: string | null;
  /** 这张单跑过的每次运行（按尝试顺序）；会话号是 `worker-<runId>`。 */
  runIds: string[];
  score: NodeScore | null;
}

export interface WorkWave {
  index: number;
  nodeIds: string[];
}

export interface WorkEdge {
  from: string;
  to: string;
}

export interface WorkGraph {
  batchId: string;
  /** 这份快照是什么时候读的（服务端时间），画面上「x 秒前更新」用。 */
  at: string;
  nodes: WorkNode[];
  waves: WorkWave[];
  edges: WorkEdge[];
  /** 批里的单数多于接口上限时只给前面的，这里写真实总数；没截断就是 null。 */
  truncatedFrom: number | null;
}

export interface BatchSummary {
  batchId: string;
  items: number;
  /** 各状态有几张单（只列有的）。 */
  counts: Record<string, number>;
  /** 这一批最早的 snapshot_at（冻结时刻）。 */
  snapshotAt: string;
}

export interface BatchesPage {
  batches: BatchSummary[];
  /** 非空 = 还有更老的批次，下一页把它当 before 传。 */
  nextBefore: string | null;
}

/** 一批最多给多少个节点（再多的批次整体被截，truncatedFrom 写真实总数）。 */
export const GRAPH_NODE_MAX = 500;

/** 数各状态的个数。 */
export function countStates(nodes: readonly Pick<WorkNode, 'state'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of nodes) out[n.state] = (out[n.state] ?? 0) + 1;
  return out;
}
