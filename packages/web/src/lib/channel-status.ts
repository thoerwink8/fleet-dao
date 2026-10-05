// 渠道状态（#1087，路由页顶部）：每个渠道一张卡，一眼看通不通、排第几、不通了顺延到谁。
// 通不通不在这里再判一遍：每条路由「接得上」这一件由后端现算（db 的 routing-liveness.ts 的 connect），这里只把一个渠道下的
// 几条路由并成一句话，再按路由两层里的先后给渠道排顺位。探针报错 = 这条路暂不可用（探针写 alive=false，选路本来就不派），
// 这里只显示，不改选路。没排进任何用途的渠道（干粉）探针不花额度去探，卡片照列、写「没在配的路由里，未探」。

import { routeProbeEveryMinutes } from '@fleet-dao/shared';
import type { Channel, Model, Route, RoutingLayerRoute, RoutingLayers } from '../api/types';
import { TIME } from './format';
import type { Tone } from './status';

/** 探针的结论超过「探测间隔 + 这么多分钟」还没更新，卡片就改成「检测中断」（mirastatus 同一个口径：不拿旧绿灯掩盖中断）。 */
export const CHANNEL_INTERRUPT_GRACE_MINUTES = 3;

export type ChannelState =
  /** 在用的路都探通了。 */
  | 'ok'
  /** 有的路探通、有的路探针报错。 */
  | 'partial'
  /** 在用的路探针全报错：这个渠道暂不可用，选路顺延到下一个。 */
  | 'down'
  /** 在用的路探针还没看过 / 这一轮没探（按量计费、组织对不上）。 */
  | 'unknown'
  /** 没排进任何用途（或排进去的路都关着）：不花额度去探。 */
  | 'idle'
  /** 渠道在目录里下架了。 */
  | 'off';

export interface ChannelCard {
  channel: Channel;
  /** 顺位，从 1 起；干粉和下架的渠道没有。 */
  rank?: number;
  /** 探针结论算出来的状态；检测中断时仍是上一次结论的状态，由 interrupted 盖住。 */
  state: ChannelState;
  /** 超过探测间隔 + 3 分钟没更新：不再当现状。 */
  interrupted: boolean;
  /** 状态标签的字（检测中断时是「检测中断」）。 */
  label: string;
  tone: Tone;
  /** 在用的路里最新的一次结论时刻；没有 = 探针还没看过。 */
  probedAt?: string;
  /** 探通的路里「用时 N 秒」那一截（探针 detail 里的）。 */
  latency?: string;
  /** 报错一句（探针写的原因）。 */
  reason?: string;
  /** 探针报错的路数 / 在用的路数。 */
  deadRoutes: number;
  activeRoutes: number;
  /** 暂不可用时的顺延说明：顺延到谁，或后面没有能用的了。 */
  fallback?: string;
}

const LATENCY = /用时\s*(\d+)\s*秒/;

/** 探针 detail 里的「用时 N 秒」；没有就没有（不拿别的数顶）。 */
export function probeLatency(detail: string | undefined): string | undefined {
  const m = detail ? LATENCY.exec(detail) : null;
  return m ? `用时 ${m[1]} 秒` : undefined;
}

/** 这条路最近一次结论过没过「间隔 + 3 分钟」。 */
export function channelProbeInterrupted(route: { probedAt: string; hostId: string }, now: number): boolean {
  const limit = (routeProbeEveryMinutes(route.hostId) + CHANNEL_INTERRUPT_GRACE_MINUTES) * TIME.MIN;
  return now - Date.parse(route.probedAt) > limit;
}

interface Seen {
  /** 在各个模型的路由顺序里，这个渠道最靠前的名次（从 0 起，同一个模型里同一个渠道的几条路只算一个名额）。 */
  best: number;
  /** 路由两层里最先排到它的先后（用途 → 模型 → 路由）：名次相同时按它。 */
  first: number;
}

/**
 * 路由两层里每个渠道的顺位依据，加上它在用的路。
 * 在用 = 路由在它的模型下开着，这个模型又排进了某个用途（和探针「在用」同一个口径）；关着的路不参与。
 * 已下架的模型下的路由永远派不到，不算渠道的通不通（它们的「死」是模型下架，不是渠道坏了），也不占顺位。
 */
function collect(
  layers: RoutingLayers,
  retired: ReadonlySet<string>,
): { seen: Map<string, Seen>; routes: Map<string, RoutingLayerRoute[]> } {
  const seen = new Map<string, Seen>();
  const routes = new Map<string, RoutingLayerRoute[]>();
  const done = new Set<string>();
  const doneModels = new Set<string>();
  let order = 0;
  for (const purpose of layers.purposes) {
    for (const model of purpose.models) {
      if (retired.has(model.modelId)) continue;
      const firstTime = !doneModels.has(model.modelId);
      doneModels.add(model.modelId);
      const channelsHere: string[] = [];
      for (const r of model.routes) {
        if (!r.enabled) continue;
        if (!channelsHere.includes(r.channelId)) channelsHere.push(r.channelId);
        if (!done.has(r.routeId)) {
          done.add(r.routeId);
          routes.set(r.channelId, [...(routes.get(r.channelId) ?? []), r]);
        }
      }
      // 同一个模型在几个用途里排的路由顺序是同一份，名次只算一次
      if (!firstTime) continue;
      channelsHere.forEach((channelId, rank) => {
        const cur = seen.get(channelId);
        if (!cur) seen.set(channelId, { best: rank, first: order });
        else if (rank < cur.best) cur.best = rank;
        order += 1;
      });
    }
  }
  return { seen, routes };
}

