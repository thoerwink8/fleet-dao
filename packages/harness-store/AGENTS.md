# packages/harness-store：新内核的存储

决定 0124 的新内核（母单 #3770）存储层：同一个 Postgres 实例里独立的 schema `fleet2`，事件表加投影加命令回执加 outbox。方案和验收用例见 #3770 的讨论稿（「总设计」和旧坑表的「挑错补的」那几类）。

## 不变量

- 不依赖旧包、不建跨 schema 外键、不写旧表；要读旧库（比如 `tasks.fencing`）由调用方把读函数传进来。
- 事件只追加：`(stream_id, seq)` 唯一，追加带调用方读到的位置，对不上抛 `StreamConflictError`，不覆盖。
- 投影可以删了从事件重建（`resetStreamHeads` 加 `advanceStreamHeads`），改投影和检查点在同一个事务里。
- 对外副作用只经 outbox，至少一次投递：领取用 `FOR UPDATE SKIP LOCKED` 加租约和领取令牌，收尾要令牌对得上（`LostClaimError`）；结果不知道记 `unknown`、到点领出来先查证，不盲重试；令牌（所有权）对不上进 `dead`；重试到上限进 `dead`。
- 读都有页上限 `PAGE_MAX`，按游标往后读，读的行数和页大小成正比。
- 时刻按数据库 `now()` 判，不用应用时钟。
- 调度器（`src/scheduler.ts`，#3774，不用 Temporal）：一行 `jobs` 一件到点要做的事，`key` 唯一即幂等。领取同 outbox（SKIP LOCKED、租约、令牌），续租靠 `heartbeat`，回 `lost` 或 `cancelled` 的要立刻停手。没在 `queue_limits` 登记的队列不让领（`NoQueueLimitError`）：停机后积压一起到期，靠它的同时在领上限和每分钟上限限住追赶速度。子活截止不晚于父活，过截止不领、进 `dead`；取消顺着 `parent_key` 一路传下去。领的次数到 `max_attempts` 还没做完（毒活）进 `dead`。故障矩阵里库断线、只读、重启这几类在 CI 的 pg 台和法国真机测，不在 PGlite。

## 迁移和测试

- 改 `src/schema.ts` 后 `pnpm --filter @fleet-dao/harness-store db:generate`，迁移在 `migrations/`，记账表 `fleet2.__migrations`（不和旧库的混）。第一份迁移的 `CREATE SCHEMA` 手改成了 `IF NOT EXISTS`（迁移器先建记账表）。
- `npx vitest run packages/harness-store`：每个测试文件一份 PGlite 跑真迁移，见 `src/testing.ts`。
- 生产部署（独立库用户只授 `fleet2`、发布时跑迁移）在第 3 片接上，见 #3775。
