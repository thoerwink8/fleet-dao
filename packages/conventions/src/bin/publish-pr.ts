// 「发布 vN」PR 的发起入口：pnpm publish:pr（= node packages/conventions/src/bin/publish-pr.ts），在 release/v<N> 分支上跑。
// - 版本号取当前版本里程碑（GitHub 上开着的 v<N> 里程碑里 N 最小的那张）；分支名得是 release/<这个版本号>；
// - 把仓根 CHANGELOG.md 的 Unreleased 段收进「## [v<N>] - 日期」、提交、推，再跑 gh pr create 开「发布 v<N>」PR（base 一律 main）；
// - 不调 workflow_dispatch：合并这张 PR 之后，.github/workflows/release.yml 接手核版本里程碑 → 打 tag → 建 release → 关里程碑 → 推飞书（0011 第 4 条）。
// 退出码：0 开成了（打 PR 号和地址）；1 没开成（分支不对、没身份、读不到里程碑、版本对不上、gh 报错、CHANGELOG.md 认不出，逐条写明）。
// 测试用 publish-actions.ts（纯）+ publish-pr.ts 的 deps 替身（packages/conventions/test/publish-pr.test.ts）。
import { fileURLToPath } from 'node:url';
import { publishPr } from '../publish-pr.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

try {
  const r = await publishPr({ env: process.env, root, note: (line) => console.log(line) });
  console.log(`开了「发布 ${r.version}」PR #${r.pr}：${r.url}（head ${r.headBranch} → main）`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
