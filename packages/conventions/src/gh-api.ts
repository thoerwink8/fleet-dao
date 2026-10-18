// 合并闸在 Actions 里读写 GitHub 用的小客户端：只用 Node 自带的 fetch，不装依赖（merge-gate.yml 不跑 pnpm install）。
// 令牌只放进请求头，报错里不带；非 2xx 一律抛（getOrNull 的 404 除外），由调用方判「没查成」。

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
    return await fetchImpl(target, {
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
