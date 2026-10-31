// 接口层的前端口：同源，开发时 Vite 代理、部署时由门面转到接口服务。浏览器里没有令牌——令牌由服务端按会话代带。
import type { HistoryPage, SessionSummary } from './types';

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL}api`;

/** 这类错重试没用（令牌无效、会话不存在、请求本身不对）：页面直接说原因，不退避重连。 */
export class FatalApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FatalApiError';
    this.status = status;
  }
}

export function explainStatus(status: number): string {
  if (status === 401) return '没有权限看这个会话（令牌无效或已撤销）。';
  if (status === 403) return '令牌不属于这个会话。';
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

export function fetchSessions(signal?: AbortSignal): Promise<{ sessions: SessionSummary[] }> {
  return getJson(`${API_BASE}/sessions`, signal);
}

export type { HistoryPage };
