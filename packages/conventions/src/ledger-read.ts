// 本机读法国账本里的创始人引导收件箱（#3741 片 2c，决定 0122）：GET <法国地址>/api/nodes/events?after=&limit=，机器通行证放请求头
// X-Fleet-Node-Token，地址和通行证读法同 pnpm work claim（work.ts 的 readClaimsEndpoint）。零安装区引不了包：响应形状按 shared 的 intake.ts 手写。
// 收件箱 = 账本里 target 为 progress:<owner/name>、action 为 decision.handoff 的行（驾驶舱「要你拍」拍完写的），减去已被后来一条
// progress.note「已迁 <行id>」/「已处理 <行id>」认领掉的。只看最近 INBOX_DAYS 天。
// 读不到、回包认不出、翻页翻不动、翻太多页都抛 ProgressUnchecked（退出码 2），不当成「收件箱是空的」。
// 增量：账本只追加，本机在 ~/.fleet-dao/ledger-inbox.json 按仓存 cursor（上次读到的最后一行 id）和 pending，
// 每次只请求 cursor 之后的新行；没有状态文件才从 0 读一次全量，文件坏了当不存在重建（打一行说明）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { INBOX_DAYS, ProgressRefused, ProgressUnchecked } from './progress.ts';
import { type ClaimsEndpoint, readClaimsEndpoint } from './work.ts';

export const LEDGER_EVENTS_URL_PATH = '/api/nodes/events';
const TOKEN_HEADER = 'X-Fleet-Node-Token';
const GET_TIMEOUT_MS = 15_000;
/** 法国读口的单页上限（shared 的 INTAKE_EVENTS_MAX_LIMIT），超过它法国也按它给 */
export const LEDGER_PAGE = 500;
/** 最多翻这么多页（25 万行）；到了照实报没读全 */
export const LEDGER_PAGES_MAX = 500;
export const HANDOFF_ACTION = 'decision.handoff';
export const NOTE_ACTION = 'progress.note';
/** 创始人引导（pnpm progress directive 写的，#3764，决定 0123）：target 是 issue:<owner/name>#<挂的单> */
export const DIRECTIVE_ACTION = 'directive';

export interface LedgerEvent {
  id: number;
  at: string;
  actorKind: string;
  actorId: string;
  action: string;
  target: string;
  after: unknown;
  ok: boolean;
}

export type LedgerEventsGet = (q: {
  after: number;
  limit: number;
}) => Promise<{ status: number; text: string }>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string, max = 200) => s.trim().replace(/\s+/g, ' ').slice(0, max);

/** 真读；读不到地址或通行证、超时、断连都抛带原因的错（通行证不进错误信息）。 */
export function liveLedgerEventsGet(
  endpoint: () => ClaimsEndpoint = readClaimsEndpoint,
  fetchImpl: typeof fetch = fetch,
): LedgerEventsGet {
  return async ({ after, limit }) => {
    const { url, token } = endpoint();
    try {
      const res = await fetchImpl(
        `${url.replace(/\/+$/, '')}${LEDGER_EVENTS_URL_PATH}?after=${after}&limit=${limit}`,
        { method: 'GET', headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(GET_TIMEOUT_MS) },
      );
      return { status: res.status, text: await res.text() };
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`${GET_TIMEOUT_MS / 1000} 秒内没回（超时）`);
      }
      throw new Error(msg(e).replaceAll(token, '***'));
    }
  };
}

function parseEvent(raw: unknown): LedgerEvent {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (
    typeof o.id !== 'number' ||
    !Number.isInteger(o.id) ||
    typeof o.at !== 'string' ||
    typeof o.action !== 'string' ||
    typeof o.target !== 'string' ||
    typeof o.ok !== 'boolean'
  )
    throw new ProgressUnchecked('法国账本读回来的行认不出（没有 id、at、action、target、ok）。');
  return {
    id: o.id,
    at: o.at,
    actorKind: typeof o.actorKind === 'string' ? o.actorKind : '',
    actorId: typeof o.actorId === 'string' ? o.actorId : '',
    action: o.action,
    target: o.target,
    after: o.after,
    ok: o.ok,
  };
}

