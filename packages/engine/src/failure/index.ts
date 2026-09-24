// 失败分流、路由熔断、停滞判断（设计第十二节）。除 ask.ts 外全是纯函数。
export * from './ask.ts';
export * from './breaker.ts';
export * from './classify.ts';
export * from './jev.ts';
export type { FailureRule, RuleHit, Rung } from './rules.ts';
export { matchRule, RULES } from './rules.ts';
export * from './stall.ts';
export * from './types.ts';
