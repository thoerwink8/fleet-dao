// 把默认骨架（routing.default.json）写进库的两张路由表（#574）。骨架只做新装机的初始值（#1356）：
// routing_purpose_models 已经有任何一行，就不再往用途里补模型、不再改开关、不再追加路由（创始人在页面上删掉的要留着）。
// 一张用途行都没有的空库才按骨架整份写一次。用途还是空、但某个模型的路由层已经有行：那些行不动（不改开关），只给还没有路由行的模型写。
// 引用对不上（模型、路由库里没有，路由不属于那个模型）、思考档位这条路由的执行方式不认、有用途既没单列又没有 default、
// 只有创始人本人能开的模型（Fable，决定 0033）被配进用途或路由写成开着：先报错、一行不写
// （库里已经有用途行时也一样，不因为「这次本来就不改」就把坏骨架放过去）。关着、不进任何用途的可以写。
// 发布时由 bin/routing.ts 在目录装载器之后调（deploy/release.sh 的 load_routing）：路由要先由目录装进库，骨架才对得上。
import { founderOnlyFor, routeEffortProblem } from '@fleet-dao/shared';
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
  /** 这次整个写进去的用途、模型（库里原来一行都没有）。 */
  purposesApplied: string[];
  modelsApplied: string[];
  /** 库里已经有行、骨架也没有新东西要补，所以没动的用途、模型。 */
  purposesKept: string[];
  modelsKept: string[];
  /** 库里已有行的用途里，这次追加了的「用途 → 模型」行（追加在该用途末尾）。 */
  purposeModelsAppended: { purpose: string; modelId: string }[];
  /** 库里已有行的模型里，这次追加了的「模型 → 路由」行（追加在该模型末尾）。 */
  routesAppended: { modelId: string; routeId: string; enabled: boolean }[];
  /** 这次一共写进去几行（整块写的加追加的）：用途 → 模型那一层、模型 → 路由那一层。 */
  purposeRowsInserted: number;
  catalogRowsInserted: number;
}

