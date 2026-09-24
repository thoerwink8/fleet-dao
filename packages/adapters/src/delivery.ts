// 交付判据：执行体说「做完了」不算数。会话只在本地提交，推分支由引擎在会话外做，所以交付 = 引擎能推走的东西：
// 1. 相对「此刻」的目标分支有自己的提交，而且有内容差异——必须先抓最新的目标分支再比：拿旧的比，
//    被快进到新主线、自己一行没写的树也会显得「有新提交」（旧系统一次零产出的假完成就这样一路绿到合并，windsurf-dao#1572）；
// 2. 这一轮会话自己有新提交（since..HEAD）——续会话那一轮什么都没做，不能靠上一轮的提交算交付；
// 3. 已跟踪的文件没有没提交的改动——引擎只推提交，这部分会丢。没跟踪的文件（构建产物之类）不算。
import { execFile } from 'node:child_process';

export interface DeliveryCheck {
  /** unknown = 没查成（抓取失败、找不到分支、git 出错），不等于没交付。 */
  state: 'delivered' | 'not_delivered' | 'unknown';
  /** 比较基准，例如 refs/remotes/origin/main。 */
  target: string;
  /** 目标分支上没有、HEAD 上有的提交数。 */
  ownCommits?: number;
  /** 这一轮会话新增的提交数（since..HEAD）。 */
  newCommits?: number;
  /** 相对合并基有没有内容差异。 */
  hasDiff?: boolean;
  /** 已跟踪文件里没提交的改动条数（git status --porcelain --untracked-files=no）。 */
  uncommitted?: number;
  detail: string;
}

export interface DeliveryOptions {
  /** 工作树。 */
  cwd: string;
  remote: string;
  branch: string;
  /** 起这一轮会话之前的 HEAD：这一轮必须在它之后有新提交。 */
  since: string;
  /** 默认先 git fetch 目标分支；只在确定刚抓过时才关。 */
  fetch?: boolean;
  timeoutMs?: number;
  /** 跑 git 用的环境（抓取私有仓要带凭据——这是引擎的环境，不是会话的）；默认用当前进程的。 */
  env?: Record<string, string | undefined>;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

export async function checkDelivery(options: DeliveryOptions): Promise<DeliveryCheck> {
  const target = `refs/remotes/${options.remote}/${options.branch}`;
  const unknown = (detail: string): DeliveryCheck => ({ state: 'unknown', target, detail });
  const git = (args: string[]) => runGit(args, options);

  if (options.fetch !== false) {
    const fetched = await git(['fetch', '--quiet', '--no-tags', options.remote, options.branch]);
    if (fetched.code !== 0)
      return unknown(`抓取 ${options.remote}/${options.branch} 失败：${tail(fetched.stderr)}`);
  }
  for (const ref of [target, options.since]) {
    const verified = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (verified.code !== 0) return unknown(`找不到提交 ${ref}`);
  }

  const ownCommits = await count(git, `${target}..HEAD`);
  const newCommits = await count(git, `${options.since}..HEAD`);
  if (ownCommits === undefined || newCommits === undefined) return unknown('数提交失败');

  const diffed = await git(['diff', '--quiet', `${target}...HEAD`]);
  if ((diffed.code !== 0 && diffed.code !== 1) || diffed.stderr.trim()) {
    return unknown(`比内容失败：${tail(diffed.stderr)}`);
  }
  const hasDiff = diffed.code === 1;

  const status = await git(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return unknown(`看工作树失败：${tail(status.stderr)}`);
  const uncommitted = status.stdout.split('\n').filter((l) => l.trim()).length;

  const facts = { target, ownCommits, newCommits, hasDiff, uncommitted };
  const problems = [
    ownCommits === 0 ? `相对 ${target} 没有自己的提交` : undefined,
    ownCommits > 0 && !hasDiff ? `有 ${ownCommits} 个提交，但内容和 ${target} 没有差异` : undefined,
    newCommits === 0 ? '这一轮会话没有新提交' : undefined,
    uncommitted > 0 ? `已跟踪的文件还有 ${uncommitted} 处改动没提交（引擎只推提交，这些会丢）` : undefined,
  ].filter((p): p is string => p !== undefined);
  if (problems.length === 0) {
    return {
      state: 'delivered',
      ...facts,
      detail: `这一轮新提交 ${newCommits} 个，相对 ${target} 共 ${ownCommits} 个自己的提交`,
    };
  }
  return { state: 'not_delivered', ...facts, detail: problems.join('；') };
}

async function count(git: (args: string[]) => Promise<GitRun>, range: string): Promise<number | undefined> {
  const res = await git(['rev-list', '--count', range]);
  const n = Number.parseInt(res.stdout.trim(), 10);
  return res.code === 0 && Number.isFinite(n) ? n : undefined;
}

function runGit(args: string[], options: DeliveryOptions): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 60_000,
        env: options.env ?? process.env,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr) || (code === -1 ? String(error) : ''),
        });
      },
    );
  });
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > 300 ? `…${t.slice(-300)}` : t || '（没有输出）';
}
