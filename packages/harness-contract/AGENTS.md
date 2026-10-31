# packages/harness-contract：新内核的契约

决定 0124 的新内核（母单 #3770）接口层唯一一份契约：事件信封和类型、外部动作种类、操作键。存储、接口、驾驶舱都只认这里；字段改了先改这里。

- 认不出的 `schemaVersion` 一律拒（`parseEvent`），不猜、不降级。加字段不升版本，改含义或删字段才升。
- 操作键 `opKey` 带所有权令牌：换了所有者就是另一件事，旧所有者的重试对不上。
- 工人过程（#3781）：流 `transcript:<runId>`，事件 `transcript.assistant|tool_use|tool_result|result|dropped`，载荷形状和截断上限（`TRANSCRIPT_*`）在文件末尾。信封的 `schemaVersion` 沿用 `SCHEMA_VERSION`：加字段不升版本，改含义才升。
- 只依赖 zod，不依赖任何旧包。
- 测试：`npx vitest run packages/harness-contract`。
