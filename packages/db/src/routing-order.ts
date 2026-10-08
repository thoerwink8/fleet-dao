// 路由两层的先后、开关，以及用途里加模型、移出、改档位（#1089、#1356）：驾驶舱「路由」页改。
// 先后和开关改 position、enabled。用途下的档位写 routing_purpose_models.effort，不改 routing_catalog.effort（起会话仍读路由上的档）。
// 加、移、改档位带用途版本（routing_purpose_revisions），对不上回 conflict、一行不动。拖动先后仍比 expected 那一串，不改这个版本。
// 和 routing-effort.ts 同一个写法：事务里先锁行、再比调用方看到的旧值，对不上回 conflict；能传事务进来（驾驶舱后端在同一个事务里再记操作记录）。
// 为什么锁和读是两条语句：Postgres 在默认的 READ COMMITTED 下，`order by … for update` 若在锁上等过别人，
// 等到之后会拿「别人提交后的新值」，但行的顺序还是按等之前的旧值排的（官方文档点名的「可能乱序」）。
// 一条语句里写就会：后到的事务看到的 position 是新的、顺序却是旧的，对 expected 照样「对得上」，两个并发的换位置都成功、互相覆盖。
// 所以先只锁（等到锁），再另起一条普通读：新语句拿新快照，读到的就是前一个事务提交后的先后。
// 换位置要小心两张表对 (purpose, position)、(model_id, position) 的唯一约束（不能延后检查）：两行互换不能直接各改一次，
// 先把其中一行挪到谁都没占的临时位置（这一串里最大的 position + 1），再换，最后落位。position 一直 >= 0。
import {
  hardBanFor,
  isSessionEffort,
  routeEffortProblem,
  type SessionEffort,
  type StageKind,
} from '@fleet-dao/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  channels,
  models,
  routes,
  routingCatalog,
  routingPurposeModels,
  routingPurposeRevisions,
} from './schema/index.ts';

export type MoveDirection = 'up' | 'down';

export type MoveResult =
  | {
      ok: true;
      /** 改之前这一串的先后（编号，从先到后）。 */
      before: string[];
      /** 改之后。 */
      after: string[];
    }
  | { ok: false; kind: 'not_found'; why: string }
  /** 调用方看到的先后和库里现在的对不上（别人刚改过）：current 是库里现在的先后。 */
  | { ok: false; kind: 'conflict'; current: string[] }
  /** 已经在最上 / 最下，没处挪。 */
  | { ok: false; kind: 'at_edge'; why: string }
  /** 新先后不是现在这一串的重排（多了、少了、重复）。 */
  | { ok: false; kind: 'invalid'; why: string };

interface Slot {
  key: string;
  position: number;
}

/**
 * 在已锁住、按 position 排好的一串里把 key 往上 / 下挪一位：先和 expected 比，再换。换的写法见文件头：
 * 一行先去临时位置，另一行落到它的老位置，最后它落到对方的老位置。
 */
