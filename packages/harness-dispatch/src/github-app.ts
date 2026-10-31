// 新内核换 GitHub 只读令牌（#3811）：读 GitHub App 的凭据 json（id、pem），签 RS256 JWT，
// 按仓换只读短期令牌并缓存（到期前 5 分钟换新）。决定 0124：不依赖旧包，需要的逻辑拷过来。
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface AppTokenOptions {
  /** App 凭据 json 的路径（含数字 id 和 pem 私钥） */
  file: string;
  api?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export const READ_ONLY_PERMISSIONS = {
  issues: 'read',
  pull_requests: 'read',
  contents: 'read',
  metadata: 'read',
} as const;

const REFRESH_BEFORE_MS = 5 * 60_000;
const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** iat 往前拨 60 秒（防时钟差），exp 在现在之后 9 分钟。 */
export function appJwt(appId: number, pem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
  )}`;
  return `${head}.${b64(createSign('RSA-SHA256').update(head).sign(pem))}`;
}

/** 返回「按仓（owner/name）给令牌」的异步函数。 */
export function appTokenSource(o: AppTokenOptions): (repo: string) => Promise<string> {
  const api = (o.api ?? 'https://api.github.com').replace(/\/$/, '');
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  let cred: { appId: number; pem: string } | undefined;

  const load = () => {
    if (cred) return cred;
    let raw: { id?: unknown; pem?: unknown };
    try {
      raw = JSON.parse(readFileSync(o.file, 'utf8'));
    } catch (err) {
      throw new Error(`读不了 GitHub App 凭据 ${o.file}：${(err as Error).message}`);
    }
    const appId = Number(raw.id);
    if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error(`${o.file} 缺数字 id`);
    if (typeof raw.pem !== 'string' || !raw.pem.trim()) throw new Error(`${o.file} 缺 pem 私钥`);
    cred = { appId, pem: raw.pem };
    return cred;
  };

  const call = async (url: string, init: RequestInit, what: string, jwt: string) => {
    const res = await f(url, {
      ...init,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`${what}：HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const exchange = async (repo: string) => {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error(`换令牌：仓名要是 owner/name：${repo}`);
    const { appId, pem } = load();
    const jwt = appJwt(appId, pem, now());
    const inst = await call(`${api}/repos/${repo}/installation`, {}, `查 ${repo} 的 App 安装`, jwt);
    if (typeof inst.id !== 'number') throw new Error(`查 ${repo} 的 App 安装：回来的形状认不出`);
    const tok = await call(
      `${api}/app/installations/${inst.id}/access_tokens`,
      { method: 'POST', body: JSON.stringify({ repositories: [name], permissions: READ_ONLY_PERMISSIONS }) },
      `换 ${repo} 的只读令牌`,
      jwt,
    );
    const expiresAt = Date.parse(String(tok.expires_at));
    if (typeof tok.token !== 'string' || !tok.token || Number.isNaN(expiresAt)) {
      throw new Error(`换 ${repo} 的只读令牌：回来的形状认不出`);
    }
    return { token: tok.token, expiresAt };
  };

  return async (repo) => {
    const hit = cache.get(repo);
    if (hit && hit.expiresAt - now() > REFRESH_BEFORE_MS) return hit.token;
    const fresh = await exchange(repo);
    cache.set(repo, fresh);
    return fresh.token;
  };
}
