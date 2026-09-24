// 跑 git 子进程：凭据只走环境变量里的一次性配置（GIT_CONFIG_COUNT/KEY/VALUE），不进命令行参数（ps 看得见）、
// 不写进 remote 地址、不落盘；子进程环境里不留 GH_TOKEN 之类的个人凭据，也不让它弹窗要密码。
//
// 改这里之前必须知道：带令牌的 git 进程绝不在 AI 会话的工作树里跑——工作树的 .git/config、钩子是会话写得到的，
// 一条 core.hooksPath、reference-transaction 钩子、insteadOf 就能把令牌带走。推送在引擎自己的裸仓（镜像）里做，
// 会话的提交经 GIT_ALTERNATE_OBJECT_DIRECTORIES 只按对象读进来：不在会话的仓里执行任何 git 命令、不读它的配置。
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { GitHubError, redact } from './errors.ts';

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitCall {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export type GitRunner = (args: string[], call: GitCall) => Promise<GitRun>;

export const execGit: GitRunner = (args, call) =>
  new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      {
        cwd: call.cwd,
        env: call.env,
        timeout: call.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolvePromise({
          code,
          stdout: String(stdout),
          stderr: String(stderr) || (code === -1 && error ? String(error.message) : ''),
        });
      },
    );
  });

/** 子进程环境里不许有的：个人凭据、会让 git 换目录/换对象库/打印请求头的变量。 */
const DROP_ENV: readonly RegExp[] = [
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /^GIT_ASKPASS$/i,
  /^SSH_ASKPASS$/i,
  /^GIT_CONFIG_/i,
  /^GIT_CONFIG$/i,
  /^GIT_DIR$/i,
  /^GIT_WORK_TREE$/i,
  /^GIT_INDEX_FILE$/i,
  /^GIT_OBJECT_DIRECTORY$/i,
  /^GIT_ALTERNATE_OBJECT_DIRECTORIES$/i,
  /^GIT_NAMESPACE$/i,
  /^GIT_COMMON_DIR$/i,
  // GIT_TRACE_CURL 等会把请求头打出来
  /^GIT_TRACE/i,
  /^GIT_CURL_VERBOSE$/i,
  /^GIT_SSH/i,
  /^GIT_PROXY_COMMAND$/i,
];

export interface GitEnvOptions {
  /** 父进程环境，默认 process.env；只去掉 DROP_ENV 里的键。 */
  base?: Readonly<Record<string, string | undefined>> | undefined;
  /** 一次性配置（按顺序进 GIT_CONFIG_KEY_n/VALUE_n；同名多值的键，空值 = 清空之前的）。 */
  config?: readonly (readonly [string, string])[] | undefined;
  /** 额外的对象库（只读地借会话仓里的提交）。 */
  alternates?: readonly string[] | undefined;
}

