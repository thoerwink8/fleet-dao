// 接口层的前端口：同源，开发时 Vite 代理、部署时由门面转到接口服务。浏览器里没有令牌——令牌由服务端按会话代带。
import type { HistoryPage, SessionsPage } from './types';

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL}api`;

/** 这类错重试没用（没登录、不在白名单、会话不存在、请求本身不对）：页面直接说原因，不退避重连。 */
export class FatalApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FatalApiError';
    this.status = status;
  }
}

export function explainStatus(status: number): string {
  if (status === 401) return '还没登录，或登录已过期。';
  if (status === 403) return '这个账号没有查看权限。';
  if (status === 404) return '没有这个会话。';
  if (status === 400) return '请求不合规矩，请刷新页面再试。';
  return `服务返回了 ${status}。`;
}

/** 4xx（除 408、429）算致命，5xx 和网络错算可重试。 */
export function isFatalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function getJson<T>(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(url, { signal: signal ?? null, headers: { accept: 'application/json' } });
  if (!res.ok) {
    if (isFatalStatus(res.status)) throw new FatalApiError(res.status, explainStatus(res.status));
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function historyUrl(
  base: string,
  sessionId: string,
  q: { before?: number; after?: number; limit?: number },
): string {
  const p = new URLSearchParams();
  if (q.before !== undefined) p.set('before', String(q.before));
  if (q.after !== undefined) p.set('after', String(q.after));
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  const qs = p.toString();
  return `${base}/sessions/${encodeURIComponent(sessionId)}/history${qs ? `?${qs}` : ''}`;
}

export function eventsUrl(base: string, sessionId: string): string {
  return `${base}/sessions/${encodeURIComponent(sessionId)}/events`;
}

export function sessionsUrl(base: string, q: { before?: number; limit?: number } = {}): string {
  const p = new URLSearchParams();
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.before !== undefined) p.set('before', String(q.before));
  const qs = p.toString();
  return `${base}/sessions${qs ? `?${qs}` : ''}`;
}

/** 会话列表一页：不给 before 是最新一页；nextBefore 非空就是还有更老的，下一页把它当 before 传。 */
export function fetchSessions(signal?: AbortSignal, before?: number): Promise<SessionsPage> {
  return getJson(sessionsUrl(API_BASE, before === undefined ? {} : { before }), signal);
}

/** 没登录（或登录过期）：页面给登录入口，不再重试。 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof FatalApiError && err.status === 401;
}

/** 登录在旧驾驶舱：飞书走服务端 302 回到新驾驶舱，账密登录页在旧驾驶舱根路径。 */
export const LOGIN_LINKS = {
  feishu: '/auth/feishu/login?next=%2Fnext%2F',
  password: '/login',
} as const;

export type { HistoryPage };
