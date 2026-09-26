// 合并闸在 Actions 里读写 GitHub 用的小客户端：只用 Node 自带的 fetch，不装依赖（merge-gate.yml 不跑 pnpm install）。
// 令牌只放进请求头，报错里不带；非 2xx 一律抛（getOrNull 的 404 除外），由调用方判「没查成」。

export interface GhApi {
  /** GET 仓内接口（path 从 /repos/{owner}/{repo} 之后算，如 /pulls/3）；回 JSON。 */
  get(path: string): Promise<unknown>;
  /** 同 get，但 404 回 null（问「这个文件在不在」用）。 */
  getOrNull(path: string): Promise<unknown>;
  /** POST 仓内接口，body 发 JSON。 */
  post(path: string, body: unknown): Promise<void>;
}

export function ghApi(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): GhApi {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> => {
    const token = env.GITHUB_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    if (!token) throw new Error('没有 GITHUB_TOKEN');
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('没有 GITHUB_REPOSITORY（owner/名字）');
    const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    return await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleet-dao-merge-gate',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  };
  const failed = (res: Response, method: string, path: string) =>
    new Error(`GitHub 回了 ${res.status}（${method} ${path.split('?')[0]}）`);
  return {
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
  };
}
