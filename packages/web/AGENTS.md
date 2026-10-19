# packages/web：驾驶舱前端

驾驶舱的看板和后台管理，React Router 纯前端单页（不做服务端渲染），Vite 打包，法国后端经香港门面给人用。界面规范是 `docs/design/驾驶舱界面.md`，改界面先读它。

## 入口

- `packages/web/src/routes.ts`：路由表（登录页在外壳外，其余挂在 `routes/shell.tsx` 里）；页面在 `packages/web/src/routes/`。
- `packages/web/src/root.tsx`：根组件；`packages/web/src/api/index.ts` 决定用哪个 `FleetApi`：mock 模式用假数据，否则连真后端（`http.ts`，开发时 Vite 代理到本机 `127.0.0.1:8787`）。
- `packages/web/src/api/mock/`：假后端（`server.ts` 是 `FleetApi` 的 mock 实现，`seed.ts` 是样例数据）。
- `packages/web/src/app.css`：设计令牌；`packages/web/src/components/`：共用组件。
- 仓根 `pnpm dev` = `pnpm --filter @fleet-dao/web dev:mock`：本机起 mock 开发服务，不要后端。

## 测试

- 单测：`npx vitest run packages/web/src/<文件>`（测试和源码放一起，界面行为的回归在 `packages/web/src/test/`）。
- 界面检查：`packages/web/src/test/lint-design.test.ts` 跑 `packages/web/scripts/lint-design.ts`（严格模式，CI 必过）；本机在 `packages/web` 下 `node scripts/lint-design.ts --list` 看每一处违规。
- e2e（真库 + 真后端 + 真前端 + 真浏览器）：`packages/web/e2e/`，先 `pnpm pg:local start`，再 `E2E_PG_ADMIN_URL=... pnpm --filter @fleet-dao/web e2e`；没设这个变量直接失败。全套跑法见 `packages/web/e2e/README.md`。CI 一律全套：每个 PR 和主线推送都跑 e2e 全套（两种屏宽，决定 0101）。

## 常见坑

- 前端走 Vite 打包，相对导入不带 `.ts`（和后端相反）。
- 全局虚拟仓（`enableGlobalVirtualStore`）下依赖的真实路径在工作区外，vite 的 strict fs 会拒绝 `?url` 这类资源读取（Denied ID）。`src/build/asset-access.ts` 按本包声明的依赖补它们的真实包目录进 `server.fs.allow`，`vite.config.ts` 和根 `vitest.config.ts` 共用；不要关 strict 或放整个 store，新资源依赖先在 `package.json` 里声明。
- 类名只用规范里的令牌和档位，任意值、裸色值会被 lint-design 拦；例外只写在 `lint-design.ts` 的 `allowed()` 里并写理由，不在页面里绕。
- 令牌（`app.css`）改了，同一个 PR 改 `docs/design/驾驶舱界面.md`。
- 截图、e2e 报告放仓根 `_tmp/`，不进 git；PR 里贴截图的要求见 `docs/design/驾驶舱界面.md` 第七部分（截图怎么交）。

## 改它时要连带改

- 接口契约只有一份：`packages/shared/src/web-api.ts`。前端用了契约里的哪些由 `packages/web/src/api/contract.test.ts` 核对，后端注册了哪些由 `packages/api/test/web-routes-contract.test.ts` 核对。
- 加改接口：shared 契约 → 后端路由（`packages/api`）→ `src/api/http.ts` → mock（`src/api/mock/server.ts` 实现 `FleetApi`，不同步编译不过）。
- api 的测试也读 web 的文件（`packages/conventions/src/ci-plan.ts` 的 `TEST_READS`）：改这里可能让 api 的测试红。
- 改了页面行为：同步 design 第十五节「驾驶舱」对应条。
