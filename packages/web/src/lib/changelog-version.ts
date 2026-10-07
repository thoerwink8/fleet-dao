// 更新日志上「已发布」和「这一版」不能是同一个号。
// 已发布＝有 v<N> 发布标记（CHANGELOG 里 ## [vN] - 日期）。
// 「这一版」的候选＝开着的版本里程碑里 N 最小的那张（和发布判法同一条）。
// 候选已经有发布标记：它算已发布，「这一版」取下一个号；下一个号也发过就继续往后，直到不再撞上。
// 候选自己没有标记就不动：版本号可以不连续（更早的号发过，不代表这一版要按「已发布的最大号 +1」猜）。
// 真后端同一条在 packages/api/src/release-version.ts 的 openMilestonesForChangelog。
// pnpm publish:pr 不走这条：标题里已经有这一版、里程碑还开着，发起仍然拒绝。

export interface ReleaseMilestone {
  number: number;
  title: string;
}

export interface OpenReleaseMilestone {
  version: string;
  milestone: ReleaseMilestone;
}

export interface SeparatedRelease {
  version: string;
  milestone: ReleaseMilestone;
  others: ReleaseMilestone[];
}

const VERSION_RE = /^v(\d+)$/;

function versionNumber(version: string): number {
  const matched = VERSION_RE.exec(version);
  if (!matched?.[1]) throw new Error(`版本号认不出：${version}`);
  return Number(matched[1]);
}

/**
 * 开着的版本里程碑里 N 最小的那张是「这一版」的候选。
 * 它已在 released 里：判成已发布，这一版改成下一个还没发布标记的号。
 */
export function separateReleasedFromCurrent(
  open: readonly OpenReleaseMilestone[],
  released: readonly { version: string }[],
): SeparatedRelease {
  if (open.length === 0) throw new Error('开着的版本里程碑一张都没有，定不了这一版');
  let candidate = open[0] as OpenReleaseMilestone;
  let candidateN = versionNumber(candidate.version);
  for (const item of open) {
    const n = versionNumber(item.version);
    if (n < candidateN) {
      candidate = item;
      candidateN = n;
    }
  }
  const taken = new Set(released.map((item) => item.version));
  let n = candidateN;
  let version = candidate.version;
  while (taken.has(version)) {
    n += 1;
    version = `v${n}`;
  }
  const hit = open.find((item) => item.version === version);
  const milestone = hit?.milestone ?? { number: n, title: version };
  const others = open
    .filter((item) => item.version !== version && !taken.has(item.version))
    .map((item) => item.milestone);
  return { version, milestone, others };
}