export async function applyRoutingDefault(db: Db, cfg: RoutingConfig): Promise<RoutingApplyReport> {
  const problems: string[] = [];
  const listFor = (stage: (typeof STAGE_KINDS)[number]) => cfg.purposes[stage] ?? cfg.purposes.default;
  const missing = STAGE_KINDS.filter((s) => listFor(s) === undefined);
  if (missing.length > 0) problems.push(`没有 default，这些用途也没单列：${missing.join('、')}`);

  const modelIds = Object.keys(cfg.models);
  const modelRows = await db
    .select({ id: models.id, family: models.family, displayName: models.displayName })
    .from(models)
    .where(inArray(models.id, modelIds));
  const knownModels = new Set(modelRows.map((m) => m.id));
  for (const m of modelIds) if (!knownModels.has(m)) problems.push(`模型 ${m} 库里没有`);
  const routeIds = Object.values(cfg.models).flatMap((rs) => rs.map((r) => r.routeId));
  const knownRoutes = new Map(
    (
      await db
        .select({
          id: routes.id,
          modelId: routes.modelId,
          hostId: routes.hostId,
          upstreamModel: routes.upstreamModel,
          upstreamAliases: routes.upstreamAliases,
        })
        .from(routes)
        .where(inArray(routes.id, routeIds))
    ).map((r) => [r.id, r]),
  );
  // 只有创始人本人能开的模型（Fable，决定 0033）：骨架是机器写进库的，不能替他把它配进用途或打开。
  // 骨架里列着它、但路由是关着的、也不在任何用途里，可以（入库默认就是这样）。
  for (const [modelId, rs] of Object.entries(cfg.models)) {
    const row = modelRows.find((m) => m.id === modelId);
    if (row === undefined) continue;
    const founderOnly = [
      founderOnlyFor(row),
      ...rs.map((r) => {
        const known = knownRoutes.get(r.routeId);
        return known && founderOnlyFor({ ...row, ...known, id: row.id });
      }),
    ].find((rule) => rule !== undefined);
    if (founderOnly === undefined) continue;
    const inPurposes = STAGE_KINDS.filter((s) => listFor(s)?.includes(modelId));
    const opened = rs.filter((r) => r.enabled).map((r) => r.routeId);
    if (inPurposes.length > 0) {
      problems.push(`模型 ${modelId} 在骨架里被配进用途 ${inPurposes.join('、')}：${founderOnly.reason}`);
    }
    if (opened.length > 0) {
      problems.push(`模型 ${modelId} 的路由 ${opened.join('、')} 在骨架里是开着的：${founderOnly.reason}`);
    }
  }
  for (const [model, rs] of Object.entries(cfg.models)) {
    for (const r of rs) {
      const known = knownRoutes.get(r.routeId);
      if (known === undefined) problems.push(`路由 ${r.routeId} 库里没有`);
      else if (known.modelId !== model) {
        problems.push(`路由 ${r.routeId} 在库里属于模型 ${known.modelId}，配置把它挂在 ${model} 下`);
      } else if (r.effort !== undefined) {
        // 已经装过的模型这次不写，档位照样要对：骨架是一份，错的值不留到下一个新库里才发现
        const problem = routeEffortProblem(known.hostId, known.upstreamModel ?? known.modelId, r.effort);
        if (problem) problems.push(`路由 ${r.routeId} 的思考档位配不了：${problem}`);
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
      purposeModelsAppended: [],
      routesAppended: [],
      purposeRowsInserted: 0,
      catalogRowsInserted: 0,
    };
    const existingPurposes = await tx
      .select({ purpose: routingPurposeModels.purpose })
      .from(routingPurposeModels);
    if (existingPurposes.length > 0) {
      const havePurposes = new Set(existingPurposes.map((r) => r.purpose));
      report.purposesKept = STAGE_KINDS.filter((stage) => havePurposes.has(stage));
      const haveModels = new Set(
        (await tx.select({ modelId: routingCatalog.modelId }).from(routingCatalog)).map((r) => r.modelId),
      );
      report.modelsKept = Object.keys(cfg.models).filter((modelId) => haveModels.has(modelId));
      return report;
    }
    for (const stage of STAGE_KINDS) {
      const list = listFor(stage) ?? [];
      if (list.length > 0) {
        await tx
          .insert(routingPurposeModels)
          .values(list.map((modelId, position) => ({ purpose: stage, modelId, position })));
        report.purposeRowsInserted += list.length;
      }
      report.purposesApplied.push(stage);
    }
    for (const [modelId, rs] of Object.entries(cfg.models)) {
      const have = await tx
        .select({ routeId: routingCatalog.routeId })
        .from(routingCatalog)
        .where(eq(routingCatalog.modelId, modelId));
      if (have.length > 0) {
        report.modelsKept.push(modelId);
        continue;
      }
      if (rs.length > 0) {
        await tx.insert(routingCatalog).values(
          rs.map((r, position) => ({
            modelId,
            routeId: r.routeId,
            position,
            enabled: r.enabled,
            effort: r.effort ?? null,
          })),
        );
        report.catalogRowsInserted += rs.length;
      }
      report.modelsApplied.push(modelId);
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
  if (
    r.purposesApplied.length === 0 &&
    r.modelsApplied.length === 0 &&
    r.purposeModelsAppended.length === 0 &&
    r.routesAppended.length === 0
  ) {
    return `路由两层已齐，这次一行没改；${kept}`;
  }
  const lines: string[] = [];
  if (r.routesAppended.length > 0) {
    lines.push(
      `给库里已有的模型追加了路由 ${r.routesAppended.length} 行（接在该模型现有路由末尾）：${r.routesAppended
        .map((x) => `${x.modelId} ← ${x.routeId}（${x.enabled ? '开' : '关'}）`)
        .join('、')}`,
    );
  }
  if (r.purposeModelsAppended.length > 0) {
    lines.push(
      `给库里已有的用途追加了模型 ${r.purposeModelsAppended.length} 行（接在该用途末尾）：${r.purposeModelsAppended
        .map((x) => `${x.purpose} ← ${x.modelId}`)
        .join('、')}`,
    );
  }
  if (r.purposesApplied.length > 0) {
    lines.push(
      `补了用途 → 模型 ${r.purposeRowsInserted - r.purposeModelsAppended.length} 行（${r.purposesApplied.length} 个用途：${r.purposesApplied.join('、')}）`,
    );
  }
  if (r.modelsApplied.length > 0) {
    lines.push(
      `补了模型 → 路由 ${r.catalogRowsInserted - r.routesAppended.length} 行（${r.modelsApplied.length} 个模型：${r.modelsApplied.join('、')}）`,
    );
  }
  lines.push(kept);
  return lines.join('\n');
}

/**
 * 命令行（bin/routing.ts）和测试共用的一趟：读骨架 → 空库才写进库 → 摘要。读不到、格式错、引用对不上照样抛
 * （RoutingConfigError，库里一行不写），由命令行变成退出码 1、发布那一步红，不吞。
 */
export async function runRoutingApply(db: Db, path: string | URL = ROUTING_DEFAULT_PATH): Promise<string> {
  const cfg = await loadRoutingConfig(path);
  return formatRoutingApplyReport(await applyRoutingDefault(db, cfg));
}
