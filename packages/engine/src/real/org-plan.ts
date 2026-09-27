// 会话用户切号的判法要的事实（库里带组织类型的池的额度窗口、整池暂停、还没结束的 Claude 会话，db 的 sessionOrgFacts）和判法
// 本身（jobs/org-switch.ts 的 planOrgSwitch）：切号（real/org-switch.ts，路由探针每一轮探之前）和选路（store-ports：不是挂着的
// 那个组织的池等不等得来）读同一份、用同一个判法，口径一个（#335：选路写着「要等切过去才能派」，却不知道引擎切不切）。
import { type Db, sessionOrgFacts } from '@fleet-dao/db';
import type { OrgKind } from '@fleet-dao/shared';
import { type OrgPool, orgIntent, planOrgSwitch } from '../jobs/org-switch.ts';
import type { OrgPlanView } from '../routing/index.ts';

export interface OrgSwitchFactsNow {
  /** 按组织类型合起来的池（拼车、独享）：窗口、整池暂停着没有。 */
  pools: Partial<Record<OrgKind, OrgPool>>;
  /** 这些池上还没结束的会话数。 */
  busy: number;
  poolIds: Set<string>;
}

/** held：整池暂停着的池（pool-hold:<池> 那条要人拍还开着）。库读不了照抛。 */
export async function loadOrgSwitchFacts(
  db: Db,
  options: { now: Date; held: ReadonlySet<string> },
): Promise<OrgSwitchFactsNow> {
  const f = await sessionOrgFacts(db, { now: options.now });
  const pools: Partial<Record<OrgKind, OrgPool>> = {};
  for (const p of f.pools) {
    const seen = pools[p.orgKind];
    pools[p.orgKind] = {
      windows: [...(seen?.windows ?? []), ...p.windows],
      held: (seen?.held ?? false) || options.held.has(p.poolId),
    };
  }
  return { pools, busy: f.busy, poolIds: new Set(f.pools.map((p) => p.poolId)) };
}

/**
 * 选路要的引擎切号打算：和切号同一份事实、同一个判法。canStopRunning 照真装配（#59 接上了会话端口，有会话在跑也照切）：它只
 * 定「切」还是「等」，不定切到哪个。库读不了照抛（选路照常报没查成，不当成不打算切）。
 */
export async function orgPlanView(
  db: Db,
  options: { live: OrgKind; held: ReadonlySet<string>; now: Date },
): Promise<OrgPlanView> {
  const facts = await loadOrgSwitchFacts(db, options);
  const intent = orgIntent(
    planOrgSwitch({
      live: { ok: true, org: options.live },
      pools: facts.pools,
      busy: facts.busy,
      canStopRunning: true,
      now: options.now,
    }),
  );
  return { to: intent.to, at: intent.at ? intent.at.toISOString() : null, why: intent.why };
}
