# packages/db：表结构、迁移、查询

Postgres 的表结构（Drizzle）、迁移和查询函数，以及路由骨架、额度留量线的默认值和本机测试库的起停。为什么用 Postgres 见 design 第四节「为什么用 Postgres」。

## 入口

- `packages/db/src/schema/`：全部表和枚举；`packages/db/src/queries/`：查询函数；`packages/db/src/index.ts`：对外导出。
- `acceptance_duties` 只读（决定 0113）：`queries/acceptance-duties.ts` 只剩读口和一次性交回 `handBackAcceptanceDuty`（只写 `settled_*`，按 id + 代次 + 未结清条件更新，已交回回 `already`）。验收候选索引和管理归并已删（#3630）；表、`acceptance_candidate_groups` 和迁移里的触发器照留。
- `src/queries/admission-alerts.ts`：独立准入未知事件的专用 insert-once/read-back，复用 notifications，不新增表；全局 identity 与首码分离，不更新原通知的时间、处理状态或交付记录，不用会重开通知的 `upsertAlert`。调用宿主仍须核外层 COMMIT/close，函数返回本身不是渠道送达证明。
- `src/schema/task-execution.ts`：未接生产的持久执行资格、原子出生与 legacy 责任表；控制行缺失就是未受管，不回填、不自动初始化。当前指针组合外键绑定任务、操作、epoch和revision，出生组合外键绑定control/task/epoch；birthRequest全局唯一，legacy的namespace/runId唯一且不按任务限制责任行数。完整 canonical 仅进私有库，不进实时推送或审计正文。历史操作和epoch都不是受管覆盖证明；真实竞争夹具只在 `@fleet-dao/db/testing` 创建随机克隆库和独立连接。新增复合unique被后续新表FK引用时，分两次正规生成迁移，保证unique先落库，再建引用表。
- `packages/db/migrations/`：迁移，drizzle-kit 生成的和手写的（触发器等，如 `0001_triggers.sql`）放在一起，按编号走。
- `packages/db/drizzle.config.ts`：只用来生成迁移，不连库。
- `@fleet-dao/db/migration-budget`：发布版固定子进程只核 PG7 snapshot JSON 与独立生成 SQL 的字节一致性，不加载候选 schema/config；完整已知形状、journal链和重复键先核，未知或超时明确失败。TS 与快照的漂移仍由 `schema-drift.test.ts` 核验。
- 命令（`pnpm --filter @fleet-dao/db <命令>`）：`db:generate`（生成迁移并格式化）、`db:migrate`、`db:seed`、`db:catalog`、`db:routing`，入口都在 `packages/db/src/bin/`。
- `packages/db/src/bin/local-pg.ts`：仓根 `pnpm start` / `pnpm stop` / `pnpm pg:local` 都指向它，起停本机嵌入式 Postgres（默认端口 55432，判法在 `src/local-pg.ts`）。
- `src/queries/task-process.ts`：任务概览按请求的 runIds 单次批量读轻量统计列，不读 text 或整份 meta；调用/结果的接受和去重由 shared 的同一解析器供概览与步骤使用。无调用号命令仍未知；孤立失败和编辑事实保留在结果出现的步骤，不造调用号或文件路径。没有记录和读不到分开，不拿 0 代替。
- `packages/db/routing.default.json`、`packages/db/quota-reserve.default.json`：路由骨架和额度留量线的默认值，只在新装机时写初始值。

## 测试

- `npx vitest run packages/db/test/<文件>`。默认每个测试文件一份 PGlite（内存 Postgres，跑真迁移），不要起库；占内存大。
- 设了 `FLEET_TEST_PG_URL` 才连真库（CI 的 pg 台起 `postgres:16`）；连不上、迁移没跑成当场报错，不退回 PGlite。`test/real-pg.test.ts` 只在设了它时跑。
- `TestClient.query` 的 raw JSON/JSONB 参数：字符串按已序列化 JSON 文本传给数据库验证，对象/数组仍可直接传；JSON 字符串值须先 `JSON.stringify`。仅测试 raw PG 池覆盖 JSON 编码，不更改日期和其它类型的原合同。
- 驾驶舱 e2e 用的是另一个变量 `E2E_PG_ADMIN_URL`，见 `packages/web/e2e/README.md`。

