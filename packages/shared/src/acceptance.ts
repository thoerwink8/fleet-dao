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
  /** 替代时操作者逐项声明的覆盖映射（jsonb）；读时只认格式合法的条目。 */
  supersedeCoverage?: unknown;
}

/**
 * 逐源项覆盖声明：源项原文措辞和目标项不同（不同冷验收轮次写的）时，操作者人工审定「这条源项由目标的哪一条覆盖、凭什么」。
 * 不是自动匹配：source / target 必须是两行 items 里的原文整串，basis 是人写的依据；没写到的源项只认整串相等。
 */
export interface AcceptanceCoverage {
  source: string;
  target: string;
  basis: string;
}

/** 严格解析：不是 {source,target,basis} 三个非空串的数组就返回 undefined（调用方当格式错）。 */
export function parseAcceptanceCoverage(value: unknown): AcceptanceCoverage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AcceptanceCoverage[] = [];
  for (const e of value) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return undefined;
    const { source, target, basis, ...rest } = e as Record<string, unknown>;
    if (
      Object.keys(rest).length ||
      typeof source !== 'string' ||
      typeof target !== 'string' ||
      typeof basis !== 'string' ||
      !source ||
      !target ||
      !basis.trim()
    )
      return undefined;
    out.push({ source, target, basis: basis.trim() });
  }
  return out;
}

/** 排序去重成稳定形状：同一份声明换个顺序重放仍算同一请求。 */
export function normalizeAcceptanceCoverage(entries: readonly AcceptanceCoverage[]): AcceptanceCoverage[] {
  const key = (e: AcceptanceCoverage) => JSON.stringify([e.source, e.target, e.basis]);
  return [...new Map(entries.map((e) => [key(e), e])).values()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

export const sameAcceptanceCoverage = (a: unknown, b: unknown) => {
  const x = parseAcceptanceCoverage(a);
  const y = parseAcceptanceCoverage(b);
  return (
    !!x &&
    !!y &&
    JSON.stringify(normalizeAcceptanceCoverage(x)) === JSON.stringify(normalizeAcceptanceCoverage(y))
  );
};

const MERGE_COMMIT = /^[a-f0-9]{40}$/;

/**
 * source 能不能由 target 的 generation 代替代收口：不行回原因，行回 undefined。写入前核验和读时现算用同一个判法——
 * 同仓同单同 PR 不同头、目标有真合并回执且最终验收完成、目标没被替代、目标仍是那一代、目标验收项盖住源的全部项。
 * 「盖住」= 源项原文整串在目标项里，或操作者逐项声明了覆盖（源项、目标项都得是两行里的原文整串，且写了依据）。
 * coverage 缺省取源行上已落账的声明（读时现算）；写入前核验传本次请求里的。
 */
export function supersessionProblem(
  source: AcceptanceDutyFacts,
  target: AcceptanceDutyFacts | undefined,
  generation: number | null | undefined,
  coverage: unknown = source.supersedeCoverage,
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
  const declared = coverage == null ? [] : parseAcceptanceCoverage(coverage);
  if (!declared) return '覆盖声明格式不对';
  const targetItems = new Set(target.items);
  const sourceItems = new Set(source.items);
  const stray = declared.filter((e) => !sourceItems.has(e.source) || !targetItems.has(e.target));
  if (stray.length)
    return `覆盖声明里的项不是源 / 目标的原文：${stray.map((e) => `${e.source}→${e.target}`).join('；')}`;
  const mapped = new Set(declared.map((e) => e.source));
  const missing = source.items.filter((i) => !targetItems.has(i) && !mapped.has(i));
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
