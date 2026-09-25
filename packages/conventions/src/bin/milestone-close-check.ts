// 阶段收口入口（#67，见 ../milestone-close.ts）：pnpm milestone:close-check P1
// 退出码 0 = 里面没有开着的，可以关；1 = 还有开着的（逐张列出）；2 = 没查成（里程碑找不到、GitHub 读不到）。
import { fileURLToPath } from 'node:url';
import { liveGitHub, repoName } from '../github-api.ts';
import { milestoneCloseCheck } from '../milestone-close.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = repoName(process.env, root);
if (!repo) {
  console.error('没查成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
  process.exit(2);
}
const { code, lines } = await milestoneCloseCheck(process.argv.slice(2), liveGitHub(repo, process.env));
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