## 常见坑

- `startRun` 同编号更新原子保留首次 workflowId/temporalRunId（含 NULL、部分未知），明确的不同来源整行拒绝；不补历史。带池的 `admitRun` 复用此写口，来源冲突须回滚预占交接。真实两连接竞争在 `test/real-pg.test.ts` 的现有 PG 台验证。

- `claimIdempotencyKey` 遇到成功INSERT冲突后成功SELECT为空，会完整重做占键/读回，最多四次；持续竞争抛可重试的 `IdempotencyClaimContentionError`，不冒充已占键。数据库异常直接抛出，不延长TTL、不持连接跨外部操作；更强隔离事务的序列化失败由调用方重试整个事务。

- 改了 `src/schema` 没生成迁移：`packages/db/test/schema-drift.test.ts` 当场红。
- 迁移只进不退：发布时先迁移再切版本，退回上一版不撤迁移。新迁移要写成旧代码照样能跑（先加列、下一版再删旧的）。见 ops 第八节「改之前要知道的」。
- 公开仓：种子（`src/seed.ts`）不放账号、池、路由、额度。种子只补缺，已有的行不跟着改值。
- 并行几条库查询用 `src/queries/all-settled.ts` 的 `allSettledOrThrow`，不用 `Promise.all` / `race` / `any`：一条失败就返回，其余查询还占着连接和锁，真库会死锁（#2181）。`test/static.test.ts` 扫 `src/` 拦着。
- 实时推送靠触发器 `NOTIFY fleet_changes`：表名单在 `packages/shared/src/realtime.ts`，只增不改，`packages/db/test/notify.test.ts` 逐表核对。

## 改它时要连带改

- 改表结构：改 `src/schema/` → `pnpm --filter @fleet-dao/db db:generate` → 新的 `.sql` 和 `migrations/meta` 一起提交。
- 新表要实时推送：加进 `REALTIME_TABLES`，迁移里建触发器。
- 用到新列、新表的读写：`packages/store` 两套实现（见 `packages/store/AGENTS.md`）和 engine 的查询一起改。
- 改了库、用户、备份相关的部署：同步 ops 第三节「用户、目录、库」、第十一节「备份与恢复」。

- `settleQueuedDecision` 仅结算精确 `answerId`、`claimId`、`answeredAt` 且仍 queued 的答案。历史无代次不授权；失败/未知不能 resolve，不能靠同毫秒时间相等认定同一次回答。

- `private_quotes` 存创始人原话，仅私有管理链访问，不入 realtime 表名单。同 id 异文必须拒绝并回滚整批，不能 upsert 覆盖原话；receivedAt 只在首次入库生成。
- PR 文件账经 `recordPrHeadFiles` 同事务写 `pr_head_snapshots` 和文件，成功零文件也有快照。读取用 `readPrHeadFiles` 传完整头；只有精确头 `complete` 才是完整清单，旧行无 metadata 不推定完整，失败不覆盖成功。
- `verify_aggregates` 独立存组合结论，来源 run 必须属于同任务/工作流/PR 且已有原始 verdict；已有来源不能跨头或跨验收轮复用。首次精确头由真实验收装配绑定，runs 自身没有 head 列，库不能独立证明首次头身份。

- `recordCheckoutReceipt` 复用 audit_log：每次物理完整检出独立 receiptId，target 为 checkout:<receiptId>，同 ID 同内容幂等、异内容拒绝；事务锁串行查重。无回执的旧历史保持未知，不回填、不以已撤报警冒充成功证据。

