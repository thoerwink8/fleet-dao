// 并主线共用的核心（#307/#389 那次真事之后加，见 fusion.ts 里 CI 报冲突走的那条路；创始人 09-28 凌晨接着要的
// 「正在干活的工人都拉一下主线内容」也用它）：调 syncMainline 端口，干净了交回新头，真冲突交回冲突文件——
// 不摸调用方的状态（谁调用谁自己决定要不要更新 head、写 status、派会话解冲突）。纯粹是「并一次」，多调几次
// 没坏处：本来就是最新的，端口内部（packages/github/src/sync.ts 第 3 步）短路成 clean、不产生新提交。
import type { Repo } from '@fleet-dao/shared';
import type { EngineActivities } from '../activity-options.ts';
import type { Scope } from '../ports.ts';
import { attempt, type Kit } from './kit.ts';

export interface SyncMainlineParams extends Scope {
  repo: Repo;
  /** 还没开 PR（任务边界并主线可能发生在开 PR 之前）时给 undefined：只影响并主线提交说明里那句话。 */
  prNumber?: number | undefined;
  branch: string;
  /** 以为分支现在的头（必须是最近一次引擎认下的头：pushBranch/上一次并主线交回的那个，不是本地随便一个提交）。 */
  head: string;
  worktreePath: string;
}

export interface SyncMainlineOutcome {
  /** clean = 并上了（或者本来就是最新，没什么可并）；conflict = 真冲突，什么都没推、没改工作树。 */
  state: 'clean' | 'conflict';
  /** clean 时是并出来的新头（工作树已经被端口快进过去，见 github-ports.ts 的 syncMainline）；conflict 时还是原来的 head。 */
  head: string;
  conflictFiles: string[];
}

/** 调 syncMainline 端口、把结果整理成调用方好用的形状。读不到 GitHub、推不上都走 attempt 的失败分流，不吞。 */
export async function syncMainlineNow(
  kit: Kit,
  acts: Pick<EngineActivities, 'syncMainline'>,
  params: SyncMainlineParams,
): Promise<SyncMainlineOutcome> {
  const sync = await attempt(kit, 'syncMainline', () => acts.syncMainline(params));
  if (sync.state === 'conflict') {
    return { state: 'conflict', head: params.head, conflictFiles: sync.conflictFiles };
  }
  return { state: 'clean', head: sync.head, conflictFiles: [] };
}
