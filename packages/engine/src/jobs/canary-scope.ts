// 一台引擎只认自己的巡检仓（#1136）。别的环境在自己的期望里写的 FLEET_CANARY_REPO，这台拉单不收。
// 写法和对账那一侧（deploy/france/auto-release/config.mjs 的 canaryRepoProblems）同一条：owner/name，不分大小写。

/** GitHub 的 owner/仓名。空的、认不出回 null（不当成某个仓）。 */
const CANARY_SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** 收成小写的 owner/name；没配、空着、认不出回 null。 */
export function normalizeCanarySlug(raw: string | undefined | null): string | null {
  const value = raw?.trim() ?? '';
  if (!CANARY_SLUG.test(value)) return null;
  return value.toLowerCase();
}

/**
 * 别的环境声明的巡检仓（小写 owner/name，去重）。自己这一项不算。
 * 自己没配、认不出：回空。猜哪一个是别人的，会把这台该拉的仓跳过。
 */
export function foreignCanarySlugs(own: string | undefined, declared: readonly string[]): string[] {
  const mine = normalizeCanarySlug(own);
  if (!mine) return [];
  const out: string[] = [];
  for (const raw of declared) {
    const slug = normalizeCanarySlug(raw);
    if (!slug || slug === mine || out.includes(slug)) continue;
    out.push(slug);
  }
  return out;
}
