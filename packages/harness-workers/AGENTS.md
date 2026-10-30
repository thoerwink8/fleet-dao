# packages/harness-workers：新内核的工人槽位

决定 0124 的新内核（母单 #3770，第 3 片 #3775）里起工人的那一层。第一个槽位是 Claude Code（经 reclaude）；进程起停交给 `harness-runner`，事件写进 `harness-store` 的 `fleet2.events`。不依赖旧包，从旧 `adapters/src/{env,claude-code/args}.ts` 复制改写。

## 不变量

- 每轮起止各记一条事件，流名 `worker:<runId>`：`worker.spawned` 在起进程之前写，带我们给的会话号（A3：进程没起来、应答丢了也知道续哪个）；`worker.settled` 带结局（退出码、叫停原因、停在哪一步、收尸剩几个）。
- 令牌只进工人临时目录里 0600 的 MCP 配置文件，不进命令行（H1：命令行谁都能列）；MCP 地址不许带查询参数。
- 工人环境每次现场构造，只抄白名单；推送凭据、像密钥的变量一律拒（`env.ts`）。对外写只经内核的 outbox。
- 影子模式起之前自检三样：只读探测没有写权限、outbox 真实处理器没装配、影子用户出网规则在。任何一样没过或没查成都不起、不记事件（`shadow.ts`）。三个探测的真实实现跟着法国部署接上（单独系统用户、nftables），这里只定判法。
- 临时目录每轮一个，跑完整个删。

## 测试

- `npx vitest run packages/harness-workers`：假执行体 `test/fake-claude.mjs` 从参数认会话号、读 MCP 配置；PGlite 跑 `fleet2` 真迁移。
- 真 reclaude 的八种情况（成功、超时、被杀、断网、重启接回、重复提交、限流、退回）在法国真机跑，命令和 `fleet2.events` 查询贴进 #3775 的 PR。
