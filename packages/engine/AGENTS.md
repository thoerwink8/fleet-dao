# packages/engine：引擎

Temporal 工作流、活动与 worker，跑在法国：每张单一条任务工作流，执行每一步（起会话、跑测试、开 PR、合并、记账）；派工选路、定时任务也在这里。为什么这样分见 design 第四节「架构」、第五节、第九节。旧系统的审计（不是这个包）在 `docs/archive/old-engine-audit.md`。

## 入口

- `packages/engine/src/main.ts`：进程入口（`pnpm --filter @fleet-dao/engine start`），必须设 `FLEET_ENGINE_PORTS`（`real` / `fake`），其余环境变量见文件头注释。
- `packages/engine/src/worker.ts`：起 worker；`packages/engine/src/workflows/index.ts` 是工作流打包入口（只导出 `helloWorkflow`、`taskWorkflow`）。
- `packages/engine/src/workflows/task.ts`：任务工作流，按职责拆在同目录 `task-*.ts`，共用零件在 `kit.ts`。
- `packages/engine/src/activities.ts`、`packages/engine/src/real/`：活动和真端口的装配（库、GitHub、会话、工作树），缺一项就不起。
- `src/real/execution-start-reader.ts`：未接生产准入的只读前置；专用 Connection 显式限制接收大小、禁默认重试，按精确 run 读首个 Start 参数。`observed` 只证明读取结果，可信 ActivityInfo、任务与派发身份仍须由后续 gate 核验，不能当执行资格或终态证明。
- `src/real/execution-legacy-admission.ts`：未接生产的 legacy 来源适配器；无参入口从当前 Local Activity Context 读精确 Start 并经独立有界 SQL 能力登记持久责任，返回允许/拒绝/未知，不生成 Workflow 失败、不支持 managed 派发或终态释放；History 和 SQL 共用单调总期限。
- `src/real/legacy-admission-process.ts`：未接生产的独立单次 SQL 子进程；固定入口和封闭限长协议，一次最多一个在途子进程，取消/超时强杀后须核退出及管道关闭，未核清保持占槽。在途 COMMIT 可能已经持久化责任，未知不代表回滚；复用 Store 原事务，不把空通知警告当送达证明。
- `src/real/github-reconcile.ts`：replay/poll 与 API 复用 store source publisher，`synced` 同样先发布再 accepted；失败留原投递账重放。`policy-source-origin.ts` 只读固定 `/etc/fleet-dao/api.env` 的唯一 `FLEET_PUBLIC_URL`，复用发布配置的 systemd parser，不装入环境或回显配置；缺失/重复/非法值使相关投递失败，不阻塞 engine 启动。旧已 accepted 版本保留去重，由标准 `fleet-api project refresh-policy-source` 补当前 open 头，不为已合 PR 补历史。
- `src/real/self-check-ci.ts`：只给 fleet-dao 已有 PR 的同树标准源码测试识别规范 CI 覆盖；受信运行发布 SHA 绑定官方 Git 配置/锁合同，每台 test job 的实际 Node 声明须同 major/minor。未知、旧 CI、脏树/子模块、合同变更回本机路径；tsc 与自定义命令仍实跑，`coveredByCi` 不算本机 PASS。
- `src/real/mechanical-conflict.ts`（#3428）：并主线冲突里机械可解的（`MECHANICAL_CONFLICT_RULES` 名单：迁移生成文件、`pnpm-lock.yaml`）引擎自己解，活动 `resolveConflictMechanically`（装配在 `github-ports.ts`，借 selfCheck 档限时）。迁移丢掉分支上生成的、取主线的再 `db:generate`，锁文件取主线再 `--lockfile-only`；schema-drift 和 tsc 自测过才推，没过撤回。手写迁移（快照与上一版一致）、改过已有迁移、生成后手改过 SQL 的（并之前对分支新增迁移用上一版快照重新生成，和提交的 `.sql` 逐字节比，`GENERATED_CHECK_SCRIPT`）不自己解。工作流只在 `task-sync.ts` 的 `patched('mechanical-conflict-resolve')` 一支里调，次数计入 `conflictSelfSyncs` 的 3 次上限。
- `src/real/scope-oom-evidence.ts`（#3448）：会话 scope 自己的内存事件见证。边跑边读 `fleet-agent-<runId>.scope/memory.events.local`（层级的 `memory.events` 只作旁证），收场再读一次，经 `facts.scopeOom` 进 result.json；只证明「这个 scope 里有 OOM 事件」，被杀的是谁永远 unknown，不能拿 137/143、内存峰值、时间邻近、父 slice 或兄弟 scope 的计数顶替。每次读前后取 scope 目录的实例身份（生产 stat 的 dev:ino），同路径被同名新 scope 重建、前后对不上或取不到身份的读数不收，判 unknown 并标 `instanceChanged`（第一次读成之前就被换掉的看不出，限制写在文件头）。没读到、读不全、计数回退、首读非 0 都记 unknown 和完整性，不写 0；Mirasim 不经本机 scope，写 unsupported。文字刻意避开 `failure/rules.ts` 里 oom_killed 的文本判法，不进 stderr / failureReason；保全失败不改退出事实。只保存证据，不为旧运行补原因。
- `packages/engine/src/real/self-check.ts`：以工作树主人身份跑测试和 tsc；各段预算统一从 `packages/engine/src/self-check-budget.ts` 取，活动总限时只由这些预算相加。
- `packages/engine/src/decisions/`：判断（纯函数）；`packages/engine/src/routing/`：选路；`packages/engine/src/jobs/`：引擎进程里的定时器（不是 Temporal 工作流，登记表在 `real/jobs.ts`）。
- `src/jobs/github-reconcile-window.ts`：真实对账在扫描前按上次完整成功身份把窗口封存到既有幂等账；partial、失败和重启都复用原下限，避免 fallback/cap 移动而丢游标。读写或回执异常明确失败；此账不当扫描锁。超过 GitHub 保留期仍保留原下限并警告可能有漏，持久窗口不证明过期投递已补回。
- `src/real/migration-budget.ts`：本仓超默认体量预算时，按固定 Git blob 和发布版数据验证器识别唯一新增 PG7 快照；原始 addedLines 不换口径，未知回 raw，Git读取失败抛错。候选改动验证器、依赖声明/锁、计量判据或任意层级 `.gitattributes` 等固定信任输入时不折扣。20k行/2MiB只限自动折扣资格，不自动恢复已停任务。

