// 欠账检查入口（#67，见 ../debt.ts）：node packages/conventions/src/bin/debt-check.ts [--open-issues]
// 不带参数：文档里推后的话带着开着的单号、需求.md 写了怎么算做完（pnpm check 里跑）。
// --open-issues：另查开着的 issue 在主线上都有需求文档（.github/workflows/debt.yml 定时跑）。
// 退出码 0 = 没欠账；1 = 有欠账（逐条 文件:行）；2 = 没查成（读不到文档或 GitHub），同样是红。
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runDebtCheck } from '../debt.ts';
import { liveGitHub, repoName } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';
import { fsRepo } from '../repo.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let openIssues = false;
try {
  openIssues =
    parseArgs({ options: { 'open-issues': { type: 'boolean' } }, strict: true }).values['open-issues'] ===
    true;
} catch (e) {
  console.error(
    `参数不对（${e instanceof Error ? e.message : String(e)}）。用法：debt-check.ts [--open-issues]`,
  );
  process.exit(2);
}
const repo = repoName(process.env, root);
const { code, lines } = await runDebtCheck({
  repo: fsRepo(root),
  gh: repo
    ? liveGitHub(repo, process.env)
    : '认不出是哪个仓：没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址',
  openIssues,
});
const inActions = process.env.GITHUB_ACTIONS === 'true';
for (const line of lines) {
  if (code === 0 || line.startsWith('提醒：')) console.log(line);
  else console.error(inActions ? annotation(line) : line);
}
process.exitCode = code;
