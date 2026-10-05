// reclaude 开放接口的「原样读数」（#194 方案 v2 4.1、4.4，第六节第 1、2、3、18 条）：和 reclaude.ts（把拼车额度读成额度表里的窗口）
// 读的是同两个接口（GET /api/v1/carpool/quota、GET /api/v1/orgs），但这里给切号用：多带回包头 Date、Age（判「是不是缓存的旧读数」）、
// 每个组织一个账号（账号数量不固定，切号前逐个查状态）。账号级的 Key：挂着独享时照样读得到拼车。只读 GET，不起 Claude Code、不花额度。
//
// 改这里之前必须知道：
// - 读不到、认不出一律明确失败（ok: false 带 code 和白话原因），不当成「额度没用」或「账号可用」：
//   network 网断超时；http 5xx 等；auth Key 失效或没有 Key（401/403 或 Key 文件认不出）；bad_response 回包认不出；throttled 接口自己限流（429）。
// - 组织编号、名字、邮箱一律不往外带：账号只给 `<类型>-<序号>` 的占位编号（它会进库、上驾驶舱）。
// - 额度接口是主数；组织接口读不成时额度照给、orgs 标 ok:false（不拿「没读到组织」冒充「没有组织」）。
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, redact, toIso } from '../util.ts';
import { DEFAULT_RECLAUDE_BASE_URL } from './reclaude.ts';

const KEY_SHAPE = /^rck_[A-Za-z0-9_-]{20,}$/;
const MAX_BODY = 4 * 1024 * 1024;

export interface ReclaudeQuotaRead {
  usedUsd: number;
  limitUsd: number;
  resetsAt: Date | null;
  /** 上游原字（status / state）；没给为 null。 */
  status: string | null;
}

export interface ReclaudeOrgRead {
  /** `<类型>-<序号>` 的占位编号，不是接口的组织编号。 */
  id: string;
  kind: 'carpool' | 'solo' | 'other';
  /** 回包里没给或不是布尔：null。 */
  hasAssignedAccount: boolean | null;
  expiresAt: Date | null;
}

export type ReclaudeApiRead =
  | {
      ok: true;
      requestedAt: Date;
      serverDate: Date | null;
      ageSeconds: number | null;
      /** null = 上游明说这个成员没设上限（enabled: false）。 */
      quota: ReclaudeQuotaRead | null;
      orgs: { ok: true; accounts: ReclaudeOrgRead[] } | { ok: false; code: ReclaudeApiCode; why: string };
    }
  | { ok: false; requestedAt: Date; code: ReclaudeApiCode; why: string };

export type ReclaudeApiCode = 'network' | 'http' | 'auth' | 'bad_response' | 'throttled';

export interface ReclaudeApiConfig {
  keyFile: string;
  baseUrl?: string;
}

export interface ReclaudeApiIo {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  homeDir: string;
  now: () => Date;
  /** 整次读（两个接口）最多等多久（毫秒）。 */
  timeoutMs: number;
}

class ApiFail extends Error {
  readonly code: ReclaudeApiCode;
  constructor(code: ReclaudeApiCode, why: string) {
    super(why);
    this.code = code;
  }
}

interface Reply {
  body: unknown;
  serverDate: Date | null;
  ageSeconds: number | null;
}

