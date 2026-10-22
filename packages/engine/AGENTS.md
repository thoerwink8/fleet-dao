# packages/engine：引擎

Temporal 工作流、活动与 worker，跑在法国：每张单一条任务工作流，执行每一步（起会话、跑测试、开 PR、合并、记账）；派工选路、定时任务也在这里。为什么这样分见 design 第四节「架构」、第五节、第九节。各模块的细节约束在该文件头注释（「改这里之前必须知道」），这里只留跨文件的不变量。

## 去哪找

| 要找 | 位置 |
|---|---|
| 进程入口（必须设 `FLEET_ENGINE_PORTS=real\|fake`，其余环境变量见文件头） | `src/main.ts`、`src/worker.ts` |
| 工作流 | `src/workflows/task.ts`（按职责拆成同目录 `task-*.ts`，共用零件 `kit.ts`）；打包入口 `workflows/index.ts` 只导出 `helloWorkflow`、`taskWorkflow` |
| 活动与真端口装配（缺一项不起） | `src/activities.ts`、`src/real/` |
| 判断（纯函数）/ 选路 | `src/decisions/`、`src/routing/` |
| 定时任务（引擎进程里的定时器，不是工作流） | `src/jobs/`，登记在 `real/jobs.ts` 的 `ENGINE_JOBS` |
| 自测 | `src/real/self-check.ts`，预算只在 `self-check-budget.ts` |
| 未接生产的承接能力 | `real/execution-start-reader.ts`、`execution-legacy-admission.ts`、`legacy-admission-process.ts`、`admission-alert-*.ts`（细节 `docs/design/admission-alert-spool.md`） |
| 旧引擎审计 | `docs/archive/old-engine-audit.md` |

## 工作流不能变僵尸

- 改工作流步序必须用 `patched('<新标记>')` 包住：在途任务（含停着等人、等合并的）换新代码重放对不上会报 `TMPRL1100` 变僵尸。重放测试红了不许重录夹具变绿。
- 比较「之前的值」这类参数不给默认值：显式传 `undefined` 会被默认参数换成当前值，把「第一次」判成「没变」（#3402，夹具 `task-contract-first-accept` 钉着）。
- 工作流要确定：不取随机数、不生成编号（主键走 `decide('newIds')`），不碰活动实现、worker、客户端、Node 模块；判断只经本地活动 `decide`，对 `decisions` 只许 `import type`（`test/structure.test.ts` 检查）。
- 活动超时、心跳、重试只在 `activity-options.ts` 设；长活动要心跳。工作流对外输入（`contract.ts`）只许加可选字段。
- 记账类可选字段（`cause`、`causeSummary`、`roundSeq`、`resumeReason`、`prNumber`、`numstat`、`numstatSnapshot`）只在对应 `patched('run-cause-fields')`、`patched('pr-head-files')` 为真时给，只记账不改步序；新起因先改 shared 的 `RUN_CAUSES`（`packages/db/test/run-cause.test.ts` 核对）。老历史只有数组没有总数是明确未知，不升级成完整清单。
- 改了步序或停点，同步 design 第五节对应条；录新场景用 `node packages/engine/test/replay/record.ts <场景>`，已有夹具拒绝覆盖。

## 三态：未知就报，不当成没事

- 读不到、读不全、身份对不上一律明确失败或记 unknown/「没查成」，不拿空、0、「没有」、「已合」冒充；写账失败记任务日志、证据保持未知，不改已跑出的裁决，也不因此再起模型重验。
- 已合 PR 只按同仓精确 PR/head/真实 mergeCommit 经 `readMergedTask` + `onlyBook` 结清；已合观察补账（`bookMergedPull`）固定传 `mergePr.onlyBook`，未合或回执读不全明确失败，不退到主动合并。未结验收责任保留 OPEN，不用 closed-issue/abandon 冒充已合。
- 自动关单只走 `taskCloseClosedIssue` Update：同步核精确 run、停法代数、继续代数，只有 `accepted` 回执才记成功、撤提醒；旧 worker 缺能力、RPC 超时、回执未知保留未核实，不退回无条件放弃信号。parked/paused 的已合结清走 `taskSettleMerged`，数据库活动会话须为零。
- 合并对账撤风险只认真实 `github.merge_pr`（action/target/完整回执/当前 PR、head、合并提交、合并人都一致）；`github.merge_pr_backfill` 不当队列证据。
- 正式评审：读不全明确未送达；CI 红返工入口走 `readCiReviews`（`patched('ci-red-review-context')`），读失败不当成没有评审。
- 主线同步每段最多 `MAX_MAIN_SYNCS` 次；预算耗尽停下后，只有收到停下之后的新「继续」才续下一段，运行中或重复的「继续」不预存额度；每次同步新头仍重走 CI、验收与路径闸。
- 冷验收：完整检出前经受管镜像补齐既定 head，不拿分支最新头替换待验头；成功回执由 `placeVerifyCheckout.onCompleted` 独立写，不借撤卡证明；每家原始结论在 `verifier-invoke.ts` 按真实 runId 先于格式重试、过滤和聚合入库（聚合另经 `noteVerifyAggregate`）。
- 引擎不再写 `acceptance_duties`（决定 0113）：冷验收转人的待验条只在工作流状态 `rt.handedOver`，`openDuties` 并上库里旧开着的行；读不成重试或停下，读到空才是没有。
- 新 PR 创建前从需求单现读 domain/nature 两轴，缺失、冲突、未知值拒开；直开 PR 贴标签后回读，失败不当成功。

