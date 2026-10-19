# packages/db：表结构、迁移、查询

Postgres 的表结构（Drizzle）、迁移和查询函数，以及路由骨架、额度留量线的默认值和本机测试库的起停。为什么用 Postgres 见 design 第四节「为什么用 Postgres」。

## 入口

- `packages/db/src/schema/`：全部表和枚举；`packages/db/src/queries/`：查询函数；`packages/db/src/index.ts`：对外导出。
- `packages/db/migrations/`：迁移，drizzle-kit 生成的和手写的（触发器等，如 `0001_triggers.sql`）放在一起，按编号走。
- `packages/db/drizzle.config.ts`：只用来生成迁移，不连库。
- 命令（`pnpm --filter @fleet-dao/db <命令>`）：`db:generate`（生成迁移并格式化）、`db:migrate`、`db:seed`、`db:catalog`、`db:routing`，入口都在 `packages/db/src/bin/`。
- `packages/db/src/bin/local-pg.ts`：仓根 `pnpm start` / `pnpm stop` / `pnpm pg:local` 都指向它，起停本机嵌入式 Postgres（默认端口 55432，判法在 `src/local-pg.ts`）。
- `src/queries/task-process.ts`：任务概览按请求的 runIds 单次批量读轻量统计列，不读 text 或整份 meta；调用/结果的接受和去重由 shared 的同一解析器供概览与步骤使用。无调用号命令仍未知；孤立失败和编辑事实保留在结果出现的步骤，不造调用号或文件路径。没有记录和读不到分开，不拿 0 代替。
- `packages/db/routing.default.json`、`packages/db/quota-reserve.default.json`：路由骨架和额度留量线的默认值，只在新装机时写初始值。

## 测试

- `npx vitest run packages/db/test/<文件>`。默认每个测试文件一份 PGlite（内存 Postgres，跑真迁移），不要起库；占内存大。
- 设了 `FLEET_TEST_PG_URL` 才连真库（CI 的 pg 台起 `postgres:16`）；连不上、迁移没跑成当场报错，不退回 PGlite。`test/real-pg.test.ts` 只在设了它时跑。
- 驾驶舱 e2e 用的是另一个变量 `E2E_PG_ADMIN_URL`，见 `packages/web/e2e/README.md`。

## 常见坑

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
- `readCorrectMergedLedger` / `casCorrectMergedTask`：误记 abandoned 且真实已合的任务。读任务、会话、指定 PR 的镜像和成功的 `task.correct-merged` 回执；CAS 在同一事务里锁任务行，仍是引擎的 stopped/abandoned、更新时间没变、没有没结的起代意图（`beginTaskStart` 落的 `task.start-intent` 比 `settleTaskStart` 落的 `task.start-settled.upTo` 新）、没有开着的会话、会话账仍对得上，才改成 done/merged 并写操作记录。事务里不等网络。同一工作流下只要还有另一条不同的非空 PR，就不算对得上，不能靠其中一条匹配记录放行；旧行 temporal run 为空的混合 PR 写成归属歧义，不把这些行当成同一次执行的证据。事务里才看到的冲突会话回 stale，不写。不改 runs、pull_requests、acceptance_duties。审计写不进整笔回滚。会话数读不成就抛错，不当成零。
