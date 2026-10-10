// 「思考档位」页（#470）的白话和计数：页面只管摆，判法（能配哪几档）在后端照 shared 的 effort.ts 给好的 choices / fixed。
// 分组（#1756）：能配顶上展开；配不了、未分类默认折叠。未分类＝目录没厂家（family）。
import type { EffortModel, RouteEffort, SessionEffort } from '../api/types';

/** 每一档的一句白话（悬停看）；页面上的字照命令行的叫法写，和 claude --effort、grok --reasoning-effort 对得上。 */
export const EFFORT_HINT: Record<SessionEffort, string> = {
  low: '想得最少，最快最省',
  medium: '少想一些（快档的活引擎会压到这一档）',
  high: '默认档（创始人 2026-09-28 拍）',
  xhigh: '想得更深，更慢更贵',
  max: '想得最深，最慢最贵（Grok 没有这一档）',
};

/** 起会话照哪一档：配了照配的，没配用默认档。配不了的（档位写死在模型串里、引擎没接上）返回 null。 */
export function effectiveEffort(
  route: Pick<RouteEffort, 'effort' | 'fixed'>,
  defaultEffort: SessionEffort,
): { effort: SessionEffort; configured: boolean } | null {
  if (route.fixed !== undefined) return null;
  return route.effort
    ? { effort: route.effort, configured: true }
    : { effort: defaultEffort, configured: false };
}

/** 顶上的数：几条配了、几条用默认、几条配不了。 */
export function effortCounts(models: readonly EffortModel[]): {
  configured: number;
  byDefault: number;
  fixed: number;
} {
  const routes = models.flatMap((m) => m.routes);
  const fixed = routes.filter((r) => r.fixed !== undefined).length;
  const configured = routes.filter((r) => r.fixed === undefined && r.effort !== undefined).length;
  return { configured, byDefault: routes.length - fixed - configured, fixed };
}

/** 目录里没有厂家（family）＝未分类：展示用人读名，原始编号放悬停。 */
export function isUncategorizedModel(model: Pick<EffortModel, 'family'>): boolean {
  return !model.family;
}

/**
 * 从模型编号拼一句人能读的名字（目录没有 displayName 时用）。
 * gpt-5.5-none-fast → GPT 5.5 none fast；claude-4-sonnet → Claude 4 sonnet。
 */
export function readableModelName(modelId: string): string {
  return modelId
    .split('-')
    .map((part, i) => {
      if (/^\d/.test(part)) return part;
      if (part.toLowerCase() === 'gpt') return 'GPT';
      if (i === 0) return part.charAt(0).toUpperCase() + part.slice(1);
      return part;
    })
    .join(' ');
}

/** 表里的一行：一条「模型 × 路由」。 */
export type EffortRow = { model: EffortModel; route: RouteEffort };

/** 家族分组的先后：常用的在前，其余按名字排。 */
const FAMILY_ORDER = ['claude', 'gpt', 'grok', 'deepseek', 'gemini', 'glm', 'kimi'] as const;
const FAMILY_LABEL: Record<string, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  glm: 'GLM',
  kimi: 'Kimi',
  cursor: 'Cursor',
};

export function familyLabel(family: string): string {
  return FAMILY_LABEL[family.toLowerCase()] ?? family.charAt(0).toUpperCase() + family.slice(1);
}

/** 把能配的模型按家族分堆，每堆摊成「模型 × 路由」的行。没有厂家的模型不在这里（走未分类）。 */
export function groupRowsByFamily(
  models: readonly EffortModel[],
): { family: string; label: string; rows: EffortRow[] }[] {
  const byFamily = new Map<string, EffortRow[]>();
  for (const model of models) {
    const key = (model.family ?? '').toLowerCase();
    const rows = byFamily.get(key) ?? [];
    for (const route of model.routes) rows.push({ model, route });
    byFamily.set(key, rows);
  }
  const rank = (f: string) => {
    const i = (FAMILY_ORDER as readonly string[]).indexOf(f);
    return i === -1 ? FAMILY_ORDER.length : i;
  };
  return [...byFamily.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([family, rows]) => ({ family, label: familyLabel(family), rows }));
}

/** 搜索：模型名、模型编号、渠道名、池、路由编号里找（不分大小写）。 */
export function effortRowMatches(row: EffortRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const { model, route } = row;
  return [model.displayName, model.modelId, route.channelName, route.poolId, route.routeId, route.model].some(
    (s) => s.toLowerCase().includes(q),
  );
}

/** 一条配不了的路由，带着它所属的模型（行上要写渠道、模型名）。 */
export type FixedEffortItem = { model: EffortModel; route: RouteEffort };

/** 按原因归堆：同一句原因只在分组头写一次。 */
export type FixedEffortReasonGroup = { reason: string; items: FixedEffortItem[] };

/**
 * 把路由分成三组（#1756）：
 * - configurable：目录里有的、能配档位的（按模型聚好，只留能配的路）
 * - fixed：所有配不了的路，按原因归堆；total 与顶上「配不了」一致
 * - uncategorized：未分类模型下能配的路（配不了的进 fixed）
 */
export function groupEffortRoutes(models: readonly EffortModel[]): {
  configurable: EffortModel[];
  fixed: { total: number; byReason: FixedEffortReasonGroup[] };
  uncategorized: EffortModel[];
} {
  const configurable: EffortModel[] = [];
  const uncategorized: EffortModel[] = [];
  const byReason = new Map<string, FixedEffortItem[]>();

  for (const model of models) {
    const configRoutes = model.routes.filter((r) => r.fixed === undefined);
    const fixedRoutes = model.routes.filter((r) => r.fixed !== undefined);

    for (const route of fixedRoutes) {
      const reason = route.fixed ?? '';
      const list = byReason.get(reason) ?? [];
      list.push({ model, route });
      byReason.set(reason, list);
    }

    if (configRoutes.length === 0) continue;
    const slice: EffortModel = { ...model, routes: configRoutes };
    if (isUncategorizedModel(model)) uncategorized.push(slice);
    else configurable.push(slice);
  }

  const groups = [...byReason.entries()].map(([reason, items]) => ({ reason, items }));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { configurable, fixed: { total, byReason: groups }, uncategorized };
}