## 会话树与进程

- 会话工作树是会话用户的 700 私有目录：读其中路径（含归属核验里的 realpath）必须经 `UserExec`，引擎进程不直接读。
- 镜像给用户树的增量包只经 `real/mirror.ts bundleFromMirror`，有 exclude 必须传目标 `UserTree` 做真实 `git bundle verify`；不用 previousHead 存在或错误文案代替证明，不 reset/强推掩盖不同步。
- 删树前置只经 `real/preserve-worktree.ts`（收尾、建树前替换、小时清扫共用）：成果可恢复（bundle/受限快照，独立空仓恢复对上）、原树身份没变、删除前现核无进程 cwd/无活会话/无任务和子任务工作流，才放行；查不清、读失败、浅仓、非 Git 成果一律留树。旁边已有的备份不是回执。根清扫只信固定 root 帮手的 `cleanup-status`，未结事务保留恢复责任。
- 重启收孤儿（`real/orphan-reap.ts`）：临时 cwd 从 `runs.worktree_path` 读，读不到先报错不当空清；延迟回收前重读 detached 标记及 TTL，已接回的不碰。
- 收树图片核对：本地分支、标签、引用都不代表远端交付；Git 探测只有明确报告不在仓内才算无仓；归档清单与图片实物（大小、hash、blob、文件头）全核过才回 archived，缺失/损坏/链接回 unknown。
- 自测容量只有一层归属：`test:changed` 与本机测试共用 conventions 的测试槽，引擎不另占名额、不设环境变量冒充持槽；等槽 20 分钟排队预算，拿到后测试 30 分钟、tsc 5 分钟。自测心跳带 probe/queue/test/tsc/done；已确认的测试失败或 tsc 诊断不能被超时/兜底抹成跳过，测试未完成而 tsc 过时摘要必须写明测试没有结果。

## 派工与停下

- 「派出过没有」只有 `jobs/dispatch-standing.ts` 一份（拉单、点名派单共用）。本机退回法国队列的单要靠退回时刻晚于最后一代 `closeTime` 认成「重新派」，时刻读不到不判、不猜。
- 法国接不了的单（验收要 diff 外证据、交代不全、改标准）不能退回，贴回「本机做」；通知键只报一次，用 `insertAlertOnce`，不能改成 `upsertAlert`（会把人处理掉的重开；代码注释在 `real/intake.ts` 的 `notifyLocal`）。`local-kept:` 提醒跟着单子走，单关了或「本机做」摘了就撤。
- 引擎自己挑单，进队条件见 design 第九节：四节齐、范围写死、验收条在 diff 里看得见、不贴「本机做」「待补」「要人拍」。引擎不直写主线，它的单它自己关。
- 无 PR 的 `pushBranch/WORKFLOWS_PERMISSION` 首次自然停点只走 `taskHandbackPermissionPush` Update（`push-handback.ts`，同 run、generation=1、continued=0）；合同修订原位交还用显式 v2 同时绑 H0/H1，v1 不自动放宽；`handed_back` 才证明控制消费，`accepted` 或人工报告不替代。
- 指挥官（`jobs/park-triage.ts`、`real/park-triage.ts`）：会话只交裁决，动手经白名单；重做的多步先写接续账 `commander.redo`，账写不进不动手，每次动手前现读归属，转本机/对不上记 `given-up`，读不到记 `unverified` 继续保留责任。总轮数到顶（码 `total_rounds`）已交回本机的停下指挥官整个跳过、不出拍板卡；`commander.redo` 和 `task.redo` 起新一代前按历代累计动手轮数封顶（`totalRoundsHoldOf`，#3625），到了交回本机、读不到不重做。验收责任巡检里，模型 `leave` 不是转人依据，只有引擎可信来源 `acceptanceFounderFacts` 给出精确绑定的创始人事实才发「要你拍」；自动 settle 须过 `acceptanceTrustedRead`，PR 实际已合的 head 须等于责任 head。当前真装配没有这两种来源，生产上一律保留责任（#3497、#3579 的欠项）。
- 看门狗只报和撤卡，修复在 api（`packages/api/src/alert-repair.ts`）。改 `jobs/watchdog.ts`、`jobs/idle-running.ts`、`real/watchdog.ts` 的提醒键（`watchdog:idle-running:<任务>`、`watchdog:release:train:<提交>:running|failed`）、阈值、撤卡条件，必须同步 api 的 `IDLE_PREFIX`、`RELEASE_KEY` 和 core 的 idle 判据（`packages/api/test/alert-repair.test.ts` 会红）。
- 定时任务 `schedule_runs.why` 在一轮没收尾期只放诊断见证，只证明「最后记到的位置」，不证明为什么中断；`ended_at`、scanned、found 仍未知，由下次启动补记 failed。
- 其它定时任务：changelog（`jobs/changelog.ts`）任何一版没查成不开部分 PR；没有已关闭里程碑记 unscanned，不用零扫描冒充成功。固定版本宿主工具（Go，`cli-upgrade-go.ts`）只在发布/空闲排空窗口运行，入口被遮住明确失败、保留现有安装。

