// 本机面板对 GitLab 的三步（#3944）：人点了才做。
// 和 GitHub 一样先入 change.*，再由这次点击做完。令牌只从数据目录读，不进命令行、不进载荷。
// 合并只认 merge 和 squash。别的方式按它的名字拒绝，不改成这两种。
import { fileURLToPath } from 'node:url';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { runCommand } from '../command.ts';
import { isGitlabHost, remoteHost, reviewState } from './git.ts';
import { type CmdResult, type CmdRun, panelHostEnv } from './github-ops.ts';

export interface GitlabRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface GitlabResponse {
  status: number;
  json: unknown;
}

/** 测试注入假响应。不给就走 fetch。 */
export type GitlabFetch = (req: GitlabRequest) => Promise<GitlabResponse>;

const SHA = /^[0-9a-f]{40}$/;

export interface GitlabRemote {
  host: string;
  apiBase: string;
  project: string;
}

export function parseGitlabRemote(remote: string): GitlabRemote {
  const raw = remote.trim().replace(/\/\/[^@/\s]+@/, '//');
  const host = remoteHost(raw);
  if (!host) throw new Error('认不出 GitLab 地址');
  if (raw.toLowerCase().includes('fleet-dao')) throw new Error('不往 fleet-dao 推');
  let project = '';
  let apiBase = `https://${host}/api/v4`;
  if (raw.includes('://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('认不出 GitLab 地址');
    }
    project = url.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    if (url.protocol === 'https:' || url.protocol === 'http:')
      apiBase = `${url.protocol}//${url.host}/api/v4`;
  } else {
    const path = /^(?:[^@\s]+@)?[^:\s]+:(.+)$/.exec(raw)?.[1] ?? '';
    project = path
      .replace(/\.git$/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }
  if (!project || project.includes('..')) throw new Error('认不出 GitLab 项目');
  return { host, apiBase, project };
}

/** 做得到的才有请求体。别的名字抛错，调用方不会换成 merge。 */
export function gitlabMergeBody(method: string, sha: string): { sha: string; squash: boolean } {
  if (!SHA.test(sha)) throw new Error('要带上看到的 head');
  if (method === 'merge') return { sha, squash: false };
  if (method === 'squash') return { sha, squash: true };
  throw new Error(`GitLab 做不到 ${method}`);
}

function shQuote(value: string): string {
  return `'${value.replaceAll('\\', '/').replaceAll("'", `'"'"'`)}'`;
}

/** 口令助手只拿到令牌文件的路径，参数里没有令牌。 */
export function gitlabCredentialHelper(): string {
  const node = shQuote(process.execPath);
  const script = shQuote(fileURLToPath(new URL('./gitlab-credential.mjs', import.meta.url)));
  return `!${node} ${script}`;
}

export function gitlabRunEnv(tokenFile: string): Record<string, string> {
  return panelHostEnv({ FLEET2_GITLAB_TOKEN_FILE: tokenFile });
}

export function defaultGitlabRun(tokenFile: string | null, token: string | null): CmdRun {
  const redact = makeRedactor(token ? [token] : []);
  const trustedEnv = tokenFile ? gitlabRunEnv(tokenFile) : panelHostEnv();
  return (cwd, command) =>
    runCommand({ command, cwd, timeoutMs: 60_000, redact, trustedEnv }).then((r) => ({
      ran: r.ran,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderrTail: r.stderrTail,
      ...(r.spawnError ? { spawnError: r.spawnError } : {}),
    }));
}

export async function defaultGitlabFetch(req: GitlabRequest): Promise<GitlabResponse> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      signal: AbortSignal.timeout(20_000),
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : '';
    throw new Error(`连不上 GitLab${why ? `：${why}` : ''}`);
  }
  const text = await res.text();
  if (!text.trim()) return { status: res.status, json: null };
  try {
    return { status: res.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, json: { message: text.slice(0, 200) } };
  }
}

function hide(token: string, text: string): string {
  return token ? text.split(token).join('***') : text;
}

function tail(r: CmdResult): string {
  return (r.stderrTail || r.stdout || r.spawnError || '').trim().slice(-300);
}

function fail(r: CmdResult, what: string): never {
  throw new Error(`${what}没成：${tail(r) || '没有输出'}`);
}

function messageOf(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const msg = (json as { message?: unknown }).message;
  if (typeof msg === 'string') return msg.slice(0, 200);
  if (Array.isArray(msg))
    return msg
      .map((item) => String(item))
      .join(' ')
      .slice(0, 200);
  return '';
}

interface MrRow {
  iid: number;
  state: string;
  sha: string;
  webUrl: string;
  source: string;
  draft: boolean;
}

