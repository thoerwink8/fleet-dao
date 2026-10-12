// 用 ELK 把首页看板排成思维导图（初版 PR #13 的排法原样搬回）：引擎在中间，右边一棵向右展开、左边一棵向左展开，最后把两边的根对齐。
// 浏览器里 ELK 跑在 Web Worker 里（elkjs 自带的 elk-worker），排版再久也不卡页面；
// 没有 Worker 的环境（单元测试）退回同线程的打包版。elkjs 约 1.5 MB，用到时才加载。
// 排不出来（脚本没加载成、Worker 出错、卡死）必须报错，画布据此说「排版没成」，不能一直空着。
// 一段的单子排成几列（Graph.columns > 1，#1973）时，ELK 只定引擎和段那两层的横向位置，单子这一层由 wrapColumns 按网格摆。
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { type Graph, NODE_SIZE, ROOT_ID, type Side, SPACING } from './model';

/** 一套能用的 ELK：failed 在它坏掉时（Worker 加载失败、运行出错）拒绝；dispose 扔掉它。 */
export interface ElkHandle {
  elk: ELK;
  failed: Promise<never>;
  dispose(): void;
}

/** 100 张单在 Worker 里约 0.3 秒；给足余量，超过就当卡死。 */
const LAYOUT_TIMEOUT_MS = 20_000;

let current: Promise<ElkHandle> | undefined;

async function createElk(): Promise<ElkHandle> {
  if (typeof Worker === 'undefined') {
    const m = await import('elkjs/lib/elk.bundled.js');
    return { elk: new m.default(), failed: new Promise<never>(() => {}), dispose() {} };
  }
  const m = await import('elkjs/lib/elk-api.js');
  let worker: Worker | undefined;
  let reject: (err: Error) => void = () => {};
  const failed = new Promise<never>((_, r) => {
    reject = r;
  });
  // 没人在等排版时坏掉也别冒成「未处理的拒绝」；真在等的那次 race 照样收到。
  failed.catch(() => {});
  const elk = new m.default({
    workerUrl: elkWorkerUrl,
    workerFactory: (url?: string) => {
      worker = new Worker(url ?? elkWorkerUrl);
      worker.addEventListener('error', (e) => {
        reject(new Error(`排版引擎出错：${e.message || '脚本没加载成'}`));
      });
      return worker;
    },
  });
  return { elk, failed, dispose: () => worker?.terminate() };
}

function getElk(): Promise<ElkHandle> {
  current ??= createElk().catch((err: unknown) => {
    // 连脚本都没下载成（断网、发版换了文件名）：下次重试重新下载，不把失败缓存住。
    current = undefined;
    throw err;
  });
  return current;
}

export type Positions = Map<string, { x: number; y: number }>;

/**
 * 分层按「离源头多远」（LONGEST_PATH_SOURCE）：图是一棵树，这就等于深度，是线性的；
 * 默认的网络单纯形分层在 100 张单上要 3 秒，结果却一模一样。
 * 连线由 React Flow 自己画，ELK 算出的线型不用。
 */
function options(direction: 'RIGHT' | 'LEFT', scale: number): Record<string, string> {
  // 间距和节点尺寸乘同一个根字号倍数（model.ts 的 Graph.scale）：整张图等比放大，疏密不变
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'SPLINES',
    'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(SPACING.between * scale)),
    'elk.spacing.nodeNode': String(Math.round(SPACING.node * scale)),
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    // 保持数据里的先后（单子按「最该看的在前」排好了），不让算法为了少交叉而打乱。
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  };
}