## 测试

- 时间跳跃用例先 `pnpm test:temporal-server` 显式准备固定 Java test-server，再走 `support.ts` 的 `createEnv()`；录重放夹具和单跑 evolution 同样先准备。缺失/坏缓存不在业务测试内下载，每个用例仍独立起停；与下面的真实 CLI 准备分开。
- `npx vitest run packages/engine/test/<文件>`。不要 Postgres（用到库的跑在 PGlite 上）。
- 法国工具链 `/bin/sh` 和目录 chmod 权限测试在 Linux 跑真端口；Windows 用明示的命令/阶段错误夹具验证装配与失败分类，不代表引擎支持 Windows 生产宿主。Git 归档检出在两种系统都跑真实 git/tar，归档名相对私有 scratch，避免 GNU tar 把 Windows 盘符当远端。
- Temporal 测试用 `@temporalio/testing` 的时间跳跃环境（`packages/engine/test/support.ts`）；真服务端先用 `pnpm temporal:install` 按 `deploy/france.sh` 固定版本准备本机 CLI，或用 `pnpm test:temporal --cli <绝对路径>` 登记已安装 CLI、设 `FLEET_TEST_TEMPORAL_CLI`，版本须一致。正规选测和创建入口都核路径/版本，不隐式下载；SDK 创建阶段只报 `start-or-connect`，内部细分状态未知。
- 重放：`packages/engine/test/replay.test.ts` 拿 `test/replay/fixtures/task-*.json` 对现在的代码重放。录新场景用 `node packages/engine/test/replay/record.ts <场景>`，已有的夹具拒绝覆盖。
- `push-handback-contract.test.ts` 对本文件全合成假端口历史启用失败取证，`push-handback.test.ts` 只对 worker replacement 那一条启用同一取证：第一个 beforeEach 起算 50 秒的 watchdog 或原测试失败时，按真实 handle/run 和 SDK 三秒 RPC deadline 读原 protobuf（每份 2MiB）与白名单 describe（128KiB）。等待阶段只留固定标签，写进该 workflow/run 的 history 与 describe 起始帧，不另记可串台的时间线。先落仓根临时区中由测试创建的 synthetic-history 子目录，再以 SHA256、gzip/base64 完整帧写日志；整文件最多 8MiB，超限/读失败/缺帧均未知，不能当成功历史。正常快速用例不额外读取；watchdog 不停 worker，原测试结束后才等实际 runUntil 收尾、按环境去重关闭，再 teardown。禁止扩大到真实端口或其它测试历史，不放宽原断言、60 秒测试超时、缓存或 SDK 阈值；这只是诊断分片，不结清 #3258 的重放兼容责任，也不把另一条 park-kind 重放错误当成 worker replacement 超时的原因。已保留的 watchdog 原字节在 `packages/engine/test/replay/worker-replacement-3413/`：阶段 `first-worker:parked-query`，workflow `handback-0c8f4322-17be-4b14-9e92-c81f0514e949`，run `6385a827-f825-4d12-8bd9-d3e2351b6db6`。`readTaskBrief` 完成后工作流任务因 `self-check-own-timeout` 的 TMPRL1100 失败并接着超时；该标记仍归 #3258，不改 `packages/engine/src/workflows/kit.ts`。这不是 CI run 39392992046，不许重录覆盖。机制由 `la-query-split.test.ts` 钉住：回查询时本地活动结果还没交给工作流，core 强开新任务，本地活动之后才问的补丁标记落到下一个任务；重放在第一个任务里就解开本地活动、问补丁，于是 TMPRL1100。只钉机制，不修。同目录 `slow-parked-query.*` 是另一种卡法（无失败事件，cache0 下查询和任务都整段重放，负载下 20 秒走不到停下）。该文件的 `parked()` 改为先 `w.until` 等假库写进 phase `parked` 再查停点，走向停下的路上不发查询。

## 常见坑

