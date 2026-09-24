// 交付判据：执行体说「做完了」不算数，工作树相对「此刻」的目标分支要有自己的提交，而且有内容差异。
// 必须先抓最新的目标分支再比：拿旧的比，被快进到新主线、自己一行没写的树也会显得「有新提交」
// （旧系统一次零产出的假完成就这样一路绿到合并，windsurf-dao#1572）。
import { execFile } from 'node:child_process';

export interface DeliveryCheck {
  /** unknown = 没查成（抓取失败、找不到分支、git 出错），不等于没交付。 */
  state: 'delivered' | 'not_delivered' | 'unknown';
  /** 比较基准，例如 refs/remotes/origin/main。 */
  target: string;
  /** 目标分支上没有、HEAD 上有的提交数。 */
  ownCommits?: number;
  /** 相对合并基有没有内容差异。 */
  hasDiff?: boolean;
  /** 工作树里还没提交的改动条数（git status --porcelain）。 */
  uncommitted?: number;
  detail: string;
}

export interface DeliveryOptions {
  /** 工作树。 */
  cwd: string;
  remote: string;
  branch: string;
  /** 默认先 git fetch 目标分支；只在确定刚抓过时才关。 */
  fetch?: boolean;
  timeoutMs?: number;
  /** 跑 git 用的环境（抓取私有仓要带凭据）；默认用当前进程的。 */
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
  const verified = await git(['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  if (verified.code !== 0) return unknown(`找不到目标分支 ${target}`);

  const counted = await git(['rev-list', '--count', `${target}..HEAD`]);
  const ownCommits = Number.parseInt(counted.stdout.trim(), 10);
  if (counted.code !== 0 || !Number.isFinite(ownCommits))
    return unknown(`数提交失败：${tail(counted.stderr)}`);

  const diffed = await git(['diff', '--quiet', `${target}...HEAD`]);
  if ((diffed.code !== 0 && diffed.code !== 1) || diffed.stderr.trim()) {
    return unknown(`比内容失败：${tail(diffed.stderr)}`);
  }
  const hasDiff = diffed.code === 1;

  const status = await git(['status', '--porcelain']);
  const uncommitted =
    status.code === 0 ? status.stdout.split('\n').filter((l) => l.trim()).length : undefined;
  const facts = { target, ownCommits, hasDiff, ...(uncommitted === undefined ? {} : { uncommitted }) };
  const dirty = uncommitted ? `；工作树里还有 ${uncommitted} 处改动没提交` : '';

  if (ownCommits > 0 && hasDiff) {
    return { state: 'delivered', ...facts, detail: `相对 ${target} 有 ${ownCommits} 个自己的提交${dirty}` };
  }
  const why = ownCommits === 0 ? '没有自己的提交' : `有 ${ownCommits} 个提交，但内容和目标分支没有差异`;
  return { state: 'not_delivered', ...facts, detail: `相对 ${target} ${why}${dirty}` };
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