async function layoutSide(elk: ELK, graph: Graph, rootId: string, side: Side): Promise<Positions> {
  const ids = new Set(graph.nodes.filter((n) => n.side === side).map((n) => n.id));
  ids.add(rootId);
  const input: ElkNode = {
    id: `root-${side}`,
    layoutOptions: options(side === 'right' ? 'RIGHT' : 'LEFT', graph.scale),
    children: graph.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const out = await elk.layout(input);
  const pos: Positions = new Map();
  for (const c of out.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return pos;
}

async function layoutBoth(elk: ELK, graph: Graph, rootId: string): Promise<Positions> {
  const hasLeft = graph.nodes.some((n) => n.side === 'left');
  const [right, left] = await Promise.all([
    layoutSide(elk, graph, rootId, 'right'),
    hasLeft ? layoutSide(elk, graph, rootId, 'left') : Promise.resolve(undefined),
  ]);
  if (!left) return right;
  const r = right.get(rootId) ?? { x: 0, y: 0 };
  const l = left.get(rootId) ?? { x: 0, y: 0 };
  const dx = r.x - l.x;
  const dy = r.y - l.y;
  const merged: Positions = new Map(right);
  for (const [id, p] of left) if (id !== rootId) merged.set(id, { x: p.x + dx, y: p.y + dy });
  return merged;
}

/**
 * 一段的单子排成 columns 列的网格（#1973 排版）：ELK 排出来的引擎、段的横向位置不动，每一侧从上到下一段接一段重新摆——
 * 段的单子按数据里的先后一行一行排（第一列贴着段，往外一列一列），段节点竖着对准自己那块单子的正中；
 * 要你拍挂在这一行最外侧那列的外面（夹在两列中间会盖住下一列），同一行有几片就上下叠，叠不下这一行就加高。
 * 一侧摆完整体上下挪，让它的正中对准引擎。
 */
export function wrapColumns(graph: Graph, pos: Positions): Positions {
  if (graph.columns.right <= 1 && graph.columns.left <= 1) return pos;
  const s = graph.scale;
  const out: Positions = new Map(pos);
  const size = (id: string) => graph.nodes.find((n) => n.id === id) ?? { width: 0, height: 0 };
  const root = pos.get(ROOT_ID);
  if (!root) return pos;
  const rootSize = size(ROOT_ID);
  const tW = Math.round(NODE_SIZE.ticket.width * s);
  const tH = Math.round(NODE_SIZE.ticket.height * s);
  const askW = Math.round(NODE_SIZE.ask.width * s);
  const askH = Math.round(NODE_SIZE.ask.height * s);
  const between = SPACING.between * s;
  const gapY = SPACING.node * s;
  const gapX = SPACING.column * s;
  const segGap = SPACING.segment * s;
  for (const side of ['right', 'left'] as const) {
    const cols = graph.columns[side];
    // 只排一列的那侧照 ELK 排出来的不动
    if (cols <= 1) continue;
    const segments = (graph.childrenOf.get(ROOT_ID) ?? []).filter(
      (id) => graph.nodes.find((n) => n.id === id)?.side === side,
    );
    if (!segments.length) continue;
    const placed = new Map<string, { x: number; y: number }>();
    let top = 0;
    for (const sid of segments) {
      const sp = pos.get(sid);
      if (!sp) continue;
      const seg = size(sid);
      const tickets = graph.childrenOf.get(sid) ?? [];
      const rows = Math.max(1, Math.ceil(tickets.length / cols));
      // 每行的要你拍（按单子先后）和行高：要你拍叠不下就把这一行加高
      const asksOf = (row: number) =>
        tickets.slice(row * cols, row * cols + cols).flatMap((t) => graph.childrenOf.get(t) ?? []);
      const rowH = Array.from({ length: rows }, (_, r) => {
        const n = asksOf(r).length;
        return Math.max(tH, n * askH + Math.max(0, n - 1) * gapY);
      });
      const blockH = rowH.reduce((a, b) => a + b, 0) + (rows - 1) * gapY;
      const blockH2 = Math.max(blockH, seg.height);
      placed.set(sid, { x: sp.x, y: top + (blockH2 - seg.height) / 2 });
      // 第一列贴着段：右侧从段的右边往右排，左侧从段的左边往左排
      const near = side === 'right' ? sp.x + seg.width + between : sp.x - between;
      const colX = (col: number) =>
        side === 'right' ? near + col * (tW + gapX) : near - col * (tW + gapX) - tW;
      // 要你拍那一列：最外一列（单子凑不满时也按满列算，各行对齐）再往外一层
      const askX = side === 'right' ? colX(cols - 1) + tW + between : colX(cols - 1) - between - askW;
      let rowTop = top + (blockH2 - blockH) / 2;
      for (let r = 0; r < rows; r++) {
        const h = rowH[r] ?? tH;
        tickets.slice(r * cols, r * cols + cols).forEach((tid, col) => {
          placed.set(tid, { x: colX(col), y: rowTop + (h - tH) / 2 });
        });
        const asks = asksOf(r);
        const stackH = asks.length * askH + Math.max(0, asks.length - 1) * gapY;
        asks.forEach((aid, i) => {
          placed.set(aid, { x: askX, y: rowTop + (h - stackH) / 2 + i * (askH + gapY) });
        });
        rowTop += h + gapY;
      }
      top += blockH2 + segGap;
    }
    // 整侧的正中对准引擎的正中
    const sideH = top - segGap;
    const dy = root.y + rootSize.height / 2 - sideH / 2;
    for (const [id, p] of placed) out.set(id, { x: p.x, y: p.y + dy });
  }
  return out;
}

// 同一套节点排过一次就记住：来回切「只看卡住的」时第二次不用再算。
const cache = new Map<string, Positions>();
const CACHE_SIZE = 8;

export interface LayoutOptions {
  timeoutMs?: number;
  /** 测试用：换一套 ELK（例如一个永远不回话的）。 */
  elk?: () => Promise<ElkHandle>;
}

/** 排版。排不出来就拒绝（带白话原因），这一套 ELK 随之作废，下次调用重新建。 */
export async function layoutGraph(graph: Graph, opts: LayoutOptions = {}): Promise<Positions> {
  const hit = cache.get(graph.structureKey);
  if (hit) return hit;
  const root = graph.nodes[0];
  if (!root) return new Map();
  const handle = await (opts.elk ?? getElk)();
  const ms = opts.timeoutMs ?? LAYOUT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`排版超过 ${Math.round(ms / 1000)} 秒没出结果`)), ms);
  });
  try {
    const merged = wrapColumns(
      graph,
      await Promise.race([layoutBoth(handle.elk, graph, root.id), handle.failed, timeout]),
    );
    cache.set(graph.structureKey, merged);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return merged;
  } catch (err) {
    handle.dispose();
    if (!opts.elk) current = undefined;
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}
