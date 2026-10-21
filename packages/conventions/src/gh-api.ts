// 合并闸在 Actions 里读写 GitHub 用的小客户端：只用 Node 自带的 fetch，不装依赖（merge-gate.yml 不跑 pnpm install）。
// 令牌只放进请求头，报错里不带；非 2xx 一律抛（getOrNull 的 404 除外），由调用方判「没查成」。
// 非成功响应只附加这一次响应的白名单证据，不另请求、不重试。

export interface GhApi {
  /** GET 仓内接口（path 从 /repos/{owner}/{repo} 之后算，如 /pulls/3）；回 JSON。 */
  get(path: string): Promise<unknown>;
  /** 可信装配选择的 GitHub 全局只读路径（Bot 数字身份）。 */
  globalGet?(path: string): Promise<unknown>;
  /** 同 get，但 404 回 null（问「这个文件在不在」用）。 */
  getOrNull(path: string): Promise<unknown>;
  /** POST 仓内接口，body 发 JSON。 */
  post(path: string, body: unknown): Promise<void>;
}

/** 在 GhApi 之上多一个改（PATCH，关单用）；只有要写的脚本才用它，别的调用方和测试的假客户端仍只实现 GhApi。 */
export interface GhApiWrite extends GhApi {
  /** PATCH 仓内接口，body 发 JSON；非 2xx 抛。 */
  patch(path: string, body: unknown): Promise<void>;
  /** 查 GraphQL（REST 读不到的字段，如正文最后改动的时刻）；非 2xx 或回了 errors 都抛，回 data。 */
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export function ghApi(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): GhApiWrite {
  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    graphql = false,
  ): Promise<Response> => {
    const token = env.GITHUB_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    if (!token) throw new Error('没有 GITHUB_TOKEN');
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('没有 GITHUB_REPOSITORY（owner/名字）');
    const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const target = graphql
      ? (env.GITHUB_GRAPHQL_URL ?? `${api}/graphql`)
      : path.startsWith('/users/')
        ? `${api}${path}`
        : `${api}/repos/${repo}${path}`;
    const where = `${method} ${path.split('?')[0]}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    try {
      return await fetchImpl(target, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'fleet-dao-merge-gate',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(appendTransportEvidence(`连不上 GitHub（${where}）`, error));
    }
  };
  const failed = (res: Response, method: string, path: string) =>
    new Error(
      appendResponseEvidence(`GitHub 回了 ${res.status}（${method} ${path.split('?')[0]}）`, res.headers),
    );
  return {
    async globalGet(path) {
      if (!/^\/users\/[A-Za-z0-9%_-]+$/.test(path)) throw new Error('不支持的 GitHub 全局读口');
      const res = await call('GET', path);
      if (!res.ok) throw failed(res, 'GET', path);
      return await res.json();
    },
    async get(path) {
      const res = await call('GET', path);
      if (!res.ok) throw failed(res, 'GET', path);
      return await res.json();
    },
    async getOrNull(path) {
      const res = await call('GET', path);
      if (res.status === 404) return null;
      if (!res.ok) throw failed(res, 'GET', path);
      return await res.json();
    },
    async post(path, body) {
      const res = await call('POST', path, body);
      if (!res.ok) throw failed(res, 'POST', path);
    },
    async patch(path, body) {
      const res = await call('PATCH', path, body);
      if (!res.ok) throw failed(res, 'PATCH', path);
    },
    async graphql(query, variables) {
      const res = await call('POST', '/graphql', { query, variables }, true);
      if (!res.ok) throw failed(res, 'POST', '/graphql');
      const got = (await res.json()) as { data?: unknown; errors?: unknown } | null;
      if (got === null || typeof got !== 'object') throw new Error('GitHub GraphQL 回的不是对象');
      if (Array.isArray(got.errors) && got.errors.length > 0)
        throw new Error(`GitHub GraphQL 回了 ${got.errors.length} 条错误`);
      return got.data;
    },
  };
}

// 正式 Node reader 的非成功响应证据：只格式化这一次响应里的白名单头。
// 不读 body，不另请求 /rate_limit，不把缺字段当成 0、当前时间或已经恢复。
// 不合格的值写成 unknown，不把未信任字符串原样拼进错误文本。

/** 只读这些响应头。名字用小写，Headers.get 本身不分大小写。 */
export const GITHUB_RESPONSE_EVIDENCE_HEADERS = [
  'date',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'retry-after',
  'x-github-request-id',
] as const;

/** GitHub 官方 rate-limit 文档与 OpenAPI 已知资源的并集；其它字符串一律 unknown。 */
export const GITHUB_RATE_LIMIT_RESOURCES = [
  'core',
  'graphql',
  'search',
  'code_search',
  'source_import',
  'integration_manifest',
  'actions_runner_registration',
  'scim',
  'dependency_snapshots',
  'dependency_sbom',
  'code_scanning_upload',
  'code_scanning_autofix',
  'copilot_usage_records',
] as const;

const UNKNOWN = 'unknown';
const RESOURCES = new Set<string>(GITHUB_RATE_LIMIT_RESOURCES);
/** toISOString 在公元 10000 年会带正号；超过这一秒就标 unknown，不改写成现在。 */
const MAX_RESET_EPOCH = 253402300799;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const WEEKDAY = WEEKDAYS.join('|');
const MONTH = Object.keys(MONTH_INDEX).join('|');
/** 四位年份可独立核验；旧式两位年份只由本响应的有效 Date 锚定，不读本机时钟。 */
const IMF_DATE = new RegExp(`^(${WEEKDAY}), (\\d{2}) (${MONTH}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`);
/** asctime 没有时区字段；HTTP 规定按 GMT 解释，不按本机时区。 */
const ASCTIME_DATE = new RegExp(`^(${WEEKDAY}) (${MONTH}) ([ \\d]\\d) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`);
const RFC850_DATE = new RegExp(
  `^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\\d{2})-(${MONTH})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const COUNT = /^(?:0|[1-9][0-9]{0,9})$/;
const EPOCH = /^(?:0|[1-9][0-9]{0,11})$/;
const REQUEST_ID = /^[0-9A-Fa-f]{1,16}(?::[0-9A-Fa-f]{1,16}){1,8}$/;

export interface GitHubHeaderSource {
  get(name: string): string | null;
}

/** 响应已经拿到。每个白名单字段要么是校验后的事实，要么是 unknown。 */
export function githubResponseEvidence(headers: GitHubHeaderSource): string {
  const date = dateField(headers.get('date'));
  return [
    '阶段=响应已收到',
    `date=${date}`,
    `limit=${countField(headers.get('x-ratelimit-limit'))}`,
    `remaining=${countField(headers.get('x-ratelimit-remaining'))}`,
    `reset=${resetField(headers.get('x-ratelimit-reset'))}`,
    `resource=${resourceField(headers.get('x-ratelimit-resource'))}`,
    `retry-after=${retryAfterField(headers.get('retry-after'), date)}`,
    `request-id=${requestIdField(headers.get('x-github-request-id'))}`,
  ].join('；');
}

/**
 * fetch 抛了，没有响应。阶段是「响应未收到」；白名单字段保持 unknown，不补一头。
 * name / code 只收已知错误枚举，不复印任意安全字符组成的秘密。detail 只留本仓自己写的传输说明；其余原文写成 unknown。
 */
export function githubTransportEvidence(error: unknown): string {
  return [
    '阶段=响应未收到',
    `name=${errorName(error)}`,
    `code=${errorCode(error)}`,
    `detail=${errorDetail(error)}`,
    `date=${UNKNOWN}`,
    `limit=${UNKNOWN}`,
    `remaining=${UNKNOWN}`,
    `reset=${UNKNOWN}`,
    `resource=${UNKNOWN}`,
    `retry-after=${UNKNOWN}`,
    `request-id=${UNKNOWN}`,
  ].join('；');
}

export function appendResponseEvidence(base: string, headers: GitHubHeaderSource): string {
  return `${base}；${githubResponseEvidence(headers)}`;
}

export function appendTransportEvidence(base: string, error: unknown): string {
  return `${base}；${githubTransportEvidence(error)}`;
}

function countField(raw: string | null): string {
  if (raw === null || !COUNT.test(raw)) return UNKNOWN;
  return raw;
}

function resetField(raw: string | null): string {
  if (raw === null || !EPOCH.test(raw)) return UNKNOWN;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_RESET_EPOCH) return UNKNOWN;
  const date = new Date(seconds * 1000);
  if (date.getTime() !== seconds * 1000) return UNKNOWN;
  const iso = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) return UNKNOWN;
  return `${raw} utc=${iso}`;
}

