// 会话外推分支：AI 会话只在本地提交，这里用「干活的」机器人把会话交出来的提交推到远端任务分支。
// 推之前核对四件事：不是主线（拒绝推默认分支）、包含此刻最新的主线、相对主线真有内容（不推空交付，C7）、
// 远端分支要么没有、要么是我们的祖先（别人在上面推进过就报出来让引擎认领新头，分叉就停，绝不强推，C6）。
// 会话的提交由会话用户打成包（git bundle）交出来，这里只把包导入引擎自己的裸仓；带令牌的 git 只在这个裸仓里跑
// （为什么见 git.ts 开头）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitHubClient, Logger, RepoRef } from './client.ts';
import { repoSlug } from './client.ts';
import { GitHubError } from './errors.ts';
import {
  authHeaderConfig,
  classifyPushFailure,
  type GitCall,
  type GitRun,
  type GitRunner,
  gitEnv,
  tail,
} from './git.ts';
import type { RepoFactsCache } from './repos.ts';

export interface PushDeps {
  client: GitHubClient;
  facts: RepoFactsCache;
  git: GitRunner;
  /** 仓的 git 地址，默认 https://github.com/<owner>/<name>.git（测试指向本地裸仓）。 */
  gitUrl: (repo: RepoRef) => string;
  /** 令牌请求头只发给这个前缀，默认 https://github.com/ */
  gitHost: string;
  /** 引擎自己的裸仓放这里，每个仓一个。 */
  mirrorRoot: string;
  log: Logger;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface PushBranchInput {
  repo: RepoRef;
  /**
   * 会话用户交出来的包：起会话前的头之后的新提交（会话用户在树里跑 `git bundle create <文件> HEAD ^<起会话前的头>`）。
   * 包的前置提交必须在主线或远端分支上。这里只读这个文件、导入引擎的裸仓；文件归调用方收。
   */
  bundlePath: string;
  branch: string;
  /** 要推的提交；推完远端分支头就是它。 */
  head: string;
  signal?: AbortSignal | undefined;
}

export interface PushBranchResult {
  head: string;
  /** 推之前远端分支的头；null = 这次新建。 */
  remoteBefore: string | null;
  /** false = 远端早就是这个头（重试），这次没推。 */
  pushed: boolean;
  /** 核对时主线的头：推上去的提交包含它。 */
  mainline: string;
  defaultBranch: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NET_TIMEOUT_MS = 5 * 60_000;

/** 分支名：git 的规矩 + 不许 refs/ 开头、不许是 HEAD。 */
export function validBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.startsWith('refs/') || name === 'HEAD' || name.includes('..') || name.includes('//')) return false;
  return name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

const mirrorLocks = new Map<string, Promise<unknown>>();

async function withMirrorLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = mirrorLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.catch(() => undefined);
  mirrorLocks.set(dir, settled);
  try {
    return await run;
  } finally {
    if (mirrorLocks.get(dir) === settled) mirrorLocks.delete(dir);
  }
}

