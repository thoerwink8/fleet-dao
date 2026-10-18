// 现在的计划入口（见 ../plan-view.ts）：pnpm plan
// 从 GitHub 现读版本、先后、母单和子单，打印出来；不写任何文件（#654 起不再把计划抄进仓里）。
// 退出码 0 = 打印出来了；2 = 没读成（没登录、GitHub 读不到、先后标记认不出）。
import { fileURLToPath } from 'node:url';
import { exitWith, runMain } from '../exit.ts';
import { type GitHubReader, resolveRepo } from '../github-api.ts';
import { planReader } from '../plan-reader.ts';
import { planCommand } from '../plan-view.ts';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，../exit.ts）：提前退出用 exitWith，runMain 接住设退出码。
runMain(async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const resolved = resolveRepo(process.env, root);
  if (!resolved.repo) {
    console.error(
      resolved.error ?? '没读成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。',
    );
    exitWith(2);
  }
  const repo = resolved.repo;
  let reader: GitHubReader | undefined;
  try {
    reader = await planReader(repo, process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : '没读成：plan 的传输装配失败。');
    return 2;
  }
  const { code, lines } = await planCommand(process.argv.slice(2), {
    reader,
    repo,
    now: () => new Date(),
  });
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  return code;
});
