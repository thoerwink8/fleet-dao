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

## 为什么没进 CI

CI 的 `test` job 只收 `*.test.ts(x)`，`*.e2e.ts` 不在其内，`pnpm test` 不会误跑它。要进 CI 得在 `ci.yml` 里加一个 job（postgres 服务容器 + 装浏览器 + 起三个进程，约几分钟），那是改 CI 工作流（先审后合），单开了子单跟踪（见 `specs/902-驾驶舱用户视角e2e/缺陷清单.md` 末尾），现在是手动脚本。

## 用例

按创始人剧本的顺序编号，文件名即顺序：登录 → 主页 → 单子详情 → 额度 → 设置 → 提醒 → 其余页面 → 后端不可用 → 退出。两个视口都走（1366×768 那一遍只读，1920×1080 那一遍带写）。
已知缺陷用 `test.fail(true, '缺陷 Dn …')` 标出：现在红着的事实被钉住，缺陷修好后这个用例会「意外通过」而变红，提醒把标记删掉。
