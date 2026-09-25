// 直接用 HTTP 调 GitHub（不经 gh 命令行：旧系统的多行参数被拆、输出缓冲撑爆、正文进参数撞 E2BIG、从输出里抠 URL，全是那一层招来的）。
// 这里管四件事：按身份带凭据（App JWT / 某个仓的安装令牌）、限流按 GitHub 给的头退避、写请求全局串行且间隔 ≥1 秒、
// 把失败分成「能重试 / 不能重试 / 可能已经写成」三类。
//
// 改这里之前必须知道：
// - POST 断在回执上（网络错、5xx）不自动重试，抛 AMBIGUOUS_WRITE（maybeLanded）：GitHub 那边可能已经建好了，重试交给幂等层先回查。
// - 次级限流（403/429 + retry-after 或「secondary rate limit」）后，GitHub 要求所有请求都先停，所以用一个全局的 pausedUntil。
// - 404 不一定是「不存在」：App 没装到这个仓、没权限，GitHub 也回 404（报错里两种都写上）。
import { setTimeout as delay } from 'node:timers/promises';
import { type MintedToken, signAppJwt, TokenCache } from './app-auth.ts';
import { type AppCredentials, type AppRole, ROLE_NAMES } from './credentials.ts';
import { GitHubError, redact } from './errors.ts';

export interface RepoRef {
  owner: string;
  name: string;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function parseRepoSlug(slug: string): RepoRef {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(slug.trim());
  if (!m?.[1] || !m[2]) throw new GitHubError('BAD_INPUT', `仓名要写成 owner/name，现在是「${slug}」`);
  return { owner: m[1], name: m[2] };
}

/** app = App 自己的 JWT（只调 /app/…）；agent / engine = 那个机器人在某个仓上的安装令牌。 */
export type Auth = { as: 'app'; role: AppRole } | { as: AppRole; repo: RepoRef } | { as: 'anonymous' };

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface GhRequest {
  method: Method;
  path: string;
  auth: Auth;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: unknown;
  /** 这些状态码原样返回、不抛（例如删分支时的 404/422 = 本来就没了）。 */
  allow?: readonly number[] | undefined;
  /** 条件请求：带上次的 ETag，没变回 304（不占主配额）。 */
  etag?: string | undefined;
  signal?: AbortSignal | undefined;
  accept?: string | undefined;
  /** POST 但不改东西（GraphQL 查询、换令牌）：可以放心重试，也不占写请求的串行队列。 */
  idempotent?: boolean | undefined;
  /** 翻页时用 Link 头给的完整地址。 */
  url?: string | undefined;
}

export interface GhResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** 日志出口再打一遍码：字段里的字符串、错误信息都过 redact。 */
export function redactingLogger(log: Logger): Logger {
  const clean = (fields?: Record<string, unknown>) => {
    if (!fields) return fields;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = typeof v === 'string' ? redact(v) : v instanceof Error ? redact(`${v.name}: ${v.message}`) : v;
    }
    return out;
  };
  return {
    info: (m, f) => log.info(redact(m), clean(f)),
    warn: (m, f) => log.warn(redact(m), clean(f)),
    error: (m, f) => log.error(redact(m), clean(f)),
  };
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: Sleep = async (ms, signal) => {
  await delay(ms, undefined, signal ? { signal } : undefined);
};

export interface GitHubClientOptions {
  apps: Record<AppRole, AppCredentials>;
  /** 默认 https://api.github.com；测试指向本地假服务。 */
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: Sleep;
  log?: Logger;
  userAgent?: string;
  /** 单个请求的超时，默认 30 秒。 */
  requestTimeoutMs?: number;
  /** 写请求之间至少隔多久，默认 1 秒（官方最佳实践：写请求串行、间隔至少 1 秒）。 */
  writeSpacingMs?: number;
  /**
   * 限流要等的时间超过它就不在这里干等，抛可重试的 RATE_LIMITED（带 retryAfterSeconds），交给上层排期。默认 90 秒：
   * 等的时候没有心跳，活动的心跳超时要比它长（或者把它调小）。
   */
  maxRateLimitWaitMs?: number;
  /** 同一个请求最多因限流退避几次，默认 3。 */
  maxRateLimitRetries?: number;
  /** 网络错、5xx 最多重试几次（只对能安全重试的请求），默认 3。 */
  maxTransientRetries?: number;
}

export class GitHubClient {
  readonly apps: Record<AppRole, AppCredentials>;
  readonly apiUrl: string;
  readonly log: Logger;
  readonly now: () => Date;
  readonly sleep: Sleep;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly writeSpacingMs: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxTransientRetries: number;
  private readonly tokens: TokenCache;
  private readonly installations = new Map<string, number>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private lastWriteAt = 0;
  private pausedUntil = 0;

