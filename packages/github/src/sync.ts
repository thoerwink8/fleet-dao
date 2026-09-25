// 并主线：在引擎自己的镜像仓里把最新主线并进 PR 分支、推上去，供合并队列与子任务返工用。
// 复用 push.ts 已经导出的镜像辅助（同一个仓算出同一个镜像路径、同一把 withMirrorLock）：
// 并主线和推分支可能碰同一个镜像，必须用同一把锁串行，否则两边同时 fetch/push 会互相踩对象库。
// 带令牌的 git 只在镜像里跑，原因见 git.ts 开头；生成的合并提交用「干活的」机器人身份（commitIdentity）。
import type { GitHubClient, Logger, RepoRef } from './client.ts';
import { repoSlug } from './client.ts';
import type { Bots } from './deps.ts';
import { GitHubError } from './errors.ts';
import { authHeaderConfig, classifyPushFailure, type GitCall, type GitRunner, gitEnv, tail } from './git.ts';
import {
  ensureMirror,
  fromGitFailure,
  fromPushFailure,
  type Git,
  isAncestor,
  lsRemote,
  mirrorPath,
  NET_TIMEOUT_MS,
  revParse,
  SHA,
  validBranchName,
  withMirrorLock,
} from './push.ts';
import type { RepoFactsCache } from './repos.ts';

export interface SyncMainlineDeps {
  client: GitHubClient;
  facts: RepoFactsCache;
  bots: Bots;
  git: GitRunner;
  gitUrl: (repo: RepoRef) => string;
  gitHost: string;
  mirrorRoot: string;
  log: Logger;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface SyncMainlineInput {
  repo: RepoRef;
  prNumber: number;
  branch: string;
  /** 以为分支现在的头。 */
  head: string;
  signal?: AbortSignal | undefined;
}

export type SyncMainlineResult =
  /** 并好了（merged=true，新头是并出来的合并提交），或本来就含最新主线（merged=false，头不变）。 */
  | { state: 'clean'; head: string; merged: boolean; previousHead: string; mainline: string }
  /** 有冲突：什么都没推，头不变，冲突文件交回去让会话解决。 */
  | { state: 'conflict'; head: string; conflictFiles: string[]; mainline: string }
  /** 远端分支头不是以为的那个（被别人推过，或分支整个不在了）：什么都没做。 */
  | { state: 'head_moved'; head: string; expectedHead: string };

const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 38;

/** `merge-tree --write-tree` 要 git ≥ 2.38；不查版本直接跑，太旧的 git 会报「unknown option」之类认不出来的错。 */
async function assertMergeTreeSupported(git: Git, call: GitCall): Promise<void> {
  const res = await git(['--version'], call);
  const m = /git version (\d+)\.(\d+)/.exec(res.stdout);
  if (res.code !== 0 || !m?.[1] || !m[2]) {
    throw new GitHubError(
      'GIT_TOO_OLD',
      `读不到 git 版本号（${tail(res.stderr || res.stdout)}）：并主线要 git ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} 以上（merge-tree --write-tree）`,
    );
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)) {
    throw new GitHubError(
      'GIT_TOO_OLD',
      `这台机器的 git 是 ${major}.${minor}，并主线要 ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} 以上（merge-tree --write-tree 是这个版本才有的）`,
    );
  }
}

/** `git merge-tree --write-tree --name-only` 冲突时的输出：树号一行，接着是冲突文件名（直到空行），再往后是信息行。 */
function parseConflictFiles(stdout: string): string[] {
  const lines = stdout.split('\n');
  const files: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) break;
    files.push(line);
  }
  return files;
}

/** 一个提交的父提交号，按 `commit-tree -p a -p b` 生成时的顺序（"<自己> <父1> <父2> …"）。 */
async function commitParents(git: Git, call: GitCall, sha: string): Promise<string[]> {
  const res = await git(['rev-list', '--parents', '-n', '1', sha], call);
  if (res.code !== 0) throw fromGitFailure(`查 ${sha.slice(0, 7)} 的父提交`, '', res);
  const parts = res.stdout.trim().split(/\s+/).filter(Boolean);
  return parts.slice(1);
}

