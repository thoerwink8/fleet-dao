// 失败分流、路由熔断（设计第十二节）。全是纯函数：不取时钟、不碰网络和文件。
// 停滞判断和问 Jev 的端口没有生产调用，已删。
export * from './breaker.ts';
export * from './classify.ts';
export type { FailureRule, Kind, RuleHit } from './rules.ts';
export { matchRule, RULES } from './rules.ts';
export * from './types.ts';
