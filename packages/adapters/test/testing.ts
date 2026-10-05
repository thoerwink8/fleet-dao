// 给别的包的测试用的夹具和小工具（子路径 @fleet-dao/adapters/testing，和 db、store 的 /testing 同一个做法）。
// #901 ⑥：以前别的包的测试用 '../../adapters/test/helpers.ts' 这样的相对路径伸进来，改 adapters 的目录结构会悄悄断；
// 现在只经这里：夹具目录（FIXTURES）、临时目录（tempDir）、假 Mirasim 服务端（startWsServer）等。只在 vitest 里用（helpers.ts 引了 vitest）。

export type { FakeScript } from './fake-agent.ts';
export * from './helpers.ts';
export * from './ws-server.ts';
