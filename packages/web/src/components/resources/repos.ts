// 资源页「仓库」一节（#1993）：每个仓在法国占多少、有几棵工作树、每棵现在是什么状态。
// 创始人 2026-10-13：「我只需要关心我们发版的……仓库这种，它占用多少……最好也能加上比如说工作树……一键清理掉。」
//
// 数据从哪来：工作树清单由引擎在每小时对账（或一键清理）那一轮出（GET /worktrees，shared/web-api/worktrees.ts 文件头）；
// 内存、CPU 是主页数据里在跑的单按仓归的会话（和上线项目「AI 会话」的子行同一份算法 sessionChildren）。
//
// 改这里之前必须知道：
// - 一个仓的磁盘 = 镜像 + 名下每棵树。有一样量不了时写下限「≥」加「不全」和原因；一样都没量成写「没量到」。不拿 0 顶。
// - 树的状态只照引擎判的写（在跑、会话在用、有改动、留着、没查成、这轮没轮到），这里不另判能不能删。
// - 清单整轮没跑成（根读不了）、引擎还没出过、库里那份认不出，三种分开写，都不画成「0 棵树」。
import type { WorktreeRow, WorktreeState, Worktrees } from '../../api/types';
import { formatBytes } from '../home/resources';
import type { HomeResources, HomeRunning } from '../home/types';
import type { LayoutTone as StatusTone } from '../layout/tone';
import { type Cell, sessionChildren } from './view';

export interface TreeView {
  key: string;
  tree: string;
  what: string;
  issueNumber?: number;
  state: WorktreeState;
  /** 状态字（点加字）。 */
  label: string;
  tone: StatusTone;
  /** 引擎写的原因全文。 */
  why: string;
  /** 最近一次会话收场（或起）的时刻；库里没有是 undefined。 */
  lastSessionAt?: string;
  size: { kind: 'ok'; text: string; bytes: number } | { kind: 'unread'; why: string };
}

export type RepoDisk =
  | { kind: 'ok'; text: string; bytes: number; incomplete?: string }
  | { kind: 'unread'; why: string };

export interface RepoRow {
  repo: string;
  disk: RepoDisk;
  mirror: RepoDisk;
  memory: Cell;
  cpu: Cell;
  sessions: number;
  trees: TreeView[];
  /** 有改动、留着、没查成——一键清理会拒删的几棵（在用的不算）。 */
  held: number;
}

export type RepoRowsResult =
  | {
      kind: 'ok';
      rows: RepoRow[];
      takenAt: string;
      trigger: 'hourly' | 'cleanup';
      removed: string[];
      /** 一部分没查成。 */
      unchecked: string[];
    }
  /** 整轮没跑成：树的列表不可信；镜像照列。 */
  | { kind: 'failed'; why: string; takenAt: string; rows: RepoRow[] }
  | { kind: 'none'; why: string }
  | { kind: 'unread'; why: string };

const STATE: Record<WorktreeState, { label: string; tone: StatusTone }> = {
  running: { label: '任务在用', tone: 'run' },
  session: { label: '会话在用', tone: 'run' },
  leftover: { label: '有改动', tone: 'stall' },
  kept: { label: '留着', tone: 'stop' },
  unchecked: { label: '没查成', tone: 'doubt' },
  deferred: { label: '这轮没轮到', tone: 'wait' },
};

export const treeStateWord = (s: WorktreeState) => STATE[s].label;

function treeView(t: WorktreeRow): TreeView {
  return {
    key: `${t.repo}/${t.tree}`,
    tree: t.tree,
    what: t.what,
    ...(t.issueNumber === undefined ? {} : { issueNumber: t.issueNumber }),
    state: t.state,
    ...STATE[t.state],
    why: t.why,
    ...(t.lastSessionAt === undefined ? {} : { lastSessionAt: t.lastSessionAt }),
    size:
      t.size.state === 'ok'
        ? { kind: 'ok', text: formatBytes(t.size.bytes), bytes: t.size.bytes }
        : { kind: 'unread', why: t.size.why },
  };
}

function sizeOf(s: { state: 'ok'; bytes: number } | { state: 'unread'; why: string }): RepoDisk {
  return s.state === 'ok'
    ? { kind: 'ok', text: formatBytes(s.bytes), bytes: s.bytes }
    : { kind: 'unread', why: s.why };
}