- 已合 PR 任务只按同仓精确 PR/head/真实 mergeCommit 经 `readMergedTask` + `onlyBook` 结清；活工人自然返回后在检查点止损，不取消会话。parked/paused 用 `taskSettleMerged` Update，IO 前后核同 run/停法代数/continued，数据库活动会话必须为零；accepted 不是 finish 完成，不提前撤提醒。收尾走 merged 与持久验收责任，未结责任保留 OPEN，工作树先存档，不用 closed-issue/abandon 冒充已合。closed-issue 正式 Update 对已知 PR 同样现读，未知不放弃、已合转成功收尾但不发撤提醒回执；新 reader 用 Claims.readPull 的 requireMergeState，缺失/矛盾状态不能合成为未合。detached 等待到同 session 接回终态期间一直算在跑，禁止提前结清或收树。

- 镜像给用户树的增量包统一经 `real/mirror.ts bundleFromMirror`，有 exclude 必须传目标 `UserTree`：以目标会话身份执行真实 `git bundle verify`，核全部 prerequisites/对象闭包；不通过只回退一次有大小和取消限制的完整包，再验证才能导入。不能用 previousHead 存在或错误文案代替证明，也不能 reset/强推掩盖旧树与远端不同步。

- 主线同步每段最多 `MAX_MAIN_SYNCS` 次；只有精确 PR/head/已用次数对应的预算耗尽停法，实际收到这次停下之后的新「继续」，才能续下一段。普通失败、运行中或重复的「继续」不能预存额度。活动旧结果没有结构身份时先保持原停法，重试得到新身份后仍须下一次「继续」；每次同步新头仍重走仓原有 CI、验收与路径闸。

- 冷验收完整检出：archive 前经 GitHub 的受管镜像入口补齐既定完整 head，复用镜像锁、只读凭据、取消和超时；已有对象不联网，不拿分支最新头替换待验头。获取或检出失败保留真实降级和报警，只有精确头完整检出成功才撤旧报警。

- 重启收孤儿（`real/orphan-reap.ts`）：脱开会话的真实临时 cwd 从原 `runs.worktree_path` 读，冷验收的目录名不等于 runId。交接或账读不到先报错，不把未知当空清掉；延迟回收前重读 detached 标记及 TTL，已经接回的不碰。

- 根清扫只将精确 `.cleanup-transactions` 真目录交给固定 root 帮手的 `cleanup-status` 核身份、属主/权限和完整事务列表，不以会话身份读私有目录。核准才排除业务树分类；同名文件/链接、旧帮手缺身份、读取失败或截断均报问题；完整列表须经适配器有界分页读完全部页、只原样交回帮手签发的游标（缺页、游标重复回退、页不接续、变动超轮次、超界都算没读全），未结事务仍保留恢复责任，其它陌生点目录不豁免。

- 正式评审先按原白名单选尚未解决的要求改，再翻全该 review 的行内原文，核仓/PR/review 与原审查者数字身份。总述与行内编辑都进消费键，新完整原文按code point安全分段、带引用尾界保住末空白，旧历史缺行内字段时保留原键和反馈。读不全明确未送达，合前已挂的 autoMerge 尝试撤掉，撤失败一并报明；三个合并入口及waitCi确认已合后共用review-audit补读留账，补读失败记未读，写账失败抛重试。CI 红返工入口走同一读取（readCiReviews，patched('ci-red-review-context')），和失败证据一起交下一轮；读失败不当成没有评审。

- 合并对账撤风险只认真实 `github.merge_pr`：账的 action/target、完整回执与 GitHub 当前 PR/head/合并提交/实际引擎合并人都须一致；`github.merge_pr_backfill` 留原来源，后续轮次也不能当队列证据。读账失败保留提醒并报没查成。
- 已合并观察补账经 `bookMergedPull` 固定传 `mergePr.onlyBook`：writer 在实际重读后、写账前核 PR 编号、已合并、头、完整合并提交和合并人；未合或回执读不全明确失败，不能退到主动合并。主动合并入口不传此约束。

