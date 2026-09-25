// 选路（设计 §九）：纯函数，引擎的 pickRoute 端口从库里取齐输入后调 chooseRoute。
export { chooseRoute } from './choose.ts';
export { hostUnfit } from './filter.ts';
export { HOST_NAMES, routeLabel, STAGE_NAMES } from './names.ts';
export {
  ABILITY_NAMES,
  type Ability,
  DEFAULT_ROUTING_POLICY,
  type FastReset,
  HOST_ABILITIES,
  type RoutingPolicy,
  resolveRoutingPolicy,
  STAGE_NEEDS,
} from './policy.ts';
export { fastResetHit, poorRecord } from './rank.ts';
export * from './types.ts';
