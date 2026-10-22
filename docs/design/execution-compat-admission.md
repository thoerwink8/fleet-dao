# 执行资格兼容准入基线（版本 1 合同）

范围：#3337 本片。交「兼容基线」：让 taskWorkflow 的每个新 run 在第一个必经 local activity 上核可信来源并登记持久责任，成功时历史与旧版一模一样；并交可信终态收敛（按精确 run 的真实终态释放 admitted）。**不启用生产、不接手原任务、不等于 #3200/#3232 完成。**

## 1. 为什么复用 `decide('limits')`

taskWorkflow 的首个既有命令是 `limitsFor(undefined)` → local activity `decide('limits', {})`。首句之前没有 TaskRuntime、业务活动、cleanup。在 workflow 开头新增 patched 活动会令第一版自身回退到 pre-A 时遇到新增历史命令不兼容，故撤销该切口；准入放在**活动实现**里（worker 注册的 `decide`），workflow 侧命令序列不变。

- 成功：准入通过后原样调内层 `decide('limits', {})`，输入、输出、local activity marker、事件序列与 pre-A 工人完全相同（真实测试比对命令序列，并验证两个方向的换工人收尾）。
- 已录 limits 结果的旧 run：重放不再执行活动，**不会重新准入**；它们的准入属后续「旧 run 协议」，本片明确不覆盖，也禁止重放时悄悄管理化。
- 唯一的 workflow 代码改动是 `judgeRetrying` 失败路径多一个判型（确证拒绝直接终结），不增删命令。

## 2. 输入来源与绑定

准入入口是 `createLegacyExecutionAdmission` 返回的无参函数，来源只有：

| 字段 | 来源 |
|---|---|
| namespace / workflowId / runId / workflowType / taskQueue / isLocal / activityType | SDK 1.24.0 `Context.current().info`（可信，与宿主配置的 namespace、taskQueue、`taskWorkflow`、`decide` 严格比对） |
| 完整 Start 输入 | 对**该精确 run** 的 `GetWorkflowExecutionHistory`（首事件、单页、≤2MiB、5s、可取消；仅 `json/plain` 默认编码） |
| taskId / repo / issue | Start 输入；与 task 持久镜像的 repoId/issue 在 store 事务内核对 |
| generation | **只信 Temporal 给的 workflowId**（`:rN` 后缀）：生产 Start 输入本来就不带 generation（taskWorkflow 自己也是 `parseTaskWorkflowId(workflowId)` 取代次），所以不能要求输入自带；规则是 workflowId 须等于用输入里 repo/issue 重建出的 `taskWorkflowId(repo, issue, generation)`，输入若自带 generation 必须相等，否则 `start_identity_conflict`。`legacyMatchesTask` 的「缺省 generation 视为一致」与此同一规则 |
| operation | 固定常量 `legacy_first_limits`（本责任所属的操作＝新 run 首个 `decide('limits')`）；进入身份比较、`task_legacy_execution_admissions.operation` 列（CHECK 只允许该值）和审计；缺失或别的值 `invalid_identity`。redo/managed 操作另立，不复用 |
| 规范输入与摘要 | `canonicalExecutionInput` / `executionInputHash`，由完整原始对象算出，不信 caller 的「已核 hash」，不按当前 task 镜像重构 |

不按 workflowId 反推任务；伪造 taskId 指向库里没有的任务 → store `not_found` 拒绝。含保留字段 `execution`（任何值）一律 `managed_start_unsupported`，不降格为 legacy。

## 3. 状态与结果

| 结果 | 触发 | workflow 表现 |
|---|---|---|
| allowed | store 在**同一持久事务**登记（或幂等重放）legacy 责任 | 正常继续，limits 原样 |
| denied（确证） | 输入非法、身份冲突、`managed_start_unsupported`、task 不存在、已受管（`managed_requires_operation`）、store 明确拒绝 | local activity 抛 `ApplicationFailure`（type=`ExecutionAdmissionDenied`，nonRetryable，details=[固定码]）；`judgeRetrying` 按 type+nonRetryable 判型（不看 message）原样抛出，workflow 失败于 TaskFlow 构造前：零业务、零 task 镜像、零 cleanup、无退避 timer |
| unknown | History/DB/子进程不可读、超时、容量满、context 缺失 | 抛可重试 `ExecutionAdmissionUnknown`；local activity 先自重试 3 次，再由 `judgeRetrying` 以 15s 起翻倍、封顶 600s 退避，**每轮重新核**，不缓存放行；与拒绝分列，fail-closed |
| cancelled | 活动信号已取消（工作流取消、超时、工人收场），不论 admit 返回什么或抛什么 | 以 SDK 约定的 `CancelledFailure` 结束（`judgeRetrying` 的取消分支原样上抛）；**不当成未知去重试**、不报警、不放行；取消前已提交的责任照常保留，迟到的 admit 结果不再放行 |

未知的报警承接：活动在抛出前经 `AdmissionAlertRecorder.record` 写本地 spool（`admission-alert-spool`，按 namespace/workflowId/runId 去重，一个 run 一条）。`createEngineWorker({ admission: { transfer: { sink, intervalMs } } })` 给了 `transfer` 才起移交循环：随 `worker.run` 起（一个 Worker 一次）、`run` 结束必停，不新增实例或调度器；移交由 PG 通知承接，写失败 failure details 标 `unrecorded`，不报「已送达/已拒绝」。不给 `transfer` 就只落本地 spool。

