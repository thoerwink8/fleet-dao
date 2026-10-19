# packages/api：驾驶舱后端

Hono 写的驾驶舱后端，跑在法国：登录、驾驶舱接口、实时推送（SSE）、GitHub 事件接收、给 Temporal 工作流发信号，另有一个只听本机回环的 fleet 命令接口。读数据只从 Postgres 读、不直接查 GitHub（例外和理由见 design 第四节「架构」）。

## 入口

- `packages/api/src/main.ts`：进程入口，两个监听（驾驶舱接口、fleet 命令接口）；有 `DATABASE_URL` 走真库 + 真 Temporal，没有就用内存样例数据，飞书登录没配时 `POST /auth/dev-login` 免登（只许本机回环）。
- `packages/api/src/app.ts`：`buildApps` 装两个应用；驾驶舱挂 `/auth`、`/api`、`/github`，命令接口挂 `/agent/v1`。新路由在这里挂。
- `packages/api/src/config.ts`：地址、端口、密钥都从环境变量读。
- `github-mirror.ts`：main 的真实 GitHub 装配；开发环境非 HTTPS origin 只让策略桥未装配，不能把其它能力误报凭据缺失。生产桥初始化错误单独失败。
- `ci-policy-bridge.ts`、`ci-policy-public.ts`：受管公开仓 DB 策略只读协议与 source publisher。精确 GET 挂在 session 前，严格核 GitHub 当前 public/数字身份；协议在 shared 的 `ci-policy-bridge.ts`，独立于浏览器 FleetApi，路由契约测试仍逐条登记。私有 force 原路径，私有 off 明确不支持。
- `packages/api/bin/`：法国上的管理命令 `fleet-api`，用法见 ops 第九节「发布应用（deploy/release.sh）」前后的 `fleet-api` 段落。
- `historical-audit` 管理命令从 stdin 收历史通知审计 JSON，现读 GitHub PR/head 与证据 issue，再以真实 ops 身份原子处理通知、记审计。结论只允许 `historical_unproven`，不能作为正常队列账或创始人批准；入口在 `src/historical-audit-cli.ts`。
- `attention --json` 的 `runningIdle` 是版本化即时只读结论：完整 `listRunningEngineTasks` 与 core 唯一 idle 判据，带任务身份、完整 openRuns 和采集时刻。`notes` 是按推送白名单到点的通知，两者不能相互替代；读取失败退出 1，诊断不回退为展示会话计数。

## 测试

- 单测：`npx vitest run packages/api/test/<文件>`；整包 `npx vitest run packages/api`（本机一般不跑整包，交给 CI）。
- 默认用内存 Store，不要 Postgres。驾驶舱用户视角的 e2e（真库 + 真后端 + 真前端）在 `packages/web/e2e/`，备库脚本是 `packages/api/test/e2e/prepare.ts`，跑法见 `packages/web/e2e/README.md`。

## 常见坑

- 接口契约只有一份：`packages/shared/src/web-api.ts` 的 `WebRoutes`、`AuthRoutes`。`packages/api/test/web-routes-contract.test.ts` 两头核对（契约里有、后端没注册；后端注册了、契约里没有，都红）。
- 「只有创始人本人能开」（决定 0033）：打开 Fable 的路由/模型、加进或拖动用途，一律调 `packages/api/src/founder-only.ts` 的 `guardFounderOnly`，不另写判法；`packages/api/test/fable-founder-only.test.ts` 两道门都测。
- 飞书网关的意图接口、别的环境推快照的写口挂在登录门前面，只认各自的通行证；改挂载顺序会把它们关到登录门后面（见 `app.ts` 注释）。
- 读不到就如实报红：GitHub 机器人凭据、Temporal 连不上都不能当成没事，健康检查照实报。
- CI 策略的唯一权威是 repos 行，不能把 mode 写进 caller/source。publisher 必须在 intake 的 await accept 内，wake=false 也执行，失败沿投递账重放；不让 source status 再发布 source。setter 用策略专用 strict pgLocker，先撤绿、原 DB+audit 事务、再撤绿+刷新 source；成功只排重算，失锁和部分同步返回明确阶段。
- 两个 App 装没装的判法只有一份：`packages/api/src/repo-import-routes.ts` 的 `mergedInstallations`（一边失败整次失败）。驾驶舱 `GET /api/repos/importable` 和 `fleet-api project installations`（`project-cli.ts` 的 `installationFacts`，#2977）都调它，别另写；后者按仓号认、只打目标仓，没读全、身份对不上退出 1（没查成），不当成没装，也不碰 repos 表、不写安装。

## 改它时要连带改

- 加改接口：先改 `packages/shared/src/web-api.ts`，再改这里的路由、`packages/web/src/api/http.ts`，以及 web 的 mock（`packages/web/src/api/mock/server.ts`，它 `implements FleetApi`，类型不同步编译不过）。
- 测试会读 web 的文件（`packages/conventions/src/ci-plan.ts` 的 `TEST_READS` 里 api 读 web）：改 web 也可能让这里的测试红。
- 改了行为（发信号、权限、读写哪张表）：同步 `docs/design.md` 第十五节「驾驶舱」对应条；改了部署相关的环境变量、端口：同步 `docs/ops.md`。

