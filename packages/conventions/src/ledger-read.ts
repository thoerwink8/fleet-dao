// 本机读法国账本里的创始人引导收件箱（#3741 片 2c，决定 0122）：GET <法国地址>/api/nodes/events?after=&limit=，机器通行证放请求头
// X-Fleet-Node-Token，地址和通行证读法同 pnpm work claim（work.ts 的 readClaimsEndpoint）。零安装区引不了包：响应形状按 shared 的 intake.ts 手写。
// 收件箱 = 账本里 target 为 progress:<owner/name>、action 为 decision.handoff 的行（驾驶舱「要你拍」拍完写的），减去已被后来一条
// progress.note「已迁 <行id>」/「已处理 <行id>」认领掉的。只看最近 INBOX_DAYS 天。
// 读不到、回包认不出、翻页翻不动、翻太多页都抛 ProgressUnchecked（退出码 2），不当成「收件箱是空的」。
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

/** 按 id 往后翻页读完整本账（limit 用上限）。 */
export async function readAllLedgerEvents(get: LedgerEventsGet): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  let after = 0;
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

/** 认领标记：progress.note 的正文以「已迁 <行id>」或「已处理 <行id>」开头 */
const HANDLED_NOTE = /^\s*已(?:迁|处理)\s+(\d+)/;

const textOfAfter = (after: unknown): string => {
  const t = (after as { text?: unknown } | null)?.text;
  return typeof t === 'string' ? t : '';
};

/** 收件箱：最近 INBOX_DAYS 天里还没被认领的 decision.handoff（旧到新）。repo 是 owner/name，只看这个仓的账。 */
export async function ledgerInboxPending(
  repo: string,
  deps: { get: LedgerEventsGet; now?: () => Date },
): Promise<LedgerHandoff[]> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = now.getTime() - INBOX_DAYS * 86_400_000;
  const target = `progress:${repo}`;
  const rows = (await readAllLedgerEvents(deps.get)).filter((r) => r.ok && r.target === target);
  const handled = new Set<number>();
  for (const r of rows) {
    if (r.action !== NOTE_ACTION) continue;
    const m = HANDLED_NOTE.exec(textOfAfter(r.after));
    if (m?.[1]) handled.add(Number(m[1]));
  }
  const out: LedgerHandoff[] = [];
  for (const r of rows) {
    if (r.action !== HANDOFF_ACTION || handled.has(r.id)) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) throw new ProgressUnchecked(`法国账本行 ${r.id} 的时间认不出（${r.at}）。`);
    if (at < cutoff) continue;
    out.push({ id: r.id, at: r.at, text: textOfAfter(r.after) });
  }
  return out;
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
export async function readLedgerHandoff(
  id: number,
  repo: string,
  deps: { get: LedgerEventsGet; now?: () => Date },
): Promise<LedgerHandoff> {
  const found = (await ledgerInboxPending(repo, deps)).find((h) => h.id === id);
  if (!found)
    throw new ProgressRefused(
      `账本行 ${id} 不在 ${repo} 的待处理引导里（已迁、已处理、超过 ${INBOX_DAYS} 天，或不是 decision.handoff），没改。`,
    );
  return found;
}
