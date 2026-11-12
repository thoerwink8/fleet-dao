// 本机面板对 GitHub 的三步（#3948）：人点了才做，命令只经 runCommand。
// 不走内核的发布令牌，也不给 github-write 加合并。远端含 fleet-dao 或 GitLab 的直接拒。
// 合并带上看到的 40 位 head：对不上，或 gh 的 --match-head-commit 拒了，就不合并。
import { makeRedactor } from '@fleet-dao/harness-runner';
import { runCommand } from '../command.ts';

export interface CmdResult {
  ran: boolean;
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
  spawnError?: string;
}

/** 一条不经 shell 的命令。测试注入假的，真跑走 runCommand。 */
export type CmdRun = (cwd: string, command: readonly string[]) => Promise<CmdResult>;

const redact = makeRedactor([]);
const SHA = /^[0-9a-f]{40}$/;

/** 内核自己跑 gh/git：带上家目录（gh 的登录在里面）和代理。不把 GH_TOKEN 抄进环境。 */
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TZ',
    'TERM',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

export function defaultGithubRun(cwd: string, command: readonly string[]): Promise<CmdResult> {
  return runCommand({ command, cwd, timeoutMs: 60_000, redact, trustedEnv: hostEnv() }).then((r) => ({
    ran: r.ran,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderrTail: r.stderrTail,
    ...(r.spawnError ? { spawnError: r.spawnError } : {}),
  }));
}

function tail(r: CmdResult): string {
  return (r.stderrTail || r.stdout || r.spawnError || '').trim().slice(-300);
}

function fail(r: CmdResult, what: string): never {
  throw new Error(`${what}没成：${tail(r) || '没有输出'}`);
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

/** 只认 GitHub，且不是 fleet-dao。地址里的账号口令不往外带。 */
export function assertGithubRemote(url: string): string {
  const raw = url.trim();
  const low = raw.toLowerCase();
  if (!low) throw new Error('没有 origin');
  if (low.includes('fleet-dao')) throw new Error('不往 fleet-dao 推');
  if (low.includes('gitlab')) throw new Error('gitlab 还没实现');
  if (!low.includes('github.com')) throw new Error('这个远端不是 GitHub');
  return raw.replace(/\/\/[^@/]+@/, '//');
}

async function originUrl(run: CmdRun, cwd: string): Promise<string> {
  const remote = await run(cwd, ['git', '-c', 'safe.directory=*', 'remote', 'get-url', 'origin']);
  if (!remote.ran || remote.exitCode !== 0) fail(remote, '读 origin');
  return assertGithubRemote(remote.stdout);
}

function jsonOf(stdout: string): Record<string, unknown> {
  const line = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{'))
    .at(-1);
  if (!line) throw new Error('GitHub 读到的不是 JSON');
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('GitHub 读到的不是 JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('GitHub 读到的不是 JSON');
  return value as Record<string, unknown>;
}

interface PrView {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
  headRefName: string;
}

async function viewPr(run: CmdRun, cwd: string): Promise<PrView> {
  const r = await run(cwd, ['gh', 'pr', 'view', '--json', 'number,url,state,headRefOid,headRefName']);
  if (!r.ran || r.exitCode !== 0) fail(r, '读 PR');
  const o = jsonOf(r.stdout);
  if (typeof o.number !== 'number') throw new Error('GitHub 读到的不是 PR');
  return {
    number: o.number,
    url: typeof o.url === 'string' ? o.url : '',
    state: typeof o.state === 'string' ? o.state : '',
    headRefOid: typeof o.headRefOid === 'string' ? o.headRefOid : '',
    headRefName: typeof o.headRefName === 'string' ? o.headRefName : '',
  };
}

export async function pushCurrentBranch(
  run: CmdRun,
  cwd: string,
  branch: string,
): Promise<Record<string, unknown>> {
  assertBranch(branch);
  const remote = await originUrl(run, cwd);
  const head = await run(cwd, ['git', '-c', 'safe.directory=*', 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ran || head.exitCode !== 0) fail(head, '读分支');
  if (head.stdout.trim() !== branch) throw new Error('分支和载荷对不上');
  const pushed = await run(cwd, [
    'git',
    '-c',
    'safe.directory=*',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential',
    'push',
    '--porcelain',
    '-u',
    'origin',
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!pushed.ran || pushed.exitCode !== 0) fail(pushed, '推送');
  return { remote, branch };
}

export async function openPullRequest(
  run: CmdRun,
  cwd: string,
  branch: string,
  title: string,
): Promise<Record<string, unknown>> {
  assertBranch(branch);
  await originUrl(run, cwd);
  const name = title.trim() || branch;
  const existing = await run(cwd, ['gh', 'pr', 'view', '--json', 'number,url,state,headRefOid,headRefName']);
  if (existing.ran && existing.exitCode === 0) {
    const pr = jsonOf(existing.stdout);
    const headName = typeof pr.headRefName === 'string' ? pr.headRefName : '';
    if (headName && headName !== branch) throw new Error('当前分支对不上这个 PR');
    if (typeof pr.number !== 'number') throw new Error('GitHub 读到的不是 PR');
    return {
      number: pr.number,
      url: typeof pr.url === 'string' ? pr.url : '',
      opened: false,
    };
  }
  const created = await run(cwd, ['gh', 'pr', 'create', '--head', branch, '--title', name, '--body', name]);
  if (!created.ran || created.exitCode !== 0) fail(created, '开 PR');
  const pr = await viewPr(run, cwd);
  if (pr.headRefName && pr.headRefName !== branch) throw new Error('开出来的 PR 不是这个分支');
  if (pr.state !== 'OPEN') throw new Error('PR 开出来了但不是开着的');
  return { number: pr.number, url: pr.url, opened: true };
}

export async function mergePullRequest(
  run: CmdRun,
  cwd: string,
  expectedHead: string,
): Promise<Record<string, unknown>> {
  if (!SHA.test(expectedHead)) throw new Error('要带上看到的 head');
  await originUrl(run, cwd);
  const local = await run(cwd, ['git', '-c', 'safe.directory=*', 'rev-parse', 'HEAD']);
  if (!local.ran || local.exitCode !== 0) fail(local, '读 head');
  if (local.stdout.trim() !== expectedHead) throw new Error('分支又有新提交，没合并');
  const pr = await viewPr(run, cwd);
  if (pr.headRefOid !== expectedHead) throw new Error('分支又有新提交，没合并');
  if (pr.state === 'MERGED') return { number: pr.number, url: pr.url };
  if (pr.state !== 'OPEN') throw new Error(`PR #${pr.number} 现在是 ${pr.state}，没合并`);
  const merged = await run(cwd, [
    'gh',
    'pr',
    'merge',
    String(pr.number),
    '--merge',
    '--match-head-commit',
    expectedHead,
  ]);
  const after = await viewPr(run, cwd);
  if (after.headRefOid !== expectedHead) throw new Error('分支又有新提交，没合并');
  if (after.state === 'MERGED') return { number: after.number, url: after.url };
  if (!merged.ran || merged.exitCode !== 0) fail(merged, '合并');
  throw new Error('合并没有对上');
}
