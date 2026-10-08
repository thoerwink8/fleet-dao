// 路由页「模型目录」「渠道」两块的数据（#1366 第二部分）：把路由两层（只含配进用途的模型）和路由目录（全部模型、渠道、路由）并成
// 一行一个模型、一行一个渠道。只做拼，不判活不活（判法在后端 routing-liveness.ts，页面只读）。
// 开关状态只有路由两层里有：没配进任何用途的模型读不到它的路由开着没有，如实标出来，不猜、不画成开或关。

import {
  founderOnlyFor,
  type HostId,
  hardBanFor,
  routeEffortProblem,
  SESSION_EFFORTS,
  type SessionEffort,
} from '@fleet-dao/shared';
import type {
  LivenessVerdict,
  Model,
  Route,
  RoutingLayerPurpose,
  RoutingLayerRoute,
  RoutingLayers,
} from '../api/types';
import { filterRows, type ListFilter, NO_FILTER } from './list-window';

export interface CatalogEntry {
  modelId: string;
  displayName: string;
  family: string;
  /** 在路由两层里的结论；没配进任何用途 = null（没人算过，不画成活也不画成死）。 */
  verdict: LivenessVerdict | null;
  /** 路由两层里这个模型下的路由（带开关、三件事）；没配进用途为空。 */
  routes: RoutingLayerRoute[];
  /** 目录里这个模型下一共几条路由（没配进用途的也数）。 */
  routeCount: number;
  /** 配进了哪些用途（用途编号，按页面顺序）。 */
  purposes: RoutingLayerPurpose['purpose'][];
  /** 下面至少一条路由开着。没配进用途的读不到，按 false，调用方另看 switchKnown。 */
  enabled: boolean;
  /** 能不能读到开关状态：配进了用途且下面有路由才读得到。 */
  switchKnown: boolean;
  /** 目录里的下架时间；没下架没有。 */
  retiredAt?: string;
  /** 这个模型的路由挂在哪些渠道上（配进用途的和目录里的并起来）。 */
  channelIds: string[];
  /** 路由编号以 auto: 开头：名册发现后自动入库的，还没人整理。 */
  discovered: boolean;
}

export function buildCatalog(
  layers: Pick<RoutingLayers, 'purposes'>,
  routing: { models: readonly Model[]; routes: readonly Route[] } | undefined,
): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  const info = new Map((routing?.models ?? []).map((m) => [m.id, m]));
  const rawCount = new Map<string, number>();
  const rawByModel = new Map<string, Route[]>();
  for (const r of routing?.routes ?? []) {
    rawCount.set(r.modelId, (rawCount.get(r.modelId) ?? 0) + 1);
    const list = rawByModel.get(r.modelId) ?? [];
    list.push(r);
    rawByModel.set(r.modelId, list);
  }
  const channelsOf = (modelId: string, layerRoutes: readonly RoutingLayerRoute[]): string[] => {
    const ids: string[] = [];
    const push = (id: string) => {
      if (!ids.includes(id)) ids.push(id);
    };
    for (const r of layerRoutes) push(r.channelId);
    for (const r of rawByModel.get(modelId) ?? []) push(r.channelId);
    return ids;
  };
  const discoveredOf = (modelId: string, layerRoutes: readonly RoutingLayerRoute[]): boolean =>
    layerRoutes.some((r) => r.routeId.startsWith('auto:')) ||
    (rawByModel.get(modelId) ?? []).some((r) => r.id.startsWith('auto:'));

  for (const p of layers.purposes) {
    for (const m of p.models) {
      const have = entries.get(m.modelId);
      if (have) {
        if (!have.purposes.includes(p.purpose)) have.purposes.push(p.purpose);
        continue;
      }
      const meta = info.get(m.modelId);
      entries.set(m.modelId, {
        modelId: m.modelId,
        displayName: m.displayName,
        family: m.family ?? meta?.family ?? '',
        verdict: m.verdict,
        routes: m.routes,
        routeCount: Math.max(m.routes.length, rawCount.get(m.modelId) ?? 0),
        purposes: [p.purpose],
        enabled: m.routes.some((r) => r.enabled),
        switchKnown: m.routes.length > 0,
        channelIds: channelsOf(m.modelId, m.routes),
        discovered: discoveredOf(m.modelId, m.routes),
        ...(meta?.retiredAt ? { retiredAt: meta.retiredAt } : {}),
      });
    }
  }

  const rest = (routing?.models ?? [])
    .filter((m) => !entries.has(m.id))
    .map(
      (m): CatalogEntry => ({
        modelId: m.id,
        displayName: m.displayName,
        family: m.family,
        verdict: null,
        routes: [],
        routeCount: rawCount.get(m.id) ?? 0,
        purposes: [],
        enabled: false,
        switchKnown: false,
        channelIds: channelsOf(m.id, []),
        discovered: discoveredOf(m.id, []),
        ...(m.retiredAt ? { retiredAt: m.retiredAt } : {}),
      }),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.modelId.localeCompare(b.modelId));
  return [...entries.values(), ...rest];
}

