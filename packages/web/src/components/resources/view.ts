// 资源页（/resources，#1986）怎么把后端的读数写给人看：每个上线项目一行（CPU、内存、磁盘、放在哪）。
// 数据和主页同一份（HomeResources：5 秒随推送来；按目录的占用 10 分钟测一回、带着推），见 packages/api/src/host-resources.ts。
//
// 改这里之前必须知道：
// - 一格三种：读成了写数；没在跑写「没在占用」；读不到写「没读到」加原因。绝不拿 0 顶（仓的底线）。
// - CPU 写「忙的核数」（1 核 = 占满一个核，cgroup cpu.stat 两回的差 ÷ 墙钟）；只读到一回时写「采样中」，不写 0。
// - 磁盘按应用：它名下登记的目录 + 库（pg_database_size）相加。有目录读不全（权限、时限）时数是下限，写「不全」带棵数；
//   这一回没量成的目录用上次量成的旧数（带「旧数」缺口），名下一个目录都没读成写没读到；名下没登记目录写登记表里的补充（diskNote，例如「代码在发布版本目录里」）。
// - 老后端（没有 apps、footprint、disk 这几项）写明「后端没给」，选了远程环境写「那台没推」。
// - AI 会话按所属仓折成子行：主页数据里每张在跑的单有 runIds 和 repo，拿它到 sessions.byRun 里对；对不上单的（路由探针这类）归「别的会话」。
import { formatBytes, formatMb, type ResourceOptions } from '../home/resources';
import type { HomeResources, HomeRunning } from '../home/types';

export type Cell =
  | { kind: 'ok'; text: string; title?: string; tight?: boolean }
  | { kind: 'sampling'; why: string }
  | { kind: 'idle'; why?: string }
  /** 会话 scope 都还在、里面没进程（memory.current 是 0，#1992）：写「空 scope」，不写 0M / 0 核。 */
  | { kind: 'empty'; why: string }
  | { kind: 'none'; why: string }
  | { kind: 'unread'; why: string };

export type DiskCell =
  | { kind: 'ok'; text: string; bytes: number; gaps: Gaps; incomplete?: string }
  | { kind: 'pending'; why: string }
  | { kind: 'none'; why: string }
  | { kind: 'unread'; why: string };

type Apps = NonNullable<HomeResources['apps']>;
type HostApp = Extract<Apps, { state: 'ok' }>['items'][number];
type Footprint = NonNullable<HomeResources['footprint']>;

export interface AppRow {
  id: string;
  name: string;
  place: string;
  units: readonly string[];
  external: boolean;
  cpu: Cell;
  memory: Cell;
  disk: DiskCell;
  /** 这个应用名下的目录、库各多少（展开明细里列）。 */
  diskParts: DiskPart[];
  /** AI 会话按仓折的子行。 */
  children?: SubRow[];
}

export interface SubRow {
  key: string;
  name: string;
  sessions: number;
  /** 还在、但里面没进程的 scope 个数（#1992）：不算会话、不进合计，单独写出来好发现没回收的。 */
  emptyScopes: number;
  /** 排序用；读不到是 -1。 */
  memoryMb: number;
  cpu: Cell;
  memory: Cell;
}

export interface DiskPart {
  key: string;
  /** 目录路径，或「库 fleet」。 */
  label: string;
  /** 是目录（等宽字）还是库。 */
  kind: 'dir' | 'database';
  appId: string;
  /** 后端随这一项带来的应用名（老后端没有）。 */
  appName?: string;
  size: DiskCell;
}

/** 老后端、远程那台没推的原因：哪一项没有就写哪一项。 */
function notGiven(what: string, opts: ResourceOptions): string {
  return opts.remote
    ? `那台推来的读数里没有${what}（那台的版本还没有这一项）`
    : `后端没给${what}（后端的版本还没有这一项）`;
}

/** 忙的核数：一位小数，太小写两位，免得「0.0 核」看着像没在跑。 */
export function formatCores(cores: number): string {
  if (cores > 0 && cores < 0.005) return '<0.01 核';
  if (cores > 0 && cores < 0.05) return `${cores.toFixed(2)} 核`;
  return `${cores.toFixed(1)} 核`;
}