export function gitEnv(options: GitEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.base ?? process.env)) {
    if (v === undefined) continue;
    if (DROP_ENV.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  // 输出要按英文认（推送失败的原因分类），别被本机语言设置改掉
  env.LC_ALL = 'C';
  env.LANGUAGE = 'C';
  const config: (readonly [string, string])[] = [
    // 不用机器上配的任何凭据助手：推送一律显式带机器人的令牌（A5：挡掉个人登录后照样推得动）
    ['credential.helper', ''],
    ...(options.config ?? []),
  ];
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  if (options.alternates?.length)
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = options.alternates.join(pathListSeparator());
  return env;
}

function pathListSeparator(): string {
  return process.platform === 'win32' ? ';' : ':';
}

/**
 * 给某个 GitHub 主机（例如 https://github.com/）带上安装令牌的一次性请求头。按地址前缀限定：
 * 地址被改写到别处（insteadOf）时请求头不会跟过去。先放一个空值清掉机器上已有的同类请求头（actions/checkout 会留一个）。
 */
export function authHeaderConfig(gitHost: string, token: string): [string, string][] {
  const prefix = gitHost.endsWith('/') ? gitHost : `${gitHost}/`;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return [
    [`http.${prefix}.extraHeader`, ''],
    [`http.${prefix}.extraHeader`, `AUTHORIZATION: basic ${basic}`],
  ];
}

/**
 * 找工作树的对象库目录——只读文件，不跑 git（不在会话的仓里执行任何东西）。
 * 普通仓：<树>/.git/objects；加出来的工作树：.git 是个文件，指到主仓的 worktrees/<名>，再按 commondir 找到主仓。
 */
export function objectsDirOf(worktreePath: string): string {
  const dotGit = join(worktreePath, '.git');
  let gitDir: string;
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!m?.[1]) throw new Error('.git 文件里没有 gitdir');
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(worktreePath, m[1]);
    }
  } catch (err) {
    // 也许传进来的就是个裸仓
    try {
      if (
        statSync(join(worktreePath, 'objects')).isDirectory() &&
        statSync(join(worktreePath, 'HEAD')).isFile()
      ) {
        return join(worktreePath, 'objects');
      }
    } catch {
      // 落到下面报错
    }
    throw new GitHubError(
      'WORKTREE_UNREADABLE',
      `找不到工作树 ${worktreePath} 的仓库目录：${redact(String(err))}`,
    );
  }
  let commonDir = gitDir;
  try {
    const rel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (rel) commonDir = isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } catch {
    // 没有 commondir 就是主仓自己
  }
  const objects = join(commonDir, 'objects');
  try {
    if (!statSync(objects).isDirectory()) throw new Error('不是目录');
  } catch (err) {
    throw new GitHubError(
      'WORKTREE_UNREADABLE',
      `工作树 ${worktreePath} 的对象库 ${objects} 读不了：${redact(String(err))}`,
    );
  }
  return objects;
}

export type PushFailure =
  /** 机器人没有 workflows 权限而推送碰了 .github/workflows/：换多少次都一样，要人（C3）。 */
  | 'workflow_permission'
  /** 远端分支不是我们要推的祖先（别人推过、或分叉了）。 */
  | 'non_fast_forward'
  /** 规则集、保护分支拒了。 */
  | 'rule_rejected'
  /** 凭据、权限不对。 */
  | 'auth'
  /** 网络、GitHub 临时故障：可以重试。 */
  | 'transient'
  | 'unknown';

/** 推送失败按原因分类。只认 git 与 GitHub 的固定说法（LC_ALL=C 下），认不出来的归 unknown（按可重试处理，但次数有限）。 */
export function classifyPushFailure(stderr: string): PushFailure {
  const s = stderr.toLowerCase();
  if (
    s.includes('refusing to allow a github app to create or update workflow') ||
    s.includes('`workflows` permission')
  )
    return 'workflow_permission';
  if (s.includes('gh013') || s.includes('repository rule violations') || s.includes('protected branch'))
    return 'rule_rejected';
  if (
    s.includes('non-fast-forward') ||
    s.includes('fetch first') ||
    s.includes('[rejected]') ||
    s.includes('stale info')
  )
    return 'non_fast_forward';
  if (
    s.includes('authentication failed') ||
    s.includes('permission to') ||
    s.includes('403') ||
    s.includes('401') ||
    s.includes('could not read username') ||
    s.includes('terminal prompts disabled')
  )
    return 'auth';
  if (
    s.includes('could not resolve host') ||
    s.includes('connection timed out') ||
    s.includes('connection reset') ||
    s.includes('early eof') ||
    s.includes('rpc failed') ||
    s.includes('the remote end hung up') ||
    s.includes('502') ||
    s.includes('503') ||
    s.includes('504') ||
    s.includes('operation timed out') ||
    s.includes('failed to connect')
  )
    return 'transient';
  return 'unknown';
}

export function tail(text: string, max = 400): string {
  const t = redact(text.trim());
  return t.length > max ? `…${t.slice(-max)}` : t || '（没有输出）';
}
