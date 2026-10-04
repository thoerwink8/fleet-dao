// 三段流程用的纯判断：不碰网络和库，引擎、后端、网页、fleet 命令都是外壳，调这里判。
// 只许依赖 shared 和 zod（test/structure.test.ts 盯着）。

export * from './alert-work.ts';
export * from './ask.ts';
export * from './brief.ts';
export * from './criteria.ts';
export * from './dispatch.ts';
export * from './seat.ts';
export * from './verdict.ts';
