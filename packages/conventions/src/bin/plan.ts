// 现在的计划入口（见 ../plan-view.ts）：pnpm plan
// 从 GitHub 现读版本、先后、母单和子单，打印出来；不写任何文件（#654 起不再把计划抄进仓里）。
// 退出码 0 = 打印出来了；2 = 没读成（没登录、GitHub 读不到、先后标记认不出）。
import { fileURLToPath } from 'node:url';
import { githubToken, liveGitHub, repoName } from '../github-api.ts';
import { planCommand } from '../plan-view.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = repoName(process.env, root);
if (!repo) {
  console.error('没读成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
  process.exit(2);
}
const token = githubToken(process.env);
const { code, lines } = await planCommand(process.argv.slice(2), {
  reader: token === undefined ? undefined : liveGitHub(repo, process.env, { token: () => token }),
  repo,
  now: () => new Date(),
});
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