function mrOf(json: unknown, token: string): MrRow {
  if (!json || typeof json !== 'object') throw new Error('GitLab 读到的不是 MR');
  const o = json as Record<string, unknown>;
  if (typeof o.iid !== 'number') throw new Error('GitLab 读到的不是 MR');
  const sha = typeof o.sha === 'string' ? o.sha : '';
  if (!SHA.test(sha)) throw new Error(hide(token, 'GitLab 没给出这次提交'));
  return {
    iid: o.iid,
    state: typeof o.state === 'string' ? o.state : '',
    sha,
    webUrl: typeof o.web_url === 'string' ? o.web_url : '',
    source: typeof o.source_branch === 'string' ? o.source_branch : '',
    draft: o.draft === true,
  };
}

async function call(
  fetchImpl: GitlabFetch,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<GitlabResponse> {
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': token,
    accept: 'application/json',
  };
  let text: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    text = JSON.stringify(body);
  }
  try {
    return await fetchImpl({ method, url, headers, ...(text !== undefined ? { body: text } : {}) });
  } catch (err) {
    const why = err instanceof Error ? err.message : '没做成';
    throw new Error(hide(token, why));
  }
}

function okJson(res: GitlabResponse, token: string, what: string): unknown {
  if (res.status >= 200 && res.status < 300) return res.json;
  const detail = hide(token, messageOf(res.json));
  if (what === '合并' && (res.status === 409 || res.status === 405 || res.status === 422)) {
    throw new Error('分支又有新提交，没合并');
  }
  throw new Error(hide(token, `${what}没成：GitLab 回了 ${res.status}${detail ? ` ${detail}` : ''}`));
}

async function readOrigin(run: CmdRun, cwd: string, hosts: readonly string[]): Promise<string> {
  const remote = await run(cwd, ['git', '-c', 'safe.directory=*', 'remote', 'get-url', 'origin']);
  if (!remote.ran || remote.exitCode !== 0) fail(remote, '读 origin');
  const url = remote.stdout.trim();
  const host = remoteHost(url);
  if (!host || !isGitlabHost(host, hosts)) throw new Error('这个远端不是 GitLab');
  if (url.toLowerCase().includes('fleet-dao')) throw new Error('不往 fleet-dao 推');
  return url.replace(/\/\/[^@/\s]+@/, '//');
}

function assertBranch(branch: string): void {
  if (
    branch === '' ||
    branch === 'HEAD' ||
    branch === 'main' ||
    branch === 'master' ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error(branch === 'main' || branch === 'master' ? '不动 main' : '这个分支不能推');
  }
}

