// 「思考档位」页（#470）的白话和计数：页面只管摆，判法（能配哪几档）在后端照 shared 的 effort.ts 给好的 choices / fixed。
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
