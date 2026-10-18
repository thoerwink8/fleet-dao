# packages/engine：引擎

Temporal 工作流、活动与 worker，跑在法国：每张单一条任务工作流，执行每一步（起会话、跑测试、开 PR、合并、记账）；派工选路、定时任务也在这里。为什么这样分见 design 第四节「架构」、第五节、第九节。旧系统的审计（不是这个包）在 `docs/archive/old-engine-audit.md`。

## 入口

- `packages/engine/src/main.ts`：进程入口（`pnpm --filter @fleet-dao/engine start`），必须设 `FLEET_ENGINE_PORTS`（`real` / `fake`），其余环境变量见文件头注释。
- `packages/engine/src/worker.ts`：起 worker；`packages/engine/src/workflows/index.ts` 是工作流打包入口（只导出 `helloWorkflow`、`taskWorkflow`）。
- `packages/engine/src/workflows/task.ts`：任务工作流，按职责拆在同目录 `task-*.ts`，共用零件在 `kit.ts`。
- `packages/engine/src/activities.ts`、`packages/engine/src/real/`：活动和真端口的装配（库、GitHub、会话、工作树），缺一项就不起。
- `packages/engine/src/real/self-check.ts`：以工作树主人身份跑测试和 tsc；各段预算统一从 `packages/engine/src/self-check-budget.ts` 取，活动总限时只由这些预算相加。
- `packages/engine/src/decisions/`：判断（纯函数）；`packages/engine/src/routing/`：选路；`packages/engine/src/jobs/`：引擎进程里的定时器（不是 Temporal 工作流，登记表在 `real/jobs.ts`）。

## 测试

- `npx vitest run packages/engine/test/<文件>`。不要 Postgres（用到库的跑在 PGlite 上）。
- Temporal 测试用 `@temporalio/testing` 的时间跳跃环境（`packages/engine/test/support.ts`）；要真服务端时设 `FLEET_TEST_TEMPORAL_CLI`。
- 重放：`packages/engine/test/replay.test.ts` 拿 `test/replay/fixtures/task-*.json` 对现在的代码重放。录新场景用 `node packages/engine/test/replay/record.ts <场景>`，已有的夹具拒绝覆盖。

## 常见坑

- 正式评审先按原白名单选尚未解决的要求改，再翻全该 review 的行内原文，核仓/PR/review 与原审查者数字身份。总述与行内编辑都进消费键，新完整原文按code point安全分段、带引用尾界保住末空白，旧历史缺行内字段时保留原键和反馈。读不全明确未送达，合前已挂的 autoMerge 尝试撤掉，撤失败一并报明；三个合并入口及waitCi确认已合后共用review-audit补读留账，补读失败记未读，写账失败抛重试。

- 合并对账撤风险只认真实 `github.merge_pr`：账的 action/target、完整回执与 GitHub 当前 PR/head/合并提交/实际引擎合并人都须一致；`github.merge_pr_backfill` 留原来源，后续轮次也不能当队列证据。读账失败保留提醒并报没查成。
- 已合并观察补账经 `bookMergedPull` 固定传 `mergePr.onlyBook`：writer 在实际重读后、写账前核 PR 编号、已合并、头、完整合并提交和合并人；未合或回执读不全明确失败，不能退到主动合并。主动合并入口不传此约束。

