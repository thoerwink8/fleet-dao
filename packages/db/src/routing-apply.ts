// 把默认骨架（routing.default.json）写进库的两张路由表（#574）。只补缺：某个用途在 routing_purpose_models 里已有行、某个模型在
// routing_catalog 里已有行，就不动它（驾驶舱改过的顺序、开关不覆盖），和目录装载器同一个规矩。
// 引用对不上（模型、路由库里没有，路由不属于那个模型）、有用途既没单列又没有 default：一行不写、明确报错。
// 发布时由 bin/routing.ts 在目录装载器之后调（deploy/release.sh 的 load_routing）：路由要先由目录装进库，骨架才对得上。
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  loadRoutingConfig,
  ROUTING_DEFAULT_PATH,
  type RoutingConfig,
  RoutingConfigError,
} from './routing-config.ts';
import { STAGE_KINDS } from './schema/enums.ts';
import { models, routes, routingCatalog, routingPurposeModels } from './schema/index.ts';

export interface RoutingApplyReport {
  /** 这次写进去的用途、模型。 */
  purposesApplied: string[];
  modelsApplied: string[];
  /** 库里已经有行、所以没动的用途、模型。 */
  purposesKept: string[];
  modelsKept: string[];
  /** 这次写进去几行：用途 → 模型那一层、模型 → 路由那一层。 */
  purposeRowsInserted: number;
  catalogRowsInserted: number;
}

export async function applyRoutingDefault(db: Db, cfg: RoutingConfig): Promise<RoutingApplyReport> {
  const problems: string[] = [];
  const listFor = (stage: (typeof STAGE_KINDS)[number]) => cfg.purposes[stage] ?? cfg.purposes.default;
  const missing = STAGE_KINDS.filter((s) => listFor(s) === undefined);
  if (missing.length > 0) problems.push(`没有 default，这些用途也没单列：${missing.join('、')}`);

  const modelIds = Object.keys(cfg.models);
  const knownModels = new Set(
    (await db.select({ id: models.id }).from(models).where(inArray(models.id, modelIds))).map((m) => m.id),
  );
  for (const m of modelIds) if (!knownModels.has(m)) problems.push(`模型 ${m} 库里没有`);
  const routeIds = Object.values(cfg.models).flatMap((rs) => rs.map((r) => r.routeId));
  const knownRoutes = new Map(
    (
      await db
        .select({ id: routes.id, modelId: routes.modelId })
        .from(routes)
        .where(inArray(routes.id, routeIds))
    ).map((r) => [r.id, r.modelId]),
  );
  for (const [model, rs] of Object.entries(cfg.models)) {
    for (const r of rs) {
      const owner = knownRoutes.get(r.routeId);
      if (owner === undefined) problems.push(`路由 ${r.routeId} 库里没有`);
      else if (owner !== model) {
        problems.push(`路由 ${r.routeId} 在库里属于模型 ${owner}，配置把它挂在 ${model} 下`);
      }
    }
  }
  if (problems.length > 0) throw new RoutingConfigError('默认骨架和库里对不上，一行没写', problems);

  return db.transaction(async (tx) => {
    const report: RoutingApplyReport = {
      purposesApplied: [],
      modelsApplied: [],
      purposesKept: [],
      modelsKept: [],
      purposeRowsInserted: 0,
      catalogRowsInserted: 0,
    };
    for (const stage of STAGE_KINDS) {
      const has = await tx
        .select()
        .from(routingPurposeModels)
        .where(eq(routingPurposeModels.purpose, stage))
        .limit(1);
      if (has.length > 0) {
        report.purposesKept.push(stage);
        continue;
      }
      const list = listFor(stage) ?? [];
      await tx
        .insert(routingPurposeModels)
        .values(list.map((modelId, position) => ({ purpose: stage, modelId, position })));
      report.purposesApplied.push(stage);
      report.purposeRowsInserted += list.length;
    }
    for (const [modelId, rs] of Object.entries(cfg.models)) {
      const has = await tx.select().from(routingCatalog).where(eq(routingCatalog.modelId, modelId)).limit(1);
      if (has.length > 0) {
        report.modelsKept.push(modelId);
        continue;
      }
      await tx
        .insert(routingCatalog)
        .values(rs.map((r, position) => ({ modelId, routeId: r.routeId, position, enabled: r.enabled })));
      report.modelsApplied.push(modelId);
      report.catalogRowsInserted += rs.length;
    }
    return report;
  });
}

/**
 * 给发布日志看的摘要：补了几条、保持几条。发布脚本把它原样打出来，读回两张表的行数另由脚本自己核。
 * 一行没写也说清「已齐」和保持了哪些，不留空（空着看不出是没跑还是跑了没改）。
 */
export function formatRoutingApplyReport(r: RoutingApplyReport): string {
  const kept = `库里已有、没动的：用途 ${r.purposesKept.length} 个、模型 ${r.modelsKept.length} 个（驾驶舱改过的不覆盖）`;
  if (r.purposesApplied.length === 0 && r.modelsApplied.length === 0) {
    return `路由两层已齐，这次一行没改；${kept}`;
  }
  const lines: string[] = [];
  if (r.purposesApplied.length > 0) {
    lines.push(
      `补了用途 → 模型 ${r.purposeRowsInserted} 行（${r.purposesApplied.length} 个用途：${r.purposesApplied.join('、')}）`,
    );
  }
  if (r.modelsApplied.length > 0) {
    lines.push(
      `补了模型 → 路由 ${r.catalogRowsInserted} 行（${r.modelsApplied.length} 个模型：${r.modelsApplied.join('、')}）`,
    );
  }
  lines.push(kept);
  return lines.join('\n');
}

/**
 * 命令行（bin/routing.ts）和测试共用的一趟：读骨架 → 只补缺写进库 → 摘要。读不到、格式错、引用对不上照样抛
 * （RoutingConfigError，库里一行不写），由命令行变成退出码 1、发布那一步红，不吞。
 */
export async function runRoutingApply(db: Db, path: string | URL = ROUTING_DEFAULT_PATH): Promise<string> {
  const cfg = await loadRoutingConfig(path);
  return formatRoutingApplyReport(await applyRoutingDefault(db, cfg));
}
