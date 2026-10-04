// 测试夹具：api 的测试和 store 自己的契约测试共用（样例数据在 dev-fixtures.ts，从包的主入口取）。不要在生产代码里引它。
export { FEISHU_IDS, feishuData, T0 } from './testing/feishu-fixtures.ts';
export { seedPg } from './testing/pg-fixtures.ts';