- 通知回答先存代次，再原子 claim，最后按答案和 claim CAS 结算；在途或结果未知返回明确 409，不自动重放。HTTP 重试复用 `requestId`，新决定用新编号，带 `requestId` 必须同时带 `expectedAnswerId`（首答 null），拒绝跨新答案的迟到重试。handoff 的 GitHub key 绑定答案代次；历史无代次不能执行或交接。

- 最终现场验收：`fleet-api acceptance status <owner/仓> <单号>` 读持久责任账；`settle` 必须提交精确责任 id、generation、PR/head 和证据，旧代次不能结清新增项。公开只读口复用现有 CI bridge 验证公开仓身份，不提供写口。

- 看门狗提醒的受控修复（#3033，`alert-repair.ts`）：动作读时现算，不存、不借 `decision_reason`；点的时候只收服务端动作编号（含证据摘要）+ incident + `requestId`，条件变了、已撤、incident 对不上、动作过期、上一次在途或结果未知一律 409，不发副作用。信号、请求文件只记 `accepted`，要重读原条件才记 `verified`，读不到或未恢复保持未修好。idle-running 的仓和工作流从键里的任务编号现查，不从正文猜；没有直接修复入口的只能「交给修复」（开在 fleet-dao，key `alert-repair:<incident>`，同一次事故一张），不放开 alert-sweep 的 24 小时立案排除。修复状态在设置表 `alert.repair:<提醒编号>`，版本号 CAS；incident 用现成 `raisedAt` 区分同 key 重开，跨代在途/未知/受理待核验仍禁止覆盖和重放。测试 `alert-repair.test.ts` 跑引擎的真看门狗（`runWatchdogJob(watchdogJob(...))`，PGlite 真库）造提醒，所以 api 的 `devDependencies` 有 engine（只有测试用，`src` 不许引 engine；`tsconfig.json` 的 include 带 `../engine/src`），改 engine 的 PR 也会测 api。看门狗改了键、标题、撤卡口径，这些测试会红：`alert-repair.ts` 的 `IDLE_PREFIX`、`RELEASE_KEY` 要一起改。

- 受控修复同一 incident 在执行、结果未知或受理待核验时，所有其他动作也必须阻挡，不允许覆盖原副作用。idle 判据与原检测器共用 core 纯模块，具体 workflow run 必须现读并钉入信号；发版核验绑原 SHA 和 startedAt。交修复在开单后调用固定 `engine/src/bin/dispatch-issue.ts` 准入入口，不拼 shell，不提权，派工未知保留原单和未知状态；确定未派重试复用原单。

- 真核验通过后按设置版本与通知 `raisedAt` 双守卫 CAS 持久写 verified 和审计；并发 GET 只一份结清审计，结算冲突/读取失败均不展示绿。不替看门狗撤原通知。执行路由的最终结算同样只回已落库的记录：CAS 冲突或持久读写失败不把内存里的 verified 等终态当 200；重读只采纳精确同一 incident、requestId、动作且已落库的结果，不覆盖并发赢家，不重放动作。

- 明确关联已有单（#3100，`POST /api/notifications/:id/repair/link`）：可信登录操作者指定这次告警由哪张现有 fleet-dao 单处理，只收受管仓 + 单号 + 服务端关联版本（视图 `linkAction`）+ incident + `requestId`，多一个字段（如伪造 actor）就 400；服务端现读必须是开着的 issue，并按目标仓和单精确查任务、开放 PR（`listPullRequests` 的 `repoId`/`issueNumber`，不读全局前 N 条再筛；一页读满当没读全，关联 502、交给修复标 failed 不派工）；读不到、PR、错仓、已关闭一律拒绝，不回退成开单。线上契约不加枚举：修复记录的 kind/state 与 #3033 一样，关联存成设置表里的内部记录（`StoredRecordSchema`，只在 `alert-repair.ts` 里认），出口经 `wireLast` 投影，关联只走视图的 `linked` 和关联端点自己的回执；通知卡（#3034）按旧枚举取 `PHASE_META[state]`，新枚举会让它崩溃，`alert-repair.test.ts` 有照抄旧消费者的严格检查。交给修复沿用绑定：每次重新核实，失效标 `invalid` 不开新单；已有进行中的任务或开放 PR 回 409 `link_already_handled` 不派工，否则经原准入派一次（不传 force）。关联与开单抢同一事故走同一个设置版本 CAS。标题正文相似不自动认同根因。

- `fleet-api quote put|get|list` 仅私有管理命令；put 从 stdin 收数组，同 id 同内容幂等、异文整批拒绝。错误不回显 payload 或数据库明细，get/list 的私有原文输出不可送公开日志；不挂 HTTP 或 realtime。