async function swapNeighbour(
  slots: readonly Slot[],
  key: string,
  direction: MoveDirection,
  expected: readonly string[] | undefined,
  setPosition: (key: string, position: number) => Promise<void>,
  names: { what: string; where: string },
): Promise<MoveResult> {
  const before = slots.map((s) => s.key);
  const index = before.indexOf(key);
  if (index < 0) return { ok: false, kind: 'not_found', why: `${names.where}下没有${names.what} ${key}` };
  if (expected !== undefined && !sameOrder(before, expected)) {
    return { ok: false, kind: 'conflict', current: before };
  }
  const neighbourIndex = direction === 'up' ? index - 1 : index + 1;
  const neighbour = slots[neighbourIndex];
  const me = slots[index];
  if (!neighbour || !me) {
    return {
      ok: false,
      kind: 'at_edge',
      why: `${names.what} ${key} 已经在${names.where}的最${direction === 'up' ? '上' : '下'}面，没处${direction === 'up' ? '上' : '下'}移了`,
    };
  }
  const temporary = Math.max(...slots.map((s) => s.position)) + 1;
  await setPosition(me.key, temporary);
  await setPosition(neighbour.key, me.position);
  await setPosition(me.key, neighbour.position);
  const after = [...before];
  after[index] = neighbour.key;
  after[neighbourIndex] = me.key;
  return { ok: true, before, after };
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** 新先后必须是现在这一串的重排。返回 null = 是。 */
function permutationProblem(current: readonly string[], order: readonly string[]): string | null {
  if (order.length !== current.length) {
    return `新先后有 ${order.length} 项，现在是 ${current.length} 项`;
  }
  const seen = new Set<string>();
  for (const id of order) {
    if (!current.includes(id)) return `新先后里的 ${id} 不在现在这一串里`;
    if (seen.has(id)) return `新先后里 ${id} 出现了两次`;
    seen.add(id);
  }
  return null;
}

/**
 * 把已锁住的一串排成 order。先和 expected 比，再确认是重排。落位分两步：先挪到没人占的临时位置，再从 0 排，
 * 躲开 (purpose, position) / (model_id, position) 的唯一约束。
 */
async function applyOrder(
  slots: readonly Slot[],
  key: string,
  order: readonly string[],
  expected: readonly string[] | undefined,
  setPosition: (key: string, position: number) => Promise<void>,
  names: { what: string; where: string },
): Promise<MoveResult> {
  const before = slots.map((s) => s.key);
  if (!before.includes(key)) {
    return { ok: false, kind: 'not_found', why: `${names.where}下没有${names.what} ${key}` };
  }
  if (expected !== undefined && !sameOrder(before, expected)) {
    return { ok: false, kind: 'conflict', current: before };
  }
  const problem = permutationProblem(before, order);
  if (problem) return { ok: false, kind: 'invalid', why: problem };
  if (sameOrder(before, order)) return { ok: true, before, after: [...before] };
  const base = Math.max(...slots.map((s) => s.position), -1) + 1;
  for (let i = 0; i < order.length; i++) await setPosition(order[i] ?? '', base + i);
  for (let i = 0; i < order.length; i++) await setPosition(order[i] ?? '', i);
  return { ok: true, before, after: [...order] };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return sameOrder(sorted(a), sorted(b));
};

export interface MovePurposeModelInput {
  purpose: StageKind;
  modelId: string;
  direction: MoveDirection;
  /** 调用方改之前看到的这个用途下的模型先后（模型编号，从先到后）：给了就比，对不上回 conflict。不给 = 不比。 */
  expected?: readonly string[];
}

/** 用途下的一个模型上移 / 下移一位（routing_purpose_models.position）。 */
export async function movePurposeModel(db: Db, input: MovePurposeModelInput): Promise<MoveResult> {
  const { purpose, modelId, direction } = input;
  return db.transaction(async (tx) => {
    // 先锁、再另起一条语句读（原因见文件头「为什么锁和读是两条语句」）：不能把 order by 和 for update 写在同一条里。
    await tx
      .select({ key: routingPurposeModels.modelId })
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.purpose, purpose))
      .orderBy(asc(routingPurposeModels.position))
      .for('update');
    const rows = await tx
      .select({ key: routingPurposeModels.modelId, position: routingPurposeModels.position })
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.purpose, purpose))
      .orderBy(asc(routingPurposeModels.position));
    return swapNeighbour(
      rows,
      modelId,
      direction,
      input.expected,
      async (key, position) => {
        await tx
          .update(routingPurposeModels)
          .set({ position })
          .where(and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, key)));
      },
      { what: '模型', where: `用途 ${purpose} ` },
    );
  });
}

export interface MoveModelRouteInput {
  modelId: string;
  routeId: string;
  direction: MoveDirection;
  /** 调用方改之前看到的这个模型下的路由先后（路由编号，从先到后）：给了就比，对不上回 conflict。不给 = 不比。 */
  expected?: readonly string[];
}

