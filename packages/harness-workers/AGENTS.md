# packages/harness-workers：新内核的工人槽位

决定 0124 的新内核（母单 #3770，第 3 片 #3775）里起工人的那一层。第一个槽位是 Claude Code（经 reclaude）；进程起停交给 `harness-runner`，事件写进 `harness-store` 的 `fleet2.events`。不依赖旧包，从旧 `adapters/src/{env,claude-code/args}.ts` 复制改写。

## 不变量

- 每轮起止各记一条事件，流名 `worker:<runId>`：`worker.spawned` 在起进程之前写，带我们给的会话号（A3：进程没起来、应答丢了也知道续哪个）；`worker.settled` 带结局（退出码、叫停原因、停在哪一步、收尸剩几个）。
- 工人每一步落库（#3781，`src/transcript.ts`）：stdout 的 stream-json 每行经 `runProcess` 的 `onFrame` 交给 `TranscriptWriter`，拆成 `transcript.assistant` / `tool_use` / `tool_result` / `result` 写在**另一条流** `transcript:<runId>`（不写进 `worker:<runId>`：那条流的 seq 是槽位自己数的，掺几百条会乱；驾驶舱会话页的 `tail` 只读 `session:<号>`，也不被挤）。文字**先过 `redact`（槽位那一把，含 MCP 令牌和宿主环境里的密钥）再按字节截断**，顺序不能反（先截会把令牌截成认不出的半截、漏出前缀）：助手的话和工具结果各 4KB，工具参数 JSON 1KB，参数摘要 160 字一行；thinking、system、限流等行不落。写入批量：攒到 50 条或 1.5 秒写一个事务；`runProcess` 在子进程退出收尸后才 resolve，槽位在 `finally` 里 `close()` 把攒着的写完，然后才记 `worker.settled`（带 `transcript: {rows, bytes, dropped, lost, batches}`），所以被叫停、超时、被杀都不丢最后一批。一次运行最多 2000 条 / 6MB，超了丢掉并末尾记一条 `transcript.dropped`；写库连续失败不抛，记进 `lost`（过程丢了不拖垮起止记账）。形状见 `harness-contract` 的 `Transcript*`。
- 令牌只进工人临时目录里 0600 的 MCP 配置文件，不进命令行（H1：命令行谁都能列）；MCP 地址不许带查询参数。
- 工人环境每次现场构造，只抄白名单；推送凭据、像密钥的变量一律拒（`env.ts`）。对外写只经内核的 outbox。
- 影子模式起之前自检三样：只读探测没有写权限、outbox 真实处理器没装配、影子用户出网规则在。任何一样没过或没查成都不起、不记事件（`shadow.ts`）。三个探测的真实实现跟着法国部署接上（单独系统用户、nftables），这里只定判法。
- 临时目录每轮一个，跑完整个删。
- 法国上工人以会话用户跑（接口 `sandbox.ts`，经 sudo 调帮手的真实现在 `harness-dispatch/src/scope-sandbox.ts`：起子进程只走 runProcess，#3814）：内核以 `fleet` 建的临时目录写完 MCP 配置后经 `fleet-agent-scope adopt` 交出去；跑完先按编号 `stop` 收掉 scope（会话用户的进程运行层认不到），再按 adopt 回执的身份 `remove`。收尾结局记 `worker.cleaned`，收不干净照实记、不抛。不给 sandbox 就是同一个用户（本机、CI）。

## 测试

- `npx vitest run packages/harness-workers`：假执行体 `test/fake-claude.mjs` 从参数认会话号、读 MCP 配置；PGlite 跑 `fleet2` 真迁移。
- `test/transcript.test.ts`：`test/fixtures/stream-sample.jsonl`（真实格式的 stream-json 样例，脱敏；令牌占位 `__TOKEN__` 测试里现拼）覆盖解析、截断打码、批量、被叫停也写掉；假执行体 `FAKE_MODE=replay` / `replay-hang` 按 `FAKE_REPLAY` 逐行回放样例。
- 真 reclaude 的八种情况（成功、超时、被杀、断网、重启接回、重复提交、限流、退回）在法国真机跑，命令和 `fleet2.events` 查询贴进 #3775 的 PR。
