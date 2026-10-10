# 驾驶舱用户视角 e2e（母单 #902）

站在创始人角度逐页走一遍：真 Postgres + 真后端（`packages/api/src/main.ts`，线上同一个入口）+ 真前端（Vite）+ 真浏览器（Chrome）。
不用假数据：备库（`packages/api/test/e2e/prepare.ts`）按发布时同一条装载链装目录、路由骨架、额度留量线，再灌任务、会话、提醒、追问、额度读数、切号账本。

## 跑法

要先有一台真 Postgres，把管理连接串给 `E2E_PG_ADMIN_URL`（会在里面建/重建 `fleet_e2e` 库，库名必须 `fleet_e2e` 开头）：

```
E2E_PG_ADMIN_URL=postgres://postgres:<密码>@127.0.0.1:5432/postgres pnpm --filter @fleet-dao/web e2e
```

- 没设 `E2E_PG_ADMIN_URL` 会明确失败，不退回内存库冒充。
- 浏览器默认用本机装的 Chrome（`channel: 'chrome'`）；别的用 `E2E_BROWSER_CHANNEL`（`msedge`、`chromium`，后者要先 `npx playwright install chromium`）。
- 端口默认 前端 15173、后端 18787、开关代理 18786/18785、fleet 命令口 18788，可用 `E2E_WEB_PORT`、`E2E_API_PORT`、`E2E_PROXY_PORT`、`E2E_CONTROL_PORT`、`E2E_AGENT_PORT` 改。
- 截图存仓根 `_tmp/e2e/1920x1080/`、`_tmp/e2e/1366x768/`，HTML 报告在 `_tmp/e2e/report/`，各进程日志在 `_tmp/e2e/*.log`。

反复调用例：`pnpm --filter @fleet-dao/web e2e:serve` 起一套环境留着（写 `_tmp/e2e/stack.json`），另一个终端 `E2E_REUSE=1 pnpm --filter @fleet-dao/web e2e`。改库的用例只能跑一次（它们动的是同一份库），要重跑就重启 `e2e:serve`（每次重建库）。

本机没有 Postgres 的办法：WSL 里装的 Postgres 16 也行；或者用 npm 的 `@embedded-postgres/windows-x64`（Windows 版 PG 二进制，不用装、不用管理员，`initdb` + `postgres.exe -p 55432` 起一份，装在仓外）。

## 在 CI 里怎么跑（#930）

`.github/workflows/ci.yml` 的 `e2e` job：Linux、容器里的 `postgres:16-alpine`（由 `.github/scripts/start-pg.sh` 多源带重试地拉：`public.ecr.aws`、`mirror.gcr.io`，避开单一源限速）（`E2E_PG_ADMIN_URL` 指向它）、Playwright 的 Chromium（`E2E_BROWSER_CHANNEL=chromium`，`playwright install --with-deps chromium`，浏览器按 Playwright 版本缓存）。
- 只在改到 `packages/web`、`api`、`db`、`shared`、依赖文件（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`）、`ci.yml` 自己，或认不出改了什么时才跑（判法 `packages/conventions/src/ci-plan.ts` 的 `touchesE2e`），别的 PR 跳过。
- 红了挡合并：必过检查 `check` 等它，该跑的它必须绿（`ciVerdict`）。不管成败，报告、截图、各进程日志都当 artifact 上传、留 7 天（`e2e-<运行号>`，#1061）。
- 和本机的差别：本机是 Windows + 本机 Chrome + 自己起的 Windows 版 PG；CI 是 Linux + 下载的 Chromium + 容器 PG。库名、端口、用例顺序一样。
- CI 的 `test` job 只收 `*.test.ts(x)`，`*.e2e.ts` 不在其内，`pnpm test` 不会误跑它。

## 用例

按创始人剧本的顺序编号，文件名即顺序：登录 → 主页 → 单子详情 → 额度 → 设置 → 提醒 → 其余页面 → 后端不可用 → 退出。两个视口都走（1366×768 那一遍只读，1920×1080 那一遍带写）；CI 的 PR 上只走 1920 那一遍，1366 留给每夜全量和主线推送（`support/viewports.ts`）。
已知缺陷用 `test.fail(true, '缺陷 Dn …')` 标出：现在红着的事实被钉住，缺陷修好后这个用例会「意外通过」而变红，提醒把标记删掉。
