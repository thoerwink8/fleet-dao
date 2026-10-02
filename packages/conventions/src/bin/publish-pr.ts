// 「发布 vN」PR 的发起入口：node packages/conventions/src/bin/publish-pr.ts
// - 读仓根 CHANGELOG.md 的 Unreleased 段算下一版（shared/changelog.ts 的 nextVersion）；
// - 拿当前分支当 head（发起之前先推好）；base 一律 main；
// - 跑 gh pr create，标题「发布 v<N>」、正文含「Closes #227」；
// - 不调 workflow_dispatch：合并这张 PR 之后，.github/workflows/release.yml 接手打 tag → 建 release → 关 milestone → 推飞书（0011 第 4 条）。
// 退出码：0 开成了（打 PR 号和地址）；1 没开成（缺 GITHUB_TOKEN、gh 报错、CHANGELOG.md 认不出，逐条写明）。
// 测试用 publish-actions.ts（纯）+ publish-pr.ts 的 deps 替身（packages/conventions/test/publish-pr.test.ts）。
import { fileURLToPath } from 'node:url';
import { publishPr } from '../publish-pr.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

try {
  const r = await publishPr({ env: process.env, root });
  console.log(`开了「发布 ${r.version}」PR #${r.pr}：${r.url}（head ${r.headBranch} → main）`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
