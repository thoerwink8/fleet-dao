// 路由两层「这一层现在活着吗」的存法（#574，specs/509 方案第八节）：不另存一列「活着」——那一列会和事实各过各的，
// 层级一深就变成看着整齐、一条都派不出去（#293 断 47 分钟就是这个形状）。活着由三件事现算，每件事的来源写死在这里；
// 读成每一层的结论在 routing-layers.ts（驾驶舱看它），选路按同一份候选事实挑（queries/engine-route-facts.ts 的 routeFactsForPurpose）。
//
// 改这里之前必须知道：
// - 三件事一个都不能缺：接得上、额度够、没被禁令挡。缺一件，「活着」就是猜的。
// - unknown（没探过、额度没读成）不是 live：和选路一样，没查成不当「还够」。
// - 一层一条都没有（空）是 dead，不是 live：整层没人，派不出去。
import type { PgTable } from 'drizzle-orm/pg-core';
import type { RouteCandidate } from './queries/candidates.ts';
import { bans, pools, quotaWindows, routes } from './schema/index.ts';

export type LivenessVerdict = 'live' | 'dead' | 'unknown';

/** 三件事里的一件：结论 + 原因。dead、unknown 必须写原因（没跑成 ≠ 没问题）。 */
export interface LivenessFact {
  verdict: LivenessVerdict;
  reason: string;
}

/** 一条路由现在活着吗：三件事各一份。 */
export interface RoutingLiveness {
  /** 接得上：路由探针最近一次的结论、探针认为挂着的是不是这个组织。 */
  connect: LivenessFact;
  /** 额度够：账号池最近读成的时刻没过期、窗口没用满。 */
  quota: LivenessFact;
  /** 没被禁令挡：代码里的硬禁令（shared/bans.ts）和库里的 bans 表。 */
  ban: LivenessFact;
}

/** 三件事各看哪张表的哪几列（测试对着真表校验，改了列名这里不跟着改会红）。 */
export const ROUTING_LIVENESS_SOURCES = {
  connect: { table: routes, columns: ['alive', 'probeState', 'probedAt', 'probeDetail', 'probeOrg'] },
  quota: { table: pools, columns: ['lastReadOkAt'] },
  quotaWindow: {
    table: quotaWindows,
    columns: ['utilization', 'used', 'limit', 'upstreamStatus', 'resetsAt', 'readAt', 'staleSince'],
  },
  ban: { table: bans, columns: ['family', 'modelId', 'stage'] },
} as const satisfies Record<string, { table: PgTable; columns: readonly string[] }>;

/** 一条路由的三件事合起来：任何一件 dead 就 dead；没有 dead、有 unknown 就 unknown；三件都 live 才 live。 */
export function routeLiveness(l: RoutingLiveness): LivenessVerdict {
  const verdicts = [l.connect.verdict, l.quota.verdict, l.ban.verdict];
  if (verdicts.includes('dead')) return 'dead';
  if (verdicts.includes('unknown')) return 'unknown';
  return 'live';
}

/**
 * 一层（一个模型下的路由、或一个用途下的模型）合起来：有一条 live 就 live（派得出去）；没有 live、有 unknown 就 unknown
 * （不知道，不当没事也不当没救）；全 dead、或这一层一条都没有就 dead。
 */
export function layerLiveness(children: readonly LivenessVerdict[]): LivenessVerdict {
  if (children.includes('live')) return 'live';
  if (children.includes('unknown')) return 'unknown';
  return 'dead';
}

const BLOCKER_WORDS: Readonly<Record<string, string>> = {
  'channel-disabled': '渠道关了',
  'channel-failed': '渠道运行中失败，已顺延给下一个渠道（探针探通后恢复）',
  'pool-expired': '账号池订阅过期了',
  'model-retired': '模型已下架',
};

/**
 * 把选路用的候选（queries/candidates.ts 的 evaluateRoutes，「为什么不能用」只有这一处判法）读成三件事。
 * - 接得上：渠道关了、池过期、模型下架、探针判不在线 = dead；探针还没看过、或那一轮没探它（skipped：按量计费不探、挂着的是
 *   另一个组织……不是探了没通）= unknown。探针的原因照它自己写的（routes.probe_detail）说，这里不猜。
 * - 额度够：用满 = dead；没读成、读数过期、窗口判不了 = unknown（不当「还够」）。
 * - 没被禁令挡：命中禁令、或开关关着（这条路由在它的模型下关着）= dead（关着的照样挂在顺序里，但不派）；
 *   引擎暂时不往它派（hold，例如拼车并发登记核对不上，#896）也算这一件：写明原因，对上了自己恢复。
 * 并发满了（no-slot）不算 dead：那是等空位，不是坏了。
 */
export function livenessOf(c: RouteCandidate, options: { hold?: string } = {}): RoutingLiveness {
  const dead = (reason: string): LivenessFact => ({ verdict: 'dead', reason });
  const unknown = (reason: string): LivenessFact => ({ verdict: 'unknown', reason });
  const live = (reason: string): LivenessFact => ({ verdict: 'live', reason });

  const hard = c.blockers.find((b) => b in BLOCKER_WORDS);
  let connect: LivenessFact;
  if (hard) connect = dead(BLOCKER_WORDS[hard] ?? hard);
  else if (c.probeState === 'on_demand')
    connect = unknown(`按需探测（不主动探，派给它时先探一次）：${c.probeDetail || '探针没写原因'}`);
  else if (!c.blockers.includes('offline')) connect = live('探针探通了');
  else if (c.probeState === null) connect = unknown('探针还没看过这条路由');
  else if (c.probeState === 'skipped')
    connect = unknown(`探针这一轮没探它（不是探了没通）：${c.probeDetail || '探针没写原因'}`);
  else if (c.probeState === 'ok') connect = dead('不在线：探针上一次探通了，但这条路由被标成了不在线');
  else connect = dead(`探针判不在线：${c.probeDetail || `探针没写原因（${c.probeState}）`}`);

  const quota: LivenessFact =
    c.quota === 'exhausted'
      ? dead('适用的额度窗用满了')
      : c.quota === 'unknown'
        ? unknown('额度没读成、读数过期，或判不了扣不扣这条路由')
        : live('额度读数新、窗口有余');

  const ban: LivenessFact = c.blockers.includes('banned')
    ? dead(`命中禁令：${c.banReasons.join('；')}`)
    : c.blockers.includes('switched-off')
      ? dead('开关关着（这条路由在它的模型下关着）')
      : options.hold
        ? dead(options.hold)
        : live('没有禁令、开关开着');

  return { connect, quota, ban };
}