function resourceField(raw: string | null): string {
  if (raw === null || !RESOURCES.has(raw)) return UNKNOWN;
  return raw;
}

function retryAfterField(raw: string | null, responseDate: string): string {
  if (raw === null || raw.length > 40) return UNKNOWN;
  if (COUNT.test(raw)) return `seconds:${raw}`;
  const http = httpDate(raw) ?? obsoleteRetryDate(raw, responseDate);
  if (http === undefined) return UNKNOWN;
  return `http-date:${http}`;
}

/** RFC 9110 的旧式两位年份按响应 Date 的世纪和 50 年窗口解释；缺可靠锚点就 unknown。 */
function obsoleteRetryDate(raw: string, responseDate: string): string | undefined {
  if (responseDate === UNKNOWN) return undefined;
  const match = RFC850_DATE.exec(raw);
  if (!match) return undefined;
  const [, weekday, day, month, shortYear, hour, minute, second] = match;
  const reference = new Date(responseDate);
  const referenceYear = reference.getUTCFullYear();
  let year = Math.floor(referenceYear / 100) * 100 + Number(shortYear);
  const monthIndex = month === undefined ? undefined : MONTH_INDEX[month];
  if (monthIndex === undefined) return undefined;
  const limit = new Date(reference);
  limit.setUTCFullYear(referenceYear + 50);
  const candidate = () =>
    Date.UTC(year, monthIndex, Number(day), Number(hour), Number(minute), Number(second));
  if (candidate() > limit.getTime()) year -= 100;
  else {
    year += 100;
    if (candidate() > limit.getTime()) year -= 100;
  }
  return canonicalUtc(weekday?.slice(0, 3), String(year), month, day, hour, minute, second);
}

