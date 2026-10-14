// 对账：每条近期有回合的 Mirasim Claude 会话，Mirasim 设的路由、启动器每次拉起选的路由和网关处理、
// 账本里平台中继（viaRelay）的计数，三方对不上就标红。只读；只打会话 ID 前 8 位、时间、路由和计数，
// 不打请求内容、提示词、令牌或网关地址。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class AuditUnreadable extends Error {}

/** 本地时间到分钟：对账输出只要看得懂的时间。 */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface Launch {
  at: number;
  route: string;
  /** kept / stripped / none；旧版启动器不记时为 '?'。 */
  gateway: string;
}
export interface Turn {
  start: number;
  end: number;
}
export interface Ledger {
  at: number;
  relay: boolean;
}
export interface SessionAudit {
  sid: string;
  mirasimRoute: string;
  turns: number;
  lastTurn: number;
  launches: Record<string, number>;
  relay: number;
  direct: number;
  flags: string[];
}
export interface AuditReport {
  logStart?: number;
  sessions: SessionAudit[];
  /** 没有 startedAt、放不进时段的回合数。 */
  untimedTurns: number;
}

export function launchLogPath(home: string, platform: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(base, 'reclaude-mirasim', 'launch.log');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'reclaude-mirasim', 'launch.log');
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'reclaude-mirasim', 'launch.log');
}

function readText(file: string, label: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new AuditUnreadable(`${label}读不到：${file}`);
  }
}

function list(dir: string, label: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    throw new AuditUnreadable(`${label}读不到：${dir}`);
  }
}