- 收树图片核对同时清点本地引用可达与不可达的无父图片提交；本地分支、标签、其他引用都不代表远端交付。Git 探测只有明确报告不在仓内才算无仓，坏配置、权限、超时不能当空；清点和清单回读用同一套目录名、图片名边界。树已收后的重试，归档清单必须身份一致，图片实物的大小、hash、blob 号和文件头全部核过才回 archived；缺失、损坏或链接回 unknown，不能只信清单。
- **改工作流步序必须用 `patched('<新标记>')` 包住**：在途任务（包括停着等人、等合并的）换上新代码会重放对不上，报 `TMPRL1100` 变僵尸。重放测试红了不许重录夹具让它变绿。
- 工作流里要确定：不取随机数、不生成编号（主键经 `decide('newIds')` 进历史），不碰活动实现、worker、客户端、Node 模块；判断只经本地活动 `decide`，工作流文件对 `decisions` 只许 `import type`。`packages/engine/test/structure.test.ts` 把这些写成了检查。
- 活动的超时、心跳、重试只在 `packages/engine/src/activity-options.ts` 设，调用处不许另写；长活动要心跳。
- 会话工作树是会话用户的700私有目录；归属核验中的物理路径解析也必须经 `UserExec`，不能在引擎进程直接 `realpath` 会话树里的 `.git`。路径词法归一不读磁盘，路径读取失败继续明确报错。
- 自测容量只有一层归属：`test:changed` 和普通本机测试共用 conventions 的测试槽，引擎不再占自测名额，也不设环境变量冒充持槽；自测名额只管 tsc 和其他测试命令。所有等槽、等锁合用 20 分钟排队预算，拿到容量后才算 30 分钟测试执行预算，tsc 另有 5 分钟，杀进程、放锁都有收尾上限。
- 自测心跳带 probe / queue / test / tsc / done、阶段起点、最后输出时刻；看门狗在活动总限时内把自测无会话视为正常。超时、取消、异常退出保留已有输出并脱敏限长；已确认测试失败或真实 tsc 诊断仍为 fail/red，不能被中断或顶层兜底抹成跳过。无失败证据的普通超时交给 CI；测试未完成而 tsc 通过时，摘要必须写明测试没有结果。
- 工作流对外的输入（`packages/engine/src/contract.ts`）加字段只许可选，不然在途任务的输入对不上。
- 自动关单收尾只走 `taskCloseClosedIssue` Update：同步核精确 run、当前停法代数和继续代数，只有 `accepted` 回执才能记成功、撤提醒。继续信号先使凭据失效，不能等公开 phase 改好。旧 worker 缺能力、Update RPC 超时或回执未知保留未核实，不能退回人类的无条件放弃信号。
- 新 PR 创建前从需求单现读两轴（正文无需求号时认任务分支）；缺失、冲突或未知值拒开并明报，不猜分类。groom 新单显式提供 domain/nature，拆分单可逐轴继承来源单的唯一有效值，写前仍须齐全。驾驶舱会话在 modules 中独立声明两轴，后端开单前同样校验，正文移到独立查询分类节，不计入模块范围和派工规模。查询轴不参与派工、合并与版本判定；此处只保证创建的元数据齐全。报警立案贴 engine/bug，耗时表直开 PR 贴 engine/process，隔离集直开 PR 贴 engine/bug；直开 PR 贴后回读，失败不能当成功。
- 引擎自己挑单，进队条件见 design 第九节。要它接：单的四节齐、范围写死、验收条写成 diff 里看得见的、不贴「本机做」「待补」「要人拍」。引擎不直写主线，它的单它自己关。

## 改它时要连带改

- 改工作流：加 `patched()` + 必要时录一个新重放场景；改了步序、停在哪等人，同步 design 第五节对应条。
- 改活动超时：只改 `activity-options.ts`。改定时任务：`src/jobs/` 加任务，`real/jobs.ts` 的 `ENGINE_JOBS` 登记。
- 改读写的表：表结构在 `packages/db`（生成迁移），共用的读写在 `packages/store`（两套实现一起改）。
- 改派工、选路：同步 design 第九节「自由组合的派工模型」。
- 改了法国上的单元、环境变量：同步 ops 第五节「AI 会话」或第九节「发布应用（deploy/release.sh）」。

## 固定版本宿主工具

- Go 的 `via: tar` 和固定 `version` 由现有 `cli-upgrade-main.ts` 管理，只在发布/空闲排空窗口运行；实现位于 `cli-upgrade-go.ts`。仅 Linux amd64/arm64，官方精确版本清单与 SHA256 校验，完整新树暂存、实际 `go version` 验真，最后原子替换 `/usr/local/bin/go`。
- 必须核对 intake 固定 PATH 的实际入口和版本；`/usr/local/go/bin/go` 遮住受管入口时明确失败，保留现有安装，不放宽 readiness。旧树和入口备份保留，失败不记健康、不自动重试。

- 删树前置：`real/preserve-worktree.ts` 由任务收尾、建树前替换旧树与小时清扫共用。干净未发布提交先保存完整 bundle，最终落盘回读并在独立空仓恢复核对 HEAD/内容树/引用；复杂未提交、未跟踪、stash、非 Git 成果或读写核验失败留原树，不能靠 diff HEAD 假称已保全。受管截图仍走 `real/shots.ts`，只排除逐文件核对内容一致的已保全图片。
