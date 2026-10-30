// 本机往法国账本记一条过程（#3741 片 2b，决定 0122）：POST <法国地址>/api/nodes/notes，机器通行证放请求头 X-Fleet-Node-Token，
// 地址和通行证读法同 pnpm work claim（work.ts 的 readClaimsEndpoint）。零安装区引不了包：请求形状按片 2a 的 shared schema 手写。
// 双写期：#1055 照旧写，账本只是多写一份；账本这边**从不抛**，写不成回 { ok: false, why }，调用方只警告、不挡 #1055。
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { type ProgressComment, type ProgressDeps, progressNote, stamp } from './progress.ts';
import { type ClaimsEndpoint, readClaimsEndpoint } from './work.ts';

export const LEDGER_NOTES_URL_PATH = '/api/nodes/notes';
const TOKEN_HEADER = 'X-Fleet-Node-Token';
const POST_TIMEOUT_MS = 15_000;

export interface LedgerNoteBody {
  kind: 'progress.note' | 'decision.handoff' | 'report.daily' | 'report.guards';
  repo: string;
  issue?: number;
  text: string;
  source: { kind: 'local-session'; ref: string };
  idempotencyKey: string;
}

export type LedgerNoteResult = { ok: true; id: number; created: boolean } | { ok: false; why: string };

export type LedgerNotePost = (body: LedgerNoteBody) => Promise<{ status: number; text: string }>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string, max = 300) => s.trim().replace(/\s+/g, ' ').slice(0, max);

/** 真发；读不到地址或通行证、超时、断连都抛带原因的错（通行证不进错误信息）。 */
export function liveLedgerNotePost(
  endpoint: () => ClaimsEndpoint = readClaimsEndpoint,
  fetchImpl: typeof fetch = fetch,
): LedgerNotePost {
  return async (body) => {
    const { url, token } = endpoint();
    try {
      const res = await fetchImpl(`${url.replace(/\/+$/, '')}${LEDGER_NOTES_URL_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`${POST_TIMEOUT_MS / 1000} 秒内没回（超时）`);
      }
      throw new Error(msg(e).replaceAll(token, '***'));
    }
  };
}

/** 发一次，把回包认成结果；任何失败都回 { ok: false, why }，不抛。 */
export async function postLedgerNote(post: LedgerNotePost, body: LedgerNoteBody): Promise<LedgerNoteResult> {
  let res: { status: number; text: string };
  try {
    res = await post(body);
  } catch (e) {
    return { ok: false, why: oneLine(msg(e), 200) };
  }
  if (res.status !== 200) return { ok: false, why: `HTTP ${res.status} ${oneLine(res.text, 200)}`.trim() };
  try {
    const j = JSON.parse(res.text) as { id?: unknown; created?: unknown };
    if (typeof j.id === 'number' && typeof j.created === 'boolean') {
      return { ok: true, id: j.id, created: j.created };
    }
  } catch {
    // 落到下面
  }
  return { ok: false, why: `回包认不出：${oneLine(res.text, 200) || '（空）'}` };
}

/** 重放得到同一个 key：正文摘要 + 分钟（同一分钟里重跑同一句不重复）。 */
export function noteIdempotencyKey(prefix: string, text: string, now: Date): string {
  const digest = createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
  return `${prefix}:${stamp(now).replace(/\D/g, '')}-${digest}`;
}

/**
 * 双写一条进度：先写账本（写不成只警告），再照旧贴 #1055（它的拒绝、没贴成照旧抛）。
 * repo 为 undefined（认不出本仓）时账本那份跳过并警告。空正文不写账本，交给 progressNote 拒绝。
 */
export async function progressNoteWithLedger(
  text: string,
  deps: ProgressDeps,
  ledger: {
    repo: string | undefined;
    kind: 'progress.note' | 'report.guards';
    idempotencyKey: string;
    post?: LedgerNotePost;
    warn?: (line: string) => void;
  },
): Promise<ProgressComment> {
  const t = text.trim();
  if (t) {
    if (ledger.repo) {
      await writeLedgerNote(
        { repo: ledger.repo, ...(ledger.post ? { post: ledger.post } : {}), ...(ledger.warn ? { warn: ledger.warn } : {}) },
        { kind: ledger.kind, text: t, idempotencyKey: ledger.idempotencyKey },
      );
    } else {
      (ledger.warn ?? ((l: string) => console.error(l)))(
        `警告：${ledger.kind} 没写进法国账本（认不出本仓 owner/name）；#1055 照写，不挡。`,
      );
    }
  }
  return progressNote(text, deps);
}

export interface LedgerNoteWiring {
  repo: string;
  post?: LedgerNotePost;
  warn?: (line: string) => void;
  /** 本机会话号；拿不到时机器名。 */
  ref?: string;
}

/** 双写的账本那一半：写不成只警告（照实打出原因），永远不抛。 */
export async function writeLedgerNote(
  w: LedgerNoteWiring,
  note: Omit<LedgerNoteBody, 'repo' | 'source'>,
): Promise<LedgerNoteResult> {
  const warn = w.warn ?? ((line: string) => console.error(line));
  const body: LedgerNoteBody = {
    ...note,
    repo: w.repo,
    source: { kind: 'local-session', ref: w.ref || process.env.CLAUDE_CODE_SESSION_ID?.trim() || hostname() },
  };
  let result: LedgerNoteResult;
  try {
    result = await postLedgerNote(w.post ?? liveLedgerNotePost(), body);
  } catch (e) {
    result = { ok: false, why: oneLine(msg(e), 200) };
  }
  if (!result.ok) warn(`警告：${note.kind} 没写进法国账本（${result.why}）；#1055 照写，不挡。`);
  return result;
}