/** 模型下的一条路由上移 / 下移一位（routing_catalog.position）。先后不分用途：哪个用途排了这个模型，都照这一串。 */
export async function moveModelRoute(db: Db, input: MoveModelRouteInput): Promise<MoveResult> {
  const { modelId, routeId, direction } = input;
  return db.transaction(async (tx) => {
    // 先锁、再另起一条语句读（原因见文件头「为什么锁和读是两条语句」）。
    await tx
      .select({ key: routingCatalog.routeId })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position))
      .for('update');
    const rows = await tx
      .select({ key: routingCatalog.routeId, position: routingCatalog.position })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position));
    return swapNeighbour(
      rows,
      routeId,
      direction,
      input.expected,
      async (key, position) => {
        await tx
          .update(routingCatalog)
          .set({ position })
          .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, key)));
      },
      { what: '路由', where: `模型 ${modelId} ` },
    );
  });
}

export interface SetRouteEnabledInput {
  modelId: string;
  routeId: string;
  enabled: boolean;
  /** 调用方改之前看到的开关：给了就比，库里已经不是它（别人刚改过）回 conflict、不覆盖。不给 = 不比。 */
  expected?: boolean;
}

export type SetRouteEnabledResult =
  | { ok: true; before: boolean; after: boolean }
  | { ok: false; kind: 'not_found'; why: string }
  | { ok: false; kind: 'conflict'; current: boolean }
  /** 打开时这个模型正挂在硬禁令挡着的用途上（GPT × 界面）。关不受这步拦。 */
  | { ok: false; kind: 'banned'; why: string };

/** 开 / 关模型下的一条路由（routing_catalog.enabled）：关着的照样挂在顺序里，只是不派。 */
export async function setRouteEnabled(db: Db, input: SetRouteEnabledInput): Promise<SetRouteEnabledResult> {
  const { modelId, routeId, enabled } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ enabled: routingCatalog.enabled })
      .from(routingCatalog)
      .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, routeId)))
      .for('update');
    if (!row) {
      return { ok: false, kind: 'not_found', why: `模型 ${modelId} 下没有路由 ${routeId}（路由两层里没挂）` };
    }
    if (input.expected !== undefined && row.enabled !== input.expected) {
      return { ok: false, kind: 'conflict', current: row.enabled };
    }
    if (enabled) {
      const why = await enableBanWhy(tx, modelId, routeId);
      if (why) return { ok: false, kind: 'banned', why };
    }
    await tx
      .update(routingCatalog)
      .set({ enabled })
      .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, routeId)));
    return { ok: true, before: row.enabled, after: enabled };
  });
}

export interface ReorderPurposeModelsInput {
  purpose: StageKind;
  /** 被拖动的那个模型：不在这一串里就是没有。 */
  modelId: string;
  /** 改完后的先后。必须是现在这一串的重排。 */
  order: readonly string[];
  expected?: readonly string[];
}

/** 用途下的模型拖到新先后（整段重排，一次落位）。 */
export async function reorderPurposeModels(db: Db, input: ReorderPurposeModelsInput): Promise<MoveResult> {
  const { purpose, modelId, order } = input;
  return db.transaction(async (tx) => {
    await tx
      .select({ key: routingPurposeModels.modelId })
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.purpose, purpose))
      .orderBy(asc(routingPurposeModels.position))
      .for('update');
    const rows = await tx
      .select({ key: routingPurposeModels.modelId, position: routingPurposeModels.position })
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.purpose, purpose))
      .orderBy(asc(routingPurposeModels.position));
    return applyOrder(
      rows,
      modelId,
      order,
      input.expected,
      async (key, position) => {
        await tx
          .update(routingPurposeModels)
          .set({ position })
          .where(and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, key)));
      },
      { what: '模型', where: `用途 ${purpose} ` },
    );
  });
}

export interface ReorderModelRoutesInput {
  modelId: string;
  /** 被拖动的那条路由：不在这一串里就是没有。 */
  routeId: string;
  order: readonly string[];
  expected?: readonly string[];
}

