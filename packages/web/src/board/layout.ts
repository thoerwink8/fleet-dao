// 用 ELK 把任务树排成思维导图：仓在中间，右边一棵向右展开、左边一棵向左展开，最后把两边的根对齐。
// 浏览器里 ELK 跑在 Web Worker 里（elkjs 自带的 elk-worker），排版再久也不卡页面；
// 没有 Worker 的环境（单元测试）退回同线程的打包版。elkjs 约 1.5 MB，用到时才加载。
// 排不出来（脚本没加载成、Worker 出错、卡死）必须报错，画布据此说「排版没成」，不能一直空着。
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { Graph, Side } from './model';

/** 一套能用的 ELK：failed 在它坏掉时（Worker 加载失败、运行出错）拒绝；dispose 扔掉它。 */
export interface ElkHandle {
  elk: ELK;
  failed: Promise<never>;
  dispose(): void;
}

/** 100 个需求 × 5 个子任务在 Worker 里约 0.3 秒；给足余量，超过就当卡死。 */
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
 * 默认的网络单纯形分层在 100 个需求 × 5 个子任务上要 3 秒，结果却一模一样。
 * 连线由 React Flow 自己画，ELK 算出的线型不用。
 */
function options(direction: 'RIGHT' | 'LEFT'): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'SPLINES',
    'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
    'elk.layered.spacing.nodeNodeBetweenLayers': '84',
    'elk.spacing.nodeNode': '20',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    // 保持数据里的先后（需求按优先级排好了），不让算法为了少交叉而打乱。
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  };
}

async function layoutSide(elk: ELK, graph: Graph, rootId: string, side: Side): Promise<Positions> {
  const ids = new Set(graph.nodes.filter((n) => n.side === side).map((n) => n.id));
  ids.add(rootId);
  const input: ElkNode = {
    id: `root-${side}`,
    layoutOptions: options(side === 'right' ? 'RIGHT' : 'LEFT'),
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
    const merged = await Promise.race([layoutBoth(handle.elk, graph, root.id), handle.failed, timeout]);
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
