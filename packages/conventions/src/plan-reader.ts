// plan 的本机读取装配：明确配置 gh socket 时沿用 gh 的传输，不搬令牌到直连 HTTP。
// plan 只暴露 reader；audit-client 显式复用读取及进程封装，写入另设允许范围和回执检查。
import { execFile } from 'node:child_process';
import { type GitHubReader, githubToken, liveGitHub } from './github-api.ts';

type Env = Record<string, string | undefined>;
export interface GhReadResult {
  stdout: string;
  code: number | null;
  failure?: 'unavailable' | 'transport';
}
export type RunGhRead = (args: string[], env: Env, input?: string) => Promise<GhReadResult>;

/** 不把子进程的 stderr、socket 路径或身份信息带进报错。 */
export const runGh: RunGhRead = (args, env, input) =>
  new Promise((resolve) => {
    const inputFailure = () => resolve({ stdout: '', code: null, failure: 'transport' });
    const child = execFile(
      'gh',
      args,
      { env, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (!error) return resolve({ stdout, code: 0 });
        const code = 'code' in error ? error.code : undefined;
        resolve({
          stdout,
          code: typeof code === 'number' ? code : null,
          ...(code === 'ENOENT'
            ? { failure: 'unavailable' as const }
            : error.killed || error.signal || typeof code !== 'number'
              ? { failure: 'transport' as const }
              : {}),
        });
      },
    );
    if (input !== undefined) {
      if (!child.stdin) return inputFailure();
      child.stdin.on('error', inputFailure);
      child.stdin.end(input);
    }
  });

/** 复用 liveGitHub 的状态判法、严格 JSON 解析和 Link 分页；传输本身拒绝写入和越仓请求。 */
export function ghReadFetch(repo: string, env: Env, run: RunGhRead = runGh): typeof fetch {
  const api = new URL((env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''));
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash)
    throw new Error('GitHub 的 GitHub API 地址无效，没读成。');
  const base = api.pathname.replace(/\/+$/, '');
  const repoPath = `${base}/repos/${repo}`;
  const numericPath = `${base}/repositories/`;
  let repositoryId: number | undefined;
  const transport: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    if (
      (init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'GET' ||
      init?.body != null ||
      request?.body
    )
      throw new Error('GitHub 的 gh 传输只允许无正文的 GET。');
    const url = new URL(request?.url ?? String(input));
    if (
      url.origin !== api.origin ||
      /%2f|%5c|%2e/i.test(url.pathname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('GitHub 的 GitHub 请求越过当前仓或 API，没读成。');
    const named = url.pathname === repoPath || url.pathname.startsWith(`${repoPath}/`);
    if (!named) {
      const id = url.pathname.startsWith(numericPath)
        ? /^([1-9]\d*)\//.exec(url.pathname.slice(numericPath.length))?.[1]
        : undefined;
      if (!id) throw new Error('GitHub 的 GitHub 请求越过当前仓或 API，没读成。');
      // GitHub 的 Link 会改用数字仓号；先从当前仓的元信息核对，不信 Link 自报身份。
      if (repositoryId === undefined) {
        const identity = await transport(`${api.origin}${repoPath}`);
        if (!identity.ok) throw new Error(`GitHub 核对仓身份，GitHub 回了 ${identity.status}。`);
        let data: unknown;
        try {
          data = await identity.json();
        } catch {
          throw new Error('GitHub 核对仓身份，响应不是合法 JSON。');
        }
        if (
          typeof data !== 'object' ||
          data === null ||
          !('id' in data) ||
          !('full_name' in data) ||
          !Number.isSafeInteger(data.id) ||
          Number(data.id) <= 0 ||
          typeof data.full_name !== 'string' ||
          data.full_name.toLowerCase() !== repo.toLowerCase()
        )
          throw new Error('GitHub 核对仓身份，仓号或仓名认不出。');
        repositoryId = Number(data.id);
      }
      if (String(repositoryId) !== id) throw new Error('GitHub 的 GitHub 分页仓号与当前仓不符，没读成。');
    }
    const result = await run(
      [
        'api',
        '--include',
        '--method',
        'GET',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        url.href,
      ],
      env,
    );
    return ghResponse(result);
  };
  return transport;
}

/** gh 的有界进程结果：HTTP 错误仍交给调用方原判据；进程失败不能冒充响应。 */
export function ghResponse(result: GhReadResult): Response {
  if (result.failure) throw new Error('GitHub 的 gh 请求没完成（进程不可用、超时或输出超限）。');
  const head = /^HTTP\/\d+(?:\.\d+)? (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n/.exec(result.stdout);
  if (!head) throw new Error('GitHub 的 gh 没返回可辨认的 HTTP 状态和响应头。');
  const status = Number(head[1]);
  if (status < 200 || status > 599 || (result.code !== 0 && !(result.code === 1 && status >= 400)))
    throw new Error('GitHub 的 gh 进程失败，没读成。');
  const headers = new Headers();
  for (const line of (head[2] ?? '').split(/\r?\n/)) {
    if (!line) continue;
    const at = line.indexOf(':');
    if (at <= 0) throw new Error('GitHub 的 gh 响应头认不出。');
    try {
      headers.append(line.slice(0, at), line.slice(at + 1).trim());
    } catch {
      throw new Error('GitHub 的 gh 响应头认不出。');
    }
  }
  return new Response([204, 205, 304].includes(status) ? null : result.stdout.slice(head[0].length), {
    status,
    headers,
  });
}

export async function ghSocketConfigured(env: Env, run: RunGhRead = runGh): Promise<boolean> {
  const config = await run(['config', 'get', 'http_unix_socket'], env);
  const absent = config.failure === 'unavailable' && !env.GH_CONFIG_DIR;
  if (!absent && (config.failure || config.code !== 0)) throw new Error('没读成：无法读取 gh 的传输配置。');
  return !absent && config.stdout.trim() !== '';
}

export async function planReader(
  repo: string,
  env: Env,
  opts: { runGh?: RunGhRead; fetchImpl?: typeof fetch; token?: () => string | undefined } = {},
): Promise<GitHubReader | undefined> {
  const run = opts.runGh ?? runGh;
  const bridge = await ghSocketConfigured(env, run);
  const token = bridge ? undefined : githubToken(env, opts.token);
  if (!bridge && token === undefined) return undefined;
  const client = bridge
    ? liveGitHub(
        repo,
        { GITHUB_API_URL: env.GITHUB_API_URL },
        {
          fetchImpl: ghReadFetch(repo, env, run),
          token: () => undefined,
        },
      )
    : liveGitHub(repo, env, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), token: () => token });
  const { openIssues, issue, milestones, milestoneIssues, subIssues, recentPulls } = client;
  return { openIssues, issue, milestones, milestoneIssues, subIssues, recentPulls };
}