export const isRetired = (e: Pick<CatalogEntry, 'retiredAt'>, now: number): boolean =>
  e.retiredAt !== undefined && Date.parse(e.retiredAt) <= now;

/** 渠道下的路由：配进了用途的（带开关）和目录里有、没配进任何用途的（读不到开关）。 */
export interface ChannelRoutes {
  inLayers: { route: RoutingLayerRoute; modelId: string; modelName: string }[];
  others: { route: Route; modelName: string }[];
}

export function channelRoutes(
  channelId: string,
  layers: Pick<RoutingLayers, 'purposes'>,
  routing: { models: readonly Model[]; routes: readonly Route[] } | undefined,
): ChannelRoutes {
  const seen = new Set<string>();
  const inLayers: ChannelRoutes['inLayers'] = [];
  for (const p of layers.purposes) {
    for (const m of p.models) {
      for (const r of m.routes) {
        if (r.channelId !== channelId || seen.has(r.routeId)) continue;
        seen.add(r.routeId);
        inLayers.push({ route: r, modelId: m.modelId, modelName: m.displayName });
      }
    }
  }
  const names = new Map((routing?.models ?? []).map((m) => [m.id, m.displayName]));
  const others = (routing?.routes ?? [])
    .filter((r) => r.channelId === channelId && !seen.has(r.id))
    .map((route) => ({ route, modelName: names.get(route.modelId) ?? route.modelId }));
  return { inLayers, others };
}

/** 目录状态筛：新发现、已下架、关着、锁住。多选是「或」。 */
export const CATALOG_STATUSES = ['discovered', 'retired', 'off', 'locked'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export interface CatalogFilter extends ListFilter {
  /** 厂家，用模型族。空 = 不按厂家筛。 */
  vendor: string;
  /** 渠道编号。空 = 不按渠道筛。 */
  channel: string;
  /** 勾上的状态。空 = 不按状态筛。 */
  statuses: readonly CatalogStatus[];
}

export const NO_CATALOG_FILTER: CatalogFilter = { ...NO_FILTER, vendor: '', channel: '', statuses: [] };

export const catalogFilterActive = (f: CatalogFilter): boolean =>
  f.onlyEnabled || f.query.trim() !== '' || f.vendor !== '' || f.channel !== '' || f.statuses.length > 0;

export interface CatalogMarks {
  discovered: boolean;
  retired: boolean;
  /** 开关读得到、而且关着。读不到开关的不算关着。 */
  off: boolean;
  /** Fable（只许创始人开）或 GPT × 界面硬禁。 */
  locked: boolean;
  lockWhy?: string;
}

export function catalogMarks(e: CatalogEntry, now: number): CatalogMarks {
  const subject = { id: e.modelId, family: e.family, displayName: e.displayName };
  const lockWhy = founderOnlyFor(subject)?.reason ?? hardBanFor(subject, 'ui')?.reason;
  return {
    discovered: e.discovered,
    retired: isRetired(e, now),
    off: e.switchKnown && !e.enabled,
    locked: lockWhy !== undefined,
    ...(lockWhy ? { lockWhy } : {}),
  };
}

/** 搜索和「只看已开启」照长列表那一套；厂家、渠道是并且；状态多选是或。 */
export function filterCatalog(
  entries: readonly CatalogEntry[],
  filter: CatalogFilter,
  now: number,
): CatalogEntry[] {
  const searched = filterRows(
    entries,
    filter,
    (e) => [e.displayName, e.modelId, e.family, ...e.channelIds],
    (e) => e.switchKnown && e.enabled,
  );
  return searched.filter((e) => {
    if (filter.vendor !== '' && e.family !== filter.vendor) return false;
    if (filter.channel !== '' && !e.channelIds.includes(filter.channel)) return false;
    if (filter.statuses.length === 0) return true;
    const marks = catalogMarks(e, now);
    return filter.statuses.some((status) => marks[status]);
  });
}

const EFFORT_TAIL = /-(?:xhigh|max|high|medium|low)$/i;
const CONTEXT_TAIL = /-\d+(?:\.\d+)?[km]$/i;
const FLAG_TAIL = /-(?:fast|build|thinking)$/i;

/**
 * 变体归到同一个本体：去掉渠道前缀、方括号（fast、上下文、档位）和尾巴上的 -fast / -high / -256k。
 * opus-5 和 opus-5.5 这种版本号留着，不当成变体。
 */
export function variantBase(modelId: string): string {
  let body = modelId.trim();
  const colon = body.indexOf(':');
  if (colon > 0 && colon < 48 && !body.slice(0, colon).includes('/')) body = body.slice(colon + 1);
  body = body.replace(/\[[^\]]*\]/g, '');
  let prev = '';
  while (body !== prev) {
    prev = body;
    body = body.replace(EFFORT_TAIL, '').replace(CONTEXT_TAIL, '').replace(FLAG_TAIL, '');
  }
  return body.toLowerCase();
}

