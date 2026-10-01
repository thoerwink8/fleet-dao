// 卫生检查只管 fleet-dao 这一个仓（创始人 2026-10-01 10:50 前后拍：推之前查出真密钥照拦，但「除了这个仓库，
// 其他仓库不要拦（按照其他仓库自己标准）」）。别的仓按它们自己的标准来，不套这套规则。
// 引擎会管别的仓，所以每个要扫的地方都得先说清「动的是哪个仓」：对得上才扫；对不上就不扫（不是「查完再放行」——
// 别人的仓里有没有密钥、按什么规矩，不归 fleet-dao 管）。认不出是哪个仓（没给 owner/name）一律明确报错：
// 不许默认当成别的仓放过去，也不许默认当成 fleet-dao 拦下来。
//
// 这一份是默认值（不配就是它）。哪份配置想指别处（测试夹具、迁移期），在 createGitHub 的 hygieneRepo 上传一份；
// 只改这一处，推分支、写需求文档、开 PR、写单子都跟着。本机人推那条路不用动：`git push` 跑的是仓里的
// `.githooks/pre-push`（core.hooksPath 是仓级的），只在这个仓里生效。
import type { RepoRef } from './client.ts';
import { repoSlug } from './client.ts';
import { GitHubError } from './errors.ts';

/** 默认：fleet-dao 自己（公开仓，名单、真密钥防的都是往它推）。 */
export const HYGIENE_REPO: RepoRef = { owner: 'thoerwink8', name: 'fleet-dao' };

/** 动的是不是卫生检查管的那个仓：owner、name 都比，GitHub 上大小写不算差别。认不出是哪个仓就抛。 */
export function guardedByHygiene(repo: RepoRef | undefined | null, guard: RepoRef = HYGIENE_REPO): boolean {
  if (!repo?.owner || !repo.name) {
    throw new GitHubError(
      'HYGIENE_SCOPE_UNKNOWN',
      `认不出这次动的是哪个仓（没有 owner/name）：卫生检查只管 ${repoSlug(guard)} 这一个仓，认不出就判断不了`,
    );
  }
  return (
    repo.owner.toLowerCase() === guard.owner.toLowerCase() &&
    repo.name.toLowerCase() === guard.name.toLowerCase()
  );
}