/** 从 after 往后读一页；失败一律 ProgressUnchecked。 */
async function readPage(get: LedgerEventsGet, after: number, limit: number): Promise<LedgerEvent[]> {
  let res: { status: number; text: string };
  try {
    res = await get({ after, limit });
  } catch (e) {
    throw new ProgressUnchecked(`读法国账本没成：${oneLine(msg(e))}。`);
  }
  if (res.status !== 200)
    throw new ProgressUnchecked(`读法国账本没成：HTTP ${res.status} ${oneLine(res.text)}`.trim());
  let j: unknown;
  try {
    j = JSON.parse(res.text);
  } catch {
    throw new ProgressUnchecked(`读法国账本：回包不是 JSON（${oneLine(res.text, 80) || '空'}）。`);
  }
  const events = (j as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new ProgressUnchecked('读法国账本：回包里没有 events 列表。');
  const rows = events.map(parseEvent);
  let last = after;
  for (const r of rows) {
    if (r.id <= last) throw new ProgressUnchecked('读法国账本：行 id 不是递增的，翻页认不了。');
    last = r.id;
  }
  return rows;
}

/** 从 from（不含）按 id 往后翻页读到头（limit 用上限）；不给 from 就从 0 读整本账。 */
export async function readAllLedgerEvents(get: LedgerEventsGet, from = 0): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  let after = from;
  for (let page = 0; page < LEDGER_PAGES_MAX; page += 1) {
    const rows = await readPage(get, after, LEDGER_PAGE);
    out.push(...rows);
    const last = rows.at(-1);
    if (rows.length < LEDGER_PAGE || last === undefined) return out;
    after = last.id;
  }
  throw new ProgressUnchecked(
    `法国账本超过 ${LEDGER_PAGE * LEDGER_PAGES_MAX} 行，没读全：没法说收件箱里有没有待处理的引导。`,
  );
}

/** 账本里一条待处理的创始人引导（驾驶舱「要你拍」拍完写的 decision.handoff）。 */
export interface LedgerHandoff {
  /** 账本行 id */
  id: number;
  /** 行落库时刻（ISO） */
  at: string;
  text: string;
}

/** 账本里一条创始人引导（action directive）。办没办完不在账本里：看挂的 issue 开着没有。 */
export interface LedgerDirective {
  /** 账本行 id */
  id: number;
  /** 行落库时刻（ISO） */
  at: string;
  /** 挂的单 */
  issue: number;
  /** 原话（对外仓这里是意思）；只在本机输出，不进仓内文件 */
  text: string;
  /** 不带原话的意思 */
  meaning: string;
  category: string;
  owner: string;
  /** 他说话的时刻（北京时间 YYYY-MM-DD HH:mm +0800）；老行没有给空 */
  spokenAt: string;
}
/** 状态文件里最多留多少条引导（只留尾部，防文件无限长；周报不靠它，读整本账） */
export const DIRECTIVES_KEEP = 2000;

/** 认领标记：progress.note 的正文以「已迁 <行id>」或「已处理 <行id>」开头 */
const HANDLED_NOTE = /^\s*已(?:迁|处理)\s+(\d+)/;

const textOfAfter = (after: unknown): string => {
  const t = (after as { text?: unknown } | null)?.text;
  return typeof t === 'string' ? t : '';
};

/**
 * 增量状态（只追加的账本只读上次之后的新行）：cursor＝上次读到的最后一行 id，pending＝还没被认领的引导，
 * cleared＝最近认领掉的行 id（只留尾部，防文件无限长）。按仓分键存在一个文件里。
 */
export interface InboxState {
  cursor: number;
  pending: LedgerHandoff[];
  cleared: number[];
  /** 账本里的创始人引导（#3764）；老状态文件没有这个字段，当空 */
  directives?: LedgerDirective[];
}
export const CLEARED_KEEP = 200;
export const inboxStatePath = (home = homedir()): string => join(home, '.fleet-dao', 'ledger-inbox.json');