/** 模型下的路由拖到新先后（整段重排）。先后不分用途。 */
export async function reorderModelRoutes(db: Db, input: ReorderModelRoutesInput): Promise<MoveResult> {
  const { modelId, routeId, order } = input;
  return db.transaction(async (tx) => {
    await tx
      .select({ key: routingCatalog.routeId })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position))
      .for('update');
    const rows = await tx
      .select({ key: routingCatalog.routeId, position: routingCatalog.position })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position));
    return applyOrder(
      rows,
      routeId,
      order,
      input.expected,
      async (key, position) => {
        await tx
          .update(routingCatalog)
          .set({ position })
          .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, key)));
      },
      { what: '路由', where: `模型 ${modelId} ` },
    );
  });
}

export interface SetModelEnabledInput {
  modelId: string;
  enabled: boolean;
  /** 改之前看到的、开着的路由编号。给了就比集合（顺序无关），对不上回 conflict。 */
  expectedEnabled?: readonly string[];
}

export type SetModelEnabledResult =
  | { ok: true; before: string[]; after: string[] }
  | { ok: false; kind: 'not_found'; why: string }
  | { ok: false; kind: 'conflict'; current: string[] }
  /** 打开时这个模型正挂在硬禁令挡着的用途上。关不受这步拦。 */
  | { ok: false; kind: 'banned'; why: string };

/**
 * 开 / 关一个模型：把它在 routing_catalog 里的路由全部设成同一个开关。
 * 关了以后哪个用途都不派（选路看的还是每条路由的 enabled，这里不另加判法）。先后不动。
 */
export async function setModelEnabled(db: Db, input: SetModelEnabledInput): Promise<SetModelEnabledResult> {
  const { modelId, enabled } = input;
  return db.transaction(async (tx) => {
    await tx
      .select({ key: routingCatalog.routeId })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position))
      .for('update');
    const rows = await tx
      .select({ routeId: routingCatalog.routeId, enabled: routingCatalog.enabled })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position));
    if (rows.length === 0) {
      return { ok: false, kind: 'not_found', why: `模型 ${modelId} 下没有路由（路由两层里没挂）` };
    }
    const before = rows.filter((r) => r.enabled).map((r) => r.routeId);
    if (input.expectedEnabled !== undefined && !sameSet(before, input.expectedEnabled)) {
      return { ok: false, kind: 'conflict', current: before };
    }
    if (enabled) {
      const why = await enableBanWhy(tx, modelId);
      if (why) return { ok: false, kind: 'banned', why };
    }
    await tx.update(routingCatalog).set({ enabled }).where(eq(routingCatalog.modelId, modelId));
    const after = enabled ? rows.map((r) => r.routeId) : [];
    return { ok: true, before, after };
  });
}

export interface SetChannelEnabledFlagInput {
  channelId: string;
  enabled: boolean;
  /** 改之前看到的开关。给了就比，对不上回 conflict。 */
  expected?: boolean;
}

export type SetChannelEnabledFlagResult =
  | { ok: true; before: boolean; after: boolean }
  | { ok: false; kind: 'not_found'; why: string }
  | { ok: false; kind: 'conflict'; current: boolean };

/** 开 / 关一个渠道（channels.enabled）。选路本来就看这一列（channel-disabled），这里只写它。 */
export async function setChannelEnabledFlag(
  db: Db,
  input: SetChannelEnabledFlagInput,
): Promise<SetChannelEnabledFlagResult> {
  const { channelId, enabled } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ enabled: channels.enabled })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!row) return { ok: false, kind: 'not_found', why: `没有这个渠道：${channelId}` };
    if (input.expected !== undefined && row.enabled !== input.expected) {
      return { ok: false, kind: 'conflict', current: row.enabled };
    }
    await tx.update(channels).set({ enabled }).where(eq(channels.id, channelId));
    return { ok: true, before: row.enabled, after: enabled };
  });
}

