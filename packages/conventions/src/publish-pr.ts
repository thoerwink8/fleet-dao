// 「发布 vN」PR 的编排：读仓根 CHANGELOG.md、问当前分支、读 GitHub 上的当前版本里程碑定这一版叫什么、把 CHANGELOG.md 的
// Unreleased 段收进「## [vN] - 日期」标题、git add+commit+push，然后跑 gh pr create、拿到 PR 号。
// 顺序不能反：必须先提交+推上 head 分支再开 PR——head 分支如果没提交差于 main，gh pr create 会失败
// （GraphQL: No commits between main and <branch>，第二意见 2026-10-02）；动仓之前该核的（分支、工作区、身份、版本号）全核完。
// 入口在 ./bin/publish-pr.ts（`pnpm publish:pr`）；驾驶舱 /changelog 的「发布 v<N>」按钮（packages/web/src/routes/changelog.tsx）只是提示入口。
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { liveGitHub, repoName } from './github-api.ts';
import type { MilestoneRef } from './labels.ts';
import { parseCreatedPr, publishReleasePlan, releaseBranchVersion } from './publish-actions.ts';

export interface PublishDeps {
  /** 环境变量：读 GitHub 用的令牌（GITHUB_TOKEN / GH_TOKEN，没有就用 gh auth token）、仓名（GITHUB_REPOSITORY，没有就认 origin）。 */
  env: Record<string, string | undefined>;
  /** 仓根（找 CHANGELOG.md）。 */
  root: string;
  /** 发起人当前所在分支（未传时由调用方查 git rev-parse --abbrev-ref HEAD）。 */
  currentBranch?: string;
  /** execFile 替身（测试里换 mock）。 */
  gh?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** git 替身。 */
  git?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 读仓里全部里程碑的替身（默认现读 GitHub：github-api.ts 的 liveGitHub）；版本号从开着的当前版本里程碑取。 */
  milestones?: () => Promise<readonly (MilestoneRef & { state: 'open' | 'closed' })[]>;
  /** 「今天」（YYYY-MM-DD，UTC）的替身：测试里钉死，不读真钟。 */
  today?: () => string;
  /** 给人看的回执（不给就不打；bin 传 console.log）。 */
  note?: (line: string) => void;
}

export interface PublishResult {
  pr: number;
  url: string;
  version: `v${number}`;
  headBranch: string;
  /** 提交 CHANGELOG.md 收尾的提交号（真提交时才有；测试 mock 时多半没有）。 */
  commitSha?: string;
}

interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

const defaultRunner =
  (cmd: string) =>
  (args: string[], cwd: string): Promise<RunnerResult> =>
    new Promise((done) => {
      execFile(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return done({ code: 127, stdout, stderr: `找不到 ${cmd}（没装或不在 PATH 里）` });
        }
        done({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr: stderr || e.message });
      });
    });

const fail = (what: string, r: RunnerResult) =>
  new Error(
    `${what}（退出码 ${r.code}）：${(r.stderr.trim() || r.stdout.trim() || '（什么也没说）').replace(/\s+/g, ' ')}`,
  );

/**
 * 状态机：
 *   1) 读 CHANGELOG.md、查当前分支：分支得是 release/v<N>（不碰网络先核模样）；
 *   2) git status --porcelain：工作区必须干净（除了 CHANGELOG.md 之外不许还有别的没提交的，免得发布 PR 带私货）；
 *   3) gh auth status：有身份才往下走；
 *   4) 读 GitHub 上的里程碑 → publishReleasePlan 算版本（当前版本里程碑）/核分支/新 CHANGELOG 文本/提交信息；
 *   5) writeFile CHANGELOG.md = nextChangelog；git add CHANGELOG.md、git commit、git push -u origin <head>；
 *   6) gh pr create → parseCreatedPr → 返回。
 * 任一步挂照实报错、写明哪一步、不往下走；1–4 都不动仓。
 */