const isHandoff = (v: unknown): v is LedgerHandoff => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.id === 'number' &&
    typeof o.at === 'string' &&
    typeof o.text === 'string'
  );
};
const isDirective = (v: unknown): v is LedgerDirective => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.id === 'number' &&
    typeof o.at === 'string' &&
    typeof o.issue === 'number' &&
    typeof o.text === 'string' &&
    typeof o.meaning === 'string' &&
    typeof o.category === 'string' &&
    typeof o.owner === 'string' &&
    typeof o.spokenAt === 'string'
  );
};
const isState = (v: unknown): v is InboxState => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.cursor === 'number' &&
    Number.isInteger(o.cursor) &&
    o.cursor >= 0 &&
    Array.isArray(o.pending) &&
    o.pending.every(isHandoff) &&
    Array.isArray(o.cleared) &&
    o.cleared.every((n) => typeof n === 'number') &&
    (o.directives === undefined || (Array.isArray(o.directives) && o.directives.every(isDirective)))
  );
};

/** 账本行 → 引导；挂的单从 target（issue:<repo>#<号>）读，认不出的不是这个仓的引导，给 null */
export function directiveOfEvent(r: LedgerEvent, repo: string): LedgerDirective | null {
  if (!r.ok || r.action !== DIRECTIVE_ACTION) return null;
  const m = /^issue:(.+)#([1-9]\d*)$/.exec(r.target);
  if (!m || m[1]?.toLowerCase() !== repo.toLowerCase()) return null;
  const a = (r.after ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  if (!Number.isFinite(Date.parse(r.at)))
    throw new ProgressUnchecked(`法国账本行 ${r.id} 的时间认不出（${r.at}）。`);
  return {
    id: r.id,
    at: r.at,
    issue: Number(m[2]),
    text: str('text'),
    meaning: str('meaning'),
    category: str('category'),
    owner: str('owner') || '无主',
    spokenAt: str('spokenAt'),
  };
}

/** 读状态文件：不存在 → 空（新机器）；解析不了或形状不对 → 空并说一行（当不存在重建）。 */
function loadAll(file: string, warn: (l: string) => void): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'ENOENT') return {};
    warn(`收件箱状态文件 ${file} 读不了（${msg(e)}），从头读账本重建。`);
    return {};
  }
  try {
    const j = JSON.parse(text) as unknown;
    if (typeof j === 'object' && j !== null && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    // 落到下面
  }
  warn(`收件箱状态文件 ${file} 坏了（解析不了），丢掉并从头读账本重建。`);
  return {};
}

/** 临时文件加改名，防半截；写不成只警告（下次多读一点而已，不挡这次的结果）。 */
function saveAll(file: string, all: Record<string, unknown>, warn: (l: string) => void): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(all)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    warn(`收件箱状态文件 ${file} 没写成（${msg(e)}）；下次会多读一段账本。`);
  }
}

export interface InboxDeps {
  get: LedgerEventsGet;
  now?: () => Date;
  /** 状态文件路径；不给就不存档，每次从 0 读（测试、一次性用）。 */
  stateFile?: string;
  warn?: (line: string) => void;
}

/**
 * 收件箱：最近 INBOX_DAYS 天里还没被认领的 decision.handoff（旧到新）。repo 是 owner/name，只看这个仓的账。
 * 给了 stateFile 就增量：只请求 cursor 之后的新行，更新 pending，最后写回；没有状态才从 0 读一次全量。
 * 读不到抛 ProgressUnchecked，状态文件原样不动。
 */
export async function ledgerInboxPending(repo: string, deps: InboxDeps): Promise<LedgerHandoff[]> {
  return (await ledgerSync(repo, deps)).handoffs;
}

/** 账本里这个仓记过的全部创始人引导（旧到新），同一次增量读带出来；办没办完由调用方看挂的单。 */
export async function ledgerDirectives(repo: string, deps: InboxDeps): Promise<LedgerDirective[]> {
  return (await ledgerSync(repo, deps)).directives;
}

