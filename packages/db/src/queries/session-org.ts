// 会话用户切号（#157、#59）要看的和要记的：带组织类型的池（Claude 订阅：拼车、独享）各自的额度窗口现在是什么状态、这些池上还有
// 哪些没结束的会话；切号、切号后核对、切号停下的会话怎么续上的，记进操作记录（驾驶舱「操作记录」页）。判不判、切不切由引擎定
// （engine 的 jobs/org-switch.ts）。
import {
  type ModelRef,
  type OrgKind,
  type QuotaWindowKind,
  usedRatioOf,
  windowAppliesTo,
} from '@fleet-dao/shared';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { routesInUse } from '../routing-layers.ts';
import { auditLog, models, pools, quotaWindows, routes } from '../schema/index.ts';
import { type OpenPoolRun, openPoolRuns } from './pool-runs.ts';
import { type WindowState, windowFull, windowState } from './quota.ts';

/**
 * 会话用户切号的「要人看」提醒都用这个前缀（引擎写：切号没成、切完探针读回不在线、拼车恢复时刻读不到）；开着就让驾驶舱后端的
 * 健康检查 session_org 那一项红，撤了自己回绿。
 */
export const SESSION_ORG_ALERT_PREFIX = 'session-org:';

export interface OrgPoolWindow {
  label: string;
  /** 归类（5h、7d……）：额度留量线按它配（shared 的 evaluateReserve）。 */
  window: QuotaWindowKind;
  /** 模型组窗口的组名；账号级窗口为 null。 */
  scope: string | null;
  /** 已用比例（上游给的百分比，或 used / limit），通常 0–1、超额可以大于 1；算不出为 null。 */
  used: number | null;
  /** 和选路、额度表同一个判法（windowState）。 */
  state: WindowState;
  /** 读数本身说用满了（windowFull），不看新旧。 */
  full: boolean;
  resetsAt: Date | null;
}

export interface OrgPoolFacts {
  poolId: string;
  orgKind: OrgKind;
  /**
   * 管得着这个池在用的路由（调度台上至少一个阶段挂着、开着）的窗口：不分模型的都算；按模型组扣的，只算扣得着至少一条在用
   * 路由的（和选路同一个 windowAppliesTo：只扣 Sonnet 的窗口用满了，池里只派 Opus 就不算）。上游不再报的窗口，除非还用满着，
   * 不算（和选路的候选一样）。没读数的池是空的。
   */
  windows: OrgPoolWindow[];
}

export interface SessionOrgFacts {
  /** 带组织类型的池，每个一行，按 id 排。 */
  pools: OrgPoolFacts[];
  /** 这些池上还没结束的会话（排着的、在跑的、三段占着名额还没开跑的都算，两种会话都数）：切号会让它们当场断。 */
  busy: number;
  /** 其中三段的一次性会话有几个（含占着名额还没开跑的；切号停不停得下它们，引擎那边判）。 */
  busyOneShot: number;
}

/**
 * 带组织类型的池上还没结束的会话，按排队时刻排（切号前停会话时一轮轮看还剩哪些，#59）。两种会话都算，三段占着名额、还没开跑的
 * 也算（startedAt 为空，#757），和选路数池的并发同一份（pool-runs.ts）。now 判预占过没过期，默认现在。
 */
export async function openOrgRuns(db: Db, now?: Date): Promise<OpenPoolRun[]> {
  return openPoolRuns(db, { orgPoolsOnly: true, ...(now ? { now } : {}) });
}

export async function sessionOrgFacts(db: Db, options: { now: Date }): Promise<SessionOrgFacts> {
  const orgPools = await db.select().from(pools).where(isNotNull(pools.orgKind)).orderBy(asc(pools.id));
  const poolIds = orgPools.map((p) => p.id);
  const [windowRows, used, open] = await Promise.all([
    poolIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(quotaWindows)
          .where(inArray(quotaWindows.poolId, poolIds))
          .orderBy(asc(quotaWindows.label)),
    poolIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            routeId: routes.id,
            poolId: routes.poolId,
            upstreamModel: routes.upstreamModel,
            upstreamAliases: routes.upstreamAliases,
            modelId: models.id,
            family: models.family,
          })
          .from(routes)
          .innerJoin(models, eq(models.id, routes.modelId))
          .where(and(inArray(routes.id, routesInUse(db)), inArray(routes.poolId, poolIds))),
    openOrgRuns(db, options.now),
  ]);
  // 在用的路由（路由两层里开着、模型排进了某个用途的，routing-layers.ts 的 routesInUse）→ 各池的模型
  const refs = new Map<string, Map<string, ModelRef>>();
  for (const r of used) {
    const byRoute = refs.get(r.poolId) ?? new Map<string, ModelRef>();
    byRoute.set(r.routeId, {
      id: r.modelId,
      family: r.family,
      upstreamNames: [...(r.upstreamModel ? [r.upstreamModel] : []), ...r.upstreamAliases],
    });
    refs.set(r.poolId, byRoute);
  }
  const out: OrgPoolFacts[] = [];
  for (const pool of orgPools) {
    if (!pool.orgKind) continue;
    const poolRefs = [...(refs.get(pool.id)?.values() ?? [])];
    const windows: OrgPoolWindow[] = [];
    for (const w of windowRows) {
      if (w.poolId !== pool.id) continue;
      const state = windowState(w, options.now);
      if (w.staleSince !== null && state !== 'exhausted') continue;
      const applies =
        !w.scope || poolRefs.some((ref) => windowAppliesTo(w, ref, pool.scopeModels ?? undefined) === 'yes');
      if (!applies) continue;
      windows.push({
        label: w.label,
        window: w.window,
        scope: w.scope === '' ? null : w.scope,
        used: usedRatioOf(w),
        state,
        full: windowFull(w),
        resetsAt: w.resetsAt,
      });
    }
    out.push({ poolId: pool.id, orgKind: pool.orgKind, windows });
  }
  return {
    pools: out,
    busy: open.length,
    busyOneShot: open.filter((r) => r.kind === 'oneShot').length,
  };
}

export interface EngineAudit {
  /** 例如 session-org.switch、session-org.verify。 */
  action: string;
  /** 例如 session-user:fleet-agent-carpool。 */
  target: string;
  /** 谁做的（引擎里哪一块），例如 engine:org-switch。 */
  actorId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ok: boolean;
  /** 没成要写为什么（库里约束 audit_log_failure_has_error）。 */
  error?: string | null;
  at?: Date;
}

/** 引擎自己做的一件事记进操作记录。没成的不写 error 直接拒：库里约束也挡，这里先说清楚是哪一条没写原因。 */
export async function recordEngineAudit(db: Db, input: EngineAudit): Promise<void> {
  if (!input.ok && !input.error?.trim()) throw new Error(`操作记录 ${input.action} 没成却没写为什么`);
  await db.insert(auditLog).values({
    at: input.at ?? new Date(),
    actorKind: 'engine',
    actorId: input.actorId,
    action: input.action,
    target: input.target,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    via: 'engine',
    ok: input.ok,
    error: input.ok ? null : (input.error ?? null),
  });
}
