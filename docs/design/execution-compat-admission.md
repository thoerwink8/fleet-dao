# 执行资格兼容准入基线（版本 1 合同）

范围：#3337 本片。只交「兼容基线」：让 taskWorkflow 的每个新 run 在第一个必经 local activity 上核可信来源并登记持久责任，成功时历史与旧版一模一样。**不启用生产、不接手原任务、不等于 #3200/#3232 完成。**

## 1. 为什么复用 `decide('limits')`

taskWorkflow 的首个既有命令是 `limitsFor(undefined)` → local activity `decide('limits', {})`。首句之前没有 TaskRuntime、业务活动、cleanup。在 workflow 开头新增 patched 活动会令第一版自身回退到 pre-A 时遇到新增历史命令不兼容，故撤销该切口；准入放在**活动实现**里（worker 注册的 `decide`），workflow 侧命令序列不变。

- 成功：准入通过后原样调内层 `decide('limits', {})`，输入、输出、local activity marker、事件序列与 pre-A 工人完全相同（`test/execution-compat-admission-real.test.ts` 比对事件类型序列并重放旧历史）。
- 已录 limits 结果的旧 run：重放不再执行活动，**不会重新准入**；它们的准入属后续「旧 run 协议」，本片明确不覆盖，也禁止重放时悄悄管理化。
- 唯一的 workflow 代码改动是 `judgeRetrying` 失败路径多一个判型（确证拒绝直接终结），不增删命令。

## 2. 输入来源与绑定

准入入口是 `createLegacyExecutionAdmission` 返回的无参函数，来源只有：

| 字段 | 来源 |
|---|---|
| namespace / workflowId / runId / workflowType / taskQueue / isLocal / activityType | SDK 1.24.0 `Context.current().info`（可信，与宿主配置的 namespace、taskQueue、`taskWorkflow`、`decide` 严格比对） |
| 完整 Start 输入 | 对**该精确 run** 的 `GetWorkflowExecutionHistory`（首事件、单页、≤2MiB、5s、可取消；仅 `json/plain` 默认编码） |
| taskId / repo / issue / generation | Start 输入；generation 与 workflowId 解析值、`taskWorkflowId(repo, issue, generation)` 三方一致，否则 `start_identity_conflict` |
| 规范输入与摘要 | `canonicalExecutionInput` / `executionInputHash`，由完整原始对象算出，不信 caller 的「已核 hash」，不按当前 task 镜像重构 |

不按 workflowId 反推任务；伪造 taskId 指向库里没有的任务 → store `not_found` 拒绝。含保留字段 `execution`（任何值）一律 `managed_start_unsupported`，不降格为 legacy。

## 3. 状态与结果

| 结果 | 触发 | workflow 表现 |
|---|---|---|
| allowed | store 在**同一持久事务**登记（或幂等重放）legacy 责任 | 正常继续，limits 原样 |
| denied（确证） | 输入非法、身份冲突、`managed_start_unsupported`、task 不存在、store 明确拒绝 | local activity 抛 `ApplicationFailure`（type=`ExecutionAdmissionDenied`，nonRetryable，details=[固定码]）；`judgeRetrying` 按 type+nonRetryable 判型（不看 message）原样抛出，workflow 失败于 TaskFlow 构造前：零业务、零 task 镜像、零 cleanup、无退避 timer |
| unknown | History/DB/子进程不可读、超时、容量满、取消、context 缺失 | 抛可重试 `ExecutionAdmissionUnknown`；local activity 先自重试 3 次，再由 `judgeRetrying` 以 15s 起翻倍、封顶 600s 退避，**每轮重新核**，不缓存放行；与拒绝分列，fail-closed |

未知的报警承接：活动在抛出前经 `AdmissionAlertRecorder.record` 写本地 spool（`admission-alert-spool`，按 namespace/workflowId/runId 去重，一个 run 一条），`startAdmissionAlertTransfer` 以固定间隔逐条移交 PG 通知（一个进程只起一次）。取消不报警。报警写失败时 failure details 标 `unrecorded`，不报「已送达/已拒绝」。

## 4. 初始化与 legacy 互斥、释放凭证

- legacy 准入与 managed 初始化的决胜都在 store 的同一持久事务边界（#3341）：`admitLegacyExecution` 遇已有 control → `managed_requires_operation`；`createManagedTaskFromIssue` 只能**原子新建** task+control+birth+audit，已有 task 永不初始化（`existing_task_forbidden`）。第一片因此不存在「旧对象被管理化」的路径——旧对象初始化被强制拒绝，缺口是：旧任务（已有 task 行）尚无管理化入口，留给后续旧 run 协议。
- legacy 责任清单无 TTL、owner、终态释放入口。未知、TTL、owner 消失、describe missing 都不能释放已发/已准入责任（`dispatching/admitted` 仍 `proof_required`）。
- **本片欠**：可信终态收敛（按精确 run 的真实终态 + CAS 释放 `dispatching/admitted`，审计同事务）和受管（managed）Start 的完整适配未做；因为本片不启用 managed，仓内三处 Start（`api/src/temporal.ts`、`engine/src/real/intake.ts`、`engine/src/real/park-triage.ts`）都不带 `execution`，由 `test/structure.test.ts` 钉住（防意外绕过，不是恶意代码沙箱）。

## 5. 装配与队列决定

`createEngineWorker({ admission: { admit, alert } })` 显式传入才包 decide；默认不传，行为与旧版逐字节一致。**不新增 queue、不新增 Worker 实例**：同一 worker、同一生命周期/资源槽，定时器与 intake 不复制。理由：新 queue 需要冻结版本 1 合同的完整处理器与 in-flight 收尾，而本片没有 V1 合同的 Start；「只识别但不能继续」不算回退能力，所以不预建空队列。未来 V1 必须用**新 queue**（pre-A 工人不轮询，不会消费新协议）；兼容版在同一队列看到带 `execution` 的 Start 一律拒绝（已测），不轮询的队列上 Start 不被消费也不准入（已测）。

## 6. 混部与回退顺序

1. 发兼容版（不传 `admission`）：与 pre-A 等价。
2. 传 `admission`：新 run 经准入；pre-A 工人仍可混部，其接到的 run 不被准入（缺口，由「启用」单以全量切换完成前提保证）。
3. 回退到 pre-A：已准入 run 的历史无新增命令，可重放；已登记责任持久保留，不因回退释放。
4. 启用必须另单，前置：真实发布版本证据 + 无 pre-A 工人在轮询的可判定核验；不按日期强行启用，不「作废」未决责任。
