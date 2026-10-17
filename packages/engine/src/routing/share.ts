// 同一档：选路已经选中这一档里的一条之后，按权重在还派得出去的成员里再分一次。
// 权重一样也不取第一条（和 allocate.ts 的加权平手不同）：给了抽签的数就按权重切，没给才取最大、平了取先出现的。
import { routeLabel } from './names.ts';
import type { Ranked } from './rank.ts';

export interface ShareJudged {
  item: Ranked;
  blocks: { text: string }[];
}

/** 按正整数权重切 [0, 1)。没给 u：取最大的，平了取先出现的。 */
export function sharePick(weights: readonly number[], u: number | undefined): number {
  if (weights.length === 0) return 0;
  if (u === undefined || !Number.isFinite(u)) {
    let best = 0;
    for (let i = 1; i < weights.length; i += 1) {
      if ((weights[i] ?? 0) > (weights[best] ?? 0)) best = i;
    }
    return best;
  }
  const sum = weights.reduce((n, w) => n + Math.max(0, w), 0);
  if (sum <= 0) return 0;
  let x = Math.min(Math.max(u, 0), 0.999999999) * sum;
  for (let i = 0; i < weights.length; i += 1) {
    x -= Math.max(0, weights[i] ?? 0);
    if (x < 0) return i;
  }
  return weights.length - 1;
}

function weightOf(item: Ranked): number {
  const w = item.entry.shareWeight;
  return typeof w === 'number' && Number.isInteger(w) && w >= 1 ? w : 1;
}

/**
 * 选中的这条若在「至少两条、且至少两条还派得出去」的同一档里，按权重改派。
 * 钉住的不改。档里只剩一条派得出去就维持原来的选择（它拿走全部）。
 * 返回 null = 不改。
 */
export function shareRedirect(
  chosen: Ranked,
  ready: readonly ShareJudged[],
  judged: readonly ShareJudged[],
  u: number | undefined,
  stageName: string,
  how: string,
): { item: Ranked; why: string } | null {
  if (chosen.pinned) return null;
  const band = chosen.entry.shareBand;
  if (typeof band !== 'number') return null;
  const modelId = chosen.route.modelId;
  const inBand = (j: ShareJudged) => j.item.route.modelId === modelId && j.item.entry.shareBand === band;
  const group = judged.filter(inBand);
  if (group.length < 2) return null;
  const pool = ready.filter((j) => inBand(j) && !j.item.pinned);
  if (pool.length < 2) return null;
  const weights = pool.map((j) => weightOf(j.item));
  const picked = pool[sharePick(weights, u)];
  if (!picked) return null;
  const sum = weights.reduce((n, w) => n + w, 0);
  const parts = pool
    .map(
      (j, i) =>
        `${routeLabel(j.item.route)} 权重 ${weights[i] ?? 1}（${Math.round(((weights[i] ?? 1) / sum) * 100)}%）`,
    )
    .join('、');
  const blocked = group
    .filter((j) => j.blocks.length > 0)
    .map((j) => `${routeLabel(j.item.route)}（${j.blocks.map((b) => b.text).join('、')}）`);
  const why = [
    `${stageName}阶段同一档按权重分：${routeLabel(picked.item.route)}`,
    `同一档：${parts}`,
    blocked.length > 0 ? `同一档里派不了的：${blocked.join('、')}` : null,
    how,
  ]
    .filter((s): s is string => s !== null)
    .join('；');
  return { item: picked.item, why };
}
