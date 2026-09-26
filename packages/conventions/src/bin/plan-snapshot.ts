// 版本快照入口（#138，见 ../plan-snapshot.ts）：pnpm plan:snapshot [--at 2026-09-27T09:00+08:00]
// 每个版本开始和结束时由总指挥跑：从 GitHub 读版本、先后、母单和子单，重写 docs/plan.md 快照标记之间的几节，改动照常开 PR。
// 退出码 0 = 写好了（或者和原来一样）；2 = 没生成（没登录、GitHub 读不到、先后或快照标记认不出、写不进），docs/plan.md 没动。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubToken, liveGitHub, repoName } from '../github-api.ts';
import { planSnapshot } from '../plan-snapshot.ts';
import { PLAN_DOC } from '../pr-fields.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = repoName(process.env, root);
if (!repo) {
  console.error('没生成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
  process.exit(2);
}
const file = join(root, ...PLAN_DOC.split('/'));
const token = githubToken(process.env);
const { code, lines } = await planSnapshot(process.argv.slice(2), {
  reader: token === undefined ? undefined : liveGitHub(repo, process.env, { token: () => token }),
  repo,
  read() {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  write: (text) => writeFileSync(file, text),
  now: () => new Date(),
});
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
