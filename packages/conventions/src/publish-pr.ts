// 「发布 vN」PR 的编排：读仓根 CHANGELOG.md、问当前分支、跑 gh pr create、拿到 PR 号。
// 入口在 ./bin/publish-pr.ts；驾驶舱 /changelog 的「发布 vN」按钮（packages/web/src/routes/changelog.tsx）调 import 这份里的 publishPr。
// 不带测试替身：测试用 publish-actions.ts（纯）+ mock 的 deps（见 packages/conventions/test/publish-pr.test.ts）。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCreatedPr, publishReleasePlan } from './publish-actions.ts';

export interface PublishDeps {
  /** 环境变量：查 GITHUB_TOKEN；gh 也可用 SSH/agent 但也只在没有 GITHUB_TOKEN 时报出来（调用方要不要放行自行决定）。 */
  env: Record<string, string | undefined>;
  /** 仓根（找 CHANGELOG.md）。 */
  root: string;
  /** 发起人当前所在分支（未传时由调用方查 git rev-parse --abbrev-ref HEAD）。 */
  currentBranch?: string;
  /** execFile 替身（测试里换 mock）。 */
  gh?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** git rev-parse 替身。 */
  git?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface PublishResult {
  pr: number;
  url: string;
  version: `v${number}`;
  headBranch: string;
}

const defaultRunner =
  (cmd: string) =>
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
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

export async function publishPr(deps: PublishDeps): Promise<PublishResult> {
  const env = deps.env;
  if (!env.GITHUB_TOKEN?.trim()) {
    throw new Error(
      '缺 GITHUB_TOKEN：开「发布 vN」PR 是「对外发布」的发起，没令牌不伪造成功。把 GITHUB_TOKEN 放进环境（gh auth login 也行），再重跑。',
    );
  }
  const changelog = await readFile(join(deps.root, 'CHANGELOG.md'), 'utf8');
  const git = deps.git ?? defaultRunner('git');
  let currentBranch = deps.currentBranch;
  if (!currentBranch) {
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], deps.root);
    if (r.code !== 0) {
      throw new Error(`查当前分支失败（退出码 ${r.code}）：${r.stderr.trim() || r.stdout.trim()}`);
    }
    currentBranch = r.stdout.trim();
  }
  if (!currentBranch) throw new Error('查不到当前分支：发起人先推好一个分支再开「发布 vN」PR。');
  const plan = publishReleasePlan({ changelog, head: currentBranch });
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
  return { pr, url, version: plan.version, headBranch: plan.headBranch };
}
