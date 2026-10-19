# packages/store：Store 契约和两套实现

后端（`packages/api`）和引擎（`packages/engine`）共用、不碰 HTTP 的那一层：Store 接口和两套实现（内存、Postgres）、GitHub 作者白名单、日志接口。依赖方向只许 api → store、engine → store，store 不依赖它们（`packages/conventions/test/package-layers.test.ts` 钉住）。

## 入口

- `packages/store/src/ports.ts`：Store 接口，语义写在这里。只给后端用的接口（Temporal 信号、飞书登录、健康检查）在 `packages/api/src/ports.ts`。
- `packages/store/src/memory-store.ts`：内存版，也是语义的参照实现；测试和本地开发用它，`onChange` 模拟库的 `NOTIFY fleet_changes`。
- `packages/store/src/pg-store.ts`：Postgres 版，用 `@fleet-dao/db`。
- `packages/store/src/*-logic.ts`（`task-logic.ts`、`credentials-logic.ts` 等）：两套实现共用的判断，两边都调它。
- `packages/store/src/testing.ts`：测试用的种库（`seedPg`）。

## 测试

- `npx vitest run packages/store/test/<文件>`。
- 契约测试 `packages/store/test/store-contract.ts`：内存版（`store.memory.test.ts`）和 Postgres 版（`store.pg.test.ts`）过同一套；另有几套分主题的契约（credentials、nodes、task-list）。
- Postgres 版默认跑在 PGlite 上（真迁移，不要起库）；设了 `FLEET_TEST_PG_URL` 才连真库（CI 的 pg 台）。见 `packages/db/src/testing.ts`。

## 常见坑

- GitHub 幂等账 `peek` 必须返回表里真实的 `action`、`target` 和回执；内存版也保存同一来源，不能从键推算。冲突占用、接管、完成不改原 action/target，补账不能被升级为真实队列操作。

- 改语义必须两套实现一起改、契约测试跟着改；只改一边，内存版测试绿、生产红。
- 内存版要照库的约束来（比较后再改、和操作记录同一「事务」、`ok=false` 的操作记录必须带原因……），否则契约测试过了、生产照样会撞。
- 翻页游标是 `时刻|编号`，库里的时刻比毫秒精细，比较时截到毫秒。
- 时间：Store 自己写的时间用传入的时钟，库自己记的用库的钟；不要在实现里直接 `new Date()`。
- 按编号查时，不是 uuid 的编号当「没有」，不抛库错。改数据和写操作记录在同一个事务里。

## 改它时要连带改

`resolveNotification` 的可选 `expected` 用于历史审计处置：事务内核对原通知键、正文和链接，已处理时只有同一份审计可以幂等返回，否则 `conflict`。普通处理入口不带它，保留现有行为。

- 改接口：`ports.ts` → `memory-store.ts` + `pg-store.ts` → 契约测试；调用方在 api 和 engine。
- `readCorrectMergedLedger` / `casCorrectMerged`：误记 abandoned 的已合任务。读任务行、会话、请求的 PR 镜像和既有纠正回执；CAS 只在仍是引擎的 stopped/abandoned、更新时间没变、没有开着的会话、会话账仍钉着这次交付时，把任务行改成 done/merged，并在同一事务写操作记录。同一工作流另有不同非空 PR 的会话算没钉住，回 stale；二次核对之后事务里才读到的冲突会话同样不写。不改 runs、PR 镜像、验收责任。可传 verify：任务行加锁后、写入前、写入后各核一次，回假就 stale 整笔回滚。受管起代（重做）与纠正都在 `withTaskFence(taskId, fn)` 里进行：pg 用 pgLocker 的库内租约（跨进程、不占连接），内存版进程内排队；纠正的第二次读取与写入在栅栏里，重做在栅栏里重读状态后才起代。内存版的 phase / 更新时间在 `taskClosures`，合并提交在 `pullMerges`，不塞进驾驶舱读出去的任务和 PR。
- 要新表或新列：先在 `packages/db` 改表结构并生成迁移（见 `packages/db/AGENTS.md`），再改这里。
- 要驾驶舱实时看到的新表：登记 `packages/shared/src/realtime.ts` 的 `REALTIME_TABLES`，触发器在 db 的迁移里。

- 通知答案先存不可变 `answer.id`，执行前 `claimDecision` 接活，结算携 `answerId` 和 `claimId`。executing/unknown 不超时接管、不覆盖，现场核验前保留待核；确定失败才能同代次重试。历史无代次只能读，不能自动接活。
- 看门狗提醒的受控修复状态（#3033）不加表、不改 Store 接口：存在设置表 `alert.repair:<提醒编号>`，靠 `putSetting` 的 `expectedVersion` 做 CAS（先写 executing 再动手）；`listSettings` 里这类键不在 `SETTING_SCHEMAS`，设置页不显示。读写在 `packages/api/src/alert-repair.ts`。

- 修复核验结算用 `putSetting.expectedNotification` 在同一事务锁住原通知 `raisedAt` 并核对；代次和设置版本任一不符都返回 conflict，不写值、不记成功审计。不能用 updatedAt 代替 raisedAt（开放期间重复报警会更新前者）。