function cpuCell(cores: number | undefined, total: number | undefined): Cell {
  if (cores === undefined)
    return { kind: 'sampling', why: 'CPU 要两回读数的差才算得出，这个单元刚起来、还只有一回（下一回就有）' };
  return {
    kind: 'ok',
    text: formatCores(cores),
    ...(total === undefined ? {} : { title: `忙 ${formatCores(cores)}，整机 ${total} 核` }),
  };
}

/**
 * 定时任务（oneshot，跑完 cgroup 就没了，5 秒一采抓不到）：名下有单元在 footprint.timers 里就用 root 单元从 journal 数出来的
 * 近 24 小时账——CPU 写「近 24 小时平均 N 核（跑了 M 次）」、内存写「单次峰值」。读不到写原因，不当 0。没有定时任务数据时回 undefined。
 */
function timerCells(app: HostApp, footprint: Footprint | undefined): { cpu: Cell; memory: Cell } | undefined {
  if (footprint?.state !== 'ok' || !footprint.timers) return undefined;
  const mine = footprint.timers.filter((t) => app.units.includes(t.unit));
  if (mine.length === 0) return undefined;
  let runs = 0;
  let cpuSeconds = 0;
  let peak: number | null = 0;
  for (const t of mine) {
    if ('why' in t) {
      const why = `近 24 小时的账没读到（${t.unit}）：${t.why}`;
      return { cpu: { kind: 'unread', why }, memory: { kind: 'unread', why } };
    }
    runs += t.runs24h;
    cpuSeconds += t.cpuSeconds24h;
    peak = peak === null || t.peakMemoryBytes === null ? null : Math.max(peak, t.peakMemoryBytes);
  }
  const cores = cpuSeconds / 86400;
  return {
    cpu: {
      kind: 'ok',
      text: `近 24 小时平均 ${formatCores(cores)}（跑了 ${runs} 次）`,
      title: `近 24 小时共用 CPU ${Math.round(cpuSeconds)} 秒，跑了 ${runs} 次；定时任务跑完就没了，这是从系统日志里数的`,
    },
    memory:
      peak === null
        ? { kind: 'unread', why: '这台的 systemd 日志里没有内存峰值（版本旧），量不了单次峰值' }
        : { kind: 'ok', text: `单次峰值 ${formatBytes(peak)}`, title: '近 24 小时里单次跑到的最高内存' },
  };
}

function usageCells(app: HostApp, totalCores: number | undefined): { cpu: Cell; memory: Cell } {
  const u = app.usage;
  if (u.state === 'unread')
    return { cpu: { kind: 'unread', why: u.why }, memory: { kind: 'unread', why: u.why } };
  if (u.state === 'idle') {
    const idle: Cell = u.why === undefined ? { kind: 'idle' } : { kind: 'idle', why: u.why };
    return { cpu: idle, memory: idle };
  }
  const tight = u.memoryMaxMb !== undefined && u.memoryMb / u.memoryMaxMb >= 0.85;
  return {
    cpu: cpuCell(u.cpuCores, totalCores),
    memory: {
      kind: 'ok',
      text:
        u.memoryMaxMb === undefined
          ? formatMb(u.memoryMb)
          : `${formatMb(u.memoryMb)} / ${formatMb(u.memoryMaxMb)}`,
      title:
        u.memoryMaxMb === undefined
          ? `已用 ${formatMb(u.memoryMb)}（没设上限）`
          : `已用 ${formatMb(u.memoryMb)}，上限 ${formatMb(u.memoryMaxMb)}`,
      ...(tight ? { tight } : {}),
    },
  };
}

/** 读成了的磁盘数有哪些缺口：有缺口时数是下限。 */
export interface Gaps {
  /** 读不了的子树（权限、中途没了）。 */
  trees: number;
  /** 整个没读成的目录。 */
  dirs: number;
  /** 用的是上次量成的旧数的目录个数（这一回没量成）。 */
  stale: number;
  /** 库的大小没读成。 */
  databases: boolean;
}

