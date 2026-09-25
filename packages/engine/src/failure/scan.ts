// 把证据整理成规则好认的样子：原文里嵌着的结构化码、状态码、上游写明的等待时间。只提取，不判断。

import type { FailureEvidence } from './types.ts';

export interface Scan {
  /** 小写。证据给的 code，加上原文里嵌着的码（JSON 的 "code"/"error"、errorCode=、[claude-code:…]、蛇形标识）。 */
  codes: ReadonlySet<string>;
  /** 证据自己给的 code（小写）：codes 里还混着从原文捞的，只认结构化码的规则看这个。 */
  code?: string;
  /** 上游错误原文全文。 */
  text: string;
  /** 过程记录拼起来；只给写明读过程记录的规则。 */
  tail: string;
  /** 这一步是 AI 会话（绑路由）。GitHub 那几条规则只认不是会话的步骤。 */
  session: boolean;
  status?: number;
  exitCode?: number;
  signal?: string;
}

/** 绑不绑路由：证据明说就听它的；没说时有 routeId 或 source 是 `session:` 就算。 */
export function isRouteBound(e: FailureEvidence): boolean {
  return e.routeBound ?? (e.routeId !== undefined || (e.source ?? '').startsWith('session:'));
}

const JSON_CODE = /"(?:code|error|error_code|errorCode|type)"\s*:\s*"([A-Za-z][\w.-]{1,60})"/g;
const KV_CODE = /\berror_?code\s*[=:]\s*"?([A-Za-z][\w.-]{1,60})/gi;
const CLI_TAG = /\[[\w-]+:([a-z][\w-]{1,60})\]/g;
/** 蛇形标识（account_banned、insufficient_quota）几乎都是机器码。 */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;

export function embeddedCodes(text: string): string[] {
  const out: string[] = [];
  for (const re of [JSON_CODE, KV_CODE, CLI_TAG]) {
    for (const m of text.matchAll(re)) if (m[1]) out.push(m[1]);
  }
  for (const m of text.matchAll(SNAKE)) out.push(m[0]);
  return out.map((c) => c.toLowerCase());
}

/** 只在有「状态码」上下文时认 4xx/5xx，不在任意数字里捞（no progress for 361s 不是状态码）。 */
const STATUS_PATTERNS: readonly RegExp[] = [
  /\bAPI Error:\s*([45]\d\d)\b/i,
  /\bHTTP(?:\/\d(?:\.\d)?)?\s*:?\s*([45]\d\d)\b/i,
  /"status"\s*:\s*([45]\d\d)\b/,
  /\bstatus(?:\s*code)?\s*[:=]?\s*([45]\d\d)\b/i,
  /\b([45]\d\d)\s+status code\b/i,
  /^\W*([45]\d\d)(?=[\s:：,，]|$)/,
];

export function statusFromText(text: string): number | undefined {
  for (const re of STATUS_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  秒: 1,
  分钟: 60,
  小时: 3600,
  天: 86400,
};

/** 上游在原文里写明的等待（秒）：Retry-After、ISO 时刻、in N minutes、约 N 分钟后重置。读不出就是 undefined，不编。 */
export function waitFromText(text: string, nowMs?: number): number | undefined {
  const retryAfter = /\bRetry-After\s*:?\s*(\d+)\b/i.exec(text);
  if (retryAfter?.[1]) return Number(retryAfter[1]);
  const zh = /(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天)(?:之?后|以后)/.exec(text);
  if (zh?.[1] && zh[2]) return Math.round(Number(zh[1]) * (UNIT_SECONDS[zh[2]] ?? 0));
  const en =
    /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(
      text,
    );
  if (en?.[1] && en[2]) return Math.round(Number(en[1]) * (UNIT_SECONDS[en[2].toLowerCase()] ?? 0));
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
  if (iso?.[1] && nowMs !== undefined) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) return Math.max(0, Math.round((at - nowMs) / 1000));
  }
  return undefined;
}

export function scanEvidence(e: FailureEvidence): Scan {
  const text = e.message ?? '';
  const codes = new Set<string>(embeddedCodes(text));
  const code = e.code?.trim().toLowerCase() || undefined;
  if (code) codes.add(code);
  const status = e.httpStatus ?? statusFromText(text);
  return {
    codes,
    ...(code ? { code } : {}),
    text,
    tail: (e.transcriptTail ?? []).join('\n'),
    session: isRouteBound(e),
    ...(status === undefined ? {} : { status }),
    ...(typeof e.exitCode === 'number' ? { exitCode: e.exitCode } : {}),
    ...(e.signal ? { signal: e.signal.toUpperCase() } : {}),
  };
}

/** 给人看的一小段：压空白，过长截断。 */
export function excerpt(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 给人看的时长。 */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} 秒`;
  if (s < 90 * 60) return `${Math.round(s / 60)} 分钟`;
  return `${Number((s / 3600).toFixed(1))} 小时`;
}

export function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}