- 收树图片核对同时清点本地引用可达与不可达的无父图片提交；本地分支、标签、其他引用都不代表远端交付。Git 探测只有明确报告不在仓内才算无仓，坏配置、权限、超时不能当空；清点和清单回读用同一套目录名、图片名边界。树已收后的重试，归档清单必须身份一致，图片实物的大小、hash、blob 号和文件头全部核过才回 archived；缺失、损坏或链接回 unknown，不能只信清单。
- **改工作流步序必须用 `patched('<新标记>')` 包住**：在途任务（包括停着等人、等合并的）换上新代码会重放对不上，报 `TMPRL1100` 变僵尸。重放测试红了不许重录夹具让它变绿。
- 重构工作流里「之前的值」这类比较参数时，不给默认值：显式传入的 `undefined` 会被默认参数换成当前值，把「第一次」判成「没变」，少调度一串活动（#3402，`acceptContract` 的 `before`；#3199/#3200 因此重放报 TMPRL1100）。夹具 `task-contract-first-accept` 钉着首次接纳（最初交代没有合同）这条步序。
- 工作流里要确定：不取随机数、不生成编号（主键经 `decide('newIds')` 进历史），不碰活动实现、worker、客户端、Node 模块；判断只经本地活动 `decide`，工作流文件对 `decisions` 只许 `import type`。`packages/engine/test/structure.test.ts` 把这些写成了检查。
- 活动的超时、心跳、重试只在 `packages/engine/src/activity-options.ts` 设，调用处不许另写；长活动要心跳。
- 会话工作树是会话用户的700私有目录；归属核验中的物理路径解析也必须经 `UserExec`，不能在引擎进程直接 `realpath` 会话树里的 `.git`。路径词法归一不读磁盘，路径读取失败继续明确报错。
- 自测容量只有一层归属：`test:changed` 和普通本机测试共用 conventions 的测试槽，引擎不再占自测名额，也不设环境变量冒充持槽；自测名额只管 tsc 和其他测试命令。所有等槽、等锁合用 20 分钟排队预算，拿到容量后才算 30 分钟测试执行预算，tsc 另有 5 分钟，杀进程、放锁都有收尾上限。
- 自测心跳带 probe / queue / test / tsc / done、阶段起点、最后输出时刻；看门狗在活动总限时内把自测无会话视为正常。超时、取消、异常退出保留已有输出并脱敏限长；已确认测试失败或真实 tsc 诊断仍为 fail/red，不能被中断或顶层兜底抹成跳过。无失败证据的普通超时交给 CI；测试未完成而 tsc 通过时，摘要必须写明测试没有结果。
- 工作流对外的输入（`packages/engine/src/contract.ts`）加字段只许可选，不然在途任务的输入对不上。
- 无 PR 的 `pushBranch/WORKFLOWS_PERMISSION` 首次自然停点只走 `taskHandbackPermissionPush` Update（`push-handback.ts`）；限定同 run、generation=1、continued=0。默认 CLI/check 只 query/读证据，不写 Temporal 历史；execute 才发 Update。旧 worker/cgroup、固定 scopes 和 helper 自然终态、持久 run/result、合同、树与用量由 Activity 现读；未知拒绝。原 park 交回控制权、主循环记完本轮且接纳返工后才签 `handed_back`，保留全部轮数和预算，不拿继续信号、accepted 或人工报告替代。

- 合同修订原位交还用显式 v2 同时绑定 H0/H1；v1 不自动放宽。主路径在原 park 内最终核 H1，失败保原 hold；成功同步接纳完整 brief/tier 并撤旧批准，accepted 待收场状态按历史恢复。回执 acceptedContract 只证明快照，handed_back 才证明控制消费，不证明统计落库或外部正文永久不变。后续动手前必须有旧运行实际启用的合同修订边界，否则拒 v2；不直接在 Update 调 refresh，不把普通新 actor 加进自然退场历史白名单。

- 自动关单收尾只走 `taskCloseClosedIssue` Update：同步核精确 run、当前停法代数和继续代数，只有 `accepted` 回执才能记成功、撤提醒。继续信号先使凭据失效，不能等公开 phase 改好。旧 worker 缺能力、Update RPC 超时或回执未知保留未核实，不能退回人类的无条件放弃信号。
- 新 PR 创建前从需求单现读两轴（正文无需求号时认任务分支）；缺失、冲突或未知值拒开并明报，不猜分类。groom 新单显式提供 domain/nature，拆分单可逐轴继承来源单的唯一有效值，写前仍须齐全。驾驶舱会话在 modules 中独立声明两轴，后端开单前同样校验，正文移到独立查询分类节，不计入模块范围和派工规模。查询轴不参与派工、合并与版本判定；此处只保证创建的元数据齐全。报警立案贴 engine/bug，耗时表直开 PR 贴 engine/process，隔离集直开 PR 贴 engine/bug；直开 PR 贴后回读，失败不能当成功。
- 「派出过没有」只有 `jobs/dispatch-standing.ts` 一份（拉单、点名派单共用）。本机领单不新起一代，所以本机退回法国队列（租约到期 `task.local.expire`+returned、放手 `task.local.finish`+released）的行，各代都结束后要靠操作记录里的退回时刻晚于最后一代的 Temporal `closeTime` 认成「重新派」（起 `:rN+1`，#3461）；退回时刻读不到、结束时刻读不到都不判，不猜。法国接不了的单（验收要 diff 外证据、交代不全、改标准……）不能退回：租约到期先 `franceVerdict` 试判，放手来的由拉单 `holdReturned` 贴回「本机做」；通知键只报一次（`insertAlertOnce`），别改成 `upsertAlert`（会把人处理掉的重开）。这些 `local-kept:` 提醒跟着单子走：每个仓准入走完，单关了或「本机做」摘了的撤掉（`settleLocalKept`，处理人 `engine:intake`），报给本机或贴回「本机做」那两步写不成的这轮也算留着。退回单挡着的地方改好了（`releaseReturned`：库里还挂着 `intake-returned-blocked` 提醒、单仍贴着「本机做」、行仍是没人接的退回行、`franceVerdict` 试判过了）拉单自己摘「本机做」，提醒跟着撤；本机已重新领走的不摘。
- 引擎自己挑单，进队条件见 design 第九节。要它接：单的四节齐、范围写死、验收条写成 diff 里看得见的、不贴「本机做」「待补」「要人拍」。引擎不直写主线，它的单它自己关。