/** 镜像加每棵树：量不了的记下原因，数是下限。 */
function repoDisk(mirror: RepoDisk, trees: TreeView[]): RepoDisk {
  const parts: { label: string; size: RepoDisk | TreeView['size'] }[] = [
    { label: '镜像', size: mirror },
    ...trees.map((t) => ({ label: `树 ${t.tree}`, size: t.size })),
  ];
  let bytes = 0;
  const gaps: string[] = [];
  let read = 0;
  for (const p of parts) {
    if (p.size.kind === 'ok') {
      bytes += p.size.bytes;
      read += 1;
    } else gaps.push(`${p.label}：${p.size.why}`);
  }
  if (read === 0) return { kind: 'unread', why: gaps.join('；') || '没有可量的' };
  return {
    kind: 'ok',
    text: formatBytes(bytes),
    bytes,
    ...(gaps.length ? { incomplete: `不全：${gaps.join('；')}` } : {}),
  };
}

const NOT_ON_LOCAL = '引擎还没出过工作树清单（每小时对账出一份；刚上线要等下一轮）';

/** 每个仓一行：清单里的仓（有镜像的、根下出现过的）和在跑的单所在的仓，合在一起按磁盘从大到小。 */
export function repoRows(
  w: Worktrees | undefined,
  resources: HomeResources | undefined,
  running: readonly HomeRunning[],
): RepoRowsResult {
  if (!w) return { kind: 'unread', why: '工作树清单还没读到' };
  if (w.inventoryWhy) return { kind: 'unread', why: w.inventoryWhy };
  const inv = w.inventory;
  if (!inv) return { kind: 'none', why: NOT_ON_LOCAL };
  const usage = new Map(
    (resources ? (sessionChildren(resources, running) ?? []) : []).map((r) => [r.key.toLowerCase(), r]),
  );
  const sessionsWhy =
    resources === undefined
      ? '主页数据里没有资源读数'
      : resources.sessions.state === 'unread'
        ? resources.sessions.why
        : undefined;
  const names = new Map<string, string>();
  for (const r of inv.repos) names.set(r.repo.toLowerCase(), r.repo);
  for (const t of inv.trees) names.set(t.repo.toLowerCase(), t.repo);
  for (const r of running) if (usage.has(r.repo.toLowerCase())) names.set(r.repo.toLowerCase(), r.repo);
  const rows: RepoRow[] = [...names.entries()].map(([key, repo]) => {
    const m = inv.repos.find((r) => r.repo.toLowerCase() === key);
    const mirror: RepoDisk = m ? sizeOf(m.mirror) : { kind: 'unread', why: '清单里没有这个仓的镜像' };
    const trees = inv.failed ? [] : inv.trees.filter((t) => t.repo.toLowerCase() === key).map(treeView);
    const u = usage.get(key);
    const idle: Cell = sessionsWhy
      ? { kind: 'unread', why: sessionsWhy }
      : { kind: 'idle', why: '这一刻这个仓没有会话在跑' };
    return {
      repo,
      mirror,
      disk: repoDisk(mirror, trees),
      memory: u?.memory ?? idle,
      cpu: u?.cpu ?? idle,
      sessions: u?.sessions ?? 0,
      trees,
      held: trees.filter((t) => t.state === 'leftover' || t.state === 'kept' || t.state === 'unchecked')
        .length,
    };
  });
  const bytes = (r: RepoRow) => (r.disk.kind === 'ok' ? r.disk.bytes : -1);
  rows.sort((a, b) => bytes(b) - bytes(a) || a.repo.localeCompare(b.repo));
  if (inv.failed) return { kind: 'failed', why: inv.failed, takenAt: inv.takenAt, rows };
  return {
    kind: 'ok',
    rows,
    takenAt: inv.takenAt,
    trigger: inv.trigger,
    removed: inv.removed,
    unchecked: inv.unchecked,
  };
}

/** 一次清理此刻走到哪，给按钮旁边和结果区写的话。 */
export function cleanupWord(c: Worktrees['cleanups'][number]): { label: string; tone: StatusTone } {
  switch (c.status) {
    case 'queued':
      return { label: '排队中', tone: 'wait' };
    case 'running':
      return { label: '清理中', tone: 'run' };
    case 'done':
      return { label: '做完了', tone: 'done' };
    case 'failed':
      return { label: '没做成', tone: 'fail' };
    case 'expired':
      return { label: '没人接', tone: 'stop' };
  }
}