/** 和驾驶舱 routeProblem 同一套叫法（api 的 STAGE_WORDS）。硬禁令的原因接在后面。 */
const PURPOSE_WORD: Record<StageKind, string> = {
  triage: '分诊',
  spec: '写需求文档',
  plan: '写方案',
  execute: '写码',
  ui: '写界面',
  review: '审查',
  verify: '开 PR 前验证',
  research: '调研',
  judge: '判断',
  groom: '整理待办',
};

/** 加进 / 移出 / 改档位共用的锁命名空间，和换位置那把锁分开。 */
const PURPOSE_LOCK_NS = 1356;

export interface PurposeModelSlot {
  modelId: string;
  effort: SessionEffort | null;
}

export type PurposeWriteResult =
  | {
      ok: true;
      version: number;
      beforeVersion: number;
      before: PurposeModelSlot[];
      order: PurposeModelSlot[];
    }
  | { ok: false; kind: 'not_found'; why: string }
  | { ok: false; kind: 'already'; why: string }
  | { ok: false; kind: 'conflict'; version: number }
  | { ok: false; kind: 'invalid'; code: 'position_invalid' | 'effort_invalid'; why: string }
  | { ok: false; kind: 'banned'; why: string };

const slotsOf = (rows: readonly { modelId: string; effort: SessionEffort | null }[]): PurposeModelSlot[] =>
  rows.map((r) => ({ modelId: r.modelId, effort: r.effort }));

/**
 * 先占住这个用途（咨询锁 + 锁成员行），再另起一条语句读先后和版本。
 * 咨询锁是因为用途被清空后没有成员行可锁，两个同时加还会同时以为版本是 0。
 * 锁和读分成两条：原因见文件头「为什么锁和读是两条语句」。
 */
async function lockPurpose(tx: Db, purpose: StageKind) {
  await tx.execute(sql`select pg_advisory_xact_lock(${PURPOSE_LOCK_NS}, hashtext(${purpose}))`);
  await tx
    .select({ modelId: routingPurposeModels.modelId })
    .from(routingPurposeModels)
    .where(eq(routingPurposeModels.purpose, purpose))
    .for('update');
  const [rev] = await tx
    .select({ version: routingPurposeRevisions.version })
    .from(routingPurposeRevisions)
    .where(eq(routingPurposeRevisions.purpose, purpose))
    .for('update');
  const rows = await tx
    .select({
      modelId: routingPurposeModels.modelId,
      position: routingPurposeModels.position,
      effort: routingPurposeModels.effort,
    })
    .from(routingPurposeModels)
    .where(eq(routingPurposeModels.purpose, purpose))
    .orderBy(asc(routingPurposeModels.position));
  return { version: rev?.version ?? 0, hasRevision: rev !== undefined, rows };
}

async function bumpPurposeVersion(
  tx: Db,
  purpose: StageKind,
  version: number,
  hasRevision: boolean,
): Promise<number> {
  const next = version + 1;
  if (hasRevision) {
    await tx
      .update(routingPurposeRevisions)
      .set({ version: next })
      .where(eq(routingPurposeRevisions.purpose, purpose));
  } else {
    await tx.insert(routingPurposeRevisions).values({ purpose, version: next });
  }
  return next;
}

async function hardBanWhy(
  tx: Db,
  modelId: string,
  stage: StageKind,
  onlyRouteId?: string,
): Promise<string | null> {
  const [model] = await tx
    .select({ id: models.id, family: models.family, displayName: models.displayName })
    .from(models)
    .where(eq(models.id, modelId));
  if (!model) return null;
  const routeRows = await tx
    .select({
      id: routes.id,
      upstreamModel: routes.upstreamModel,
      upstreamAliases: routes.upstreamAliases,
    })
    .from(routes)
    .where(eq(routes.modelId, modelId));
  const considered = onlyRouteId === undefined ? routeRows : routeRows.filter((r) => r.id === onlyRouteId);
  const subjects = [
    { id: model.id, family: model.family, displayName: model.displayName },
    ...considered.map((r) => ({
      id: model.id,
      family: model.family,
      displayName: model.displayName,
      upstreamModel: r.upstreamModel,
      upstreamAliases: r.upstreamAliases,
    })),
  ];
  for (const subject of subjects) {
    const ban = hardBanFor(subject, stage);
    if (ban) return `${model.displayName} 不能用在「${PURPOSE_WORD[stage]}」：${ban.reason}`;
  }
  return null;
}