function jsonLines(file: string, label: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readText(file, label).split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new AuditUnreadable(`${label}有坏行：${file}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new AuditUnreadable(`${label}有坏行：${file}`);
    out.push(value as Record<string, unknown>);
  }
  return out;
}

/** 启动器日志里的 event=launch 行，按会话分组；logStart 是日志里最早一行的时间（日志满 1MB 会清空重写）。 */
export function parseLaunchLog(text: string): { logStart?: number; launches: Map<string, Launch[]> } {
  const launches = new Map<string, Launch[]>();
  let logStart: number | undefined;
  for (const line of text.split('\n')) {
    const at = Date.parse(line.split(' ', 1)[0] ?? '');
    if (Number.isNaN(at)) continue;
    if (logStart === undefined || at < logStart) logStart = at;
    const m = / event=launch route=(\S+)(?: gateway=(\S+))? sid=(\S+)/.exec(line);
    if (!m) continue;
    const sid = m[3] as string;
    const rows = launches.get(sid) ?? [];
    rows.push({ at, route: m[1] as string, gateway: m[2] ?? '?' });
    launches.set(sid, rows);
  }
  for (const rows of launches.values()) rows.sort((a, b) => a.at - b.at);
  return { ...(logStart !== undefined ? { logStart } : {}), launches };
}

/** 这次拉起预期走哪份额度：gateway 词优先，旧日志没有时看路由。 */
export function expectedSource(l: Launch): 'platform' | 'own' | 'unknown' {
  if (l.gateway === 'kept') return 'platform';
  if (l.gateway === 'stripped') return 'own';
  if (l.route === 'cloud') return 'platform';
  if (l.route === 'local') return 'own';
  // 跟随全局、Mirasim 没给网关：经 reclaude 走自有。
  if (l.route === 'default' && l.gateway === 'none') return 'own';
  return 'unknown';
}

function mirasimRoutes(home: string): Map<string, string> {
  const dir = join(home, '.mirasim', 'plugin-index');
  const routes = new Map<string, string>();
  for (const name of list(dir, 'Mirasim 路由索引目录')) {
    if (!name.endsWith('.json') || name.endsWith('.queue.json') || name.endsWith('.deleted.json')) continue;
    let data: unknown;
    try {
      data = JSON.parse(readText(join(dir, name), 'Mirasim 路由索引'));
    } catch (error) {
      if (error instanceof AuditUnreadable) throw error;
      throw new AuditUnreadable(`Mirasim 路由索引不是 JSON：${name}`);
    }
    const r = (data as { routes?: unknown } | null)?.routes;
    if (r === undefined) continue;
    if (r === null || typeof r !== 'object' || Array.isArray(r))
      throw new AuditUnreadable(`Mirasim 路由索引的 routes 格式不认识：${name}`);
    for (const [key, value] of Object.entries(r)) {
      if (!key.startsWith('claude:') || typeof value !== 'string') continue;
      const sid = key.slice('claude:'.length);
      const seen = routes.get(sid);
      routes.set(sid, seen && seen !== value ? `${seen}/${value}` : value);
    }
  }
  return routes;
}

function turnsOf(home: string, sid: string, since: number): { turns: Turn[]; untimed: number } {
  const file = join(home, '.mirasim', 'sessions', 'claude', sid, 'turns.jsonl');
  if (!existsSync(file)) return { turns: [], untimed: 0 };
  const rows = jsonLines(file, 'Claude 回合记录');
  const turns: Turn[] = [];
  let untimed = 0;
  for (const row of rows) {
    if (typeof row.startedAt !== 'number') {
      if (typeof row.updatedAt === 'number' && row.updatedAt >= since) untimed++;
      continue;
    }
    if (row.startedAt < since) continue;
    const end =
      typeof row.updatedAt === 'number' && row.updatedAt >= row.startedAt ? row.updatedAt : row.startedAt;
    turns.push({ start: row.startedAt, end });
  }
  turns.sort((a, b) => a.start - b.start);
  return { turns, untimed };
}

function ledgerOf(home: string, sid: string, since: number): Ledger[] {
  const dir = join(home, '.mirasim', 'traffic', sid);
  if (!existsSync(dir)) return [];
  const out: Ledger[] = [];
  for (const name of list(dir, 'Mirasim 账本目录')) {
    if (!/^index-\d+\.ndjson$/.test(name)) continue;
    for (const row of jsonLines(join(dir, name), 'Mirasim 账本')) {
      if (typeof row.path !== 'string' || row.path.split('?')[0] !== '/v1/messages') continue;
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
      if (Number.isNaN(at) || typeof row.viaRelay !== 'boolean')
        throw new AuditUnreadable(`Mirasim 账本缺时间或来源字段：会话 ${sid.slice(0, 8)}`);
      if (at >= since) out.push({ at, relay: row.viaRelay });
    }
  }
  return out;
}

// 账本条目落在回合结束后几秒内也算这一回合（写账有延迟）。
const LEDGER_SLACK_MS = 5_000;

/** 对一条会话的回合逐个比：启动器当时的选择 vs 账本里的实际来源。 */
export function judgeSession(
  turns: Turn[],
  launches: Launch[],
  ledger: Ledger[],
  logStart: number | undefined,
): { flags: string[]; launchCounts: Record<string, number> } {
  const flags = new Set<string>();
  const launchCounts: Record<string, number> = {};
  for (const turn of turns) {
    // 回合开始后才拉起执行体也算这一回合的选择：取回合结束前最后一次 launch。
    let current: Launch | undefined;
    for (const l of launches) if (l.at <= turn.end) current = l;
    const inTurn = ledger.filter((e) => e.at >= turn.start && e.at <= turn.end + LEDGER_SLACK_MS);
    const relay = inTurn.filter((e) => e.relay).length;
    if (!current) {
      if (logStart !== undefined && turn.start >= logStart)
        flags.add('(c) 有回合但启动器没有拉起记录：启动器被绕过');
      continue;
    }
    const source = expectedSource(current);
    if (source === 'platform' && relay === 0) flags.add('(a) 启动器选了平台，回合里却没有平台中继账');
    if (source === 'own' && relay > 0) flags.add('(b) 启动器选了自有，账本里却有平台中继账');
  }
  for (const l of launches) {
    if (!turns.length) break;
    const first = turns[0] as Turn;
    const last = turns[turns.length - 1] as Turn;
    // 只数近期回合时段内（含第一回合前最近那次）的拉起。
    if (l.at > last.end) continue;
    const later = launches.find((x) => x.at > l.at);
    if (later && later.at <= first.start) continue;
    const key = `${l.route}/${l.gateway}`;
    launchCounts[key] = (launchCounts[key] ?? 0) + 1;
  }
  return { flags: [...flags], launchCounts };
}

export function audit(home: string, logFile: string, days: number, now = Date.now()): AuditReport {
  const since = now - days * 24 * 60 * 60_000;
  const { logStart, launches } = parseLaunchLog(readText(logFile, '启动器日志'));
  const routes = mirasimRoutes(home);
  const sessionsDir = join(home, '.mirasim', 'sessions', 'claude');
  const sessions: SessionAudit[] = [];
  let untimedTurns = 0;
  for (const sid of list(sessionsDir, 'Mirasim Claude 会话目录').sort()) {
    const { turns, untimed } = turnsOf(home, sid, since);
    untimedTurns += untimed;
    if (!turns.length) continue;
    const ledger = ledgerOf(home, sid, since);
    const judged = judgeSession(turns, launches.get(sid) ?? [], ledger, logStart);
    sessions.push({
      sid,
      mirasimRoute: routes.get(sid) ?? '默认',
      turns: turns.length,
      lastTurn: (turns[turns.length - 1] as Turn).start,
      launches: judged.launchCounts,
      relay: ledger.filter((e) => e.relay).length,
      direct: ledger.filter((e) => !e.relay).length,
      flags: judged.flags,
    });
  }
  sessions.sort((a, b) => b.lastTurn - a.lastTurn);
  return { ...(logStart !== undefined ? { logStart } : {}), sessions, untimedTurns };
}