/** 一趟增量读同时更新收件箱和引导两份（共用 cursor 和状态文件）。 */
export async function ledgerSync(
  repo: string,
  deps: InboxDeps,
): Promise<{ handoffs: LedgerHandoff[]; directives: LedgerDirective[] }> {
  const warn = deps.warn ?? ((l: string) => console.error(l));
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = now.getTime() - INBOX_DAYS * 86_400_000;
  const target = `progress:${repo}`;
  const all = deps.stateFile ? loadAll(deps.stateFile, warn) : {};
  const saved = all[repo];
  const state: InboxState = isState(saved)
    ? {
        cursor: saved.cursor,
        pending: [...saved.pending],
        cleared: [...saved.cleared],
        directives: [...(saved.directives ?? [])],
      }
    : { cursor: 0, pending: [], cleared: [], directives: [] };
  const directives = new Map((state.directives ?? []).map((d) => [d.id, d]));
  if (saved !== undefined && !isState(saved))
    warn(`收件箱状态文件里 ${repo} 那段认不出，丢掉并从头读账本重建。`);
  const events = await readAllLedgerEvents(deps.get, state.cursor);
  const byId = new Map(state.pending.map((h) => [h.id, h]));
  const cleared = new Set(state.cleared);
  for (const r of events) {
    const dir = directiveOfEvent(r, repo);
    if (dir) {
      directives.set(dir.id, dir);
      continue;
    }
    if (!r.ok || r.target !== target) continue;
    if (r.action === NOTE_ACTION) {
      const m = HANDLED_NOTE.exec(textOfAfter(r.after));
      if (m?.[1]) {
        byId.delete(Number(m[1]));
        cleared.add(Number(m[1]));
      }
    } else if (r.action === HANDOFF_ACTION && !cleared.has(r.id)) {
      if (!Number.isFinite(Date.parse(r.at)))
        throw new ProgressUnchecked(`法国账本行 ${r.id} 的时间认不出（${r.at}）。`);
      byId.set(r.id, { id: r.id, at: r.at, text: textOfAfter(r.after) });
    }
  }
  const pending = [...byId.values()].filter((h) => Date.parse(h.at) >= cutoff).sort((a, b) => a.id - b.id);
  const last = events.at(-1);
  const allDirectives = [...directives.values()].sort((a, b) => a.id - b.id);
  if (deps.stateFile) {
    const next: InboxState = {
      cursor: last?.id ?? state.cursor,
      pending,
      cleared: [...cleared].slice(-CLEARED_KEEP),
      directives: allDirectives.slice(-DIRECTIVES_KEEP),
    };
    saveAll(deps.stateFile, { ...all, [repo]: next }, warn);
  }
  return { handoffs: pending, directives: allDirectives };
}

/**
 * --from-inbox 的编号：账本行 id（正整数）。旧的 #1055 评论号是 10 位数，明确拒绝并给新用法，不拿去账本里碰运气。
 */
export function parseInboxId(raw: string): number {
  const s = raw.trim();
  if (/^\d{10,}$/.test(s))
    throw new ProgressRefused(
      `--from-inbox ${s} 是旧的 #1055 评论号，收件箱已改读法国账本。用 pnpm progress read --pending 第一列的账本行编号：pnpm progress directive --kind <类> --from-inbox <账本行编号>。`,
    );
  if (!/^[1-9]\d*$/.test(s)) throw new ProgressRefused(`--from-inbox ${raw} 不对，要账本行编号（正整数）。`);
  return Number(s);
}

/** 读收件箱里的一条（编号是账本行 id）；不在待处理里（已迁、已处理、超过 30 天、不是引导）的拒绝。 */
export async function readLedgerHandoff(id: number, repo: string, deps: InboxDeps): Promise<LedgerHandoff> {
  const found = (await ledgerInboxPending(repo, deps)).find((h) => h.id === id);
  if (!found)
    throw new ProgressRefused(
      `账本行 ${id} 不在 ${repo} 的待处理引导里（已迁、已处理、超过 ${INBOX_DAYS} 天，或不是 decision.handoff），没改。`,
    );
  return found;
}