async function get(io: ApiReadCtx, path: string): Promise<Reply> {
  let res: Response;
  try {
    res = await io.fetch(`${io.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${io.key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: io.signal,
    });
  } catch (e) {
    throw new ApiFail(
      'network',
      io.signal.aborted ? `${path} 超时` : `${path} 连不上：${redact(String((e as Error)?.message ?? e))}`,
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new ApiFail(
      'network',
      io.signal.aborted
        ? `${path} 超时`
        : `${path} 回包没收完：${redact(String((e as Error)?.message ?? e))}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiFail(
      'auth',
      `${path} 登录失效（HTTP ${res.status}）：在 reclaude 网页「设置 → API Key」重新生成，换掉 Key 文件里那把`,
    );
  }
  if (res.status === 429) throw new ApiFail('throttled', `${path} 被限流（HTTP 429）`);
  if (!res.ok) throw new ApiFail('http', `${path} 回 HTTP ${res.status}：${redact(text)}`);
  if (text.length > MAX_BODY) throw new ApiFail('bad_response', `${path} 回包太大`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiFail('bad_response', `${path} 回包不是 JSON`);
  }
  const dateHeader = res.headers.get('date');
  const parsedDate = dateHeader ? new Date(dateHeader) : null;
  const ageHeader = res.headers.get('age');
  const age = ageHeader !== null && /^\d+$/.test(ageHeader.trim()) ? Number(ageHeader.trim()) : null;
  return {
    body,
    serverDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    ageSeconds: age,
  };
}

interface ApiReadCtx {
  fetch: typeof fetch;
  baseUrl: string;
  key: string;
  signal: AbortSignal;
}

/** 额度回包 → 本人额度。enabled 缺、金额认不出一律 bad_response，不填 0。 */
export function parseCarpoolQuota(body: unknown): ReclaudeQuotaRead | null {
  if (!isRecord(body)) throw new ApiFail('bad_response', 'reclaude 拼车额度回包不是对象');
  if (typeof body.enabled !== 'boolean') {
    throw new ApiFail('bad_response', 'reclaude 拼车额度回包里没有 enabled，认不出开没开上限');
  }
  if (!body.enabled) return null;
  const limit = num(body.quota_usd);
  const used = num(body.used_usd);
  if (limit === undefined || used === undefined || !(limit > 0)) {
    throw new ApiFail(
      'bad_response',
      `reclaude 拼车额度的金额认不出（quota_usd=${String(body.quota_usd)}、used_usd=${String(body.used_usd)}）`,
    );
  }
  const resets = toIso(body.resets_at_ms);
  const rawStatus = body.status ?? body.state;
  return {
    usedUsd: used,
    limitUsd: limit,
    resetsAt: resets ? new Date(resets) : null,
    status: typeof rawStatus === 'string' ? rawStatus : null,
  };
}

/** 组织清单 → 账号清单（编号换成占位）。items 不是数组 = 认不出，抛 bad_response。 */
export function parseOrgAccounts(body: unknown): ReclaudeOrgRead[] {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : undefined;
  if (!items) throw new ApiFail('bad_response', 'reclaude 组织列表认不出（没有 items 数组）');
  const seen = { carpool: 0, solo: 0, other: 0 };
  const out: ReclaudeOrgRead[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) throw new ApiFail('bad_response', 'reclaude 组织列表里有一项不是对象');
    const kind = raw.type === 'team' ? 'carpool' : raw.type === 'personal' ? 'solo' : 'other';
    seen[kind] += 1;
    const expires = toIso(raw.subscription_expires_at);
    out.push({
      id: `${kind}-${seen[kind]}`,
      kind,
      hasAssignedAccount: typeof raw.has_assigned_account === 'boolean' ? raw.has_assigned_account : null,
      expiresAt: expires ? new Date(expires) : null,
    });
  }
  return out;
}

/** 读一次两个接口。不抛：没读成交回 ok: false（带 code 和原因）。 */
export async function readReclaudeApi(io: ReclaudeApiIo, cfg: ReclaudeApiConfig): Promise<ReclaudeApiRead> {
  const requestedAt = io.now();
  const fail = (code: ReclaudeApiCode, why: string): ReclaudeApiRead => ({
    ok: false,
    requestedAt,
    code,
    why,
  });
  const keyFile = expandHome(cfg.keyFile, io.homeDir);
  let key: string;
  try {
    key = (await io.readFile(keyFile)).trim();
  } catch (e) {
    return fail(
      'auth',
      `读不到 reclaude API Key 文件 ${keyFile}（${(e as NodeJS.ErrnoException).code ?? 'ERR'}）`,
    );
  }
  if (!KEY_SHAPE.test(key)) {
    return fail(
      'auth',
      `reclaude API Key 文件 ${keyFile} 里不是一把 rck_ 开头的 Key（文件里只放 Key 这一行）`,
    );
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), io.timeoutMs);
  const ctx: ApiReadCtx = {
    fetch: io.fetch,
    baseUrl: (cfg.baseUrl ?? DEFAULT_RECLAUDE_BASE_URL).replace(/\/+$/, ''),
    key,
    signal: ctl.signal,
  };
  try {
    const [quotaReply, orgsReply] = await Promise.all([
      get(ctx, '/api/v1/carpool/quota'),
      get(ctx, '/api/v1/orgs').catch((e: unknown) => e),
    ]);
    const quota = parseCarpoolQuota(quotaReply.body);
    // 组织接口说 Key 不认：同一把 Key，整次判失败
    if (orgsReply instanceof ApiFail && orgsReply.code === 'auth') return fail('auth', orgsReply.message);
    let orgs: Extract<ReclaudeApiRead, { ok: true }>['orgs'];
    if (orgsReply instanceof ApiFail) {
      orgs = { ok: false, code: orgsReply.code, why: orgsReply.message };
    } else if (orgsReply instanceof Error) {
      orgs = { ok: false, code: 'network', why: `/api/v1/orgs 没读成：${redact(orgsReply.message)}` };
    } else {
      try {
        orgs = { ok: true, accounts: parseOrgAccounts((orgsReply as Reply).body) };
      } catch (e) {
        if (!(e instanceof ApiFail)) throw e;
        orgs = { ok: false, code: e.code, why: e.message };
      }
    }
    return {
      ok: true,
      requestedAt,
      serverDate: quotaReply.serverDate,
      ageSeconds: quotaReply.ageSeconds,
      quota,
      orgs,
    };
  } catch (e) {
    if (e instanceof ApiFail) return fail(e.code, e.message);
    if (e instanceof QuotaReadError) return fail('bad_response', e.message);
    return fail('network', `读 reclaude 接口没成：${redact(String((e as Error)?.message ?? e))}`);
  } finally {
    clearTimeout(timer);
  }
}