- 冷验收转人的待验条持久写入 `acceptance_duties`；管理归并初建的待验目标（`management_merge`）按原来源读回，不改写成冷验收，认不出的来源记没查成。合并前通过 `acceptance-duty-before-merge` 分支读取全部待验责任、将 PR 正文写成 Refs 分片并现读核对，失败重试或停下，不带旧正文进入合并。代码仍可正常合并，收尾有待验责任不关单。责任项原子并集，新增项递增代次并撤销旧结清；没有新项时重放不把已验的再开回去。最终验收和替代仍走原来的精确仓、单、PR、head、责任 id 和代次 CAS，不认评论文本；换代后旧代次收不掉，替代要按新代重绑。

## 改它时要连带改

- 改工作流：加 `patched()` + 必要时录一个新重放场景；改了步序、停在哪等人，同步 design 第五节对应条。
- 在途需求修订：正式正文合同由 `runner/task-brief.ts` 的版本化规范产生；工作流在安全边界现读，brief/tier 同版且不清预算轮数。真实验收状态与合并写经 `real/task-contract-guard.ts` 核预期版本；读不全、旧合同不得发布通过或挂合并，撤挂未确认明确失败。普通评论不改合同，旧历史和 attach 保留原身份。
- 给任务页「过程」记的账（#3140）：动手会话入参的 `cause` / `causeSummary` / `roundSeq` / `resumeReason`、冷验收入参的 `roundSeq`、推分支的 `prNumber`、开 PR 的 `numstat` 都是可选字段，只在 `patched('run-cause-fields')`、`patched('pr-head-files')` 为真时给，只记账不改步序；加新的起因先改 shared 的 `RUN_CAUSES`（库里 `runs_cause_known` 约束同一份，`packages/db/test/run-cause.test.ts` 核对）并在 `task-session.ts` 的 `nextCause` 赋值处点名它为什么起。
- 改活动超时：只改 `activity-options.ts`。改定时任务：`src/jobs/` 加任务，`real/jobs.ts` 的 `ENGINE_JOBS` 登记。
- 冷验收每家原始结论在 `verifier-invoke.ts` 按真实 runId 立即入库，先于格式重试、二轮过滤和聚合，保留完整问题原文；组合另经 `RunsWriter.noteVerifyAggregate` 记精确头/轮次和来源 runIds，多家不带任何一家 session 身份。接回单家验收也走原始结论和聚合两份账；任一写账失败明确记任务日志、证据保持未知，不改已跑出的真实裁决、不因此再起模型重验。
- numstat 采集的截断前总数或失败原因经可选 `numstatSnapshot` 和旧 `pr-head-files` 补丁块传到开 PR，零文件照记。老历史只有数组没有总数的明确未知，不升级成完整清单。
- 改读写的表：表结构在 `packages/db`（生成迁移），共用的读写在 `packages/store`（两套实现一起改）。
- 改派工、选路：同步 design 第九节「自由组合的派工模型」。
- 改了法国上的单元、环境变量：同步 ops 第五节「AI 会话」或第九节「发布应用（deploy/release.sh）」。

## 独立准入未知承接能力

- `real/admission-alert-process.ts` 提供封闭的 `record` / `transferOne`，各持一个独立进程槽；尚未接入 worker、workflow、定时任务或终态释放。调用方传入父进程单调绝对期限，只能缩短单次十秒上限，最后一秒留收尾；退出或管道未核清时槽继续占用。
- 私有 pending 使用 Node 的 experimental `node:sqlite`，仅 Linux 普通服务用户，路径祖先只允许 root/可信服务 UID 写，叶目录 0700、文件 0600。恶意 root/同一可信 UID 不属于权限隔离范围；不把 SQLite 字符串路径冒称 dirfd 锚定。
- `real/admission-alert-spool.ts` 固定 DELETE/EXTRA、4096 字节页、1024 页、关闭 spill/auto-vacuum，最多 256 条/1MiB payload。已有超额、错 schema、损坏 journal 或身份不明均保留原件并返回未知；不删库重建。移交先核 PG 真实 COMMIT 与 close，再在同一 transfer child 内按 key/hash 删除 pending，没有 caller ACK 接口。文件字节界和私有路径/耐久边界见 `docs/design/admission-alert-spool.md`。
- 全局 identity 不含首诊断码；同 run 换码重建仍归并原通知。通知持久化不代表飞书送达，新前缀未加入推送白名单。本能力不接受 Start 正文、token 或任意 SQL。
- `test/admission-alert-spool.test.ts` / `test/admission-alert-crash.test.ts` 必须用真实 Linux 普通用户；Windows 本机入口按 `local-vitest.ts` 转交明确配置的 runner。`test/admission-alert.real-pg.test.ts` 在真实 PG 台使用随机隔离库验证移交，缺配置的 CI 明确报错。

## 定时任务中断见证（#3477）

- schedule_runs 的 why 列在一轮没收尾期间只放诊断见证：每小时对账的最后一个子步骤（`在途阶段见证：`，写不进只记 warn，不改步骤结果）；引擎正常停机、宽限到了某任务一轮还没回，再追加 `停机宽限到期时这一轮仍在跑 at=…`（`timers.ts` 的 `recordUnfinished`，只写本进程起定时器之后开始的未结束行）。它们只证明「最后记到的位置」，不证明卡在哪、为什么中断，也不是结束时刻；这一行不结束，ended_at、scanned、found 仍未知，由下次启动补记成 failed（ended_at=started_at 是补记，不是真实结束时间）。SIGKILL/OOM/断电没有机会写，仍只有最后一笔阶段见证。