/** 打开路由时：模型当前挂着的每个用途都过一遍硬禁令。没挂任何用途就不挡。 */
async function enableBanWhy(tx: Db, modelId: string, onlyRouteId?: string): Promise<string | null> {
  const memberships = await tx
    .select({ purpose: routingPurposeModels.purpose })
    .from(routingPurposeModels)
    .where(eq(routingPurposeModels.modelId, modelId));
  for (const membership of memberships) {
    const why = await hardBanWhy(tx, modelId, membership.purpose, onlyRouteId);
    if (why) return why;
  }
  return null;
}

/** 这个档位这个模型的每条路由都得认。一条都不认就拒。模型还没有路由时，只认是不是已知档位。 */
async function effortProblem(tx: Db, modelId: string, effort: SessionEffort | null): Promise<string | null> {
  if (effort === null) return null;
  if (!isSessionEffort(effort)) {
    return `思考档位（effort）不认识：${JSON.stringify(effort)}（只有 low / medium / high / xhigh / max）`;
  }
  const routeRows = await tx
    .select({
      id: routes.id,
      hostId: routes.hostId,
      upstreamModel: routes.upstreamModel,
      modelId: routes.modelId,
    })
    .from(routes)
    .where(eq(routes.modelId, modelId));
  for (const route of routeRows) {
    const problem = routeEffortProblem(route.hostId, route.upstreamModel ?? route.modelId, effort);
    if (problem) return `模型 ${modelId} 的路由 ${route.id} 配不了这个档位：${problem}`;
  }
  return null;
}

/** 把这一串落到 0..n-1。先挪到没人占的高位再落位，躲开 (purpose, position) 唯一约束。新行在高位插入。 */
async function placeOrder(
  tx: Db,
  purpose: StageKind,
  next: readonly PurposeModelSlot[],
  existing: readonly { modelId: string; position: number }[],
) {
  if (next.length === 0) return;
  const existingIds = new Set(existing.map((r) => r.modelId));
  const max = existing.reduce((hi, r) => Math.max(hi, r.position), -1);
  const base = max + next.length + 1;
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (!slot || !existingIds.has(slot.modelId)) continue;
    await tx
      .update(routingPurposeModels)
      .set({ position: base + i })
      .where(and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, slot.modelId)));
  }
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (!slot || existingIds.has(slot.modelId)) continue;
    await tx.insert(routingPurposeModels).values({
      purpose,
      modelId: slot.modelId,
      position: base + i,
      effort: slot.effort,
    });
  }
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (!slot) continue;
    await tx
      .update(routingPurposeModels)
      .set({ position: i })
      .where(and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, slot.modelId)));
  }
}

export interface AddPurposeModelInput {
  purpose: StageKind;
  modelId: string;
  /** 不给 = 接到末尾。给了必须在 0 到「现在有几条」之间（含末尾那个空位）。 */
  position?: number;
  /** 不给 = 这个用途不另配档位。 */
  effort?: SessionEffort | null;
  /** 调用方看到的这个用途的版本。对不上就一行不写。 */
  version: number;
}

