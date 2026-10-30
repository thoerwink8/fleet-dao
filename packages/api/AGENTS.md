# packages/api：驾驶舱后端

Hono 写的驾驶舱后端，跑在法国：登录、驾驶舱接口、实时推送（SSE）、GitHub 事件接收、给 Temporal 工作流发信号，另有一个只听本机回环的 fleet 命令接口。读数据只从 Postgres 读、不直接查 GitHub（例外和理由见 design 第四节「架构」）。各模块的细节约束在文件头注释，这里只留跨文件的不变量。

## 去哪找

| 要找 | 位置 |
|---|---|
| 进程入口（两个监听；有 `DATABASE_URL` 走真库 + 真 Temporal，没有用内存样例；飞书未配时 `POST /auth/dev-login` 免登，只许本机回环） | `src/main.ts` |
| 装应用、挂路由（驾驶舱 `/auth`、`/api`、`/github`，命令接口 `/agent/v1`；新路由在这里挂） | `src/app.ts` |
| 地址、端口、密钥（都从环境变量读） | `src/config.ts` |
| 真实 GitHub 装配；CI 策略读桥 | `github-mirror.ts`；`ci-policy-bridge.ts`、`ci-policy-public.ts`（协议在 shared 的 `ci-policy-bridge.ts`） |
| 法国上的管理命令 `fleet-api`（用法见 ops 第九节「发布应用（deploy/release.sh）」前后） | `packages/api/bin/`；`historical-audit`、`checkout-history`、`task correct-merged`、`quote`、`node-key`、`project` 等子命令的逻辑在 `src/*-cli.ts` 与同名模块 |
| `attention --json` | `runningIdle` 是版本化即时只读结论（完整 `listRunningEngineTasks` + core 唯一 idle 判据），与按推送白名单到点的 `notes` 不能互相替代；读取失败退出 1 |

## 必须守的不变量