## 指挥官重做的受管接续（#3496）

- `jobs/park-triage.ts` 的重做是多步（叫停旧代 → 等终态 → 起新代），每跨一步前先写接续账 `commander.redo`（`stop-requested` / `start-requested`，带叫停前读到的全部旧代 workflowId + runId），账写不进就不动手；等不到终态、启动没确认各记 `stop-unconfirmed` / `start-unconfirmed`，终态是 `started` / `exists` / `given-up`，另有「没核实」的 `unverified`。不另建表、不另起巡检：同一个 10 分钟定时任务每轮先读这份账，对没到终态的按原裁决调 `real/park-triage.ts` 的 `resumeRedo`，不新认领、不占每日名额、没配模型也接续。
- 叫停前先把全部旧代的 runId 核全（缺/空/代数不连续就在任何副作用前拒绝），对全部还在跑的旧代一次发完叫停请求，叫停、查询、读状态都钉住已核 runId。叫停请求记账后进程崩溃、或部分信号没送到时，接续在同一授权意图内补发：只对账上已核 run、身份重核仍对得上、姿态仍是 `parked` 的旧代，先记一条 `stop-requested` 再发，最多 `PARK_TRIAGE_REDO_STOP_TRIES` 轮（含首次），发完只重读一次、不等待；旧代在干活、已在收尾、读不到姿态的不发。每次接续/动手前从现有任务/仓记录（`taskContext` + `intakeTaskRow`）重核：task id/ref 对得上且 `executor=engine` 是「还是同一个引擎任务」，对不上/转本机是已核实事实 → `given-up`；状态是停着/已放弃才允许叫停、起新代（`canAct`），否则（例如新代已把任务行改成 running）只许只读确认新代是否存在；读不到只是等。
- 起新代之前（首次和接续都一样）现读全部代次：先核全部旧代（runId 一致、不少、都真实终止），旧代没核完哪怕新代已存在也不报完成；核完新代已存在才算 `exists`，不再起。补发叫停先核全部仍活旧代的姿态，任何一代仍在干活或读不到就整批拒绝；姿态查询结束后再次核任务归属，转本机或状态变化不动手。所有耗时的远端读和写账之后、真正发叫停/Start 的前一刻，各再从任务/仓记录重读一次归属和状态（不复用前面读到的结果，也不用前面的仓/标题去 Start）；读不到只等，转本机/对不上记 `given-up`，状态不是停着/已放弃不动手。这只拒绝能观察到的转移，不承诺跨库与 Temporal 的原子性；若在叫停账已写、信号未发时被拒，回执写「任务没动」。已在收尾的旧代只等终态，不对它重发。叫停后读状态失败从不当成已终止。
- 约束：接续不新认领，每日认领计数、单张单防空转、代数上限都不变；一个意图只对应固定的新代编号，Start 用 FAIL + REJECT_DUPLICATE，最多创建一个新代，`PARK_TRIAGE_REDO_START_TRIES` 是对同一编号的有界重发，不是额度。24 小时窗口或次数用完只停止发起新的 Start；`given-up` 只用于已核实的事实（身份变了、归属不对、代数到顶、旧代已终止且新代确认不存在但不许再起），读不到/旧代未终止记 `unverified`：责任继续保留，每轮继续读证并在 problems 里报「未核实」，绝不把未知当结清。
- 账本身读法严格：trail 须非空、代数连续、runId 不重复，同键后来的记录不得和起头记录的身份/代次/编号不一致；对不上就阻断该意图，每轮报 problems（「已阻断」），连键都定位不到的坏记录同样每轮报。
- 回执分三种：叫停已发送、终态未确认；旧代已终态、新代待启动/启动未确认；新代已确认启动（或已存在、本次没再起）。什么都没发出去才写「任务没动」。测试：`test/real/park-triage.test.ts`（假 Temporal + `ParkTriageWiring.clock` 假时钟）、`test/park-triage.test.ts`（假存储）。

## 验收责任巡检的责任分类（#3497）

