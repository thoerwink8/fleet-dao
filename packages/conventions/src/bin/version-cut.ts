// 版本收口入口（见 ../version-cut.ts，#2683）：node packages/conventions/src/bin/version-cut.ts
// 只给 .github/workflows/github-audit.yml 的 version-cut 任务（每天一次、可手动触发）和人手跑用，别接进 PR 的必过检查（#87）。
// 退出码 0 = 收完了或没到期；1 = 要人看（开着的版本不止一个、当前版本没设到期日）；2 = 没做成（读不到、写不成、回读对不上，旧版没关）。
import { fileURLToPath } from 'node:url';
import { exitWith, runMain } from '../exit.ts';
import { liveGitHub, resolveRepo } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';
import { cutVersions } from '../version-cut.ts';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，../exit.ts）：提前退出用 exitWith，runMain 接住设退出码。
runMain(async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const out = (line: string) => console.log(line);
  const err = (line: string) => console.error(inActions ? annotation(line) : line);
  if (process.argv.length > 2) {
    err('用法：version-cut.ts（不带参数）');
    exitWith(2);
  }
  const resolved = resolveRepo(process.env, root);
  if (!resolved.repo) {
    err(resolved.error ?? '没做成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
    exitWith(2);
  }
  const name = resolved.repo;
  const gh = liveGitHub(name, process.env);
  const r = await cutVersions(
    {
      ...gh,
      async mainHead() {
        const head = await gh.branchHead(await gh.defaultBranch());
        if (!head) throw new Error('读不到主线头');
        return head;
      },
    },
    new Date(),
  );
  for (const line of r.lines) out(line);
  for (const p of r.problems) err(`要人看：${p}。`);
  for (const f of r.failed) err(`没做成：${f}。`);
  if (r.failed.length) process.exitCode = 2;
  else if (r.problems.length) process.exitCode = 1;
  return undefined;
});
