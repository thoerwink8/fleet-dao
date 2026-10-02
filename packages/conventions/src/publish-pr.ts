// 「发布 vN」PR 的编排：读仓根 CHANGELOG.md、问当前分支、把 CHANGELOG.md 的 Unreleased 段收进
// 「## [vN] - 日期」标题、git add+commit+push，然后跑 gh pr create、拿到 PR 号。
// 顺序不能反：必须先提交+推上 head 分支再开 PR——head 分支如果没提交差于 main，gh pr create 会失败
// （GraphQL: No commits between main and <branch>，第二意见 2026-10-02）。
// 入口在 ./bin/publish-pr.ts；驾驶舱 /changelog 的「发布 v<N>」按钮（packages/web/src/routes/changelog.tsx）只是提示入口。
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCreatedPr, publishReleasePlan } from './publish-actions.ts';

export interface PublishDeps {
  /** 环境变量：查 GITHUB_TOKEN。 */
  env: Record<string, string | undefined>;
  /** 仓根（找 CHANGELOG.md）。 */
  root: string;
  /** 发起人当前所在分支（未传时由调用方查 git rev-parse --abbrev-ref HEAD）。 */
  currentBranch?: string;
  /** execFile 替身（测试里换 mock）。 */
  gh?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** git 替身。 */
  git?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 替好人看的回执（默认 console.log）。 */
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
 *   1) 读 CHANGELOG.md → publishReleasePlan 算 head/版本/新 CHANGELOG 文本/提交信息；
 *   2) git status --porcelain：工作区必须干净（除了 CHANGELOG.md 之外不许还有别的没提交的，免得发布 PR 带私货）；
 *   3) writeFile CHANGELOG.md = nextChangelog；
 *   4) git add CHANGELOG.md、git commit、git push -u origin <head>；
 *   5) gh pr create → parseCreatedPr → 返回。
 * 任一步挂照实报错、写明哪一步、不往下走。
 */
export async function publishPr(deps: PublishDeps): Promise<PublishResult> {
  const note = deps.note ?? (() => {});
  if (!deps.env.GITHUB_TOKEN?.trim()) {
    throw new Error(
      '缺 GITHUB_TOKEN：开「发布 vN」PR 是「对外发布」的发起，没令牌不伪造成功。把 GITHUB_TOKEN 放进环境（gh auth login 也行），再重跑。',
    );
  }
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
  const plan = publishReleasePlan({ changelog, head: currentBranch });

  // 工作区除了 CHANGELOG.md 之外不许还有别的没提交的：发布 PR 不该带私货（第二意见 2026-10-02）。
  const dirty = await git(['status', '--porcelain'], deps.root);
  if (dirty.code !== 0) throw fail('git status 失败', dirty);
  const others = dirty.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !l.includes('CHANGELOG.md'));
  if (others.length > 0) {
    throw new Error(
      `工作区除了 CHANGELOG.md 还有没提交的改动（${others.length} 条）：发布 PR 不该带私货，先收起来（git stash 或先 commit）再重跑。\n` +
        others.map((l) => `  ${l}`).join('\n'),
    );
  }

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

  const gh = deps.gh ?? defaultRunner('gh');
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