## 4. 初始化与 legacy 互斥、释放凭证

- legacy 准入与 managed 初始化的决胜都在 store 的同一持久事务边界（#3341，真实 PG 双连接交错测试在 `store/test/task-execution.real-pg.test.ts`）：`admitLegacyExecution` 遇已有 control → `managed_requires_operation`；`createManagedTaskFromIssue` 只能**原子新建** task+control+birth+audit，已有 task 永不初始化（`existing_task_forbidden`）。第一片因此不存在「旧对象被管理化」的路径——旧对象初始化被强制拒绝，**缺口**：旧任务（已有 task 行）尚无管理化入口，留给后续旧 run 协议。
- legacy 责任清单无 TTL、owner、终态释放入口。未知、TTL、owner 消失、describe missing 都不能释放已发/已准入责任。
- **终态收敛（本片已做，仅 managed operation）**：Store `closeExecutionRun`（`ExecutionIdentity + runId + terminal`）在同一事务里 CAS：`phase=admitted` 且 `admittedRunId===runId`、控制行 epoch/revision/当前指针不变，写 `resolved(run_completed|run_failed|run_cancelled|run_terminated|run_timed_out)` + 审计；同 run 同终态重放幂等，换终态/换 run 是 `identity_conflict`；`dispatching`（没有 run 绑定）永远 `proof_required`；`reserved` 与已撤销的 `phase_conflict`。DB CHECK 钉死 `run_*` 必带 `admitted_run_id`、派发/接纳时刻。
- **谁能调它**：只有 engine 的 `real/execution-run-terminal.ts`（`structure.test.ts` 钉住 `closeExecutionRun` 只出现在 Store 实现和它里）。它向 Temporal `DescribeWorkflowExecution` 按精确 namespace/workflowId/runId 取真实状态，返回的 run/workflowId/类型/队列任一对不上＝`identity_conflict`；只有 COMPLETED/FAILED/CANCELED/TERMINATED/TIMED_OUT 才调 Store。运行中、**ContinuedAsNew**（续跑的新 run 需另行准入，不能用首 run 的关闭释放）、找不到、读失败、超时、取消、未知状态数值都不释放。Store 调用抛错＝未知（事务可能已提交），由下一次幂等调用核实。
- **本片仍欠**：受管（managed）Start 的完整适配（保留字段 `execution` 的 Start 构造、reserve→dispatch→start→admit 的编排入口）；因为本片不启用 managed，仓内三处 Start（`api/src/temporal.ts`、`engine/src/real/intake.ts`、`engine/src/real/park-triage.ts`）都不带 `execution`，由 `test/structure.test.ts` 钉住（防意外绕过，不是恶意代码沙箱）。legacy 责任（旧 run）的终态释放同样未做，属「旧 run 协议」。

## 5. 装配与队列决定

`createEngineWorker({ admission })` 显式传入才包 decide；默认不传，行为与旧版逐字节一致。**不新增 queue、不新增 Worker 实例**：同一 worker、同一生命周期/资源槽，定时器与 intake 不复制。理由：新 queue 需要冻结版本 1 合同的完整处理器与 in-flight 收尾，而本片没有 V1 合同的 Start；「只识别但不能继续」不算回退能力，所以不预建空队列。未来 V1 必须用**新 queue**：兼容版和 pre-A 工人都不轮询它，不会消费新协议（已测）；兼容版在同一队列看到带 `execution` 的 Start 一律拒绝（已测）；在未来队列里真实在途的 V1 候选 run，兼容版仍能凭它的真实终态收尾释放 admitted（已测：完成、terminated 可释放，ContinuedAsNew 与运行中不释放）。

## 6. 混部与回退顺序

1. 发兼容版（不传 `admission`）：与 pre-A 等价。
2. 传 `admission`：新 run 经准入；pre-A 工人仍可混部，其接到的 run 不被准入（缺口，由「启用」单以全量切换完成前提保证）。
3. 回退到 pre-A：已准入 run 的历史无新增命令，可重放并收尾；已登记责任持久保留，不因回退释放（已测：兼容版起并准入、pre-A 收尾，以及 pre-A 起、兼容版收尾，命令序列与单工人一致）。
4. 迁移 0103（`operation` 列带默认值、`phase_fields` 放宽）只加不删，旧代码照样能写；回退不撤迁移。
5. 启用必须另单，前置：真实发布版本证据 + 无 pre-A 工人在轮询的可判定核验；不按日期强行启用，不「作废」未决责任。

## 7. 验证矩阵

| 层 | 文件 | 说明 |
|---|---|---|
| Store 合同（Memory / PGlite / 真实 PG） | `store/test/task-execution-contract.ts`、`task-admission-contract.ts`、`task-execution-schema-contract.ts` | 三套后端同一份；含终态释放 CAS、幂等、冲突、`operation` 与新 CHECK |
| 真实 PG 双连接 | `store/test/task-execution.real-pg.test.ts` | 终态证明竞争、迟到 admit、审计 trigger 失败整笔回滚（含 `close`） |
| 真实 Temporal + PgStore | `engine/test/execution-compat-admission-real.test.ts` | 放行/拒绝/未知/幂等/取消/混部回退/V1 队列/终态收敛/worker 装配；temporal 台无真库变量时 PgStore 跑 PGlite 真迁移，设了变量连真库 |
| 单元 | `engine/test/admitting-decide.test.ts`、`execution-run-terminal.test.ts`、`structure.test.ts` | 判型、取消、终态读取、结构边界 |