export async function syncMainline(
  deps: SyncMainlineDeps,
  input: SyncMainlineInput,
): Promise<SyncMainlineResult> {
  const { repo, branch, head, prNumber } = input;
  const slug = repoSlug(repo);
  if (!validBranchName(branch)) {
    throw new GitHubError(
      'BAD_BRANCH_NAME',
      `分支名「${branch}」不合规（git 的规矩，且不许 refs/ 开头、不许是 HEAD）`,
    );
  }
  if (!SHA.test(head)) throw new GitHubError('BAD_INPUT', `以为的分支头「${head}」不是完整的提交号`);
  const mirror = mirrorPath(deps.mirrorRoot, repo);

  return withMirrorLock(mirror, async () => {
    await ensureMirror(deps, mirror);
    const facts = await deps.facts.get(repo, 'agent', input.signal);
    const defaultBranch = facts.defaultBranch;
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
    const branchRef = 'refs/fleet/sync-branch';

    // 1. 远端此刻有什么：分支头不是以为的那个（或整个不在了）就什么都不做，交回去认领新头
    const before = await lsRemote(git, net, url, [defaultBranch, branch]);
    const remoteMain = before.get(defaultBranch);
    if (!remoteMain) {
      throw new GitHubError('MAINLINE_NOT_FOUND', `${slug} 上找不到主线 ${defaultBranch}`, {
        retryable: true,
      });
    }
    const remoteBranch = before.get(branch) ?? null;
    if (remoteBranch === null) {
      // 分支在远端整个不见了（比 pushBranch 场景更少见：PR 分支被人手删了）：没有「现在的头」可报，用空串占位。
      return { state: 'head_moved', head: '', expectedHead: head };
    }

    // 2. 抓最新主线与分支头进镜像（都要真的对象，merge-tree/commit-tree 才能跑）
    const fetched = await git(
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--quiet',
        url,
        `+refs/heads/${defaultBranch}:${mainRef}`,
        `+refs/heads/${branch}:${branchRef}`,
      ],
      net,
    );
    if (fetched.code !== 0) throw fromGitFailure('抓取主线与分支', slug, fetched);
    const mainline = await revParse(git, local, mainRef);

    try {
      if (remoteBranch !== head) {
        // 幂等：远端头不是我们以为的那个，但如果它正是「我们自己上次推的并主线提交」（两个父提交分别是
        // input.head 和某个已经是当前主线祖先的提交），说明上一次其实推成了、只是回执没确认上，当成功回。
        const parents = await commitParents(git, local, remoteBranch);
        const previousMainline = parents[1];
        if (parents.length === 2 && parents[0] === head && previousMainline !== undefined) {
          if (await isAncestor(git, local, previousMainline, mainline)) {
            return {
              state: 'clean',
              head: remoteBranch,
              merged: true,
              previousHead: head,
              mainline: previousMainline,
            };
          }
        }
        return { state: 'head_moved', head: remoteBranch, expectedHead: head };
      }

      // 3. 分支已经含最新主线：不用并
      if (await isAncestor(git, local, mainline, head)) {
        return { state: 'clean', head, merged: false, previousHead: head, mainline };
      }

      // 4. 真的要并：先模拟一遍看有没有冲突
      await assertMergeTreeSupported(git, local);
      const merged = await git(['merge-tree', '--write-tree', '--name-only', head, mainline], local);
      if (merged.code === 1) {
        return { state: 'conflict', head, conflictFiles: parseConflictFiles(merged.stdout), mainline };
      }
      if (merged.code !== 0) throw fromGitFailure('模拟并主线', slug, merged);
      const treeOid = merged.stdout.split('\n', 1)[0]?.trim();
      if (!treeOid) throw fromGitFailure('模拟并主线', slug, merged);

      // 5. 干净：生成合并提交（作者/提交者是「干活的」机器人），推到分支（快进，不强推）
      const identity = await deps.bots.identity('agent', repo, input.signal);
      const message = `引擎并主线：把 ${defaultBranch}@${mainline.slice(0, 12)} 并进 PR #${prNumber} 的 ${branch}`;
      const commitEnv = {
        ...local.env,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      };
      const committed = await git(['commit-tree', treeOid, '-p', head, '-p', mainline, '-m', message], {
        ...local,
        env: commitEnv,
      });
      if (committed.code !== 0) throw fromGitFailure('生成并主线的合并提交', slug, committed);
      const mergeSha = committed.stdout.trim();
      if (!SHA.test(mergeSha)) throw fromGitFailure('生成并主线的合并提交', slug, committed);

      const pushed = await git(
        ['push', '--porcelain', '--no-verify', url, `${mergeSha}:refs/heads/${branch}`],
        net,
      );
      if (pushed.code !== 0) {
        const kind = classifyPushFailure(`${pushed.stderr}\n${pushed.stdout}`);
        if (kind === 'non_fast_forward') {
          const now = (await lsRemote(git, net, url, [branch])).get(branch) ?? null;
          if (now === mergeSha) {
            return { state: 'clean', head: mergeSha, merged: true, previousHead: head, mainline };
          }
          throw new GitHubError('PUSH_RACE', `并 ${slug} 主线到 ${branch} 时远端刚变过，重试`, {
            retryable: true,
          });
        }
        throw fromPushFailure(kind, slug, branch, pushed);
      }

      // 6. 回读：远端分支头就是新合并提交才算推成
      const after = (await lsRemote(git, net, url, [branch])).get(branch) ?? null;
      if (after !== mergeSha) {
        throw new GitHubError(
          'PUSH_UNVERIFIED',
          `并主线推完回读 ${slug} ${branch}：远端是 ${after ?? '（没有）'}，不是 ${mergeSha}`,
          { retryable: true, details: { remote: after, head: mergeSha } },
        );
      }
      deps.log.info('并主线已推', { repo: slug, branch, head: mergeSha, previousHead: head, mainline });
      return { state: 'clean', head: mergeSha, merged: true, previousHead: head, mainline };
    } finally {
      await git(['update-ref', '-d', branchRef], local).catch(() => undefined);
    }
  });
}