export interface CatalogGroup {
  key: string;
  label: string;
  members: CatalogEntry[];
}

function groupLabel(members: readonly CatalogEntry[], base: string): string {
  const exact = members.find((m) => variantBase(m.modelId) === base && m.modelId.toLowerCase() === base);
  if (exact) return exact.displayName;
  const shortest = [...members].sort(
    (a, b) => a.modelId.length - b.modelId.length || a.displayName.localeCompare(b.displayName, 'zh'),
  )[0];
  return shortest?.displayName ?? base;
}

/** 按出现顺序分组。只有一个成员的组不当成可折叠组。 */
export function groupCatalog(entries: readonly CatalogEntry[]): CatalogGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const base = variantBase(entry.modelId);
    const key = `${entry.family.trim().toLowerCase()}::${base}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else {
      buckets.set(key, [entry]);
      order.push(key);
    }
  }
  return order.flatMap((key) => {
    const members = buckets.get(key);
    if (!members || members.length === 0) return [];
    const base = key.slice(key.indexOf('::') + 2);
    return [{ key, label: groupLabel(members, base), members }];
  });
}

export type CatalogVisual =
  | { kind: 'entry'; entry: CatalogEntry; nested: boolean }
  | { kind: 'group'; group: CatalogGroup };

/** 没收起的组展开成定高的行：组头一行，每个变体一行。单个模型不包组头。 */
export function flattenCatalog(groups: readonly CatalogGroup[], open: ReadonlySet<string>): CatalogVisual[] {
  const out: CatalogVisual[] = [];
  for (const group of groups) {
    if (group.members.length < 2) {
      const only = group.members[0];
      if (only) out.push({ kind: 'entry', entry: only, nested: false });
      continue;
    }
    out.push({ kind: 'group', group });
    if (!open.has(group.key)) continue;
    for (const entry of group.members) out.push({ kind: 'entry', entry, nested: true });
  }
  return out;
}

/**
 * 这个用途下能选的档：模型每条路由都得认（和后端 effortProblem 同一条线）。
 * 一条路由都没有时，五档都认。方括号里已经写死、或执行方式不收档位，一档都不列。
 */
export function supportedPurposeEfforts(
  modelId: string,
  routes: readonly { hostId: HostId; upstreamModel?: string | undefined }[],
): SessionEffort[] {
  return SESSION_EFFORTS.filter((effort) =>
    routes.every(
      (route) => routeEffortProblem(route.hostId, route.upstreamModel ?? modelId, effort) === null,
    ),
  );
}
