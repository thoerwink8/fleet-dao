# packages/harness-contract：新内核的契约

决定 0124 的新内核（母单 #3770）接口层唯一一份契约：事件信封和类型、外部动作种类、操作键。存储、接口、驾驶舱都只认这里；字段改了先改这里。

- 认不出的 `schemaVersion` 一律拒（`parseEvent`），不猜、不降级。加字段不升版本，改含义或删字段才升。
- 本机审批（#3932）：`session.approval`。加类型不升 `SCHEMA_VERSION`。同一 approvalId 先记 pending，决定再追加一条，不改旧事件。
- 操作键 `opKey` 带所有权令牌：换了所有者就是另一件事，旧所有者的重试对不上。
- 工人过程（#3781）：流 `transcript:<runId>`，事件 `transcript.assistant|tool_use|tool_result|result|dropped`，载荷形状和截断上限（`TRANSCRIPT_*`）在文件末尾。信封的 `schemaVersion` 沿用 `SCHEMA_VERSION`：加字段不升版本，改含义才升。
- 工人状态的判读规则（#3781 收尾）：`src/worker-state.ts`（子路径 `@fleet-dao/harness-contract/worker-state`），纯函数、不依赖 zod。驾驶舱前端给会话列表分组、接口层数「卡住」个数都 import 它，规则只在这一处，别在两边各写一份。
- 真执行（#3783）：`issue:<owner/仓>#<单号>` 流（`issueStream`）上记 `publish.pushed`（推了分支）、`publish.pr.opened`（开了 PR）、`task.released`（按状态切回），整条链能按单号查。
- hostd 帧协议（#3871）：`src/hostd-frames.ts`（子路径 `@fleet-dao/harness-contract/hostd-frames`）是内核和宿主帮手 hostd 之间 stdio 帧的唯一定义。`frames/` 是它导出的 JSON Schema、样例帧、必须被拒的帧（`node packages/harness-contract/src/bin/export-frames.ts` 重写，测试核对没漂）；TS 和 Rust（`crates/hostd/tests/frames.rs`）各读这一个目录对拍。改帧先改这里再重新导出，改字段要升 `HOSTD_PROTOCOL_VERSION`。
- 只依赖 zod，不依赖任何旧包。
- 测试：`npx vitest run packages/harness-contract`。