/** 把目录里的一个模型加进某个用途。空用途也能加。硬禁令在这一步判。 */
export async function addPurposeModel(db: Db, input: AddPurposeModelInput): Promise<PurposeWriteResult> {
  const { purpose, modelId } = input;
  return db.transaction(async (tx) => {
    const locked = await lockPurpose(tx, purpose);
    if (locked.version !== input.version) return { ok: false, kind: 'conflict', version: locked.version };
    const [model] = await tx.select({ id: models.id }).from(models).where(eq(models.id, modelId));
    if (!model) return { ok: false, kind: 'not_found', why: `目录里没有模型 ${modelId}` };
    if (locked.rows.some((r) => r.modelId === modelId)) {
      return { ok: false, kind: 'already', why: `模型 ${modelId} 已经在用途 ${purpose} 里` };
    }
    const position = input.position ?? locked.rows.length;
    if (!Number.isInteger(position) || position < 0 || position > locked.rows.length) {
      return {
        ok: false,
        kind: 'invalid',
        code: 'position_invalid',
        why: `位置 ${String(position)} 不在 0 到 ${locked.rows.length} 之间（${locked.rows.length} 是接到末尾）`,
      };
    }
    const effort = input.effort ?? null;
    const effortWhy = await effortProblem(tx, modelId, effort);
    if (effortWhy) return { ok: false, kind: 'invalid', code: 'effort_invalid', why: effortWhy };
    const banWhy = await hardBanWhy(tx, modelId, purpose);
    if (banWhy) return { ok: false, kind: 'banned', why: banWhy };
    const before = slotsOf(locked.rows);
    const order = [...before];
    order.splice(position, 0, { modelId, effort });
    await placeOrder(tx, purpose, order, locked.rows);
    const version = await bumpPurposeVersion(tx, purpose, locked.version, locked.hasRevision);
    return { ok: true, version, beforeVersion: locked.version, before, order };
  });
}

export interface RemovePurposeModelInput {
  purpose: StageKind;
  modelId: string;
  version: number;
}

/** 把模型移出用途。移到一个都不剩也允许（这个用途就派不了）。 */
export async function removePurposeModel(
  db: Db,
  input: RemovePurposeModelInput,
): Promise<PurposeWriteResult> {
  const { purpose, modelId } = input;
  return db.transaction(async (tx) => {
    const locked = await lockPurpose(tx, purpose);
    if (locked.version !== input.version) return { ok: false, kind: 'conflict', version: locked.version };
    if (!locked.rows.some((r) => r.modelId === modelId)) {
      return { ok: false, kind: 'not_found', why: `用途 ${purpose} 下没有模型 ${modelId}` };
    }
    const before = slotsOf(locked.rows);
    const order = before.filter((slot) => slot.modelId !== modelId);
    await tx
      .delete(routingPurposeModels)
      .where(and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, modelId)));
    await placeOrder(
      tx,
      purpose,
      order,
      locked.rows.filter((r) => r.modelId !== modelId),
    );
    const version = await bumpPurposeVersion(tx, purpose, locked.version, locked.hasRevision);
    return { ok: true, version, beforeVersion: locked.version, before, order };
  });
}

export interface SetPurposeModelEffortInput {
  purpose: StageKind;
  modelId: string;
  effort: SessionEffort | null;
  version: number;
}

/** 改这个用途下这个模型的档位。不改它在别的用途里的档，也不改路由上的 routing_catalog.effort。 */
export async function setPurposeModelEffort(
  db: Db,
  input: SetPurposeModelEffortInput,
): Promise<PurposeWriteResult> {
  const { purpose, modelId, effort } = input;
  return db.transaction(async (tx) => {
    const locked = await lockPurpose(tx, purpose);
    if (locked.version !== input.version) return { ok: false, kind: 'conflict', version: locked.version };
    if (!locked.rows.some((r) => r.modelId === modelId)) {
      return { ok: false, kind: 'not_found', why: `用途 ${purpose} 下没有模型 ${modelId}` };
    }
    const effortWhy = await effortProblem(tx, modelId, effort);
    if (effortWhy) return { ok: false, kind: 'invalid', code: 'effort_invalid', why: effortWhy };
    await tx
      .update(routingPurposeModels)
      .set({ effort })
      .where(and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, modelId)));
    const before = slotsOf(locked.rows);
    const order = before.map((slot) => (slot.modelId === modelId ? { modelId, effort } : slot));
    const version = await bumpPurposeVersion(tx, purpose, locked.version, locked.hasRevision);
    return { ok: true, version, beforeVersion: locked.version, before, order };
  });
}
