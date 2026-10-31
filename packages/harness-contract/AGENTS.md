# packages/harness-contract：新内核的契约

决定 0124 的新内核（母单 #3770）接口层唯一一份契约：事件信封和类型、外部动作种类、操作键。存储、接口、驾驶舱都只认这里；字段改了先改这里。

- 认不出的 `schemaVersion` 一律拒（`parseEvent`），不猜、不降级。加字段不升版本，改含义或删字段才升。
- 操作键 `opKey` 带所有权令牌：换了所有者就是另一件事，旧所有者的重试对不上。
- 工人过程（#3781）：流 `transcript:<runId>`，事件 `transcript.assistant|tool_use|tool_result|result|dropped`，载荷形状和截断上限（`TRANSCRIPT_*`）在文件末尾。信封的 `schemaVersion` 沿用 `SCHEMA_VERSION`：加字段不升版本，改含义才升。
- 工人状态的判读规则（#3781 收尾）：`src/worker-state.ts`（子路径 `@fleet-dao/harness-contract/worker-state`），纯函数、不依赖 zod。驾驶舱前端给会话列表分组、接口层数「卡住」个数都 import 它，规则只在这一处，别在两边各写一份。
- 只依赖 zod，不依赖任何旧包。
- 测试：`npx vitest run packages/harness-contract`。