const FIRST_REASON_MAX = 140;

function clip(text: string): string {
  return text.length > FIRST_REASON_MAX ? `${text.slice(0, FIRST_REASON_MAX - 1)}…` : text;
}

/**
 * 渠道卡片，按顺位排：先是排进了用途的（名次靠前的在前），再是没在配的路由里的（目录里的先后），最后是下架的。
 * layers 来自 GET /routing/layers，routing 来自 GET /routing（目录里的渠道名单、每条路探针写的 detail）。
 */
export function buildChannelCards(
  routing: { channels: readonly Channel[]; routes: readonly Route[]; models: readonly Model[] },
  layers: RoutingLayers,
  now: number,
): ChannelCard[] {
  const retired = new Set(
    routing.models
      .filter((m) => m.retiredAt !== undefined && Date.parse(m.retiredAt) <= now)
      .map((m) => m.id),
  );
  const { seen, routes: active } = collect(layers, retired);
  const rawRoute = new Map(routing.routes.map((r) => [r.id, r]));

  const cards = routing.channels.map((channel): ChannelCard => {
    const mine = channel.enabled ? (active.get(channel.id) ?? []) : [];
    if (!channel.enabled) {
      return {
        channel,
        state: 'off',
        interrupted: false,
        label: '渠道已下架',
        tone: 'stop',
        reason: '目录里这个渠道已下架，选路不派它',
        deadRoutes: 0,
        activeRoutes: 0,
      };
    }
    if (mine.length === 0) {
      return {
        channel,
        state: 'idle',
        interrupted: false,
        label: '没在配的路由里，未探',
        tone: 'stop',
        reason: '没有哪个阶段在用这个渠道，不花额度去探；哪个阶段用上它，下一轮就探',
        deadRoutes: 0,
        activeRoutes: 0,
      };
    }

    const dead = mine.filter((r) => r.connect.verdict === 'dead');
    const live = mine.filter((r) => r.connect.verdict === 'live');
    const probed = mine.filter((r) => r.probedAt !== undefined) as (RoutingLayerRoute & {
      probedAt: string;
    })[];
    const newest = probed.reduce<(RoutingLayerRoute & { probedAt: string }) | undefined>(
      (a, r) => (!a || r.probedAt > a.probedAt ? r : a),
      undefined,
    );
    // 每一条探过的路都过了「间隔 + 3 分钟」才算整个渠道检测中断（慢的执行方式用它自己的间隔）
    const interrupted = probed.length > 0 && probed.every((r) => channelProbeInterrupted(r, now));
    const latency = probeLatency(
      live
        .map((r) => rawRoute.get(r.routeId)?.probe)
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
        .sort((a, b) => b.at.localeCompare(a.at))[0]?.detail,
    );

    let state: ChannelState;
    let label: string;
    let tone: Tone;
    let reason: string | undefined;
    if (live.length > 0 && dead.length === 0) {
      state = 'ok';
      label = '通';
      tone = 'done';
    } else if (live.length > 0) {
      state = 'partial';
      label = '部分路不通';
      tone = 'stall';
    } else if (dead.length > 0) {
      state = 'down';
      label = '暂不可用';
      tone = 'fail';
    } else {
      state = 'unknown';
      label = channel.billing === 'metered' ? '按量计费，不自动探' : '还没探到';
      tone = 'stall';
    }
    const firstDead = dead[0];
    const firstUnknown = mine.find((r) => r.connect.verdict === 'unknown');
    if (firstDead) {
      reason = clip(
        `${firstDead.connect.reason}${dead.length > 1 ? `（另有 ${dead.length - 1} 条路也不通）` : ''}`,
      );
    } else if (state === 'unknown' && firstUnknown) {
      reason = clip(firstUnknown.connect.reason);
    }

    if (interrupted) {
      label = '检测中断';
      tone = 'stall';
    }
    return {
      channel,
      state,
      interrupted,
      label,
      tone,
      ...(newest ? { probedAt: newest.probedAt } : {}),
      ...(latency && state !== 'down' ? { latency } : {}),
      ...(reason ? { reason } : {}),
      deadRoutes: dead.length,
      activeRoutes: mine.length,
    };
  });

  const ranked = cards
    .filter((c) => seen.has(c.channel.id) && c.state !== 'off' && c.state !== 'idle')
    .sort((a, b) => {
      const sa = seen.get(a.channel.id) as Seen;
      const sb = seen.get(b.channel.id) as Seen;
      return sa.best - sb.best || sa.first - sb.first;
    })
    .map((c, i): ChannelCard => ({ ...c, rank: i + 1 }));
  // 顺延：探针报错暂不可用的渠道，选路顺延到后面第一个还能用的渠道（只显示，选路另有判法）
  const usable = (c: ChannelCard) => !c.interrupted && (c.state === 'ok' || c.state === 'partial');
  const withFallback = ranked.map((c, i): ChannelCard => {
    if (c.state !== 'down' || c.interrupted) return c;
    const next = ranked.slice(i + 1).find(usable);
    return {
      ...c,
      fallback: next
        ? `这个渠道暂不可用（已禁用），选路顺延到「${next.channel.name}」`
        : '这个渠道暂不可用（已禁用），后面没有能用的渠道了',
    };
  });
  const placed = new Set(ranked.map((c) => c.channel.id));
  // 没排进名次的：没在配的路由里的按目录里的先后，下架的放最后；一张卡都不丢
  const rest = cards.filter((c) => !placed.has(c.channel.id) && c.state !== 'off');
  const off = cards.filter((c) => c.state === 'off');
  return [...withFallback, ...rest, ...off];
}