function dateField(raw: string | null): string {
  if (raw === null || raw.length > 40) return UNKNOWN;
  return httpDate(raw) ?? UNKNOWN;
}

function requestIdField(raw: string | null): string {
  if (raw === null || raw.length < 8 || raw.length > 64 || !REQUEST_ID.test(raw)) return UNKNOWN;
  return raw;
}

function httpDate(raw: string): string | undefined {
  const imf = IMF_DATE.exec(raw);
  if (imf) {
    const [, weekday, day, month, year, hour, minute, second] = imf;
    return canonicalUtc(weekday, year, month, day, hour, minute, second);
  }
  const asctime = ASCTIME_DATE.exec(raw);
  if (asctime) {
    const [, weekday, month, day, hour, minute, second, year] = asctime;
    return canonicalUtc(weekday, year, month, day, hour, minute, second);
  }
  return undefined;
}

function canonicalUtc(
  weekday: string | undefined,
  yearText: string | undefined,
  monthText: string | undefined,
  dayText: string | undefined,
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined,
): string | undefined {
  if (
    weekday === undefined ||
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    return undefined;
  }
  const month = MONTH_INDEX[monthText];
  if (month === undefined || !WEEKDAYS.some((name) => name === weekday)) return undefined;
  const year = Number(yearText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59 || year < 1970 || year > 9999) return undefined;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return undefined;
  }
  return date.toISOString();
}

const TRANSPORT_NAMES = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'FetchError']);
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return UNKNOWN;
  const name = (error as { name: unknown }).name;
  return typeof name === 'string' && TRANSPORT_NAMES.has(name) ? name : UNKNOWN;
}

/** 调用方自己抛出的传输说明。别的原文可能夹着网址或令牌，整段丢掉。 */
const TRUSTED_TRANSPORT_DETAIL =
  /^GitHub 的 (?:gh 传输只允许无正文的 GET|gh 请求没完成（进程不可用、超时或输出超限）|gh 没返回可辨认的 HTTP 状态和响应头|gh 进程失败，没读成|gh 响应头认不出|GitHub 请求越过当前仓或 API，没读成|GitHub 分页仓号与当前仓不符，没读成|GitHub API 地址无效，没读成)。$|^GitHub 核对仓身份，(?:GitHub 回了 [1-5]\d{2}|响应不是合法 JSON|仓号或仓名认不出)。$/;

function errorDetail(error: unknown): string {
  if (!(error instanceof Error) || !TRUSTED_TRANSPORT_DETAIL.test(error.message)) return UNKNOWN;
  return error.message;
}

function errorCode(error: unknown): string {
  const own = codeOf(error);
  if (own !== undefined) return own;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    const fromCause = codeOf((error as { cause: unknown }).cause);
    if (fromCause !== undefined) return fromCause;
  }
  return UNKNOWN;
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  const code = (value as { code: unknown }).code;
  if (typeof code !== 'string' || !TRANSPORT_CODES.has(code)) return undefined;
  return code;
}