export async function pushBranch(deps: PushDeps, input: PushBranchInput): Promise<PushBranchResult> {
  const { repo, branch, head } = input;
  const slug = repoSlug(repo);
  if (!validBranchName(branch)) {
    throw new GitHubError(
      'BAD_BRANCH_NAME',
      `分支名「${branch}」不合规（git 的规矩，且不许 refs/ 开头、不许是 HEAD）`,
    );
  }
  if (!SHA.test(head)) throw new GitHubError('BAD_INPUT', `要推的提交「${head}」不是完整的提交号`);
  const facts = await deps.facts.get(repo, 'agent', input.signal);
  const defaultBranch = facts.defaultBranch;
  if (branch.toLowerCase() === defaultBranch.toLowerCase()) {
    throw new GitHubError('BRANCH_FORBIDDEN', `拒绝推 ${slug} 的主线 ${defaultBranch}：主线只经合并队列改`);
  }
  const mirror = join(deps.mirrorRoot, repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);

  return withMirrorLock(mirror, async () => {
    await ensureMirror(deps, mirror);
    const url = deps.gitUrl(repo);
    const token = (await deps.client.installationToken('agent', repo, input.signal)).token;
    const net: GitCall = {
      cwd: mirror,
      env: gitEnv({ base: deps.baseEnv, config: authHeaderConfig(deps.gitHost, token) }),
      timeoutMs: NET_TIMEOUT_MS,
    };
    const local: GitCall = { cwd: mirror, env: gitEnv({ base: deps.baseEnv }) };
    const git = (args: string[], call: GitCall) => deps.git(args, call);
    const mainRef = 'refs/fleet/main';
    const branchRef = `refs/fleet/b/${createHash('sha1').update(branch).digest('hex').slice(0, 16)}`;
    let branchRefUsed = false;

    try {
      // 1. 远端此刻有什么
      const before = await lsRemote(git, net, url, [defaultBranch, branch]);
      const remoteMain = before.get(defaultBranch);
      if (!remoteMain) {
        throw new GitHubError('MAINLINE_NOT_FOUND', `${slug} 上找不到主线 ${defaultBranch}`, {
          retryable: true,
        });
      }
      const remoteBefore = before.get(branch) ?? null;
      // 重试：上一次已经推成了（回执丢了），这次什么都不做
      if (remoteBefore === head) {
        return { head, remoteBefore, pushed: false, mainline: remoteMain, defaultBranch };
      }

      // 2. 抓最新主线（和远端分支）进镜像
      const refspecs = [`+refs/heads/${defaultBranch}:${mainRef}`];
      if (remoteBefore) {
        refspecs.push(`+refs/heads/${branch}:${branchRef}`);
        branchRefUsed = true;
      }
      const fetched = await git(
        ['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', url, ...refspecs],
        net,
      );
      if (fetched.code !== 0) throw fromGitFailure('抓取主线', slug, fetched);
      const mainline = await revParse(git, local, mainRef);

      // 3. 导入会话交来的包（包的前置提交靠刚抓进来的主线和远端分支补齐），再看要推的提交在不在
      await importBundle(git, local, input.bundlePath, slug);
      const exists = await git(['cat-file', '-e', `${head}^{commit}`], local);
      if (exists.code !== 0) {
        throw new GitHubError('HEAD_NOT_FOUND', `会话交来的包 ${input.bundlePath} 里没有提交 ${head}`, {
          details: { bundlePath: input.bundlePath, head },
        });
      }

      // 4. 基于最新主线
      if (!(await isAncestor(git, local, mainline, head))) {
        throw new GitHubError(
          'BEHIND_MAINLINE',
          `${head.slice(0, 7)} 不包含 ${defaultBranch} 的最新提交 ${mainline.slice(0, 7)}：先同步主线再推`,
          { details: { head, mainline, defaultBranch } },
        );
      }

      // 5. 不推空交付：主线是它的祖先、又不是它本身，就至少有一个自己的提交；还要真有内容差异
      const diff =
        head === mainline
          ? { code: 0, stdout: '', stderr: '' }
          : await git(['diff', '--quiet', mainline, head], local);
      if (diff.code !== 0 && diff.code !== 1) throw fromGitFailure('比内容', slug, diff);
      if (diff.code === 0) {
        throw new GitHubError(
          'EMPTY_DELIVERY',
          head === mainline
            ? `${head.slice(0, 7)} 就是 ${defaultBranch} 的头，没有自己的提交`
            : `${head.slice(0, 7)} 有提交，但内容和 ${defaultBranch} 没有差异`,
          { details: { head, mainline } },
        );
      }

      // 6. 远端分支的状态
      if (remoteBefore) await assertFastForward(git, local, remoteBefore, head, slug, branch);

      // 7. 推（不强推：远端这时被别人推进了，GitHub 会拒，下面再判）
      const pushed = await git(
        ['push', '--porcelain', '--no-verify', url, `${head}:refs/heads/${branch}`],
        net,
      );
      if (pushed.code !== 0) {
        const kind = classifyPushFailure(`${pushed.stderr}\n${pushed.stdout}`);
        if (kind === 'non_fast_forward') {
          const now = (await lsRemote(git, net, url, [branch])).get(branch) ?? null;
          if (now === head) return { head, remoteBefore, pushed: true, mainline, defaultBranch };
          if (now) {
            branchRefUsed = true;
            await git(
              [
                'fetch',
                '--no-tags',
                '--no-write-fetch-head',
                '--quiet',
                url,
                `+refs/heads/${branch}:${branchRef}`,
              ],
              net,
            );
            await assertFastForward(git, local, now, head, slug, branch);
          }
          throw new GitHubError('PUSH_RACE', `推 ${slug} ${branch} 时远端刚变过，重试`, { retryable: true });
        }
        throw fromPushFailure(kind, slug, branch, pushed);
      }

      // 8. 回读：远端分支头就是它才算推成
      const after = (await lsRemote(git, net, url, [branch])).get(branch) ?? null;
      if (after !== head) {
        throw new GitHubError(
          'PUSH_UNVERIFIED',
          `推完回读 ${slug} ${branch}：远端是 ${after ?? '（没有）'}，不是 ${head}`,
          {
            retryable: true,
            details: { remote: after, head },
          },
        );
      }
      deps.log.info('分支已推', { repo: slug, branch, head, remoteBefore, mainline });
      return { head, remoteBefore, pushed: true, mainline, defaultBranch };
    } finally {
      if (branchRefUsed) await git(['update-ref', '-d', branchRef], local).catch(() => undefined);
    }
  });
}