/** 「不全：有 7 棵树没读到，有 1 个目录整个没读到」；没缺口是 undefined。 */
export function gapText(g: Gaps): string | undefined {
  const notes = [
    ...(g.trees ? [`有 ${g.trees} 棵树没读到`] : []),
    ...(g.dirs ? [`有 ${g.dirs} 个目录整个没读到`] : []),
    ...(g.stale ? [`有 ${g.stale} 个目录是上次量成的旧数`] : []),
    ...(g.databases ? ['库的大小没读成'] : []),
  ];
  return notes.length ? `不全：${notes.join('，')}` : undefined;
}

function okDisk(bytes: number, gaps: Gaps): DiskCell {
  const incomplete = gapText(gaps);
  return { kind: 'ok', text: formatBytes(bytes), bytes, gaps, ...(incomplete ? { incomplete } : {}) };
}

/** 按目录的占用里一项的格。 */
function sizeCell(
  size:
    | { state: 'ok'; bytes: number; unreadTrees?: number | undefined; stale?: { why: string } | undefined }
    | { state: 'unread'; why: string },
): DiskCell {
  if (size.state === 'unread') return { kind: 'unread', why: size.why };
  return okDisk(size.bytes, {
    trees: size.unreadTrees ?? 0,
    dirs: 0,
    stale: size.stale ? 1 : 0,
    databases: false,
  });
}

/** 磁盘占用的每一项（目录 + 库），没排序。 */
export function diskParts(footprint: Footprint | undefined): DiskPart[] {
  if (footprint?.state !== 'ok') return [];
  const dirs: DiskPart[] = footprint.dirs.map((d) => ({
    key: `dir:${d.path}`,
    label: d.path,
    kind: 'dir',
    appId: d.appId,
    ...(d.appName ? { appName: d.appName } : {}),
    size: sizeCell(d.size),
  }));
  const dbs: DiskPart[] =
    footprint.databases.state === 'ok'
      ? footprint.databases.items.map((d) => ({
          key: `db:${d.name}`,
          label: `库 ${d.name}`,
          kind: 'database',
          appId: d.appId,
          ...(d.appName ? { appName: d.appName } : {}),
          size: sizeCell(d.size),
        }))
      : [];
  return [...dirs, ...dbs];
}

/** 一个应用的磁盘：名下各项相加。 */
function appDisk(
  app: HostApp,
  footprint: Footprint | undefined,
  parts: DiskPart[],
  opts: ResourceOptions,
): DiskCell {
  if (!footprint) return { kind: 'unread', why: notGiven('按目录的磁盘占用', opts) };
  if (footprint.state === 'pending') return { kind: 'pending', why: footprint.why };
  if (footprint.state === 'unread') return { kind: 'unread', why: footprint.why };
  // 库整块没读成：名下记着库的应用（数据库）就少了库那一截
  const dbMissing =
    footprint.databases.state === 'unread' && app.id === 'postgres' ? footprint.databases.why : undefined;
  if (parts.length === 0) {
    if (dbMissing) return { kind: 'unread', why: `库的大小没读成：${dbMissing}` };
    return { kind: 'none', why: app.diskNote ?? '名下没登记目录' };
  }
  const gaps: Gaps = { trees: 0, dirs: 0, stale: 0, databases: dbMissing !== undefined };
  let bytes = 0;
  let readable = 0;
  for (const p of parts) {
    if (p.size.kind !== 'ok') {
      gaps.dirs += 1;
      continue;
    }
    readable += 1;
    bytes += p.size.bytes;
    gaps.trees += p.size.gaps.trees;
    gaps.stale += p.size.gaps.stale;
  }
  if (readable === 0) {
    const first = parts.find((p) => p.size.kind === 'unread');
    return { kind: 'unread', why: first?.size.kind === 'unread' ? first.size.why : '名下的目录一个都没读成' };
  }
  return okDisk(bytes, gaps);
}