- 接口契约只有一份：`packages/shared/src/web-api.ts` 的 `WebRoutes`、`AuthRoutes`；`test/web-routes-contract.test.ts` 两头核对（契约有后端没注册、后端注册了契约没有，都红）。
- 「只有创始人本人能开」（决定 0033）：打开 Fable、加进或拖动用途一律调 `src/founder-only.ts` 的 `guardFounderOnly`，不另写判法（`test/fable-founder-only.test.ts` 两道门都测）。
- 飞书网关的意图接口、别的环境推快照的写口挂在登录门前面，只认各自通行证；改挂载顺序会把它们关到登录门后面（见 `app.ts` 注释）。
- 机器通行证认谁只有一份：`src/node-keys.ts` 的 `readNodeKeys`（库表 `node_keys` 有效行 + 旧 `FLEET_NODE_KEYS`，同编号库为准，作废行遮住旧配置），快照、本机会话、领单、看板读口都走它；每次现读不缓存，库读失败 503 `node_keys_unreadable`，不放行也不回 401。
- 开单服务（决定 0122，`src/intake.ts`，协议在 shared 的 `intake.ts`）：`POST /api/nodes/issues`、`POST /api/nodes/notes`（#3741 片 2a，过程记录）、`GET /api/nodes/events` 同样只认机器通行证，挂在 `node-report.ts`；不进 `WebRoutes`（契约对账里和 claims 一样登记为只认通行证）。账本不另建表，读 `audit_log` 里 `target` 以 `issue:` 或 `progress:` 开头的行（走部分索引 `audit_log_ledger_events_idx`，查询里的 where 要和索引谓词同形，见 db 的 `issueEventsFilter`）。`notes` 写 `progress.note` / `decision.handoff` / `report.daily` / `report.guards` 四种 action，target 挂单是 `issue:<repo>#<号>`、不挂是 `progress:<repo>`，`after` 带 text / source / idempotencyKey；同仓同 `idempotencyKey` 靠唯一索引 `audit_log_ledger_note_key_idx` 只留一行，重放回原来那行、`created:false`；不碰 GitHub，不需要 `intakeIssues` 端口。查重强命中线 `STRONG_THRESHOLD` 在 conventions 的 `issue-similar.ts`；同一个 `idempotencyKey` 重放不被自己拦成重复靠正文来源行里的「单键」。
- 两个 App 装没装的判法只有一份：`repo-import-routes.ts` 的 `mergedInstallations`（一边失败整次失败），驾驶舱与 `fleet-api project installations` 都调它；没读全、身份对不上退出 1，不当成没装。
- 读不到就如实报红：GitHub 机器人凭据、Temporal 连不上都不能当成没事，健康检查照实报。
- CI 策略的唯一权威是 repos 行，不能把 mode 写进 caller/source；publisher 必须在 intake 的 await accept 内（wake=false 也执行），失败沿投递账重放。
- 通知回答先存代次，再原子 claim，最后按答案和 claim CAS 结算；在途或结果未知返回 409，不自动重放；带 `requestId` 必须同时带 `expectedAnswerId`（首答 null），拒绝跨新答案的迟到重试。
- 看门狗提醒的受控修复（`src/alert-repair.ts`）：动作读时现算，不存；点的时候只收服务端动作编号 + incident + `requestId`，条件变了、已撤、incident 对不上、过期、上一次在途或未知一律 409 不发副作用；`accepted` 与 `verified`（要重读原条件）分开，读不到保持未修好；同一 incident 在执行、未知、待核验时其它动作也被挡；不替看门狗撤原通知；开修复单固定调 `engine/src/bin/dispatch-issue.ts`，不拼 shell。
- 看门狗改了提醒键、标题、撤卡口径，`alert-repair.ts` 的 `IDLE_PREFIX`、`RELEASE_KEY` 要一起改；其测试跑引擎真看门狗，所以 api 的 `devDependencies` 有 engine（只有测试用，`src` 不许引 engine；`tsconfig.json` include 带 `../engine/src`）。
- 关联已有单（`POST /api/notifications/:id/repair/link`）：只收受管仓 + 单号 + 关联版本 + incident + `requestId`，多一个字段 400；服务端现读必须是开着的 issue，读不到、错仓、已关闭一律拒绝，不回退成开单。线上契约不加枚举，关联存成设置表内部记录，通知卡按旧枚举取 `PHASE_META[state]`，新枚举会让它崩溃（`alert-repair.test.ts` 有照抄旧消费者的检查）。
- 私有 ops 写入（`task correct-merged`、`checkout-history --archive`、`quote put`）：不挂普通 HTTP，没经 `bin/fleet-api`（无 `FLEET_OPS_OPERATOR`）不许执行；验收责任的管理命令已删（#3630），旧开着的行只由 `fleet-api acceptance-handback-once` 转给引擎包一次性交回；`correct-merged` 默认只读预检，执行带预检打印的 `--execute --task --seen`，或带 `--workflow` 回 JSON 回执、同一命令末尾加 `--apply`（自己重读事实并事务 CAS，不用 `--task`/`--seen`）；错误不回显 payload 或数据库明细。
- 历史/检出归档证据只认服务端鲜读的完整有界 Temporal 历史（`acceptance-execution-reader.ts`、`checkout-execution-reader.ts`），不追 latest，不接上传 history/proof，不用旧 runs 的 NULL 列或会话号授权；`conclusion` 只许 `historical_unproven`，不能当正常队列账或创始人批准。

## 测试

- `npx vitest run packages/api/test/<文件>`；整包交给 CI。默认内存 Store，不要 Postgres。驾驶舱 e2e 在 `packages/web/e2e/`（备库脚本 `packages/api/test/e2e/prepare.ts`，跑法见该目录 README）。
- 字符数上限：`packages/conventions/test/agents-md-size.test.ts`（8,000）。

## 改它时要连带改

- 加改接口：先改 `packages/shared/src/web-api.ts`，再改这里的路由、`packages/web/src/api/http.ts`、web 的 mock（`packages/web/src/api/mock/server.ts`，它 `implements FleetApi`）。
- 测试会读 web 的文件（`ci-plan.ts` 的 `TEST_READS`）：改 web 也可能让这里的测试红。
- 改了行为（发信号、权限、读写哪张表）：同步 `docs/design.md` 第十五节「驾驶舱」；改了部署相关环境变量、端口：同步 `docs/ops.md`。
