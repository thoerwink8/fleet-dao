// 把默认骨架（routing.default.json）写进库的两张路由表（#574）。按行补缺（#1351）：骨架里有、库里没有的（模型, 路由）行，追加到这个模型
// 现有路由的末尾、开关和思考档位照骨架；骨架里某用途有、库里该用途没有的模型，追加到该用途末尾。库里已有的行（驾驶舱改过的顺序、开关、
// 思考档位）一律不动、不删。以前是「模型（用途）已有任何一行就整块跳过」，后来加给老模型的新路由、加进老用途的新模型就永远进不了库。
// 引用对不上（模型、路由库里没有，路由不属于那个模型）、思考档位这条路由的执行方式不认、有用途既没单列又没有 default：
// 一行不写、明确报错。
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
    for (const stage of STAGE_KINDS) {
      const list = listFor(stage) ?? [];
      const have = await tx
        .select({ modelId: routingPurposeModels.modelId, position: routingPurposeModels.position })
        .from(routingPurposeModels)
        .where(eq(routingPurposeModels.purpose, stage));
      const haveIds = new Set(have.map((h) => h.modelId));
      const missingModels = list.filter((modelId) => !haveIds.has(modelId));
      // 追加在该用途现有最大位置的后面；库里没有行就从 0 起（整个用途新装）
      const next = have.length === 0 ? 0 : Math.max(...have.map((h) => h.position)) + 1;
      if (missingModels.length > 0) {
        await tx
          .insert(routingPurposeModels)
          .values(missingModels.map((modelId, i) => ({ purpose: stage, modelId, position: next + i })));
        report.purposeRowsInserted += missingModels.length;
      }
      if (have.length === 0) report.purposesApplied.push(stage);
      else if (missingModels.length === 0) report.purposesKept.push(stage);
      else
        for (const modelId of missingModels) report.purposeModelsAppended.push({ purpose: stage, modelId });
    }
    for (const [modelId, rs] of Object.entries(cfg.models)) {
      const have = await tx
        .select({ routeId: routingCatalog.routeId, position: routingCatalog.position })
        .from(routingCatalog)
        .where(eq(routingCatalog.modelId, modelId));
      const haveIds = new Set(have.map((h) => h.routeId));
      const missingRoutes = rs.filter((r) => !haveIds.has(r.routeId));
      const next = have.length === 0 ? 0 : Math.max(...have.map((h) => h.position)) + 1;
      if (missingRoutes.length > 0) {
        await tx.insert(routingCatalog).values(
          missingRoutes.map((r, i) => ({
            modelId,
            routeId: r.routeId,
            position: next + i,
            enabled: r.enabled,
            effort: r.effort ?? null,
          })),
        );
        report.catalogRowsInserted += missingRoutes.length;
      }
      if (have.length === 0) report.modelsApplied.push(modelId);
      else if (missingRoutes.length === 0) report.modelsKept.push(modelId);
      else
        for (const r of missingRoutes)
          report.routesAppended.push({ modelId, routeId: r.routeId, enabled: r.enabled });
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
 * 命令行（bin/routing.ts）和测试共用的一趟：读骨架 → 只补缺写进库 → 摘要。读不到、格式错、引用对不上照样抛
 * （RoutingConfigError，库里一行不写），由命令行变成退出码 1、发布那一步红，不吞。
 */
export async function runRoutingApply(db: Db, path: string | URL = ROUTING_DEFAULT_PATH): Promise<string> {
  const cfg = await loadRoutingConfig(path);
  return formatRoutingApplyReport(await applyRoutingDefault(db, cfg));
}
