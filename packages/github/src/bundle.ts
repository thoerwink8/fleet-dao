// 从引擎自己的镜像仓打包给会话用户：建工作树（fetchMainline 抓最新主线进镜像，bundleCommits 打出来）、
// 并主线后快进（bundleCommits({tips:[新头], exclude:[旧头]})）。会话用户读不到引擎的镜像，只能靠 bundle 文件转手。
// 复用 push.ts 已经导出的镜像辅助：同一个仓、同一把 withMirrorLock（这里和推分支、并主线可能碰同一个镜像）。
import { chmodSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { GitHubClient, Logger, RepoRef } from './client.ts';
import { repoSlug } from './client.ts';
import { GitHubError } from './errors.ts';
import { authHeaderConfig, type GitCall, type GitRunner, gitEnv } from './git.ts';
import {
  ensureMirror,
  fromGitFailure,
  type Git,
  mirrorPath,
  NET_TIMEOUT_MS,
  withMirrorLock,
} from './push.ts';
import type { RepoFactsCache } from './repos.ts';

export interface MirrorReadDeps {
  client: GitHubClient;
  facts: RepoFactsCache;
  git: GitRunner;
  gitUrl: (repo: RepoRef) => string;
  gitHost: string;
  mirrorRoot: string;
  log: Logger;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface FetchMainlineInput {
  repo: RepoRef;
  signal?: AbortSignal | undefined;
}

export interface FetchMainlineResult {
  head: string;
  defaultBranch: string;
}

const MAIN_REF = 'refs/fleet/main';

/** 抓远端默认分支最新头进镜像（refs/fleet/main），回头和分支名。 */
export async function fetchMainline(
  deps: MirrorReadDeps,
  input: FetchMainlineInput,
): Promise<FetchMainlineResult> {
  const { repo } = input;
  const slug = repoSlug(repo);
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
    const git: Git = (args, call) => deps.git(args, call);
    const fetched = await git(
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--quiet',
        url,
        `+refs/heads/${defaultBranch}:${MAIN_REF}`,
      ],
      net,
    );
    if (fetched.code !== 0) throw fromGitFailure('抓取主线', slug, fetched);
    const rev = await git(['rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`], local);
    const head = rev.stdout.trim();
    if (rev.code !== 0 || !FULL_SHA.test(head)) throw fromGitFailure('解析刚抓到的主线', slug, rev);
    return { head, defaultBranch };
  });
}

export interface BundleCommitsInput {
  repo: RepoRef;
  /** 要打进包里的提交（必须已经在镜像里，不在就是调用方的错：先 fetchMainline 或推过它）。 */
  tips: string[];
  /** 这些提交（连同它们的祖先）不打进包；不在镜像里的直接忽略。 */
  exclude?: string[] | undefined;
  /** 包写到这个文件；调用方给目录、事后自己删。 */
  outPath: string;
  signal?: AbortSignal | undefined;
}

export interface BundleCommitsResult {
  path: string;
  bytes: number;
  /** 每个 tip 在包里对应的引用名（`git fetch <bundle> <ref>` 用得到；bundle 不含 refs/heads/*，plain clone 找不到它们）。 */
  refs: { tip: string; ref: string }[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const EXPORT_REF_PREFIX = 'refs/fleet/export/';

/** tips/exclude 只收 40 位十六进制 SHA 或 refs/fleet/ 下的引用：别的一律拒收（防把 `-x` 这类参数注入进 git 命令行）。 */
function assertSafeRev(value: string, what: string): void {
  if (FULL_SHA.test(value) || value.startsWith('refs/fleet/')) return;
  throw new GitHubError(
    'BAD_INPUT',
    `${what}「${value}」不是 40 位十六进制提交号，也不是 refs/fleet/ 下的引用`,
  );
}

/** 给输出文件权限收到 0600：预先用受限权限创建好，git bundle create 只是写内容、不会放宽已有文件的权限。 */
async function prepareOutFile(path: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'w', 0o600);
  } catch (err) {
    throw new GitHubError(
      'BUNDLE_OUT_UNWRITABLE',
      `打包输出文件 ${path} 建不了（${(err as { code?: string }).code ?? String(err)}）：目录要调用方先建好`,
      { details: { outPath: path } },
    );
  }
  await fh.close();
  try {
    chmodSync(path, 0o600);
  } catch {
    // 没有 POSIX 权限位的平台（如 Windows）尽力而为，不当失败。
  }
}

/**
 * 把 tips 可达、exclude 不可达的提交打成一个 bundle 文件。tips 必须已在镜像里；exclude 里不在镜像里的忽略。
 * bundle 不含 `refs/heads/*`，给每个 tip 现起一个 `refs/fleet/export/<序号>` 引用，用完就从镜像里删掉。
 */
export async function bundleCommits(
  deps: Pick<MirrorReadDeps, 'git' | 'mirrorRoot' | 'baseEnv'>,
  input: BundleCommitsInput,
): Promise<BundleCommitsResult> {
  const { repo, outPath } = input;
  const slug = repoSlug(repo);
  if (input.tips.length === 0) throw new GitHubError('BAD_INPUT', '至少要给一个 tip 提交');
  for (const t of input.tips) assertSafeRev(t, 'tip');
  for (const e of input.exclude ?? []) assertSafeRev(e, 'exclude');

  const mirror = mirrorPath(deps.mirrorRoot, repo);
  return withMirrorLock(mirror, async () => {
    await ensureMirror(deps, mirror);
    const local: GitCall = { cwd: mirror, env: gitEnv({ base: deps.baseEnv }) };
    const git: Git = (args, call) => deps.git(args, call);
    const exists = async (rev: string) =>
      (await git(['cat-file', '-e', `${rev}^{commit}`], local)).code === 0;

    const refs: { tip: string; ref: string }[] = [];
    try {
      for (const [i, tip] of input.tips.entries()) {
        if (!(await exists(tip))) {
          throw new GitHubError(
            'HEAD_NOT_FOUND',
            `镜像里没有提交 ${tip.slice(0, 12)}：先 fetchMainline 或推过这个提交，再打包`,
            { details: { tip } },
          );
        }
        const ref = `${EXPORT_REF_PREFIX}${i}`;
        const upd = await git(['update-ref', ref, tip], local);
        if (upd.code !== 0) throw fromGitFailure('起导出引用', slug, upd);
        refs.push({ tip, ref });
      }
      const excludeRevs: string[] = [];
      for (const ex of input.exclude ?? []) {
        if (await exists(ex)) excludeRevs.push(`^${ex}`);
      }

      await prepareOutFile(outPath);
      const bundled = await git(
        ['bundle', 'create', outPath, ...refs.map((r) => r.ref), ...excludeRevs],
        local,
      );
      if (bundled.code !== 0) throw fromGitFailure('打包', slug, bundled);
      const bytes = statSync(outPath).size;
      return { path: outPath, bytes, refs };
    } finally {
      for (const r of refs) await git(['update-ref', '-d', r.ref], local).catch(() => undefined);
    }
  });
}