/** AI 会话按仓折的子行：在跑的单按仓归，会话编号对上 sessions.byRun；对不上单的归「别的会话」。 */
export function sessionChildren(
  resources: HomeResources,
  running: readonly HomeRunning[],
): SubRow[] | undefined {
  if (resources.sessions.state !== 'ok') return undefined;
  const byRun = resources.sessions.byRun;
  const claimed = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const item of running) {
    for (const id of item.runIds ?? []) {
      if (!byRun[id]) continue;
      claimed.add(id);
      groups.set(item.repo, [...(groups.get(item.repo) ?? []), id]);
    }
  }
  const others = Object.keys(byRun).filter((id) => !claimed.has(id));
  if (others.length) groups.set('', others);
  const rows: SubRow[] = [];
  for (const [repo, ids] of groups) {
    let mem = 0;
    let cpu: number | undefined = 0;
    let unread: string | undefined;
    let live = 0;
    let emptyWhy: string | undefined;
    let emptyScopes = 0;
    for (const id of ids) {
      const u = byRun[id];
      if (!u) continue;
      if (u.state === 'unread') {
        unread = u.why;
        break;
      }
      // 空 scope（里面没进程）不算会话、不进合计（#1992）
      if (u.state === 'empty') {
        emptyWhy ??= u.why;
        emptyScopes += 1;
        continue;
      }
      live += 1;
      mem += u.memoryMb;
      cpu = cpu === undefined || u.cpuPercent === undefined ? undefined : cpu + u.cpuPercent;
    }
    if (!unread && live === 0 && emptyWhy !== undefined) {
      const empty: Cell = { kind: 'empty', why: emptyWhy };
      rows.push({
        key: repo || '_other',
        name: repo || '别的会话（路由探针、对不上单的）',
        sessions: 0,
        emptyScopes,
        memoryMb: -1,
        memory: empty,
        cpu: empty,
      });
      continue;
    }
    rows.push({
      key: repo || '_other',
      name: repo || '别的会话（路由探针、对不上单的）',
      sessions: unread ? ids.length : live,
      emptyScopes: unread ? 0 : emptyScopes,
      memoryMb: unread ? -1 : mem,
      memory: unread ? { kind: 'unread', why: unread } : { kind: 'ok', text: formatMb(mem) },
      cpu: unread
        ? { kind: 'unread', why: unread }
        : cpu === undefined
          ? { kind: 'sampling', why: '有会话刚起来、还只有一回读数（下一回就有）' }
          : { kind: 'ok', text: formatCores(cpu / 100) },
    });
  }
  // 占得多的仓排前面，「别的会话」压在最后
  return rows.sort((a, b) => (a.key === '_other' ? 1 : b.key === '_other' ? -1 : b.memoryMb - a.memoryMb));
}

export type AppRowsResult = { kind: 'ok'; rows: AppRow[] } | { kind: 'unread'; why: string };

/** 每个上线项目一行，按后端登记表的先后（本仓的在前，别家的在后）。 */
export function appRows(
  resources: HomeResources | undefined,
  running: readonly HomeRunning[],
  opts: ResourceOptions = {},
): AppRowsResult {
  if (!resources) {
    return {
      kind: 'unread',
      why: opts.remote ? '那台没推过资源读数（那台的版本还没有这一项）' : '这台后端没给资源读数',
    };
  }
  const apps = resources.apps;
  if (!apps) return { kind: 'unread', why: notGiven('每个上线项目的占用', opts) };
  if (apps.state === 'unread') return { kind: 'unread', why: apps.why };
  const totalCores = resources.cpu.state === 'ok' ? resources.cpu.cores : undefined;
  const parts = diskParts(resources.footprint);
  const rows = apps.items.map((app): AppRow => {
    const mine = parts.filter((p) => p.appId === app.id);
    const children =
      app.id === 'sessions' && app.usage.state === 'ok' ? sessionChildren(resources, running) : undefined;
    return {
      id: app.id,
      name: app.name,
      place: app.place,
      units: app.units,
      external: app.external === true,
      ...(timerCells(app, resources.footprint) ?? usageCells(app, totalCores)),
      disk: appDisk(app, resources.footprint, mine, opts),
      diskParts: mine,
      ...(children?.length ? { children } : {}),
    };
  });
  return {
    kind: 'ok',
    rows: [...rows.filter((r) => !r.external), ...rows.filter((r) => r.external)],
  };
}
