# packages/api：驾驶舱后端

Hono 写的驾驶舱后端，跑在法国：登录、驾驶舱接口、实时推送（SSE）、GitHub 事件接收、给 Temporal 工作流发信号，另有一个只听本机回环的 fleet 命令接口。读数据只从 Postgres 读、不直接查 GitHub（例外和理由见 design 第四节「架构」）。

## 入口

- `packages/api/src/main.ts`：进程入口，两个监听（驾驶舱接口、fleet 命令接口）；有 `DATABASE_URL` 走真库 + 真 Temporal，没有就用内存样例数据，飞书登录没配时 `POST /auth/dev-login` 免登（只许本机回环）。
- `packages/api/src/app.ts`：`buildApps` 装两个应用；驾驶舱挂 `/auth`、`/api`、`/github`，命令接口挂 `/agent/v1`。新路由在这里挂。
- `packages/api/src/config.ts`：地址、端口、密钥都从环境变量读。
- `packages/api/bin/`：法国上的管理命令 `fleet-api`，用法见 ops 第九节「发布应用（deploy/release.sh）」前后的 `fleet-api` 段落。

## 测试

- 单测：`npx vitest run packages/api/test/<文件>`；整包 `npx vitest run packages/api`（本机一般不跑整包，交给 CI）。
- 默认用内存 Store，不要 Postgres。驾驶舱用户视角的 e2e（真库 + 真后端 + 真前端）在 `packages/web/e2e/`，备库脚本是 `packages/api/test/e2e/prepare.ts`，跑法见 `packages/web/e2e/README.md`。

## 常见坑

- 接口契约只有一份：`packages/shared/src/web-api.ts` 的 `WebRoutes`、`AuthRoutes`。`packages/api/test/web-routes-contract.test.ts` 两头核对（契约里有、后端没注册；后端注册了、契约里没有，都红）。
- 「只有创始人本人能开」（决定 0033）：打开 Fable 的路由/模型、加进或拖动用途，一律调 `packages/api/src/founder-only.ts` 的 `guardFounderOnly`，不另写判法；`packages/api/test/fable-founder-only.test.ts` 两道门都测。
- 飞书网关的意图接口、别的环境推快照的写口挂在登录门前面，只认各自的通行证；改挂载顺序会把它们关到登录门后面（见 `app.ts` 注释）。
- 读不到就如实报红：GitHub 机器人凭据、Temporal 连不上都不能当成没事，健康检查照实报。
- 两个 App 装没装的判法只有一份：`packages/api/src/repo-import-routes.ts` 的 `mergedInstallations`（一边失败整次失败）。驾驶舱 `GET /api/repos/importable` 和 `fleet-api project installations`（`project-cli.ts` 的 `installationFacts`，#2977）都调它，别另写；后者按仓号认、只打目标仓，没读全、身份对不上退出 1（没查成），不当成没装，也不碰 repos 表、不写安装。

## 改它时要连带改

- 加改接口：先改 `packages/shared/src/web-api.ts`，再改这里的路由、`packages/web/src/api/http.ts`，以及 web 的 mock（`packages/web/src/api/mock/server.ts`，它 `implements FleetApi`，类型不同步编译不过）。
- 测试会读 web 的文件（`packages/conventions/src/ci-plan.ts` 的 `TEST_READS` 里 api 读 web）：改 web 也可能让这里的测试红。
- 改了行为（发信号、权限、读写哪张表）：同步 `docs/design.md` 第十五节「驾驶舱」对应条；改了部署相关的环境变量、端口：同步 `docs/ops.md`。
