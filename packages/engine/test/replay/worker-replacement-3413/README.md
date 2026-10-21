# #3413 原用例停在查停点：一次 watchdog 取证

`park-query-timeout.history.bin` 是 SDK `History` 的 protobuf 字节，`park-query-timeout.describe.bin` 是当时白名单 describe 的 JSON 字节。`identity.capture` 是取证当时的一行 JSON（SHA-256 `b525a892c762d8dc8219d50ad99562e3417953fbaa2ae272acdb2f6ac457bc51`），不格式化，避免改掉原字节。`worker-replacement-capture.test.ts` 核这三份的 SHA-256 和事件结构。不许重录覆盖，也不要把别的 run 的历史写进来替换。

| 项 | 值 |
| --- | --- |
| 用例 | `same run reconstructs business receipts after worker replacement, then accepts one new request` |
| 阶段 | `first-worker:parked-query`（watchdog，自用例开始约 50 秒） |
| workflow | `handback-0c8f4322-17be-4b14-9e92-c81f0514e949` |
| run | `6385a827-f825-4d12-8bd9-d3e2351b6db6` |
| 事件 | 30。`readTaskBrief` 完成之后工作流任务失败：`self-check-own-timeout` 的补丁标记没有对应的 change command（TMPRL1100）。随后 4 次工作流任务超时，最后停在 `WorkflowTaskStarted`。describe 仍是 RUNNING，待办活动 0。没有放弃信号 |

阶段时间线（同一次 status 帧，只含测试自己登记的阶段名）：`first-worker-create`、`workflow-start`、`workflow-started`、`first-worker:parked-query`。用例还在等第一次停点查询，没有走到交还，也没有走到放弃后的 `result()`。

这是这条原用例自己的 run。CI run 39392992046 没有留下历史，不能拿这份冒充那一次。`abandon-buffered-3413/` 是放弃那一步的另一条本机复现，不能解释这次停在查停点。push-handback-contract 的 park-kind（#3258）是别的用例、别的 run；错误种类同为 `self-check-own-timeout` 的 TMPRL1100，不能据此写成同根，也不改 `kit.ts` 里那条标记。

同一份 protobuf 用现在的工作流代码离线重放，稳定报 `DeterminismViolationError`，正文仍是上面那句 TMPRL1100。这钉的是「对不上」，不是修复。单次把原用例跑绿不能当成这次超时已修，也不许为了让重放变绿而改写这些字节。#3258 若改了标记行为、让同一份字节重放通过，只改 `worker-replacement-capture.test.ts` 里那条断言。

同文件里别的用例在并行负载下也可能停在查停点，工作流任务失败的标记是 `park-kind`。那是别的 run，不是这份 `6385a827-f825-4d12-8bd9-d3e2351b6db6`，不能拿来替换或解释这份取证。

## 机制（`la-query-split.test.ts` 钉住）

事件 4 交的第一个工作流任务只带本地活动标记（事件 5，limits 的 `decide`），同一毫秒强开事件 6 的新任务，`self-check-own-timeout` 的补丁标记（事件 9）落在新任务里。SDK core 1.24.0 只在两种情况下这样强开：心跳（工作流任务超时 10 秒的 80%；这个任务从开到交 0.3 秒，不是），或回查询时手上还有没交给工作流的本地活动结果（core-bridge `sdk-core/crates/sdk-core/src/worker/workflow/managed_run.rs`）。当时用例正在轮询停点查询。重放时 core 只往前看到下一个工作流任务为止（同目录 `machines/workflow_machines.rs` 的 lookahead），本地活动在第一个任务里就解开，工作流当场问补丁，看不到再下一个任务里的标记，于是 TMPRL1100。`maxCachedWorkflows: 0` 的工人每个任务都重放，所以一直失败、超时，用例在查停点等满。

`la-query-split.test.ts` 用最小工作流真跑出历史，再照这份字节的形状切开：本地活动之后问补丁，切开就报同一句 TMPRL1100；本地活动之后不问补丁、或在本地活动之前问，切开也重放得过。`worker-replacement-capture.test.ts` 另钉这份字节的事件 2–9 形状。这是机制，不是修复：`task.ts` 开头 `limitsFor` 回来后 `activitiesFor` 才问补丁，生产代码怎么改归 #3258，这里不动。查询撞上本地活动结果的窗口很窄，单跑难碰上，CI 负载下偶发；生产里驾驶舱查询撞上之后，换工人或驱逐缓存同样会重放对不上。

## 第二份：负载下走得慢（`slow-parked-query.*`）

