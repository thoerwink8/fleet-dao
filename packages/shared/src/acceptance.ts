// 公开机器只读契约，不属于浏览器 FleetApi，不提供写口。
export const PublicAcceptanceRoute = {
  method: 'GET',
  path: '/api/public/acceptance/v1/repos/:githubId/issues/:issue',
} as const;

/**
 * 验收责任的有效终态（#3114）：settled = 最终验收完成；superseded = 被同单同 PR 已合已验的后续交付替代收口；其余都是 open。
 * 关闭判定（引擎收尾留单）、受管 status、公开读口都只照这里算，不各自另判。
 */
export type AcceptanceDutyState = 'open' | 'settled' | 'superseded';

/** 判终态要用的那几列；时间列 DB 行是 Date、JSON 是串，只看有没有。 */
export interface AcceptanceDutyFacts {
  id: number;
  generation: number;
  repo: string;
  issueNumber: number;
  prNumber: number;
  head: string;
  items: readonly string[];
  mergeCommit: string | null;
  settledAt: unknown;
  supersededAt?: unknown;
  successorId?: number | null;
  successorGeneration?: number | null;
}

const MERGE_COMMIT = /^[a-f0-9]{40}$/;

/**
 * source 能不能由 target 的 generation 代替代收口：不行回原因，行回 undefined。写入前核验和读时现算用同一个判法——
 * 同仓同单同 PR 不同头、目标有真合并回执且最终验收完成、目标没被替代、目标仍是那一代、目标验收项盖住源的全部项。
 */
export function supersessionProblem(
  source: AcceptanceDutyFacts,
  target: AcceptanceDutyFacts | undefined,
  generation: number | null | undefined,
): string | undefined {
  if (!target) return '目标责任读不到';
  if (source.settledAt != null) return '源责任已最终验收，不用替代';
  if (target.id === source.id || target.head === source.head) return '目标和源是同一个交付';
  if (source.prNumber === 0) return '协调责任没有 PR 头，不能替代收口';
  if (target.repo !== source.repo || target.issueNumber !== source.issueNumber) return '目标不是同仓同单';
  if (target.prNumber !== source.prNumber) return '目标不是同一个 PR';
  if (target.generation !== generation) return '目标代次已变，替代关系过期';
  if (target.mergeCommit === null || !MERGE_COMMIT.test(target.mergeCommit)) return '目标没有真实合并回执';
  if (target.settledAt == null) return '目标还没完成最终验收';
  if (target.supersededAt != null) return '目标自己被替代了，不接力';
  const covered = new Set(target.items);
  const missing = source.items.filter((i) => !covered.has(i));
  if (missing.length) return `目标验收项没盖住源的：${missing.join('；')}`;
  return undefined;
}

/** rows 是同一张单读回来的全部责任（目标必在其中，读不到就不算替代）。 */
export function acceptanceDutyState(
  row: AcceptanceDutyFacts,
  rows: readonly AcceptanceDutyFacts[],
): AcceptanceDutyState {
  if (row.settledAt != null) return 'settled';
  if (row.supersededAt == null) return 'open';
  const target = rows.find((r) => r.id === row.successorId);
  return supersessionProblem(row, target, row.successorGeneration) ? 'open' : 'superseded';
}