  constructor(options: GitHubClientOptions) {
    this.apps = options.apps;
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? realSleep;
    this.log = redactingLogger(options.log ?? silentLogger);
    this.userAgent = options.userAgent ?? 'fleet-dao';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.writeSpacingMs = options.writeSpacingMs ?? 1000;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 90_000;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 3;
    this.maxTransientRetries = options.maxTransientRetries ?? 3;
    this.tokens = new TokenCache({ now: this.now });
  }

  // —— 身份 ——

  /** App 自己的 JWT。只给 /app/… 接口用。 */
  appJwt(role: AppRole): string {
    return signAppJwt(this.apps[role], this.now());
  }

  /** 这个机器人装在这个仓上的安装编号（缓存；装没装到就看它）。 */
  async installationId(
    role: AppRole,
    repo: RepoRef,
    signal?: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<number> {
    const key = `${role}:${repoSlug(repo).toLowerCase()}`;
    const hit = this.installations.get(key);
    if (hit !== undefined && !options.fresh) return hit;
    const res = await this.request<{ id?: unknown }>({
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/installation`,
      auth: { as: 'app', role },
      allow: [404],
      signal,
    });
    if (res.status === 404) {
      this.installations.delete(key);
      throw new GitHubError(
        'NOT_INSTALLED',
        `${ROLE_NAMES[role]}没装到 ${repoSlug(repo)}（或这个仓不存在）：到 App 设置页把它装到这个仓`,
        { details: { role, repo: repoSlug(repo) }, status: 404 },
      );
    }
    const id = res.data.id;
    if (typeof id !== 'number') throw unexpected('查安装编号', res.data);
    this.installations.set(key, id);
    return id;
  }

  /** 这个机器人在这个仓上的安装令牌（只对这一个仓有效）。只在要交给 git 子进程时才直接拿。 */
  async installationToken(role: AppRole, repo: RepoRef, signal?: AbortSignal): Promise<MintedToken> {
    const key = `${role}:${repoSlug(repo).toLowerCase()}`;
    return this.tokens.get(key, async () => {
      const id = await this.installationId(role, repo, signal);
      const res = await this.request<{ token?: unknown; expires_at?: unknown; permissions?: unknown }>({
        method: 'POST',
        path: `/app/installations/${id}/access_tokens`,
        auth: { as: 'app', role },
        body: { repositories: [repo.name] },
        idempotent: true,
        allow: [404, 422],
        signal,
      });
      if (res.status === 404 || res.status === 422) {
        this.installations.delete(key);
        throw new GitHubError(
          'NOT_INSTALLED',
          `${ROLE_NAMES[role]}换不到 ${repoSlug(repo)} 的令牌（安装已被移除，或没勾选这个仓）`,
          { details: { role, repo: repoSlug(repo) }, status: res.status },
        );
      }
      const { token, expires_at: expiresAt, permissions } = res.data;
      if (typeof token !== 'string' || typeof expiresAt !== 'string') throw unexpected('换安装令牌', {});
      return {
        token,
        expiresAt: new Date(expiresAt),
        permissions: isStringRecord(permissions) ? permissions : undefined,
      };
    });
  }

  private async credential(auth: Auth, signal?: AbortSignal): Promise<string | null> {
    if (auth.as === 'anonymous') return null;
    if (auth.as === 'app') return this.appJwt(auth.role);
    return (await this.installationToken(auth.as, auth.repo, signal)).token;
  }

  private dropCredential(auth: Auth, token: string): void {
    if (auth.as === 'agent' || auth.as === 'engine') {
      this.tokens.invalidate(`${auth.as}:${repoSlug(auth.repo).toLowerCase()}`, token);
    }
  }

  // —— 请求 ——

  async request<T = unknown>(req: GhRequest): Promise<GhResponse<T>> {
    if (isWrite(req)) return this.serializeWrite(() => this.send<T>(req));
    return this.send<T>(req);
  }

  /** 逐页取（跟 Link 头的 next），每页交给调用方；调用方 break 就停。默认最多 50 页。 */
  async *pages<T = unknown>(req: GhRequest, maxPages = 50): AsyncGenerator<GhResponse<T>> {
    let next: GhRequest | null = req;
    for (let page = 0; next && page < maxPages; page += 1) {
      const res: GhResponse<T> = await this.request<T>(next);
      yield res;
      const link = nextLink(res.headers.get('link'));
      next = link ? { ...req, url: link, query: undefined } : null;
    }
    // 调用方自己停下（break）走不到这里；走到这里还有下一页 = 翻到上限没翻完，不能当「全看过了」
    if (next) {
      throw new GitHubError(
        'TOO_MANY_PAGES',
        `${req.method} ${req.path} 翻了 ${maxPages} 页还没翻完：这次没查全（没查成）`,
        { details: { maxPages } },
      );
    }
  }

  /** 把所有页的数组拼起来。itemsOf 从一页的返回体里取数组（有的接口包在对象里）。 */
  async all<T = unknown>(
    req: GhRequest,
    itemsOf: (data: unknown) => unknown = (d) => d,
    maxPages = 50,
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages(req, maxPages)) {
      const items = itemsOf(page.data);
      if (!Array.isArray(items)) throw unexpected(`${req.method} ${req.path}`, page.data);
      out.push(...(items as T[]));
    }
    return out;
  }

  async graphql<T>(
    auth: Auth,
    query: string,
    variables: Record<string, unknown>,
    options: { mutation?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const res = await this.request<{ data?: T | null; errors?: { type?: string; message?: string }[] }>({
      method: 'POST',
      path: '/graphql',
      auth,
      body: { query, variables },
      idempotent: !options.mutation,
      signal: options.signal,
    });
    const errors = res.data?.errors ?? [];
    if (errors.length > 0) {
      const text = errors.map((e) => e.message ?? e.type ?? '?').join('；');
      const forbidden = errors.some(
        (e) => e.type === 'FORBIDDEN' || /not accessible by integration/i.test(e.message ?? ''),
      );
      const notFound = errors.some((e) => e.type === 'NOT_FOUND');
      throw new GitHubError(
        forbidden ? 'FORBIDDEN' : notFound ? 'NOT_FOUND' : 'GRAPHQL_ERROR',
        `GraphQL 出错：${text}`,
        { details: { errors } },
      );
    }
    if (!res.data?.data) throw unexpected('GraphQL', res.data);
    return res.data.data;
  }

  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(async () => {
      const gap = this.lastWriteAt + this.writeSpacingMs - this.now().getTime();
      if (gap > 0) await this.sleep(gap);
      try {
        return await fn();
      } finally {
        this.lastWriteAt = this.now().getTime();
      }
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async send<T>(req: GhRequest): Promise<GhResponse<T>> {
    const write = isWrite(req);
    const label = `${req.method} ${req.path}`;
    let authRetried = false;
    let transient = 0;
    let limited = 0;
    for (;;) {
      // 撞过限流：所有请求一起停；要停太久就别在这里干等
      const paused = this.pausedUntil - this.now().getTime();
      if (paused > this.maxRateLimitWaitMs) {
        throw new GitHubError(
          'RATE_LIMITED',
          `${label}：GitHub 限流中，还要等 ${Math.ceil(paused / 1000)} 秒`,
          {
            retryable: true,
            details: { retryAfterSeconds: Math.ceil(paused / 1000) },
          },
        );
      }
      if (paused > 0) await this.sleep(paused, req.signal);

      const token = await this.credential(req.auth, req.signal);
      const headers: Record<string, string> = {
        accept: req.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': this.userAgent,
      };
      if (token) headers.authorization = `Bearer ${token}`;
      if (req.etag) headers['if-none-match'] = req.etag;
      let body: string | undefined;
      if (req.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.body);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(req.url ?? this.url(req.path, req.query), {
          method: req.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: this.timeoutSignal(req.signal),
        });
      } catch (err) {
        if (req.signal?.aborted) throw req.signal.reason ?? err;
        const what = err instanceof Error ? err.message : String(err);
        if (write && req.method === 'POST') {
          throw new GitHubError(
            'AMBIGUOUS_WRITE',
            `${label} 没收到回执（${what}）：可能已经写成，重试前先回查`,
            {
              retryable: true,
              maybeLanded: true,
              cause: err,
            },
          );
        }
        if (transient < this.maxTransientRetries) {
          transient += 1;
          this.log.warn('连 GitHub 失败，稍后重试', { label, attempt: transient, error: what });
          await this.sleep(1000 * 2 ** (transient - 1), req.signal);
          continue;
        }
        throw new GitHubError('GITHUB_UNAVAILABLE', `${label} 连不上 GitHub（${what}）`, {
          retryable: true,
          maybeLanded: write,
          cause: err,
        });
      }

      const text = await res.text();
      const data = parseBody(text);
      if (res.ok || res.status === 304 || req.allow?.includes(res.status)) {
        return { status: res.status, data: data as T, headers: res.headers };
      }
      const message = githubMessage(data);

      const wait = this.rateLimitWait(res.status, res.headers, message, limited);
      if (wait !== null) {
        this.pausedUntil = Math.max(this.pausedUntil, this.now().getTime() + wait);
        if (wait > this.maxRateLimitWaitMs || limited >= this.maxRateLimitRetries) {
          throw new GitHubError(
            'RATE_LIMITED',
            `${label} 被 GitHub 限流（${message || res.status}），要等 ${Math.ceil(wait / 1000)} 秒`,
            {
              retryable: true,
              status: res.status,
              details: {
                retryAfterSeconds: Math.ceil(wait / 1000),
                requestId: res.headers.get('x-github-request-id'),
              },
            },
          );
        }
        limited += 1;
        this.log.warn('GitHub 限流，按它给的头退避', { label, status: res.status, waitMs: wait, message });
        continue;
      }
      if (res.status === 401 && token && !authRetried) {
        authRetried = true;
        this.dropCredential(req.auth, token);
        continue;
      }
      if (res.status >= 500) {
        if (write && req.method === 'POST') {
          throw new GitHubError('AMBIGUOUS_WRITE', `${label} 回 ${res.status}：可能已经写成，重试前先回查`, {
            retryable: true,
            maybeLanded: true,
            status: res.status,
          });
        }
        if (transient < this.maxTransientRetries) {
          transient += 1;
          await this.sleep(1000 * 2 ** (transient - 1), req.signal);
          continue;
        }
        throw new GitHubError('GITHUB_UNAVAILABLE', `${label} 回 ${res.status}（${message}）`, {
          retryable: true,
          maybeLanded: write,
          status: res.status,
        });
      }
      throw httpError(req, res.status, res.headers, message, data);
    }
  }

  /** 该不该因限流等、等多久；不是限流返回 null。 */
  private rateLimitWait(status: number, headers: Headers, message: string, tries: number): number | null {
    if (status !== 403 && status !== 429) return null;
    const retryAfter = Number(headers.get('retry-after'));
    if (headers.has('retry-after') && Number.isFinite(retryAfter)) return Math.max(1, retryAfter) * 1000;
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      if (Number.isFinite(reset)) return Math.max(1000, reset * 1000 - this.now().getTime() + 1000);
      return 60_000;
    }
    // 次级限流没给头：官方说至少等一分钟，之后指数加长。
    if (status === 429 || /secondary rate limit|abuse detection/i.test(message)) return 60_000 * 2 ** tries;
    return null;
  }

  private url(path: string, query: GhRequest['query']): string {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private timeoutSignal(outer: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return outer ? AbortSignal.any([outer, timeout]) : timeout;
  }
}

export function enc(part: string): string {
  return encodeURIComponent(part);
}

/** 分支名放进路径：斜杠保留（refs 接口要原样的层级）。 */
export function encRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function isWrite(req: GhRequest): boolean {
  return req.method !== 'GET' && !req.idempotent;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubMessage(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 300);
  if (data && typeof data === 'object') {
    const o = data as { message?: unknown; errors?: unknown };
    const parts: string[] = [];
    if (typeof o.message === 'string') parts.push(o.message);
    if (Array.isArray(o.errors)) {
      for (const e of o.errors.slice(0, 5)) {
        if (typeof e === 'string') parts.push(e);
        else if (e && typeof e === 'object') {
          const m = (e as { message?: unknown; code?: unknown; field?: unknown }).message;
          const c = (e as { code?: unknown }).code;
          const f = (e as { field?: unknown }).field;
          parts.push([m, c, f].filter((x) => typeof x === 'string').join(' '));
        }
      }
    }
    return parts.join('；');
  }
  return '';
}

function httpError(
  req: GhRequest,
  status: number,
  headers: Headers,
  message: string,
  data: unknown,
): GitHubError {
  const label = `${req.method} ${req.path}`;
  const details = {
    status,
    method: req.method,
    path: req.path,
    requestId: headers.get('x-github-request-id'),
    githubMessage: message,
    body: data,
  };
  const repo = req.auth.as === 'agent' || req.auth.as === 'engine' ? repoSlug(req.auth.repo) : undefined;
  switch (status) {
    case 401:
      return new GitHubError('AUTH_FAILED', `${label}：凭据被拒（401）${message ? `：${message}` : ''}`, {
        status,
        details,
      });
    case 403: {
      const need = headers.get('x-accepted-github-permissions');
      return new GitHubError(
        'FORBIDDEN',
        `${label}：没有权限（403）${message ? `：${message}` : ''}${need ? `；这个接口要的权限：${need}` : ''}`,
        { status, details: { ...details, acceptedPermissions: need } },
      );
    }
    case 404:
      return new GitHubError(
        'NOT_FOUND',
        `${label}：没找到（404）——对象不存在，或 App 没装到${repo ? ` ${repo}` : '这个仓'} / 没有权限（GitHub 对这几种都回 404）`,
        { status, details },
      );
    case 405:
      return new GitHubError('NOT_ALLOWED', `${label}：不允许（405）${message ? `：${message}` : ''}`, {
        status,
        details,
      });
    case 409:
      return new GitHubError('CONFLICT', `${label}：冲突（409）${message ? `：${message}` : ''}`, {
        status,
        details,
      });
    case 422:
      return new GitHubError('VALIDATION', `${label}：GitHub 不收（422）${message ? `：${message}` : ''}`, {
        status,
        details,
      });
    default:
      return new GitHubError(`HTTP_${status}`, `${label}：回 ${status}${message ? `：${message}` : ''}`, {
        status,
        details,
      });
  }
}

export function unexpected(what: string, data: unknown): GitHubError {
  return new GitHubError('UNEXPECTED_RESPONSE', `${what}：GitHub 的返回和预期的形状不一样（没查成）`, {
    retryable: true,
    details: { sample: typeof data === 'object' ? Object.keys(data ?? {}).slice(0, 20) : typeof data },
  });
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m?.[1] && m[2]?.split(/\s+/).includes('next')) return m[1];
  }
  return null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string');
}
