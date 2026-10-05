// 路由两层的先后和开关（母单 #1089 第二片）：驾驶舱「路由」页改——用途下的模型上移 / 下移、模型下的渠道上移 / 下移、渠道开关。
// 存的还是那两张表的 position、enabled（没加列）：选路按它们摊平（routing-layers.ts），改完下一次选路就照新的，不走改仓库再部署。
// 和 routing-effort.ts 同一个写法：事务里先锁行、再比调用方「看到的旧值」（expected），对不上回 conflict、一行不动；
// 能传事务进来（驾驶舱后端在同一个事务里再记操作记录）。
// 换位置要小心两张表对 (purpose, position)、(model_id, position) 的唯一约束（不能延后检查）：两行互换不能直接各改一次，
// 先把其中一行挪到谁都没占的临时位置（这一串里最大的 position + 1），再换，最后落位。position 一直 >= 0。
import type { StageKind } from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { routingCatalog, routingPurposeModels } from './schema/index.ts';

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
  | { ok: false; kind: 'at_edge'; why: string };

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
    const rows = await tx
      .select({ key: routingPurposeModels.modelId, position: routingPurposeModels.position })
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.purpose, purpose))
      .orderBy(asc(routingPurposeModels.position))
      .for('update');
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
    const rows = await tx
      .select({ key: routingCatalog.routeId, position: routingCatalog.position })
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, modelId))
      .orderBy(asc(routingCatalog.position))
      .for('update');
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
  | { ok: false; kind: 'conflict'; current: boolean };

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
    await tx
      .update(routingCatalog)
      .set({ enabled })
      .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, routeId)));
    return { ok: true, before: row.enabled, after: enabled };
  });
}
