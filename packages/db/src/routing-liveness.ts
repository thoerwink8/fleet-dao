// 路由两层「这一层现在活着吗」的存法（#574，specs/509 方案第八节）：不另存一列「活着」——那一列会和事实各过各的，
// 层级一深就变成看着整齐、一条都派不出去（#293 断 47 分钟就是这个形状）。活着由三件事现算，每件事的来源写死在这里，
// 读法（把表读成 RoutingLiveness）和选路切换留给后续切片。
//
// 改这里之前必须知道：
// - 三件事一个都不能缺：接得上、额度够、没被禁令挡。缺一件，「活着」就是猜的。
// - unknown（没探过、额度没读成）不是 live：和选路一样，没查成不当「还够」。
// - 一层一条都没有（空）是 dead，不是 live：整层没人，派不出去。
import type { PgTable } from 'drizzle-orm/pg-core';
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
  connect: { table: routes, columns: ['alive', 'probeState', 'probedAt', 'probeOrg'] },
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