## 真装配里容易误改的几处

- 对账（`real/github-reconcile.ts`、`jobs/github-reconcile-window.ts`）：replay/poll 与 API 复用 store 的 source publisher，`synced` 同样先发布再 accepted，失败留原投递账重放；`policy-source-origin.ts` 只读 `/etc/fleet-dao/api.env` 的唯一 `FLEET_PUBLIC_URL`，缺失/重复/非法使相关投递失败，不阻塞引擎启动；扫描窗口先落幂等账再扫描，此账不当扫描锁，超过 GitHub 保留期仍保留原下限并警告。
- 自测（`real/self-check-ci.ts`）：`coveredByCi` 只给 fleet-dao 已有 PR 的同树标准源码测试，不算本机 PASS；未知、旧 CI、脏树、合同变更回本机路径，tsc 仍实跑。
- 机械解冲突（`real/mechanical-conflict.ts`）：只解 `MECHANICAL_CONFLICT_RULES` 名单内的（迁移生成文件、`pnpm-lock.yaml`），手写迁移/改过已有迁移不解；schema-drift 和 tsc 自测过才推，没过撤回；只在 `task-sync.ts` 的 `patched('mechanical-conflict-resolve')` 里调，计入 `conflictSelfSyncs` 的 3 次上限。
- 会话 scope 内存事件（`real/scope-oom-evidence.ts`）：只证明「这个 scope 里有 OOM 事件」，被杀的是谁永远 unknown，不拿 137/143、内存峰值、父 slice 或兄弟 scope 顶替；读不到、读不全、实例身份变了记 unknown，不写 0。
- 迁移体量折扣（`real/migration-budget.ts`）：只是自动折扣资格，未知回原始行数，Git 读取失败抛错；候选改动信任输入时不折扣。
- 复杂快照（`real/complex-preserve.ts`、`complex-snapshot.mjs`）：浅仓、命令失败、输出不是 `true`/`false` 都明确失败留原树；PACK 在 BUNDLE 前独立核全；帧、对象数、字节有上限（`test/real/complex-snapshot-*.test.ts` 钉着），不放宽。
- 承接能力（`admission-alert-*`）：已有超额、错 schema、损坏或身份不明的 spool 保留原件返回未知，不删库重建；通知持久化不代表飞书送达；`src` 不接受 Start 正文、token 或任意 SQL。
- push-handback 诊断分片不放宽原断言、60 秒测试超时、缓存或 SDK 阈值，也不结清 #3258 的重放兼容责任。

## 测试

- `npx vitest run packages/engine/test/<文件>`；不要 Postgres（用库的跑在 PGlite）。时间跳跃先 `pnpm test:temporal-server` 显式准备，经 `test/support.ts` 的 `createEnv()`；真 Temporal 服务用 `pnpm temporal:install` 或 `pnpm test:temporal --cli <路径>`，版本须一致，不在业务测试内隐式下载。
- 重放：`test/replay.test.ts` 拿 `test/replay/fixtures/task-*.json` 对现在的代码重放。`test/replay/worker-replacement-3413/` 是保留的原字节，不许重录覆盖。
- `admission-alert-*` 测试必须用真实 Linux 普通用户（Windows 经 `local-vitest.ts` 转交）；`legacy-admission.real-pg.test.ts` 等 real-pg 在真实 PG 台跑，缺配置的 CI 明确报错。
- 本文件字符数上限由 `packages/conventions/test/agents-md-size.test.ts` 检查（engine 10,000，另两份 8,000）。

## 改它时要连带改

- 读写的表：结构在 `packages/db`（生成迁移），共用读写在 `packages/store`（两套实现一起改）。
- 派工、选路：design 第九节「自由组合的派工模型」。法国上的单元、环境变量：ops 第五节「AI 会话」或第九节「发布应用（deploy/release.sh）」。
- 在途需求修订：正式合同由 `runner/task-brief.ts` 产生，验收状态与合并写经 `real/task-contract-guard.ts` 核预期版本；读不全、旧合同不得发布通过或挂合并。