export async function publishPr(deps: PublishDeps): Promise<PublishResult> {
  const note = deps.note ?? (() => {});
  const gh = deps.gh ?? defaultRunner('gh');
  const changelogPath = join(deps.root, 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8');
  const git = deps.git ?? defaultRunner('git');
  let currentBranch = deps.currentBranch;
  if (!currentBranch) {
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], deps.root);
    if (r.code !== 0) throw fail('查当前分支失败', r);
    currentBranch = r.stdout.trim();
  }
  if (!currentBranch) throw new Error('查不到当前分支：发起人先 git switch -c release/v<N> 再重跑。');
  releaseBranchVersion(currentBranch);

  // 工作区除了仓根的 CHANGELOG.md 之外不许还有别的没提交的：发布 PR 不该带私货（第二意见 2026-10-02）。
  // porcelain 行格式是「XY 路径」（rename: XY 旧 → 新）；只放行精确等于「CHANGELOG.md」的路径，
  // 「fooCHANGELOG.md」「other/CHANGELOG.md」都算私货（第二意见 2026-10-02）。
  const dirty = await git(['status', '--porcelain'], deps.root);
  if (dirty.code !== 0) throw fail('git status 失败', dirty);
  const porcelainPath = (line: string): string => {
    // 「XY 旧 -> 新」（rename/copy）拿箭头右边；其余拿 XY 后面的路径
    const t = line.slice(3).trim();
    const arrow = t.indexOf(' -> ');
    return (arrow === -1 ? t : t.slice(arrow + 4)).replace(/^"|"$/g, '');
  };
  const others = dirty.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(porcelainPath)
    .filter((p) => p !== 'CHANGELOG.md');
  if (others.length > 0) {
    throw new Error(
      `工作区除了仓根 CHANGELOG.md 还有没提交的改动（${others.length} 条）：发布 PR 不该带私货，先收起来（git stash 或先 commit）再重跑。\n` +
        others.map((p) => `  ${p}`).join('\n'),
    );
  }

  // 先核 gh 身份再动仓（第二意见 2026-10-02）：写 CHANGELOG.md、commit、push 都是动仓，缺身份的时候跑到这一步
  // 应当明说然后停，别先把仓改了再说「没身份」——人补了身份再重跑会撞「没有改动可提交」。
  const auth = await gh(['auth', 'status'], deps.root);
  if (auth.code !== 0) {
    throw new Error(
      `gh 没有可用的身份（gh auth status 退出码 ${auth.code}）：` +
        '发起人先 gh auth login、或把 GITHUB_TOKEN/GH_TOKEN 放进环境，再重跑。没令牌不伪造成功、也不动仓。',
    );
  }

  // 这一版叫什么：当前版本里程碑的版本号（publish-actions.ts 的 releaseVersion）。读不到就停，不拿 CHANGELOG.md「上一版 +1」猜。
  const readMilestones =
    deps.milestones ??
    (async () => {
      const repo = repoName(deps.env, deps.root);
      if (!repo) throw new Error('认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）');
      return await liveGitHub(repo, deps.env).milestones();
    });
  let milestones: Awaited<ReturnType<typeof readMilestones>>;
  try {
    milestones = await readMilestones();
  } catch (e) {
    throw new Error(
      `读 GitHub 上的里程碑失败（${e instanceof Error ? e.message : String(e)}）：版本号取当前版本里程碑，读不到就不知道这一版叫什么——不猜、不动仓。`,
    );
  }
  const plan = publishReleasePlan({
    changelog,
    head: currentBranch,
    openMilestones: milestones.filter((m) => m.state === 'open'),
    ...(deps.today ? { today: deps.today } : {}),
  });
  note(`这一版是 ${plan.version}（当前版本里程碑「${plan.milestone.title}」）`);

  // 改写 CHANGELOG.md：Unreleased 段收进 ## [vN] - 日期。
  await writeFile(changelogPath, plan.nextChangelog, 'utf8');
  const add = await git(['add', 'CHANGELOG.md'], deps.root);
  if (add.code !== 0) throw fail('git add CHANGELOG.md 失败', add);
  const commit = await git(['commit', '-m', plan.commitMessage], deps.root);
  if (commit.code !== 0) throw fail('git commit 失败', commit);
  const revParse = await git(['rev-parse', 'HEAD'], deps.root);
  if (revParse.code !== 0)
    throw fail('git rev-parse HEAD 失败（刚 commit 完就读不回，发起不下去了）', revParse);
  const commitSha = revParse.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(
      `git rev-parse HEAD 的输出认不出提交号：「${commitSha.slice(0, 80)}」；不拿空字符串冒充。`,
    );
  }
  note(`提交了 CHANGELOG.md 收尾：${commitSha.slice(0, 8)}`);

  // 推 head 分支到 origin：head=release/v<N> 要带这次 commit，gh pr create 才不撞 GraphQL: No commits。
  const push = await git(['push', '-u', 'origin', plan.headBranch], deps.root);
  if (push.code !== 0) throw fail(`git push -u origin ${plan.headBranch} 失败`, push);
  note(`推好了 ${plan.headBranch}（连带 CHANGELOG.md 收尾那一个提交）`);

  const created = await gh(
    [
      'pr',
      'create',
      '--title',
      plan.title,
      '--body',
      plan.body,
      '--base',
      plan.base,
      '--head',
      plan.headBranch,
    ],
    deps.root,
  );
  if (created.code !== 0) {
    throw new Error(
      `gh pr create 失败（退出码 ${created.code}）：${(created.stderr.trim() || created.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ')}`,
    );
  }
  const { pr, url } = parseCreatedPr(created.stdout);
  return { pr, url, version: plan.version, headBranch: plan.headBranch, commitSha };
}