- `jobs/park-triage.ts` 的 `triageAcceptanceRepo` 把每条 open 责任分成三种结果：已结清/替代（只在核过白名单并真执行成功后）、**创始人证据**、**没核完**。模型的 `leave` 只是「证据仍缺」的自述（读不到证据时它也会写），不是转人的依据，`humanOnly`/`reason` 的自由文本和模型自填的任何字段都不算授权。只有 `deps.acceptanceFounderFacts`（引擎自己的可信来源：只读、限长、精确绑定 duty/代次/PR/head 的事实，`decisions/park-triage.ts` 的 `trustedFounderFact` 逐项核对，同责任多条或不合格都不认）给出这条责任的创始人证据，才发 decision「要你拍」（`reason: human-only`），说明用事实里的 `what` 而不是模型自述，并写一条 `commander.act`（action=leave，带认领键）作为「已转人」的凭据。**当前真装配没有这种可信来源**（旧历史里没有这种证明，不补造），所以生产上 leave 一律不转人，真实的创始人证据来源是 #3497 的欠项。
- 没核完＝缺唯一裁决、裁决格式/身份/代次不符、缺合并回执、证据为空、supersede 目标/coverage 不满足、结清/替代口子没装配或抛错、leave 没有可信创始人事实（来源没装配、读不到、没有精确对应）；以及主线头读不到、会话没起成、回答认不出（这三种还没拿到裁决，是读取失败）。它们都不发「要你拍」，发 alert 级提醒（正文分「已按裁决收口 / 仍未收口 / 机读或执行没核完」，部分成功只报已核那部分，不关单），责任保持 open，经 `deps.acceptanceRetry` 抵销这次认领（写不进再试一次，仍不行明报），下一轮同一 head 再处理。所有原因合用一份预算：`AuditBook.acceptanceWindowRetries` 只读 `commander.retry`（`after.cause` 为 `session` / `unverified`，`after.why` 存限长原因），24 小时窗口内 `PARK_TRIAGE_SESSION_TRIES` 次；用满后不再认领、不起会话、不执行，但每轮调度仍在 problems 里报「验收责任仍未核实」和最近一次原因，窗口滚过后预算重新开始（每天有界，不是永久停摆也不是无限重试）。已认领却没被重试抵销的候选，只有「当前每条 open 责任都有精确对应（duty/代次/PR/head 四项相等）的转人记录」才算整个候选在等创始人；凭据缺字段、身份不符、只覆盖一部分、认领后才新增的责任，都逐条在 problems 里报「已认领但既没有重试记录也没有转人记录」（例如重试记账写失败），不再起会话、不被别的责任的转人遮住、不当成已处理；所在单已关闭则不报。没动每日 60 次上限和单张防空转的口径。
- 只留给创始人的那一条与没核完的并存时，decision 卡只列创始人那条；已核结清的照实写。supersede 仍由 `checkAcceptanceVerdict` 要求同仓同单同 PR 的已结清目标和逐项 coverage，旧头没有合并回执不能 settle。引擎没有给会话新增任何读取能力或凭据：提示词只给责任身份、合并回执和 leave 不转人的约定；读不到证据只能明报机读缺口并重试，不靠编造证据过关。

- 自动 settle 的可信读证（#3579）：`checkAcceptanceVerdict` 之后、调 `settleAcceptance` 之前，`triageAcceptanceRepo` 必过 `deps.acceptanceTrustedRead` + `decisions/park-triage.ts` 的 `acceptanceSettleTrustProblem`：读方绑定精确 duty/代次/PR/head，PR 实际已合的 head（真装配现读 GitHub `readPull`）必须等于责任 head——责任行 `mergeCommit` 非空（合并收尾会回填最终合并号）、最终头 CI 齐绿、模型 evidence、PR 自述都不证明旧头已合，旧头只走同单同 PR 的 supersede；责任每条原文义务各要一项来源一致（platform / run-history）的读证，run-history 还要有效时间范围，一项事实盖不住两项义务。没装配、读失败、unknown、缺范围一律记 unverified 重试（复用既有 24 小时有界预算），不调结清、不关单、不转人。**当前真装配的义务来源分类和运行记录读方都没有**（不靠关键词猜），所以 `real/park-triage.ts` 的读方只给已合头，各义务 need/got 为 unknown，生产上自动 settle 暂时一律保留责任：结构化义务分类和运行记录只读来源是 #3579 的欠项。历史 settle 记录不改。

## 版本更新日志

- `jobs/changelog.ts` / `real/changelog.ts`（#3110）：每天 06:30（北京时间）按主线缺版一次补齐 v4 起已收口版本，只写 CHANGELOG.md，复用 `real/ci-timings.ts` 的 `openManagedFilePr` 受管模板，分支 `changelog/v<N>`。法国发布历史只读 release.sh 的 `.history`；没有文件、坏行、收口头/日期/单读不全均记 schedule_runs failed，不开部分 PR。合并对账仅对自仓、同仓分支、真实引擎开合且只改该文件的 PR 免队列，其他仍报。
- `scanned` 统一计实际读全并逐条判断适用性的已关闭里程碑数，`found` 计需要补日志的版本数；只有旧版本或全部已补齐也按真实扫描数记 ok。没有已关闭里程碑时记 unscanned 和原因并正常收尾；读取失败仍记 failed，不用零扫描冒充成功。

## 固定版本宿主工具

- Go 的 `via: tar` 和固定 `version` 由现有 `cli-upgrade-main.ts` 管理，只在发布/空闲排空窗口运行；实现位于 `cli-upgrade-go.ts`。仅 Linux amd64/arm64，官方精确版本清单与 SHA256 校验，完整新树暂存、实际 `go version` 验真，最后原子替换 `/usr/local/bin/go`。
- 必须核对 intake 固定 PATH 的实际入口和版本；`/usr/local/go/bin/go` 遮住受管入口时明确失败，保留现有安装，不放宽 readiness。旧树和入口备份保留，失败不记健康、不自动重试。

