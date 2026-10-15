# 渠道插头短索引

全文在 git 历史。下面每条是代码、测试或现行文档还在点名的「应当」。

### 2.2 怎么无头起

Claude 会话经 `--settings` 带上调工具前的钩子（发布目录里归 root 的 `agents/hooks/pretool.mjs`）。命令和 Read、Grep 碰到密钥文件就拦。钩子崩了要变成退出码 2，脚本不在就不起会话。`--bare` 经 reclaude 会认证失败。环境里不许有 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`，有值就绕开 reclaude。

### 2.5 / 3.3 / 4.5 / 6.5

报错原文样本和现行判法在 `packages/engine/test/failure/fixtures/failure-samples.json`。

### 4.5 Cursor 花费

终帧没有花费字段。usage 只算这一轮；花费只认 Dashboard API。本地 SQLite 里的 token 是上下文窗口，不是计费（CU-08）。

## 还在点名的条目

- **CC-05** `rate_limit_event` 里 `status:"rejected"` 且没有 `unifiedWindows`：判账号额度已用满并记下 resetsAt，不许判没查成。
- **CC-07** `reclaude org use` 退出码 1：号可能已经切了。回读 `org list`，不对就切回原号。
- **CC-09** 点了模型就要回读 `init.model`，不一致就停会话。别名配错是静默的。
- **CC-10** 非 Claude Code 的流量穿过 reclaude 代理，大约 90 秒后设备被解绑，而且不能自行恢复。去掉 `MIRASIM_NO_AGENT_EGRESS` 属于这一类。
- **CC-13** 跑哪份 claude 以 reclaude 配置目录里 `claude.path` 的绝对路径为准。
- **CU-01** 新工作树不带 `--trust`，cursor-agent 会被 Workspace Trust 拦下。适配器固定带 `--trust`。
- **CU-02** ACP 目录里的模型串和 `cursor-agent models` 列表不同名。别按旧形状猜，猜错会被拒 `model_unavailable`。
- **CU-03** Cursor 升级会删掉旧版本目录。解析顺序是 `current`，然后最新的数字目录。钉死一个旧目录会起不来。
- **CU-05** prompt 超过约 128KB 就走 stdin，不拼进 argv（`spawn E2BIG`）。
- **CU-08** 见上面 4.5。init 里的 model 是界面名，不是计费。
- **GK-03** grok 的旗标放在子命令前面。放在后面会 `unexpected argument` 并退出 2。
- **GK-04** 免确认用 `--always-approve`。`--permission-mode auto` 每条外部命令还要确认。
- **GK-05** 模型只从路由表来。CLI 默认值会换代，起会话后回读终帧里的实际模型。
- **GK-08** grok.com 回 402 或撞周限：判账号额度（停这个池），不是上游抖动。
- **GK-12** `--always-approve` 管不到三张卡：目录信任（`GROK_FOLDER_TRUST=0`）、模型反问（`GROK_ASK_USER_QUESTION=0`）、计划模式（`--no-plan`）。`grok agent stdio` 只收 `--always-approve`，另外两张走环境变量。
- **PI-02** 经 Mirasim 起 pi 时，model 只认 `profile:<BYOK 档 id>`。别的写法会被服务端静默置空。
- **KM-01** 不点名也要声明期望模型，起后回读快照里的 model，不符就停。kimi 点名写 roster 里的 `kimi-code/k3`，不写 `kimi-k3`。
- **GEN-05** 没有工具在跑、进度指纹连续 360 秒不变，才判停滞。有工具在跑（测试跑很久）不算。
- **GEN-08** 单元测试结构上碰不到真执行体。只有生产入口显式放行。
- **GEN-10** 广播或共享事件流里，不属于本会话的帧一律不认。
- **GEN-16** 等人回答单独成一态。重试只会再问一遍。

## pi

经 Mirasim 起 pi、不点名模型时，吃服务端默认腿，账本回显 kimi-k3。点名只认 `profile:<BYOK 档 id>`（PI-02）。

## dsh

dsh 执行体认 `deepseek-flash`（`deepseek-v4-flash` 是别名）。旧档停用过。MS-30 那次实测，中继上没有这个上游。

## 八、Mirasim 帧

连接读本机回环令牌文件，服务每次起停都换。

| 动作 | 发 | 收 |
|---|---|---|
| 握手 | `clientHello` + `getState` | `state`（含 `version`、`agentsAvailable`）。不会自己推 |
| 起会话 / 续跑 | `prompt`（`agent`、`workdir`、`route` 为 local/cloud/null、可选 `model` / `effort` / `sessionKey`、`clientRef`） | `accepted`（`sessionKey` 形如 `<agent>:<uuid>`）或带本次 `clientRef` 的 `error` |
| 读状态 | 另开一条连接 `subscribe` | `snapshot` 或 `session` 补丁 |
| 停 | `stop` | 只在失败时回 `error`。送到没有要看它翻不翻终态 |

账本在 `~/.mirasim/traffic/<会话 uuid>/index-*.ndjson`。名册帧见 [quota.md](quota.md)。

- **MS-01** 不钉手打的服务端版本。在役进程自报的版本和升级器 promote 的不一致就判红。
- **MS-02** 先发 `clientHello` + `getState`。干等 state 会超时。
- **MS-03** 推送不保证送到发起连接。读状态必须新开连接 `subscribe`。
- **MS-04** `getSnapshot` 经常读不到刚起的会话。读不到不是「没有」。
- **MS-05** 名单里的状态看 state / phase / observedState，不是 runState。
- **MS-06** 名单被截断、`hasMore` 或超时：「没有会话」是没查成，不能据此删或派。
- **MS-07** 名单和握手用单独的更长预算。负载高时别把慢判成死。
- **MS-08** 起一个 codex 会话会把单线程堵大约 40–58 秒。建连要重试到大约 60–90 秒。
- **MS-09** `route=local` 而本机没有那个执行体的账号：合成 422，零请求。
- **MS-10** `phase=done` 且 `error` 非空就是失败。死因写在 error 里。
- **MS-11** `incomplete` 也是终态。
- **MS-12** 名单里 `open:false` 不能当结束。无头在跑的 grok 可以是 `open:false`。
- **MS-13** `record.json` 的 `runPid` 是 mirasim-server 自己的 pid，不能拿来判会话进程死活。
- **MS-14** 服务端升级后读回 missing 的旧租约要能了结，不能永久占树。
- **MS-15** `stop` 之后大约 3 秒才翻终态。
- **MS-16** 没有 error 帧不等于送到了。连接断了也没有回帧。没看到终态就是没查成。
- **MS-17** 续跑是同一条 prompt 帧带上已有的 `sessionKey`。`continue` 和 `continueFrom` 不起作用。
- **MS-18** prompt 发出去没收到 accepted：按工作目录和起针时间去 `~/.mirasim/sessions` 对账，不许重发。
- **MS-19** 给 claude 注入 `ANTHROPIC_BASE_URL`、给 codex 注入代理，或借用 reclaude 出网，会架空上游或解绑设备。
- **MS-20** 服务端的 env 在启动时定死。改了用户级 env 或 PATH，不重启就不生效。
- **MS-21** 有在途回合时改 `agentLaunch` 会把在途回合杀掉。
- **MS-22** 改设置只能走 ws `applyConfig`。直接写 setting.json 会被内存态覆写。
- **MS-23** 工作区挂着很多 worktree 时，服务端单线程轮询 git，起会话会堵很久。
- **MS-24** 用量回填不收敛时，内存和 CPU 会涨到 ws 瘫痪。要有上限和告警。
- **MS-25** 执行体和 Mirasim 服务在同一个 cgroup 里时，默认 `OOMPolicy=stop` 会把全部会话一起带走。
- **MS-26** 只 ping state 帧，发现不了 `listSessions` 这一路已经不回。
- **MS-27** `route=auto` 走了哪条上游，只认账本的 `upstreamHost` / `viaRelay`。会话成功了不能反推。
- **MS-28** 中转不许反代，只能用它的客户端。
- **MS-29** 回读的模型名只多一个末尾方括号标记（例如 `[1m]`）仍是同一个模型。只剥这个标记，不放宽到前缀相同。
- **MS-30** 2026-10-01 那份实测名单里有若干 claude / codex 档和 `kimi-code/k3`，没有 haiku。`deepseek-flash` 那次中继回了 `no upstream available`。名单会过期，以服务端 modelRoster 为准。
- **MS-31** 等 accepted 的上限是起会话的总预算 `startupMs`（从起针算），不是一问一答的 `replyMs`。
- **MS-32** 中转额度用完或欠费时，通知会被当成回答：`phase=done`、`error` 为空、账本仍是 2xx。整段回答就是这条通知才判 `relay_quota_exhausted`。回答里只是提到这些词不算。
