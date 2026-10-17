/** 同一档在驾驶舱上怎么说：各自分到的比例，以及近 14 天用得均不均。 */

export interface ShareMember {
  label: string;
  weight: number;
  recent: number;
}

const MIN_SAMPLES = 8;
const EVEN_GAP = 0.15;

export function shareEvenness(members: readonly ShareMember[]): string {
  const total = members.reduce((n, m) => n + m.recent, 0);
  if (total < MIN_SAMPLES) return `近 14 天 ${total} 次，还看不出均不均`;
  const sum = members.reduce((n, m) => n + m.weight, 0);
  const uneven = members.some((m) => Math.abs(m.recent / total - m.weight / sum) > EVEN_GAP);
  return uneven ? '不均匀' : '均匀';
}

export function shareLine(members: readonly ShareMember[]): string {
  const sum = members.reduce((n, m) => n + m.weight, 0);
  const parts = members
    .map((m) => `${m.label} ${Math.round((m.weight / sum) * 100)}%（权重 ${m.weight}）`)
    .join('、');
  return `同一档：${parts}；${shareEvenness(members)}`;
}

/** 按档分组。单独一条不出这句话。 */
export function shareBanners(rows: readonly (ShareMember & { band: number })[]): string[] {
  const groups = new Map<number, ShareMember[]>();
  for (const row of rows) {
    const list = groups.get(row.band) ?? [];
    list.push({ label: row.label, weight: row.weight, recent: row.recent });
    groups.set(row.band, list);
  }
  const lines: string[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    lines.push(shareLine(members));
  }
  return lines;
}
