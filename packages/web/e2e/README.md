# 驾驶舱用户视角 e2e（母单 #902）

站在创始人角度逐页走一遍：真 Postgres + 真后端（`packages/api/src/main.ts`，线上同一个入口）+ 真前端（`react-router build` 打好的产物，门面照线上 nginx 伺候，`support/web-server.ts`）+ 真浏览器（Chrome）。
不用假数据：备库（`packages/api/test/e2e/prepare.ts`）按发布时同一条装载链装目录、路由骨架、额度留量线，再灌任务、会话、提醒、追问、额度读数、切号账本。

## 跑法

要先有一台真 Postgres，把管理连接串给 `E2E_PG_ADMIN_URL`（每个 worker 在里面建/重建自己的 `fleet_e2e_w<worker 号>` 库、收工删掉，库名必须 `fleet_e2e` 开头）：

```
E2E_PG_ADMIN_URL=postgres://postgres:<密码>@127.0.0.1:5432/postgres pnpm --filter @fleet-dao/web e2e
```

- 没设 `E2E_PG_ADMIN_URL` 会明确失败，不退回内存库冒充。
- 浏览器默认用本机装的 Chrome（`channel: 'chrome'`）；别的用 `E2E_BROWSER_CHANNEL`（`msedge`、`chromium`，后者要先 `npx playwright install chromium`）。
- 并行（决定 0093）：每个 worker 一整套环境（自己的库、自己的后端、自己的门面，`support/fixtures.ts` 的 `stack` 夹具），一个文件整个落在一个 worker 里按顺序走。worker 数：CI 上等于核数，本机取一半核数、最多 4 个，`E2E_WORKERS=<n>` 指定。
- 端口：门面、开关代理随系统分（listen 0）；后端和 fleet 命令口按 worker 号排，从 `E2E_PORT_BASE`（默认 21000）起每个 worker 两个（`stackPorts`）。被别的程序占着时后端起不来，明说是哪个端口，换 `E2E_PORT_BASE`。
- 前端每轮先打包一次（`global-setup.ts`），各 worker 共用；确认产物是新的、只想重跑用例时设 `E2E_SKIP_BUILD=1`。
- 截图存仓根 `_tmp/e2e/1920x1080/`、`_tmp/e2e/1366x768/`，HTML 报告在 `_tmp/e2e/report/`，各进程日志在 `_tmp/e2e/<worker>-api.log`。

反复调用例：`pnpm --filter @fleet-dao/web e2e:serve` 起一套环境留着（库 `fleet_e2e_serve`，写 `_tmp/e2e/stack.json`），另一个终端 `E2E_REUSE=1 pnpm --filter @fleet-dao/web e2e`。改库的用例只能跑一次（它们动的是同一份库），要重跑就重启 `e2e:serve`（每次重建库）。

本机没有 Postgres 的办法：WSL 里装的 Postgres 16 也行；或者用 npm 的 `@embedded-postgres/windows-x64`（Windows 版 PG 二进制，不用装、不用管理员，装在仓外，默认 `D:/Tools/pg-e2e`：`npm i @embedded-postgres/windows-x64`，再 `initdb -D data -U postgres -A trust -E UTF8` 一次）。

起它用 `pnpm pg:local start`（`status` 看在不在跑、`stop` 停；`FLEET_LOCAL_PG_DIR`、`FLEET_LOCAL_PG_PORT` 改位置和端口，默认端口 55432），起好打出 `E2E_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres`。它经 WMI 起 `pg_ctl`，库不在 Claude Code 会话的进程组里，会话重启不再把库一起杀掉（直接在会话里起 `postgres.exe` 会）。`E2E_PG_ADMIN_URL` 指着本机、端口连不上时 e2e 起栈前就停下，提示这条命令（`support/stack.ts`）。判法在 `packages/db/src/local-pg.ts`。

## 在 CI 里怎么跑（#930）

`.github/workflows/ci.yml` 的 `e2e` job：Linux、容器里的 `postgres:16-alpine`（取自 `public.ecr.aws/docker/library/`，避开 Docker Hub 匿名限速）（`E2E_PG_ADMIN_URL` 指向它）、Playwright 的 Chromium（`E2E_BROWSER_CHANNEL=chromium`，`playwright install --with-deps chromium`，浏览器按 Playwright 版本缓存）。
- 每个 PR、每次主线推送都跑全套（两种屏宽，决定 0101），既是合并闸也是发版闸；合并后主线那一轮和 PR 是同一棵树时复用 PR 的结果、不重跑。本机 `pnpm test:changed` 按改动提示该点哪几页（判法 `packages/conventions/src/ci-plan.ts` 的 `e2eSpecsFor`）。
- 红了这一轮 CI 就红（必过检查 `check` 等它，该跑的它必须绿，`ciVerdict`），法国的自动发版只发主线头 CI 全绿的提交，所以不发。不管成败，报告、截图、各进程日志都当 artifact 上传、留 7 天（`e2e-<运行号>-<第几次运行>-<分片号>`，#1061；主线红了 `ci-rerun.yml` 自动重跑失败的 job 一次，重跑那次的报告另起一份，#2747）。全套切 2 台各跑一半文件（`--shard`），每台 4 个 worker。
- 改了页面的 PR 想合前就点一遍：本机跑（`pnpm test:changed` 会列出该点哪几个 spec）；改 e2e 地基（夹具、配置、备库）的 PR 合前在 CI 上跑一轮全量：`gh workflow run ci.yml --ref <分支>`（手动触发一律全跑，发版不认它）。
- 和本机的差别：本机是 Windows + 本机 Chrome + 自己起的 Windows 版 PG；CI 是 Linux + 下载的 Chromium + 容器 PG。库名、端口、用例顺序一样；CI 的 worker 多（核数）。
- 偶发与隔离集（决定 0093）：首跑红的用例重试一次（`retries: 1`），重试过了标 flaky、这一轮不算红，job 摘要里列出来。每轮主线 ci 跑完，`.github/workflows/e2e-flaky.yml` 取近 10 轮的 JSON 报告（artifact 里的 `results*.json`），同一条用例首跑红达 2 次就开单（限期 7 天、带失败链接，同标题已有开着的单不重开；判法 `packages/conventions/src/e2e-flaky.ts`）。跟单的人把它加进隔离集 `quarantine.json`（`file`、`title`、`issue`、`until`）：隔离集里的用例在正式那一步跳过（`E2E_QUARANTINE=skip`），另由 `.github/workflows/e2e-quarantine.yml` 每天定时单跑一次（`E2E_QUARANTINE=only`，可手动触发，只报不挡，不在 ci 里跑），修好了从文件里删掉。隔离集只认仓里的文件，不随 GitHub 上的单子变（必过检查只看检出的文件，#87）。本机不设 `E2E_QUARANTINE`，全跑。
- CI 的 `test` job 只收 `*.test.ts(x)`，`*.e2e.ts` 不在其内，`pnpm test` 不会误跑它。

## 用例

按创始人剧本的顺序编号，文件名即顺序：登录 → 主页 → 单子详情 → 额度 → 设置 → 提醒 → 其余页面 → 后端不可用 → 退出。两个视口都走（1366×768 那一遍只读，1920×1080 那一遍带写），是两个 Playwright 项目，各自的 worker 各起一套环境（`support/viewports.ts`）。
已知缺陷用 `test.fail(true, '缺陷 Dn …')` 标出：现在红着的事实被钉住，缺陷修好后这个用例会「意外通过」而变红，提醒把标记删掉。
