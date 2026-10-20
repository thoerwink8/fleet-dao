# #3413 放弃遇被缓冲的 runSegment 完成：修复前的固定历史

两份 `.history` 是 SDK `History.toJSON` 的 JSON，录在修复前的 `task-runtime.ts`（`1a272e77` 的父提交 `d84505dc`，无 `abandon-cancel-after-buffer` 标记）上，用可跳时间测试服务端和合成假端口，跑的是 `push-handback.test.ts` 里 worker replacement 用例同样的步骤：第一个 worker 停在原权限停点，第二个 worker 接上（`maxCachedWorkflows: 0`）交还新请求，第二段 `runSegment` 开始后发放弃。录完只按 `record.ts` 的 `scrub` 把工人身份换成 `recorder`、主机名换成 `recorder-host`，之后不许重录覆盖。`abandon-buffered-replay.test.ts` 先核 SHA-256 和事件结构，再拿现在的代码重放。

| 夹具 | 场景 | 录制 run | 事件数 |
| --- | --- | --- | --- |
| `stuck-before-fix.history` | 用 `test/abandon-buffer-hold.ts` 按住放弃信号那一次工作流任务的完成，放行第二段并等它离开待办表，再放行。墙钟 20 秒后 describe 仍是 RUNNING，待办活动 0；历史停在事件 303 `WorkflowTaskStarted`，第二段（事件 300）没有 Started/Completed/CancelRequested | `a3051b16-dacb-486a-b637-d57bd62a0d53` | 303 |
| `abandon-mid-segment-before-fix.history` | 不按住，第二段还在跑时放弃：放弃任务完成后紧接 `ActivityTaskCancelRequested`（第二段），run 以 abandoned 收场 | `5baabb3f-95c5-4b0f-b1f8-e603c8df1fbe` | 330 |

第一份说明放弃之后的 `result()` 可以卡死：工作流任务收不了场。它是本机按住放弃任务录的 run `a3051b16-dacb-486a-b637-d57bd62a0d53`，不是 CI run 39392992046（那次没留历史），也不是 `worker-replacement-3413/` 里原用例停在 `first-worker:parked-query` 的那次（run `6385a827-f825-4d12-8bd9-d3e2351b6db6`，`self-check-own-timeout` 的 TMPRL1100）。不能拿这两份互相冒充，也不能据此说原 CI run 一定是这个交错。另一台 push-handback-contract 的 park-kind 重放错误（#3258）不是这里的任何一条 run。
