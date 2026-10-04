/**
 * 投递（GitHub 事件）两套 Store（pg-store、memory-store）共用的纯判断。
 * 改这里之前必须知道：pg 版把同样的判断写在 SQL 里（只能共用常量和「判完之后」的形状），内存版直接调这里的函数；
 * 两边「是否可接管」「接管次数怎么算」「重放没接到回什么」「记结局写哪些字段」以这里为准，契约测试（store-contract）管两边一致。
 */
import {
  type GitHubDeliveryClaim,
  type GitHubDeliveryOutcome,
  type GitHubDeliveryStatus,
  type GitHubObjectVersion,
  REPO_NOT_MANAGED,
} from './ports.ts';

/** 上次出错的、在等着的：不管占用多久都可以接过来重做。 */
export const RECLAIMABLE_STATUSES = ['failed', 'waiting'] as const satisfies readonly GitHubDeliveryStatus[];

/** 从这个状态接回来不加次数：等上一轮不占自动重放的次数。 */
export const ATTEMPT_FREE_STATUS = 'waiting' as const satisfies GitHubDeliveryStatus;

/** 同一时刻不同写法（秒 / 毫秒）算同一个。 */
export const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

/**
 * 可以接过来重做：上次出错的、在等着的、处理中但占用早于 staleBefore 的（那一次多半死了）。
 * 时刻都是 toISOString 的写法，按字面比就是按先后比。
 */
export function isReclaimable(
  row: { status: GitHubDeliveryStatus; claimedAt: string },
  staleBefore: string,
): boolean {
  return (
    (RECLAIMABLE_STATUSES as readonly GitHubDeliveryStatus[]).includes(row.status) ||
    (row.status === 'processing' && row.claimedAt < staleBefore)
  );
}

/** 接过来重做之后的次数：加一；从等着接回来的不加。 */
export function reclaimedAttempts(row: { status: GitHubDeliveryStatus; attempts: number }): number {
  return row.attempts + (row.status === ATTEMPT_FREE_STATUS ? 0 : 1);
}

/** force 重放：处理完的（不管成没成）也重新占住；只有处理中而且占用没过期的（真有人在做）不抢。 */
export function isForceReclaimable(
  row: { status: GitHubDeliveryStatus; claimedAt: string },
  staleBefore: string,
): boolean {
  return row.status !== 'processing' || row.claimedAt < staleBefore;
}

/** 重放没接到时回什么：库里没有 = not_found；处理中 = in_flight（别人正占着）；其余 = finished（处理完了、没开 force）。 */
export function reclaimMissStatus(
  existing: GitHubDeliveryStatus | undefined,
): 'not_found' | 'in_flight' | 'finished' {
  if (existing === undefined) return 'not_found';
  return existing === 'processing' ? 'in_flight' : 'finished';
}

/**
 * 别的投递带过这一版（skipIfSeen）时怎么办：有没被门挡掉的 = duplicate（不再做）；全被挡掉的照样做，
 * 其中只要有一条不是「仓不受管」挡的，就回 seenBefore（不算补回）。没有别的投递带过 = 正常做、不算 seenBefore。
 */
export function judgeCarriers(
  carriers: readonly { status: GitHubDeliveryStatus; reason?: string | null | undefined }[],
): { duplicate: true } | { duplicate: false; seenBefore: boolean } {
  if (carriers.some((c) => c.status !== 'ignored')) return { duplicate: true };
  return { duplicate: false, seenBefore: carriers.some((c) => c.reason !== REPO_NOT_MANAGED) };
}

/** 占到了回什么：seenBefore 只在真的为 true 时才出现（没带 skipIfSeen、或没见过的，字段不写）。 */
export function claimedResult(
  token: string,
  retry: boolean,
  seenBefore: boolean,
): Extract<GitHubDeliveryClaim, { status: 'claimed' }> {
  return { status: 'claimed', token, retry, ...(seenBefore ? { seenBefore: true } : {}) };
}

/** 同一条投递里同一个对象只能有一版（库里是主键）；有重复就回那个对象，没有回 undefined。 */
export function duplicateVersionObject(
  versions: readonly Pick<GitHubObjectVersion, 'object'>[],
): string | undefined {
  const seen = new Set<string>();
  for (const v of versions) {
    if (seen.has(v.object)) return v.object;
    seen.add(v.object);
  }
  return undefined;
}

/** 记结局：不收（ignored）、出错（failed）、等着（waiting）都得写原因（库里是 CHECK）。缺了就抛。 */
export function assertOutcomeHasReason(outcome: GitHubDeliveryOutcome): void {
  if (outcome.status !== 'accepted' && !outcome.reason) {
    throw new Error('github_events_reason_when_not_taken：不收、出错都得写原因');
  }
}

/** 记结局要写的字段：收下的只写 note（原因清空），其余只写 reason（note 清空）。没有的是 undefined（库版自己转 null）。 */
export function outcomeFields(outcome: GitHubDeliveryOutcome): {
  status: GitHubDeliveryStatus;
  reason: string | undefined;
  note: string | undefined;
} {
  return outcome.status === 'accepted'
    ? { status: outcome.status, reason: undefined, note: outcome.note }
    : { status: outcome.status, reason: outcome.reason, note: undefined };
}

/**
 * 一版是不是「更新的、开关状态不一样、算数的」：同一对象、有 state、state 和问的不一样、时刻晚于问的。
 * （投递本身是否已放进来、是否排除自己，由调用方先挡。）
 */
export function supersedes(
  candidate: GitHubObjectVersion,
  query: { object: string; version: string; state: 'open' | 'closed' },
): candidate is GitHubObjectVersion & { state: 'open' | 'closed' } {
  return (
    candidate.object === query.object &&
    !!candidate.state &&
    candidate.state !== query.state &&
    Date.parse(candidate.version) > Date.parse(query.version)
  );
}

/** 在候选里挑最新的一版（时刻相同取先遇到的）。 */
export function newestSuperseding<T extends { version: string }>(candidates: readonly T[]): T | null {
  let newest: T | null = null;
  for (const c of candidates) {
    if (!newest || Date.parse(c.version) > Date.parse(newest.version)) newest = c;
  }
  return newest;
}