本机四个测试文件并行（la-query-split、worker-replacement-capture、push-handback、history-diagnostics），原用例在 `wait:first-worker:parked-query` 等满 20 秒，失败取证：workflow `handback-219c330f-2d51-4859-8c87-780843328926`，run `d8500003-6fa1-44b5-8530-cb27b667ff2b`，测试文件为提交 a6c77390 那版（testSha256 `c754d861…`）。186 个事件里没有工作流任务失败或超时，最后一个活动是 implement 的 `selfCheck`，最后查到的 phase 是 implement。现在的代码重放得过。卡法和上面那份不同：`maxCachedWorkflows: 0` 下每个工作流任务、每次查询都整段重放，测试从起头每 50 毫秒查一次，负载下 20 秒走不到停下。`identity.capture` 那份不动，这份另存，不能互相替换。

## 原用例怎么改的

`push-handback.test.ts` 第一个工人先用假世界的 `until` 等「停下」写进假库（`saveTaskState` 的 phase `parked`，不发查询），再照旧 `parked()` 查一次拿凭据。60 秒、20 秒等待、cache0、换工人、业务断言都没变，没加重试或 sleep。这样第一段不再在走向停下的路上查询：上面两种卡法的触发都在这段。同文件的 `parked()` 也先等假库写进停下再轮询查询：本机四文件并行时 `accepted and ready do not succeed before main loop consumes; duplicate returns same receipt`（同为 cache0）在查停点等满 20 秒，最后状态 phase 仍是 implement，属第二种卡法，没有取证帧，不是这份 TMPRL1100。已停过的再查，假库里已有停下，照旧直接轮询。查询撞上本地活动结果这个生产问题本身没修（归 #3258），由 `la-query-split.test.ts` 确定钉住，不再靠这条用例偶发撞上。

## 公开 check 注解（没有 workflow/run，不替换上面的字节）

Actions 日志在这台机器上是 HTTP 403，注解里也没有 `FLEET_SYNTHETIC_HISTORY` 帧。`ci-check-runs.json` 是从公开 check-run / annotations API 原样摘的 run、job 名、head、注解路径行号和标题（用例名只在标题里），也记了各注解正文的 SHA-256。`worker-replacement-ci-annotation.test.ts` 只核这份元数据、下面三份注解原文和对应源码行。源码快照 `push-handback.d45207791e21.txt` 与本仓 `415dc14b^` 的该文件逐字节相同（该文件上次改动是 #3354）。

| 注解 | 证明了什么 |
| --- | --- |
| run 39392992046 / job 118528847472 / head `d45207791e21`，`ci-job-118528847472.annotation.txt` | 只有 `Test timed out in 60000ms`，栈停在 `push-handback.test.ts:289:3`。源码快照 `push-handback.d45207791e21.txt` 的这一行是 `it(...)` 本身，不是内部 await。注解里没有 `pollQuery`、phase、workflow、run。当时 `pollQuery` 的 20 秒要等 `read()` 返回才检查，所以这则注解定不了是查停点、Update 还是 `result()` 没返回。不能写成上面那份 TMPRL1100 |
| run 39588087499 / job 119181973185 / head `6c4d389277f9`（PR #3488，`test (5/8)`），`ci-job-119181973185.annotation.txt` | `等了 20000 毫秒还没等到：permission push park`。栈是 `support.ts:181`（抛出带最后状态的错误）和 `push-handback.test.ts:343:21`。源码快照 `push-handback.6c4d389277f9.txt` 与 `a6c7739001a4` 字节相同（SHA-256 `c754d861…`，也是 `slow-parked-query` 的 testSha256）：342 行 mark `wait:first-worker:parked-query`，343 行 `await parked(h)`。最后状态 `phase` 为 `brief`、`doing` 为读单子和需求文档、`round` 为 1，凭据是 null。查询有回包。注解没有 workflow/run，帧仍未解出。这不是 60 秒原超时，也不是 run `6385a827…`（TMPRL1100）或 `d8500003…`（implement / selfCheck） |
| 同一次原 run 的 job 118528847602（`test (8/8 · temporal)`），`ci-job-118528847602.annotation.txt` | 另一条 `60000ms`，栈在 `push-handback-contract.test.ts:233:3`。该头这一行是 `wrong H0 and exhausted original budget…` 的 `it`。注解里没有 park-kind，也没有本用例的文件名。不能拿来解释 worker replacement |

原 60 秒那次的内部 await 和 workflow/run 仍然没有。查询撞上未交本地活动结果的生产修复仍归 #3258。