async function ensureMirror(deps: PushDeps, mirror: string): Promise<void> {
  if (existsSync(join(mirror, 'HEAD'))) return;
  mkdirSync(mirror, { recursive: true });
  const init = await deps.git(['init', '--bare', '--quiet', mirror], {
    cwd: deps.mirrorRoot,
    env: gitEnv({ base: deps.baseEnv }),
  });
  if (init.code !== 0) {
    throw new GitHubError('MIRROR_FAILED', `建引擎的推送裸仓 ${mirror} 失败：${tail(init.stderr)}`, {
      retryable: true,
    });
  }
}

type Git = (args: string[], call: GitCall) => Promise<GitRun>;

/**
 * 把会话交来的包导入镜像。包是会话用户写的，当数据读：`bundle unbundle` 只写对象、不建引用、不执行包里的任何东西。
 * 读不到、不是包、缺前置提交各报各的错，都不当「导入了」往下走。
 */
async function importBundle(git: Git, call: GitCall, bundlePath: string, slug: string): Promise<void> {
  let isFile = false;
  try {
    isFile = statSync(bundlePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new GitHubError('BUNDLE_UNREADABLE', `读不到会话交来的包 ${bundlePath}：没导入成，这次不推`, {
      details: { bundlePath },
    });
  }
  const res = await git(['bundle', 'unbundle', bundlePath], call);
  if (res.code === 0) return;
  const why = res.stderr.toLowerCase();
  if (why.includes('lacks these prerequisite commits')) {
    throw new GitHubError(
      'BUNDLE_INCOMPLETE',
      `会话交来的包缺前置提交：包要从主线或远端分支上已有的提交之后打（${tail(res.stderr)}）`,
      { details: { bundlePath, exitCode: res.code } },
    );
  }
  if (why.includes('does not look like a v2 or v3 bundle') || why.includes('is not a bundle')) {
    throw new GitHubError('BUNDLE_INVALID', `会话交来的 ${bundlePath} 不是 git 包：${tail(res.stderr)}`, {
      details: { bundlePath, exitCode: res.code },
    });
  }
  if (why.includes('could not open')) {
    throw new GitHubError('BUNDLE_UNREADABLE', `打不开会话交来的包 ${bundlePath}：${tail(res.stderr)}`, {
      details: { bundlePath, exitCode: res.code },
    });
  }
  throw fromGitFailure('导入会话交来的包', slug, res);
}

async function lsRemote(
  git: Git,
  call: GitCall,
  url: string,
  branches: string[],
): Promise<Map<string, string>> {
  const res = await git(['ls-remote', '--refs', url, ...branches.map((b) => `refs/heads/${b}`)], call);
  if (res.code !== 0) throw fromGitFailure('查远端分支', url, res);
  const out = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const m = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line.trim());
    if (m?.[1] && m[2] && branches.includes(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

async function revParse(git: Git, call: GitCall, ref: string): Promise<string> {
  const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], call);
  const sha = res.stdout.trim();
  if (res.code !== 0 || !SHA.test(sha)) throw fromGitFailure(`解析 ${ref}`, '', res);
  return sha;
}

async function isAncestor(git: Git, call: GitCall, ancestor: string, of: string): Promise<boolean> {
  const res = await git(['merge-base', '--is-ancestor', ancestor, of], call);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  throw fromGitFailure('判祖先', '', res);
}

async function assertFastForward(
  git: Git,
  call: GitCall,
  remote: string,
  head: string,
  slug: string,
  branch: string,
) {
  if (await isAncestor(git, call, remote, head)) return;
  if (await isAncestor(git, call, head, remote)) {
    throw new GitHubError(
      'REMOTE_AHEAD',
      `${slug} 的 ${branch} 已经在 ${head.slice(0, 7)} 之上被推进到 ${remote.slice(0, 7)}：先认领远端的新头，别覆盖`,
      { details: { remoteHead: remote, head } },
    );
  }
  throw new GitHubError(
    'DIVERGED',
    `${slug} 的 ${branch}（${remote.slice(0, 7)}）和要推的 ${head.slice(0, 7)} 分叉了：不强推，交给引擎处理`,
    { details: { remoteHead: remote, head } },
  );
}

function fromGitFailure(what: string, where: string, res: GitRun): GitHubError {
  const kind = classifyPushFailure(res.stderr);
  const text = `${what}${where ? `（${where}）` : ''}失败：${tail(res.stderr)}`;
  if (kind === 'auth') return new GitHubError('PUSH_FORBIDDEN', text, { details: { exitCode: res.code } });
  // 其余按可重试：抓取时分支刚被删、网络抖动都在这里；重试次数由引擎的活动策略封顶。
  return new GitHubError('GIT_FAILED', text, { retryable: true, details: { exitCode: res.code, kind } });
}

function fromPushFailure(
  kind: ReturnType<typeof classifyPushFailure>,
  slug: string,
  branch: string,
  res: GitRun,
) {
  const why = tail(res.stderr || res.stdout);
  switch (kind) {
    case 'workflow_permission':
      return new GitHubError(
        'WORKFLOW_PERMISSION',
        `推 ${slug} ${branch} 被拒：改动碰了 .github/workflows/，而「干活的」机器人没有 workflows 权限——换多少次都一样，要人处理（${why}）`,
        { details: { exitCode: res.code } },
      );
    case 'rule_rejected':
      return new GitHubError('PUSH_REJECTED', `推 ${slug} ${branch} 被规则集拒了：${why}`, {
        details: { exitCode: res.code },
      });
    case 'auth':
      return new GitHubError('PUSH_FORBIDDEN', `推 ${slug} ${branch} 被拒（凭据或权限）：${why}`, {
        details: { exitCode: res.code },
      });
    default:
      return new GitHubError('PUSH_FAILED', `推 ${slug} ${branch} 失败：${why}`, {
        retryable: true,
        details: { exitCode: res.code, kind },
      });
  }
}
