# packages/engine：引擎

Temporal 工作流、活动与 worker，跑在法国：每张单一条任务工作流，执行每一步（起会话、跑测试、开 PR、合并、记账）；派工选路、定时任务也在这里。为什么这样分见 design 第四节「架构」、第五节、第九节。旧系统的审计（不是这个包）在 `docs/archive/old-engine-audit.md`。

## 入口

- `packages/engine/src/main.ts`：进程入口（`pnpm --filter @fleet-dao/engine start`），必须设 `FLEET_ENGINE_PORTS`（`real` / `fake`），其余环境变量见文件头注释。
- `packages/engine/src/worker.ts`：起 worker；`packages/engine/src/workflows/index.ts` 是工作流打包入口（只导出 `helloWorkflow`、`taskWorkflow`）。
- `packages/engine/src/workflows/task.ts`：任务工作流，按职责拆在同目录 `task-*.ts`，共用零件在 `kit.ts`。
- `packages/engine/src/activities.ts`、`packages/engine/src/real/`：活动和真端口的装配（库、GitHub、会话、工作树），缺一项就不起。
- `packages/engine/src/decisions/`：判断（纯函数）；`packages/engine/src/routing/`：选路；`packages/engine/src/jobs/`：引擎进程里的定时器（不是 Temporal 工作流，登记表在 `real/jobs.ts`）。

## 测试

- `npx vitest run packages/engine/test/<文件>`。不要 Postgres（用到库的跑在 PGlite 上）。
- Temporal 测试用 `@temporalio/testing` 的时间跳跃环境（`packages/engine/test/support.ts`）；要真服务端时设 `FLEET_TEST_TEMPORAL_CLI`。
- 重放：`packages/engine/test/replay.test.ts` 拿 `test/replay/fixtures/task-*.json` 对现在的代码重放。录新场景用 `node packages/engine/test/replay/record.ts <场景>`，已有的夹具拒绝覆盖。

## 常见坑

- **改工作流步序必须用 `patched('<新标记>')` 包住**：在途任务（包括停着等人、等合并的）换上新代码会重放对不上，报 `TMPRL1100` 变僵尸。重放测试红了不许重录夹具让它变绿。
- 工作流里要确定：不取随机数、不生成编号（主键经 `decide('newIds')` 进历史），不碰活动实现、worker、客户端、Node 模块；判断只经本地活动 `decide`，工作流文件对 `decisions` 只许 `import type`。`packages/engine/test/structure.test.ts` 把这些写成了检查。
- 活动的超时、心跳、重试只在 `packages/engine/src/activity-options.ts` 设，调用处不许另写；长活动要心跳。
- 工作流对外的输入（`packages/engine/src/contract.ts`）加字段只许可选，不然在途任务的输入对不上。
- 引擎自己挑单，进队条件见 design 第九节。要它接：单的四节齐、范围写死、验收条写成 diff 里看得见的、不贴「本机做」「待补」「要人拍」。引擎不直写主线，它的单它自己关。

## 失败分流

- 规则表在 `src/failure/rules.ts`，现在 44 条。处置只看五种 kind（resume、wait、retry、rework、stop，怎么办在 `src/failure/classify.ts` 的表里）；规则只负责认。三轮先后不改：强码、已知原文、状态码 / 退出码 / 信号 / 症状码。
- kind、`routeOutcome`、`hold` 和重试、等待那些数都一样：写成这一条的 `texts`，命中仍报原来的编号。强码、状态码、症状码留在各自认法上，不并进规则自己的 `codes`。上面几样有一样不同，就另写一条，不要并。
- 改认法先在 `test/failure/fixtures/failure-samples.json` 加样本，期望分类照已经定下来的写，再改规则。`npx vitest run packages/engine/test/failure/samples.test.ts`。

## 改它时要连带改

- 改工作流：加 `patched()` + 必要时录一个新重放场景；改了步序、停在哪等人，同步 design 第五节对应条。
- 改活动超时：只改 `activity-options.ts`。改定时任务：`src/jobs/` 加任务，`real/jobs.ts` 的 `ENGINE_JOBS` 登记。
- 改读写的表：表结构在 `packages/db`（生成迁移），共用的读写在 `packages/store`（两套实现一起改）。
- 改派工、选路：同步 design 第九节「自由组合的派工模型」。
- 改了法国上的单元、环境变量：同步 ops 第五节「AI 会话」或第九节「发布应用（deploy/release.sh）」。
