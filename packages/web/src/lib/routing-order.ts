// 路由页「调整顺序」：每一行实际排第几（只数引擎会真派的）。纯函数，组件里不再自己算。
// 判法照 packages/engine/src/routing/filter.ts 的 blocksFor：路由在它的模型下关着（entry.enabled 为假，或候选带 switched-off）就被挡，
// 渠道关了（channel-disabled）也挡；被挡的不删，引擎自动顺延给下一个。
// 模型没有自己的开关（没有 models.enabled）：模型「关着」= 下面没有一条开着的路由，开关一关就是把下面每条路由一起关掉。
// 已下架的模型不占实际顺位（目录 retiredAt 已过），哪怕下面还有开着的路由；行上写「已下架」，不写名次。
// 读不到的不猜：渠道开关没读到（undefined）当开着，不凭空把一行判成被跳过。下架没读到当没下架。

import type { RoutingLayerRoute } from '../api/types';

/**
 * on = 引擎会考虑它；off = 关着；closed = 开着的路由全在已关的渠道下面（模型层才有）；empty = 下面一条路由都没有（模型层才有）；
 * retired = 模型已下架（模型层才有）。
 * off、closed、empty、retired 都被引擎跳过、顺延给下一个，不占实际顺位。
 */
export type SlotState = 'on' | 'off' | 'closed' | 'empty' | 'retired';

export type ChannelOpen = (channelId: string) => boolean | undefined;

/** 一条路由：开关关着 = off；渠道读到了且关着 = closed；其余 on。 */
export function routeSlotState(
  r: Pick<RoutingLayerRoute, 'enabled' | 'channelId'>,
  channelOpen: ChannelOpen,
): SlotState {
  if (!r.enabled) return 'off';
  return channelOpen(r.channelId) === false ? 'closed' : 'on';
}

/**
 * 一个模型：已下架 = retired（先于路由开关，不占实际顺位）；一条路由都没有 = empty；没有开着的 = off；
 * 开着的都在已关的渠道下 = closed；否则 on。
 */
export function modelSlotState(
  m: { routes: readonly Pick<RoutingLayerRoute, 'enabled' | 'channelId'>[] },
  channelOpen: ChannelOpen,
  retired = false,
): SlotState {
  if (retired) return 'retired';
  if (m.routes.length === 0) return 'empty';
  const states = m.routes.map((r) => routeSlotState(r, channelOpen));
  if (states.every((s) => s === 'off')) return 'off';
  if (!states.includes('on')) return 'closed';
  return 'on';
}

/** 实际顺位：只数 on 的，从 1 起；被跳过的是 null。 */
export function actualRanks(states: readonly SlotState[]): (number | null)[] {
  let n = 0;
  return states.map((s) => (s === 'on' ? ++n : null));
}

/** 一行右边写的话。on 写实际第几位，已下架写「已下架」，其余写为什么被跳过。 */
export function slotWord(state: SlotState, rank: number | null, unit: '模型' | '路由'): string {
  if (state === 'on') {
    if (rank === null) throw new Error('开着的一行必须有实际顺位');
    return `实际第 ${rank} 位`;
  }
  if (state === 'retired') return '已下架';
  if (state === 'off') return '关着，已跳过';
  if (state === 'closed') return unit === '模型' ? '渠道都关着，没有可用路由，已跳过' : '渠道已关，已跳过';
  return '没有可用路由，已跳过';
}

export type OrderSummary =
  | { ok: true; active: number; skipped: number; firstPosition: number }
  /** 一个能派的都没有：不给顺位，明说无可用。 */
  | { ok: false; why: string };

/** 一层合起来：几个会被引擎考虑、几个被跳过、排头的是配置里的第几个。一个都没有返回「无可用」，不拿 0 或空冒充。 */
export function summarizeOrder(states: readonly SlotState[], noun: '模型' | '路由'): OrderSummary {
  const first = states.indexOf('on');
  if (first < 0) {
    return {
      ok: false,
      why:
        states.length === 0
          ? `无可用：一个${noun}都没有`
          : noun === '路由'
            ? `无可用：${states.length} 个路由全都关着或渠道已关。没有可用路由，已跳过这个模型`
            : `无可用：${states.length} 个模型全都被跳过（关着、已下架或没有可用路由），引擎一个也派不到`,
    };
  }
  const active = states.filter((s) => s === 'on').length;
  return { ok: true, active, skipped: states.length - active, firstPosition: first + 1 };
}
