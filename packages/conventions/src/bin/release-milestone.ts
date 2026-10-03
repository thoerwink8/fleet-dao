// release.yml 里两步的入口：node packages/conventions/src/bin/release-milestone.ts check|close
// - check：打 tag 之前核这一版对得上版本里程碑（对不上就红，tag、release 都不动）；
// - close：建完 release 之后关这一版的里程碑（重跑时已经关过就跳）。判法在 ../release-milestone.ts。
// 读环境变量：VERSION（v<N>）、RELEASE_MERGED_AT（pull_request 事件里的合并时间；手动补跑时是空，要用时自己查）、
// GITHUB_REPOSITORY、GITHUB_TOKEN（要能写 issues：里程碑归它管）。
// 退出码：0 照判走完了（要关、关了、已经关过）；1 对不上、读不到、认不出（打 ::error::，后面的步骤不走）；2 用法不对。
import { fileURLToPath } from 'node:url';
import { liveGitHub, repoName } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';
import { type ReleaseMilestoneMode, releaseMilestone } from '../release-milestone.ts';

const mode = process.argv[2];
if (mode !== 'check' && mode !== 'close') {
  console.error(annotation(`用法：release-milestone.ts check|close（收到「${mode ?? ''}」）`));
  process.exit(2);
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = repoName(process.env, root);
if (!repo) {
  console.error(
    annotation('认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）：读不了里程碑。'),
  );
  process.exit(1);
}

try {
  const r = await releaseMilestone({
    mode: mode as ReleaseMilestoneMode,
    version: process.env.VERSION ?? '',
    mergedAt: process.env.RELEASE_MERGED_AT,
    github: liveGitHub(repo, process.env),
  });
  console.log(annotation(r.note, 'notice'));
} catch (e) {
  console.error(annotation(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