- 删树前置：`real/preserve-worktree.ts` 由任务收尾、建树前替换旧树与小时清扫共用。干净未发布提交先保存完整 bundle，最终落盘回读并在独立空仓恢复核对 HEAD/内容树/引用。复杂未提交、未跟踪、stash、git 目录里还挂着的操作状态（没并完的合并、挑拣、回退、变基、二分、ORIG_HEAD 等，工作区干净也算）先打受限快照（工作文件、原始索引及其标志、resolve-undo 指的三层内容、stash 全部记录、合并头和序列状态引用的对象闭包），独立空仓恢复对上、原树身份和指纹没变、并且删除前再次确认没人用，才允许原来的清理入口继续。删除必经点不论干净还是复杂都现核进程 cwd；生产统一经固定 root 帮手扫描所有 TGID/TID（含跨 UID、sudo 和 leader 退出仍活的线程），不按属主或祖先豁免；活线程 cwd、身份或枚举读不全一律确认不了，留树。初次保全的 dev/ino/uid 身份一直传到删除端，root 删除前重新完整扫描，不能临删重新认领替身。root 以逐级 FD 和同文件系统私有隔离事务认领原对象，持久回执完整才算删除成功；未结事务进入小时对账。正常临时目录在 adopt 回执捕获身份，finally 必须原样传回；历史 attach 没有原始身份时留树，仅有任务/TTL门的孤儿回收入口可显式认领当前对象。测试经 `processLook`/`treeProcessLook` 换成夹具，不跟 CI 机器的进程表走；生产不传。删除前除了没结束的会话，还要看任务和子任务工作流；查不清不当成没人用。调用方只豁免自己这一条工作流，避免任务收自己的树时被自己挡死。非 Git 成果、读失败、快照或恢复失败留原树。旁边已有的备份不是回执。受管截图仍走 `real/shots.ts`，只排除逐文件核对内容一致的已保全图片。

- 复杂快照的 capture、verify、recheck 统一走专用有界流，普通 `UserExec` 仍限 110MiB；v3 帧和拆组件归档字节保持兼容。状态元数据限 32MiB，整帧（含帧头）和单轮临时组件各限 1GiB，文件路径最多 100000、对象最多 250000；PACK 与 BUNDLE 内的 PACK 各先逐块检查单对象及 delta 目标不超过 256MiB、实际 inflate 和目标总量各不超过 1GiB，再独立核验；这趟预算解析每次调用只用一个私有 64KiB 顺序预读缓冲（对象头和 zlib 输入共用，按 bytesWritten 推进，文件字节只读一遍，读取量随包长而不随对象数放大，`test/real/complex-snapshot-pack-budget.test.ts` 钉住），不做跨调用缓存。完整 END 前只落隔离组件，原树不写；恢复目标文件累计不超过 1GiB。浅仓（含浅仓的链接工作树）不支持：v3 不保留 shallow 边界，对象闭包不完整，`collect` 一开头（先于读树、打包、出帧）用 `rev-parse --is-shallow-repository` 现测，每次调用都测、不缓存；是浅仓、命令失败、输出不是 `true`/`false` 都明确失败留原树，`gitEnv` 清掉 `GIT_SHALLOW_FILE`、`GIT_COMMON_DIR` 防环境改写浅边界判定（`test/real/complex-snapshot-shallow.test.ts`，仅 Linux）。这只是提前识别，不支持浅历史保全，不 fetch/unshallow。准备和主命令共用 240 秒，取消或失败后的临时事务按本次 token 与已确认 dev/ino/uid 清理，共享原 10 秒收尾；身份变或收尾读不全明确留待核验，不生成成功回执。

- 复杂快照源采集仍只读 refs/reflog、索引和操作状态的对象闭包，不纳入无关垃圾对象；恢复末次采集仅在全新隔离仓用有界 `cat-file --batch-all-objects` 实读全部物理对象，再核类型/大小并严格比较。普通 reflog 不重建，其遗留对象仍须在实际清单中；额外对象也不按声明裁剪。PACK 在 BUNDLE 前独立核全的顺序不变（`test/real/complex-preserve.test.ts`、`complex-snapshot-batch.test.ts`）。

- 完整检出成功回执由 `placeVerifyCheckout.onCompleted` 在 ensureHead、checkout、最终取消守卫后独立写入，不借撤卡证明成功；写失败诊断证据未知，不改 full 或验收裁决。每次物理调用新 receiptId，调用者确实已分配才传 verifier runId。
- 看门狗提醒的受控修复（#3033，`packages/api/src/alert-repair.ts`）按看门狗的提醒键、标题和撤卡口径现算动作、核验：改 `jobs/watchdog.ts`、`jobs/idle-running.ts`、`real/watchdog.ts` 里的键格式（`watchdog:idle-running:<任务编号>`、`watchdog:release:train:<提交>:running|failed`）、阈值或撤卡条件，要同步 api 的 `IDLE_PREFIX`、`RELEASE_KEY` 和 core 的 idle-running 判据；`packages/api/test/alert-repair.test.ts` 用真看门狗造提醒，会因此变红。
- 看门狗只负责报和撤卡，不执行修复；修复动作、幂等、核验和交给修复开单都在 api 里，引擎这边不为它加开关，也不改合并闸、冷验收、改标准路径这些护栏。
