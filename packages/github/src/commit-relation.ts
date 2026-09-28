// 判两个提交谁包含谁（GitHub compare）：流程配置对账用它判「这个仓读到的新字段，是不是还没发布的引擎版本才认得」
// （jobs/flow-config.ts）——只有目标就是引擎自己的仓（thoerwink8/fleet-dao）时问它才有意义：别的受管仓的提交和引擎在跑
// 哪个提交没有祖先关系，比较不出（GitHub 回 404，两个提交不在同一段历史里）时回 null，不当成「不含」——调用方按
// 「判不出」处理，不能因为判不出就误放行该停派的项目。GitHub 接口真出错（不是 404）照样抛，不当判不出。
import { enc, encRef, type RepoRef, unexpected } from './client.ts';
import type { Deps } from './deps.ts';

export interface CommitAncestryInput {
  repo: RepoRef;
  /** 老提交（引擎自己在跑的那个）。 */
  base: string;
  /** 新提交（读到配置的那一刻，目标仓默认分支的头）。 */
  head: string;
  signal?: AbortSignal | undefined;
}

/**
 * head 是不是一个不少地包含 base（GitHub compare base...head 的 behind_by = 0）。两个提交比较不出关系（404：提交在这个
 * 仓里找不到，多半是不同的仓）回 null。
 */
export async function commitContains(deps: Deps, input: CommitAncestryInput): Promise<boolean | null> {
  const { repo, base, head, signal } = input;
  const path = `/repos/${enc(repo.owner)}/${enc(repo.name)}/compare/${encRef(base)}...${encRef(head)}`;
  const res = await deps.client.request<{ behind_by?: number }>({
    method: 'GET',
    path,
    auth: { as: 'engine' as const, repo },
    query: { per_page: 1 },
    allow: [404],
    signal,
  });
  if (res.status === 404) return null;
  const behindBy = res.data?.behind_by;
  if (typeof behindBy !== 'number')
    throw unexpected(`比较 ${base.slice(0, 7)}...${head.slice(0, 7)}`, res.data);
  return behindBy === 0;
}