export async function pushGitlabBranch(
  run: CmdRun,
  cwd: string,
  branch: string,
  opts: { tokenFile: string | null; hosts: readonly string[] },
): Promise<Record<string, unknown>> {
  assertBranch(branch);
  const remote = await readOrigin(run, cwd, opts.hosts);
  const head = await run(cwd, ['git', '-c', 'safe.directory=*', 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ran || head.exitCode !== 0) fail(head, '读分支');
  if (head.stdout.trim() !== branch) throw new Error('分支和载荷对不上');
  const https = /^https?:\/\//i.test(remote);
  if (https && !opts.tokenFile) throw new Error('缺 GitLab 令牌');
  const pushed = await run(cwd, [
    'git',
    '-c',
    'safe.directory=*',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    ...(https ? ['-c', 'credential.helper=', '-c', `credential.helper=${gitlabCredentialHelper()}`] : []),
    'push',
    '--porcelain',
    '-u',
    'origin',
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!pushed.ran || pushed.exitCode !== 0) fail(pushed, '推送');
  return { remote, branch };
}

async function projectDefault(fetchImpl: GitlabFetch, token: string, remote: GitlabRemote): Promise<string> {
  const res = await call(
    fetchImpl,
    token,
    'GET',
    `${remote.apiBase}/projects/${encodeURIComponent(remote.project)}`,
  );
  const json = okJson(res, token, '读项目');
  const branch =
    json &&
    typeof json === 'object' &&
    typeof (json as { default_branch?: unknown }).default_branch === 'string'
      ? (json as { default_branch: string }).default_branch
      : '';
  if (!branch) throw new Error('GitLab 没给出默认分支');
  return branch;
}

async function listMrs(
  fetchImpl: GitlabFetch,
  token: string,
  remote: GitlabRemote,
  branch: string,
  state: 'opened' | 'all',
): Promise<MrRow[]> {
  const query = new URLSearchParams({
    source_branch: branch,
    state,
    order_by: 'updated_at',
    sort: 'desc',
    per_page: '20',
  });
  const res = await call(
    fetchImpl,
    token,
    'GET',
    `${remote.apiBase}/projects/${encodeURIComponent(remote.project)}/merge_requests?${query}`,
  );
  const json = okJson(res, token, '读 MR');
  if (!Array.isArray(json)) throw new Error('GitLab 读到的不是 MR 列表');
  return json.map((item) => mrOf(item, token)).filter((row) => row.source === branch);
}

async function pipelinesOf(
  fetchImpl: GitlabFetch,
  token: string,
  remote: GitlabRemote,
  iid: number,
): Promise<{ name: string; state: string }[]> {
  const res = await call(
    fetchImpl,
    token,
    'GET',
    `${remote.apiBase}/projects/${encodeURIComponent(remote.project)}/merge_requests/${iid}/pipelines`,
  );
  const json = okJson(res, token, '读流水线');
  if (!Array.isArray(json)) throw new Error('GitLab 读到的不是流水线');
  const checks: { name: string; state: string }[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; status?: unknown };
    const name = typeof row.id === 'number' ? `流水线 ${row.id}` : '流水线';
    const state = typeof row.status === 'string' && row.status ? row.status : 'unknown';
    checks.push({ name, state });
  }
  return checks;
}

export async function openGitlabMr(
  fetchImpl: GitlabFetch,
  token: string,
  remoteUrl: string,
  branch: string,
  title: string,
  hosts: readonly string[],
): Promise<Record<string, unknown>> {
  assertBranch(branch);
  const remote = parseGitlabRemote(remoteUrl);
  if (!isGitlabHost(remote.host, hosts)) throw new Error('这个远端不是 GitLab');
  const existing = await listMrs(fetchImpl, token, remote, branch, 'opened');
  const had = existing[0];
  if (had) return { number: had.iid, url: had.webUrl, opened: false, sha: had.sha };
  const target = await projectDefault(fetchImpl, token, remote);
  const created = await call(
    fetchImpl,
    token,
    'POST',
    `${remote.apiBase}/projects/${encodeURIComponent(remote.project)}/merge_requests`,
    { source_branch: branch, target_branch: target, title: title.trim() || branch },
  );
  const mr = mrOf(okJson(created, token, '开 MR'), token);
  if (mr.source && mr.source !== branch) throw new Error('开出来的 MR 不是这个分支');
  if (mr.state !== 'opened') throw new Error('MR 开出来了但不是开着的');
  return { number: mr.iid, url: mr.webUrl, opened: true, sha: mr.sha };
}

export async function readGitlabMr(
  fetchImpl: GitlabFetch,
  token: string,
  remoteUrl: string,
  branch: string,
  hosts: readonly string[],
): Promise<{
  number: number;
  url: string;
  state: string;
  sha: string;
  checks: { name: string; state: string }[];
} | null> {
  const remote = parseGitlabRemote(remoteUrl);
  if (!isGitlabHost(remote.host, hosts)) throw new Error('这个远端不是 GitLab');
  const opened = await listMrs(fetchImpl, token, remote, branch, 'opened');
  const mr = opened[0] ?? (await listMrs(fetchImpl, token, remote, branch, 'all'))[0];
  if (!mr) return null;
  const checks = await pipelinesOf(fetchImpl, token, remote, mr.iid);
  return {
    number: mr.iid,
    url: mr.webUrl,
    state: reviewState(mr.state, mr.draft),
    sha: mr.sha,
    checks,
  };
}

export async function mergeGitlabMr(
  run: CmdRun,
  fetchImpl: GitlabFetch,
  token: string,
  cwd: string,
  expectedHead: string,
  method: string,
  hosts: readonly string[],
): Promise<Record<string, unknown>> {
  const body = gitlabMergeBody(method, expectedHead);
  const remoteUrl = await readOrigin(run, cwd, hosts);
  const remote = parseGitlabRemote(remoteUrl);
  const local = await run(cwd, ['git', '-c', 'safe.directory=*', 'rev-parse', 'HEAD']);
  if (!local.ran || local.exitCode !== 0) fail(local, '读 head');
  if (local.stdout.trim() !== expectedHead) throw new Error('分支又有新提交，没合并');
  const named = await run(cwd, ['git', '-c', 'safe.directory=*', 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!named.ran || named.exitCode !== 0) fail(named, '读分支');
  const branch = named.stdout.trim();
  const opened = await listMrs(fetchImpl, token, remote, branch, 'opened');
  const any = opened[0] ?? (await listMrs(fetchImpl, token, remote, branch, 'all'))[0];
  if (!any) throw new Error('没有 MR');
  if (any.sha !== expectedHead) throw new Error('分支又有新提交，没合并');
  if (any.state === 'merged') return { number: any.iid, url: any.webUrl };
  if (any.state !== 'opened') throw new Error(`MR #${any.iid} 现在是 ${any.state}，没合并`);
  const merged = await call(
    fetchImpl,
    token,
    'PUT',
    `${remote.apiBase}/projects/${encodeURIComponent(remote.project)}/merge_requests/${any.iid}/merge`,
    body,
  );
  const after = mrOf(okJson(merged, token, '合并'), token);
  if (after.sha !== expectedHead && after.state !== 'merged') throw new Error('分支又有新提交，没合并');
  if (after.state !== 'merged') throw new Error('合并没有对上');
  return { number: after.iid, url: after.webUrl };
}
