// 对账本机入口明确复用 gh socket；Actions 仍走原 token HTTP，不在 401 后切身份。
import { liveGitHub } from './github-api.ts';
import { ghReadFetch, ghResponse, ghSocketConfigured, type RunGhRead, runGh } from './plan-reader.ts';

type Env = Record<string, string | undefined>;
type Options = { runGh?: RunGhRead; fetchImpl?: typeof fetch; token?: () => string | undefined };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** 只承接 audit 的写范围，正文走 stdin，不进命令参数或错误日志。每次写核对真实回执。 */
export function auditGhFetch(repo: string, env: Env, run: RunGhRead = runGh): typeof fetch {
  const read = ghReadFetch(repo, env, run);
  const api = new URL((env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''));
  const prefix = `${api.pathname.replace(/\/+$/, '')}/repos/${repo}/`;
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return read(input, init);
    const url = new URL(request?.url ?? String(input));
    const path = url.pathname.slice(prefix.length);
    if (
      url.origin !== api.origin ||
      !url.pathname.startsWith(prefix) ||
      /%2f|%5c|%2e/i.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('对账写请求越过当前仓或 API。');
    const allowed =
      method === 'PATCH'
        ? /^(issues|milestones)\/[1-9]\d*$/.test(path)
        : method === 'POST' && /^(issues|issues\/[1-9]\d*\/(comments|sub_issues))$/.test(path);
    if (!allowed || typeof init?.body !== 'string') throw new Error('对账 gh 传输拒绝该写请求。');
    let sent: unknown;
    try {
      sent = JSON.parse(init.body);
    } catch {
      throw new Error('对账写请求不是 JSON。');
    }
    if (!object(sent)) throw new Error('对账写请求正文认不出。');
    const response = ghResponse(
      await run(
        [
          'api',
          '--include',
          '--method',
          method,
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          'X-GitHub-Api-Version: 2022-11-28',
          '-H',
          'Content-Type: application/json',
          '--input',
          '-',
          url.href,
        ],
        env,
        init.body,
      ),
    );
    if (!response.ok) return response;
    if (method === 'POST' && response.status !== 201 && !path.endsWith('/sub_issues'))
      throw new Error('对账写回执状态不是 201，结果未知。');
    let got: unknown;
    try {
      got = await response.clone().json();
    } catch {
      throw new Error('对账写回执不是 JSON，结果未知。');
    }
    if (!object(got)) throw new Error('对账写回执认不出，结果未知。');
    const n = /^(?:issues|milestones)\/([1-9]\d*)$/.exec(path)?.[1];
    if (n && got.number !== Number(n)) throw new Error('对账写回执单号不符，结果未知。');
    if (path === 'issues' && !positive(got.number)) throw new Error('对账开单回执单号认不出，结果未知。');
    if (path.endsWith('/comments') && !positive(got.id))
      throw new Error('对账留言回执 id 认不出，结果未知。');
    for (const [key, value] of Object.entries(sent)) {
      if (key === 'replace_parent') continue;
      const actual =
        key === 'sub_issue_id'
          ? got.id
          : key === 'milestone'
            ? object(got.milestone)
              ? got.milestone.number
              : got.milestone
            : got[key];
      const same =
        key === 'labels'
          ? Array.isArray(value) &&
            Array.isArray(actual) &&
            value.every((label) => actual.some((entry) => object(entry) && entry.name === label))
          : actual === value;
      if (!same) throw new Error(`对账写回执字段 ${key} 不符，结果未知。`);
    }
    return response;
  };
}

export async function auditClient(
  repo: string,
  env: Env,
  opts: Options = {},
): Promise<ReturnType<typeof liveGitHub>> {
  // Actions 的安装令牌身份保持原样；不因本机 gh 配置改变 CI 的写入身份。
  if (env.GITHUB_ACTIONS === 'true' || !(await ghSocketConfigured(env, opts.runGh ?? runGh)))
    return liveGitHub(repo, env, opts);
  return liveGitHub(
    repo,
    { GITHUB_API_URL: env.GITHUB_API_URL },
    {
      fetchImpl: auditGhFetch(repo, env, opts.runGh ?? runGh),
      token: () => undefined,
    },
  );
}
