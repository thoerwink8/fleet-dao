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
