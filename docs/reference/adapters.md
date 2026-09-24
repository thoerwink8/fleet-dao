# 渠道插头手册

> **实现 `packages/adapters`（Claude Code、codex、cursor-agent、Grok 命令行、Mirasim、ACP、接口外壳等插头）之前读。** 对应设计 §四「执行模式与容量」、§八「进度看得见」、§九「执行方式」、§十四「AI 会话」。
> 讲清每种执行方式怎么无头起、能读到什么、怎么判「真开工 / 真完成」、会怎么坏、凭据是哪几种；旧系统踩过的坑逐条写成新系统的测试用例。
> 来源：旧系统审计切片 s1（2026-09-24）。版本和数字是当时的读数；标「没查成」的，开发时先真跑一针再写解析器，结果写回本手册（清单见 §十二）。全仓记法见 [README](README.md)。

## 记法与取证

- **基线**：windsurf-dao 本地 master `b1ebd88d`（下称 **WD**）；ai-gateway-stack `origin/master` `db44877`（下称 **AGS**）。不带仓名的「runner」指 WD `scripts/acp-session-runner.mjs`。
- **判例**：「判例 `名字`」是旧维护者的判例记忆（不公开），追溯以同处引的 issue、提交、文件为准。
- **本机实跑**：2026-09-24 在 Windows 开发机上对已装 CLI 做的只读或离线调用：`--version`、`--help`，以及「假 key + 不可达端点」起一针，只看首帧形状，不打任何上游、不耗额度。关键输出原文已摘进正文。
- **VPS 只读**：2026-09-24 在 `<VPS>` 上只读查看（`ps`、`--version`、`--help`、会话记录的键名）。
- **Grok 随装文档**：grok 1.0.41 自带的官方文档（`~/.grok/docs/user-guide/*.md`）。
- **占位**：`<VPS>` = 法国执行机；`<服务用户>` = 跑执行体的 Linux 用户，文中 `~` 指它的家目录；`<账号A/B>` = 订阅账号；`<回环>` = 本机回环地址。凭据只写种类，不写存放位置。
- **测试用例**：一律写成「给定……，当……，应当……」，编号前缀 `CC`（Claude Code）、`CX`（codex）、`CU`（cursor）、`GK`（grok）、`PI`、`DS`（dsh）、`KM`（Kimi）、`MS`（Mirasim）、`ACP`、`GEN`（通用）。「坑」只收有 issue / 判例 / 提交 / 实录为证的；读说明书或离线探针得到的约束单列为「说明书约束」，不冒充旧坑。

### 版本基线（2026-09-24）

| CLI | 本机（Windows 开发机） | `<VPS>`（`<服务用户>`） | 出处 |
|---|---|---|---|
| claude | 2.1.281 | 2.1.281 | `--version` |
| reclaude | 已装（没跑 `--version`：它会先同步配置并写 `~/.claude/settings.json`） | 已装，`reclaude _daemon` 在跑 | VPS `ps` |
| codex | 0.156.1 | 0.156.1 | `--version` |
| cursor-agent | 2026.09.23-86fc751 | 版本目录 2026.08.31 / 09.18 / 09.23 并存 | `--version`；`ls ~/.local/share/cursor-agent/versions` |
| grok | 1.0.41 | 1.0.41 | `--version` |
| pi | 0.87.1 | 0.87.1 | `--version` |
| dsh | 0.1.5-rc.3 | 0.1.5-rc.3（2026-09-20 时还没装，AGS `docs/MIRASIM-CHANNELS.md` §七） | `--version` |
| kimi（Kimi Code） | 0.40.1（原生二进制） | 2.1.1（npm `@moonshot-ai/kimi-code`） | `--version`；`readlink -f $(command -v kimi)` |
| devin | 3000.5.20 | 3000.11.3 | `--version` |
| mirasim-server | — | 0.0.355 | `~/mirasim-server/current/VERSION` |

---

## 〇、结论先行（给实施计划）

1. **旧系统从没用 Claude 订阅派过一张单。** 经 Mirasim 起的 claude 会话到不了 reclaude：`route=local` 时 Mirasim 判「本机没有这个智能体的账号」，合成 422、一个请求都不发；`route=cloud` 烧的是 Mirasim 中继额度（WD `docs/evidence/1521-fable-relay-execution.json`；WD `docs/execution-profiles.json` 的 `reclaude-claude-fable-5-1` 条）。直起 `reclaude -p` 的载体归 windsurf-dao#1521，2026-09-24 仍是 OPEN；WD 里直起 `claude -p` 的只有两个探测脚本（`scripts/agent-latency.mjs` 测延迟、`scripts/model-chain.mjs:41` 测模型别名），都不派工。唯一在役的 Claude 档 `claude-relay-opus-5-5` 走中继，而且它的可用证据是从 Fable 5.1「继承」的（`availability.evidenceKind: "inherited"`），目录里没有 Opus 5.5 在这条线上的真跑证据。**设计 §三 第 8 条「构建期先用 Claude 订阅额度」要的这条插头得从零写**，形态见 §二。
2. **旧系统没有「直接起命令行」这一层。** 执行全走两种载体：Mirasim 私有 ws（claude / codex / pi / kimi / grok / dsh）和自写的 ACP runner（cursor / devin）。所以各家无头模式的事件格式，旧仓几乎没有第一手材料。本手册的无头参数和事件字段主要来自 2026-09-24 的本机 `--help`、Grok 随装文档和离线探针，都标了出处；**标「没查成」的，开发时要先真跑一针再写解析器**（清单见 §十二）。
3. **旧系统一次都没读过「步骤清单」。** Mirasim 快照只有 `text / toolCalls / interactions / activity`；ACP runner 只处理 `agent_message_chunk / tool_call / tool_call_update`，`plan` 和 `agent_thought_chunk` 直接丢了（WD `scripts/acp-session-runner.mjs:550-582`）。已知能直接给步骤清单的有三处：Grok `--output-format streaming-json` 的 `plan` 事件（随装文档 `14-headless-mode.md:212-247`）、ACP 协议的 `plan` 更新（随装文档 `15-agent-mode.md`「Streaming updates」表）、Cursor 的 `cursor/create_plan` 请求（带 `todos`，WD runner:594）。**Claude Code 2.1.281 无头模式的工具表里没有 TodoWrite**（本机实跑 `system/init` 帧）。→ 设计 §八「先被动读步骤清单」只对部分插头成立，`fleet plan` 主动命令是必需品。
4. **起一个会话要穿过约 7.8k 行代码和五道「树占用」闸**：fleet 活动按租约收树 → execution-runtime 的 flock + 租约文件 + 登记表 + /proc 扫描 → mirasim-runtime 再扫一遍 /proc + O_EXCL 占用锁 + 渠道并发预占 → Mirasim 服务端 → CLI；ACP 另有一把目录锁。这些层自己就出过一串事故（#1420 占树 9–17 小时、#1350 每轮 117 条空转、#1735 worker 锁死自己的树……）。新系统按「一子任务一工作树一会话 + 进程组/cgroup 回收 + 状态进 Postgres/Temporal」来做，这几层可以整层删掉，详见 §十一。
5. **「真完成」从来不能只信执行体。** Mirasim 的 `phase=done` 可能带死因（`pi turn stalled past 30 minutes`、`Selected model is at capacity…`，2026-09-07 一天 11 次静默搁浅），也可能带 `incomplete`；codex 断流也显示 `done`；dsh 干完活不报结束；还有一次零产出的假完成（树被快进、HEAD 变了）一路绿到合并。**完成 = 终态信号且无错误 + 进程已退 + 相对「此刻」目标分支有自己的提交且有内容差异**（WD `packages/fleet/src/activities.mjs:284-297`）。
6. **凭据隔离是 always-approve 的前提。** 执行体和 fleet worker 跑在同一个 Linux 用户下（WD `host/machine/systemd/dao-fleet-worker.service` 与 `mirasim-server.service` 的 `User=`）。旧系统挡「读树外凭据」的只有 ACP 权限白名单，而它也漏过：`cat <树外的机器人凭据文件>` 曾会被当成「只读巡检」自动放行（runner:244-246）。新系统要是用各家的 bypass 模式，得先把凭据从执行体用户手里拿走（独立用户或沙箱），不然等于把机器人私钥交给模型。
7. **Mirasim 只该留作「中继额度」这一种路由的薄插头。** 中继额度只能经官方客户端或服务端消耗（官方明说反代会风控，AGS `docs/DECISIONS.md` §71「急停」），这是它不可替代的唯一理由。其余执行体都直起官方命令行。Mirasim 这层的坑（§八，30 条上下）大多出在私有混淆协议、客户端与服务端版本严格相等、单线程轮询，以及它对 CLI 的注入和改写。

---

## 一、总表

| 插头 | 旧系统怎么用 / 状态 | 新系统无头起法（要点） | 结构化输出 | 步骤清单 | 工具调用 | 完成信号 | token / 额度 |
|---|---|---|---|---|---|---|---|
| Claude Code（reclaude） | 只经 Mirasim 中继（`claude-relay-opus-5-5`，证据是继承来的）；直起未落地（#1521 OPEN） | `reclaude -p --output-format stream-json --verbose --permission-mode bypassPermissions --session-id <uuid> --model … < prompt` | NDJSON：`system/init`、`system/api_retry`、`system/commands_changed`、`rate_limit_event`、assistant/user、`result` | 2.1.281 无头工具表里没有 TodoWrite → 没查成 | assistant 帧的 `tool_use`（旧仓没解析过） | `result`（`is_error`）+ 退出码 | `result.usage`；`rate_limit_event`（5h / 7d 利用率 + resetsAt） |
| codex | 只经 Mirasim 中继（luna / sol / terra，审查专用）；pqapi 直连档停用 | `codex exec --json -C <树> -m <gpt…> --dangerously-bypass-approvals-and-sandbox [-o last.txt] -`（每个账号池一个 `CODEX_HOME`） | JSONL：`thread.started`、`turn.started`、`error(Reconnecting…)` 已实测；其余没查成 | 没查成 | 没查成（Mirasim 快照里 `name=shell`） | 没查成；上游不通时进程不自己退 | 没查成；中继会话走 Mirasim 账本 |
| cursor-agent | ACP（composer / grok-4.6 / grok-4.7，在役） | ACP：`cursor-agent --trust acp`；或 `cursor-agent -p --output-format stream-json --force --trust --workspace <树> --model '<目录原文>'`（旧系统没用过） | ACP `session/update`；`-p` 的 stream-json：`system/init` 带 model / session，`result` 带 request_id 与 usage（WD `execution-usage.mjs:898-899`），其余没查成 | `cursor/create_plan`（带 todos 的阻塞请求）；`plan` 更新被旧 runner 丢掉 | ACP `tool_call`（执行工具没有 rawInput，命令在 title 里） | `session/prompt` 回 `stopReason=end_turn` | ACP 流里没有；用 Dashboard API |
| Grok CLI | 经 Mirasim（grok-4.6 / 4.7，本机订阅，route=local） | `grok -p … --output-format streaming-json --always-approve -m … --cwd <树> --no-auto-update`；或 ACP `grok agent --always-approve --no-leader stdio` | streaming-json：`thought / text / tool_call / tool_call_update / usage / plan / end / error`（随装文档） | `plan{entries}`（文档） | `tool_call`（toolName / kind / rawInput） | `end` 恒为最后一行；退出码 0/1/130/143 | `usage` 行 + `end`（OAuth 路径常不带 cost） |
| pi | 经 Mirasim 中继（kimi-k3，吃服务端默认模型，起后回读核对） | `pi -p --provider <p> --model <p>/<id> --thinking <lvl> [--mode json] "<prompt>"` | `--mode json/rpc` 格式没查成；会话 jsonl 里有 `message` / `model_change` | 没查成 | 会话 jsonl | 进程退出（细节没查成） | 没查成（旧系统靠 Mirasim 账本） |
| dsh | 档停用（Mirasim 对接层不报终态） | `dsh --profile headless "<task>"`（配独立 `DSH_HOME`） | **没有结构化流**：推理写 stderr，stdout 只打最终消息 | 无 | 无 | 进程退出 | 无（经 Mirasim 时快照里有） |
| Kimi Code（附） | 经 Mirasim（自有账号，`kimi-code/k3`，在役） | `kimi -p "<prompt>" --output-format stream-json --auto`；或 `kimi acp` | stream-json 没查成 | 没查成 | Mirasim 快照：`title=Read/Write/Bash`、`kind=null` | 没查成 | 没查成 |
| Mirasim ws | 在役载体（claude / codex / pi / kimi / grok） | ws `prompt` 帧（见 §八） | 订阅快照 `snapshot` / `session` | 无（只有 `activity`） | `toolCalls[{id,name,status}]` | `phase=done` 且无 `incomplete`、无 `error`，中继路由另要账本 2xx | `~/.mirasim/traffic` 账本；中继 `/v1/limits` |
| ACP（含 devin） | cursor / devin 在役 | `cursor-agent --trust acp`、`devin --respect-workspace-trust false acp`、`grok agent --no-leader stdio`、`kimi acp` | JSON-RPC 按行分隔 | `plan`（协议有，旧 runner 丢） | `tool_call` | `stopReason=end_turn` | devin 有 usage 事件；cursor 没有 |

---

## 二、Claude Code（经 reclaude）

### 2.1 旧系统怎么用的

- **在役档** `claude-relay-opus-5-5`：`backend=mirasim, agent=claude, route=cloud, provider=mirasim-relay`，烧 Mirasim 中继额度，不是 Claude 订阅；可用证据是从 Fable 5.1 继承的（`evidenceKind: "inherited"`，「第一张真单就是验证」），目录里没有它自己的真跑证据（WD `docs/execution-profiles.json` 该条的 `availability`）。
- **停用档** `reclaude-claude-fable-5-1`（`route=local, provider=reclaude`）：上线当天在 fleet 任务上连挂 3 次，Mirasim 0.0.310 对 `route=local` 合成 422。之前那次「成功」的探针没指定 route，服务端日志写的是 `no claude account on this machine; routing this session through the relay`，实际走的是中继（WD `docs/evidence/1521-fable-relay-execution.json`；判例 `mirasim-overrides-reclaude-upstream` 第二次）。
- **Mirasim 起 claude 的形态**（AGS `docs/DECISIONS.md:2302`，0.0.282 反读）：`claude -p --output-format stream-json --input-format stream-json --model … --settings <tmp>.json --effort … --permission-mode bypassPermissions --session-id <uuid>`；凭据由临时 `--settings` 注入 `ANTHROPIC_BASE_URL=http://<回环>:<端口>/<会话令牌>` 和 `ANTHROPIC_AUTH_TOKEN`，同时清空 `ANTHROPIC_API_KEY`。0.0.354 起改成写进 `--settings` 临时文件的 env 块（AGS `deploy/reclaude-mirasim/strip.go:10-15`）。
- **直起载体**归 windsurf-dao#1521（2026-09-24 OPEN）。WD 里直起 `claude -p` 的只有两个探测脚本：`scripts/agent-latency.mjs:97-104`（测延迟）和 `scripts/model-chain.mjs:41`（测别名）。AGS 的切号探针直起 `reclaude -p`（`deploy/reclaude-org-switch.mjs:231-233`），只用来读额度。

### 2.2 怎么无头起（新系统推荐形态）

```bash
cd <工作树>
reclaude -p --output-format stream-json --verbose \
  --model <opus | claude-opus-5-5> --effort high \
  --permission-mode bypassPermissions \
  --session-id <uuid> \
  --setting-sources project \
  < prompt.txt          # 长 prompt 走 stdin
```

依据：
- `reclaude` 原样把参数交给 claude：`<VPS>` 2026-09-24 `ps` 看到 `reclaude -p --output-format stream-json --verbose --model opus --setting-sources project --allowedTools Read` 的子进程就是 `~/.local/bin/claude -p --output-format stream-json --verbose --model opus --setting-sources project --allowedTools Read`。
- `--verbose` 必带：本机实跑 `claude -p --output-format stream-json "hi"` 报 `Error: When using --print, --output-format=stream-json requires --verbose`，退出 1。
- prompt 可以走 stdin：本机实跑，不给 prompt 且 stdin 为空时报 `Error: Input must be provided either through stdin or as a prompt argument when using --print`（退出 1）；stdin 给内容就正常起会话。
- `--setting-sources project`：不加载用户级 settings，就不会跑用户的 SessionStart hooks；同一句话成本从 $0.028 降到 $0.0116，`unifiedWindows` 照样齐全（AGS `deploy/reclaude-org-switch.mjs:223-230`）。
- **不能用 `--bare`**：它只认 `ANTHROPIC_API_KEY`，经 reclaude 起会认证失败，回一条 `<synthetic>` 占位消息（同文件 :230）。
- 续跑：`--session-id <uuid>` 起的会话能用 `--resume <uuid>` 接着跑（本机 `claude --help`）。
- 工作目录就是工作树（claude 把 cwd 当工作区）。环境变量里**不许**有 `ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY`：有值就会绕开 reclaude 的代理链（WD `NEW-MACHINE.md` §8：「`ANTHROPIC_BASE_URL` 有值＝走中继；没值而 `NODE_EXTRA_CA_CERTS` 指向 reclaude＝走 reclaude」）。

### 2.3 输出与事件

- **stdout 只有 NDJSON**，`Syncing config…` 走 stderr（AGS `docs/DECISIONS.md:2306`）；stderr 还会有提示行，例如本机实跑的 `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set …`。解析只读 stdout。
- `{"type":"system","subtype":"init", session_id, model, tools[], permissionMode, apiKeySource, claude_code_version, mcp_servers, …}`（本机实跑）。**它不一定是第一行**：本机一次 stdin 起的实跑里，`system/commands_changed` 排在 `init` 前面。
- 上游不通时，每次重试一帧 `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":553,"error_status":null,"error":"unknown"}`；实测 25 秒和 90 秒内都没等到终帧（本机实跑）。
- `rate_limit_event`：`rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization, resetsAt(秒)}`。**用满时** `rate_limit_info.status:"rejected"`、`isUsingOverage:false`，而且**不带 `unifiedWindows`**，正文是「API Error: … 5 小时额度已用完，约 20 分钟后重置」（AGS `deploy/reclaude-org-switch.mjs:10-16, 80-150`）。
- 终帧 `result`：带 `is_error / usage / session_id`（AGS `docs/DECISIONS.md:2326`）、`duration_api_ms`、`usage.{cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`（WD `scripts/agent-latency.mjs:148-152`）。加 `--include-partial-messages` 会多出流式事件（`message_start`、`content_block_delta`，同文件 :143-147）。
- **步骤清单**：本机 2.1.281 无头 `init` 帧的工具表（非 bare、`--setting-sources project`、`--strict-mcp-config`）是 `Task, …, Bash, Edit, Glob, Grep, …, Read, …, WebFetch, WebSearch, Workflow, Write`，**没有 TodoWrite**。能不能从 Claude 流里被动读到步骤：没查成。
- **工具调用**：Messages 线格式里的 `tool_use` / `tool_result`；旧仓没解析过 Claude 的工具流。Mirasim 快照里 claude 的工具形如 `{name:"Bash", status:"done"}`（WD `docs/evidence/1521-fable-relay-execution.json`）。

### 2.4 真开工 / 真完成

- **真开工**：出现 `system/init` 只说明进程活着、有了会话 id；出现 `api_retry` 说明上游不通、还没开工；第一段 assistant 内容或 `tool_use` 才算开工。reclaude 首跑可能卡在 `Syncing config…` 180 秒超时，守护进程先起好再跑就通（WD `docs/observations/2026-09-19-reclaude接上mirasim-那一格补完.md` §五）。
- **真完成**：`result` 帧 `is_error:false` + 进程退出 0 + 交付判据（§十 GEN-06）。额度用满时探针非零退出（AGS `reclaude-org-switch.mjs:10-16`）。

### 2.5 常见失败与报错原文

| 原文 | 含义 | 出处 |
|---|---|---|
| `400 当前绑定账号暂不可用` | 号不可用 | AGS `docs/DECISIONS.md:2306` |
| `401 device_revoked` | 设备被解绑，要人重新登录 | AGS `docs/DECISIONS.md:2310, 2340`；判例 `mirasim-overrides-reclaude-upstream` 第三次 |
| `400` + `errorCode=non_cc_client`（「仅支持 Claude Code 客户端访问 reclaude 网关」），并上报 `leak_report: true` | 非官方客户端流量撞 reclaude；攒多了会解绑设备 | AGS `docs/RECLAUDE-IN-MIRASIM.md:19, 23-37` |
| `Not logged in` | 长驻进程的 env 陈旧，或出网被断 | WD `docs/observations/2026-09-19-reclaude接入五步与两处退役接线.md`；WD `mirasim-server.service` 注释 |
| `[claude-code:unrecognized_model] claude-5-fable-medium` | 退役网关的 env 残留 | 同上观察 |
| 422「当前是『本地』档，而本机没有这个智能体的账号，本轮已停止，没有任何请求发往云端」 | Mirasim 合成的拒跑 | WD `docs/evidence/1521-fable-relay-execution.json` |
| 422（别名指向中继不供的模型） | 模型别名配错，平时静默 | 判例 `config-empty-is-not-model-absent`；WD `NEW-MACHINE.md` §8 |
| `API Error: … 5 小时额度已用完，约 N 分钟后重置` | 5h 窗用满 | AGS `reclaude-org-switch.mjs:10-16` |
| `claude exited 1: 同步配置…` | 切 Mirasim 启动命令，杀掉了在途回合 | AGS `docs/RECLAUDE-IN-MIRASIM.md:59` |
| `<synthetic>` 占位消息 | `--bare` 经 reclaude 认证失败 | AGS `reclaude-org-switch.mjs:230` |
| `Error: When using --print, --output-format=stream-json requires --verbose` | 参数错 | 本机实跑 |

### 2.6 凭据（只写种类，不写位置）

- reclaude 的设备凭据、MITM CA、`state.json`、守护日志都在它自己的配置目录里（旧系统的落点清单见 WD `host/machine/INDEX.md:60-61`）。同目录的 `claude.path` 不是凭据，但**写的是绝对路径，决定跑哪份 claude**（CC-13）。
- `~/.claude/settings.json` 的 env 里有 `HTTPS_PROXY`（指 reclaude 守护进程端口）、`NODE_EXTRA_CA_CERTS`（指 reclaude 的 CA）、`NO_PROXY`，是 reclaude 首次真跑时补写的（WD observation「五步」第 3 步）。Claude Code 自己的凭据文件里是 reclaude 写的 OAuth 占位令牌（判例 `mirasim-overrides-reclaude-upstream` 第三次）。
- 额度读数：AGS 切号探针定时把读数落成服务用户家目录下的一个 JSON（WD `INDEX.md:62`；字段见 [quota.md](quota.md) 1.1）。
- 登录：`reclaude login`（浏览器设备授权）；切号：`reclaude org list / org use`（AGS `reclaude-org-switch.mjs:49-76`）。

### 2.7 已知的坑 → 测试用例

- **CC-01** 给定会话环境里有指向回环的 `ANTHROPIC_BASE_URL`（进程 env 或 `--settings` 注入），当起 reclaude，应当拒起并报「上游被改写」，不许让请求经任何网关转发到 reclaude。（判例 `mirasim-overrides-reclaude-upstream` 撞 5 次；AGS `deploy/reclaude-mirasim/strip.go:10-15`；AGS `docs/RECLAUDE-IN-MIRASIM.md` §1）
- **CC-02** 给定 reclaude 守护进程刚起、stdout 暂时只有 stderr 的 `Syncing config…`，当适配器等首帧，应当判「启动中」（不判失败、不再发第二份 prompt），首跑预算不少于 180 秒。（WD observation 2026-09-19「那一格补完」§五）
- **CC-03** 给定 spawn `claude -p` 时 stdin 是没关的管道，当起会话，应当不会多等约 3 秒（stdin 要么喂 prompt 后关闭，要么 ignore）。（WD `scripts/agent-latency.mjs:24-26`；同文件头注「两台机各栽一次」）
- **CC-04** 给定 `claude -p` 握手卡住，当超过墙钟上限，应当杀掉整棵进程树，并把这次记成「没查成」，不是 0 也不是超时读数。（WD `scripts/agent-latency.mjs:30-33`）
- **CC-05** 给定 `rate_limit_event` 里 `status:"rejected"` 且没有 `unifiedWindows`，当额度账解析它，应当判「账号额度已用满」并记下 resetsAt，不许判「没查成」而弃权。（AGS `reclaude-org-switch.mjs:10-16, 115-150`，2026-09-23 实测）
- **CC-06** 给定同一 reclaude 账号在多台机器上用，当记额度，应当按账号池记（5h 窗是账号级共享的），不按机器记。（AGS `reclaude-org-switch.mjs:18-21`，2026-09-19 实测三台同号）
- **CC-07** 给定 `reclaude org use` 退出码为 1，当切号，应当视为「号可能已经切了」，回读 `org list` 核实，不对就切回原号。（AGS `reclaude-org-switch.mjs:66-76`：先写 device.json 再同步，不回滚；2026-09-22 VPS 两个用户一起「切成砖」）
- **CC-08** 给定路由是「Mirasim × claude × route=local」，而 Mirasim 不认 reclaude 为本机账号，当派单，应当预期 422 并在选路阶段就排除，不许重试。（WD `docs/evidence/1521-fable-relay-execution.json`，fleet lead 连挂 3 次）
- **CC-09** 给定起会话时点了模型，当收到 `system/init`，应当回读 `init.model`，和请求不一致就停会话。（模型别名配错是静默的：WD `NEW-MACHINE.md` §8；判例 `config-empty-is-not-model-absent`；Mirasim 会把三个别名钉成同一个值，`/model` 显示和实际不一致：判例 `mirasim-overrides-reclaude-upstream`）
- **CC-10** 给定任何会让非 Claude Code 客户端的流量穿过 reclaude 代理的改动（例如去掉 `MIRASIM_NO_AGENT_EGRESS`），应当由测试拦下：reclaude 设备约 90 秒后就被解绑，而且不可自行恢复。（判例 `mirasim-overrides-reclaude-upstream` 第三次；WD `mirasim-server.service` 注释；windsurf-dao#1521）
- **CC-11** 给定长驻进程（Mirasim、编排守护）先起、reclaude 的代理和 CA 后写进 settings，当经它起 claude，应当读到的是新配置：适配器每次 spawn 都显式构造 env，不继承长驻进程启动时的 env。（WD observation「五步」真凶段：16:18 起的进程拿旧 env → `Not logged in`）
- **CC-12** 给定 `NODE_EXTRA_CA_CERTS` 指向别的 CA，当起 reclaude，应当在体检里判红（这个变量只能指一个文件）。（WD observation「五步」两处退役接线）
- **CC-13** 给定要换 claude 版本，当起会话，应当以 reclaude 配置目录里 `claude.path` 写的绝对路径为准并校验版本 ≥ 2.1.277（低于它不会在没有 CLAUDE.md 时回退读 AGENTS.md）；手换 reclaude 自带的 CLI 会被 `dl.reclaude.ai/claude-cli/latest` 强制覆盖回去。（WD observation「五步」第 2 步与「别走的弯路」；WD `AGENTS.md` 桥段）
- **CC-14** 给定无头 claude 会话，当它需要向人提问，应当走 `fleet ask` 命令，不依赖 CLI 自带的提问工具：`-p` 模式下 `AskUserQuestion` 被藏起来，Mirasim 又给 `ask=native`，两种提问工具都没有，而且零报错。（AGS `docs/MIRASIM.md:254-265`；判例 `mirasim-ask-popup-needs-claudeAskTool` 撞 2 次）
- **CC-15** 给定长会话，当记用量，应当单列 `cache_read_input_tokens`：7d 窗主要是被 cacheRead 吃掉的（一次 113 调用 output 6.3 万、cacheRead 484 万；另一次帅位长会话 cacheRead/output = 428 倍，84% 来自会话历史累积）。（判例 `mirasim-upstream-relay-and-quota-headers`；WD `NEW-MACHINE.md` §5）

**说明书约束（审计时核实，不是旧坑；开发时写成参数单测）**：`-p` + `stream-json` 必带 `--verbose`；不带 prompt 且 stdin 为空会立刻退出 1；`system/init` 不一定是第一行；`api_retry` 最多 10 次（本机实跑）。

---

## 三、codex

### 3.1 旧系统怎么用的

- **在役档** `codex-relay-gpt-5.6-{luna,sol,terra}`：`backend=mirasim, route=cloud, provider=mirasim-relay`，角色只有审查（WD `docs/execution-profiles.json`）。`codex-relay-gpt-6-astra` 停用；`codex-pqapi-*` 三档停用。
- Mirasim 服务端**常驻一个池化的 `codex app-server`**，会话复用它（AGS `docs/MIRASIM-CHANNELS.md:28`）；每个会话占 160–200 MB RSS（WD `docs/tasks/2026-09-18-commander-fusion-v2.md:51`）。它给 app-server 注入 `HTTPS_PROXY=<回环>:<端口>` + 自家 MITM CA，把传输钉在 relay，`~/.codex/config.toml` 配的上游拿不到流量（WD `docs/observations/2026-09-18-上报mirasim-回填不收敛与codex不重试.md` ③；WD `scripts/lib/turn-outcomes.mjs:19-22`）。
- 旧仓里直起 `codex exec` 只出现在冒烟里（WD `NEW-MACHINE.md` §7e；AGS `deploy/mirasim-native-baseline.mjs:99-111`）。

### 3.2 怎么无头起

```bash
cd <工作树>
CODEX_HOME=<这个账号池专用的 home> \
codex exec --json -C <工作树> -m gpt-5.6-sol \
  --dangerously-bypass-approvals-and-sandbox \
  -o <末条消息.txt> \
  - < prompt.txt        # "-" 表示从 stdin 读 prompt
# 可选：-c model_reasoning_effort=… / --output-schema <file> / --ephemeral / --ignore-user-config
# 自带上游：-c model_provider="x" -c model_providers.x.base_url="…/v1" -c model_providers.x.env_key="X_KEY"
```

依据：本机 `codex exec --help`（0.156.1）：`--json` 往 stdout 打 JSONL 事件；`-o/--output-last-message`；`--output-schema`；`--ephemeral`；`--ignore-user-config`；`-C/--cd`；prompt 不给（或给 `-`）就从 stdin 读，stdin 是管道又给了 prompt 时，stdin 会被附成一个 `<stdin>` 块。`--dangerously-bypass-approvals-and-sandbox` 与 `-c model_provider…` 的写法见 AGS `deploy/mirasim-native-baseline.mjs:104-109`。每个账号池一个 `CODEX_HOME` 见 WD `NEW-MACHINE.md` §7e。

### 3.3 输出与事件

- 本机离线探针（假 key、不可达端点）实测：
  ```
  {"type":"thread.started","thread_id":"<uuid>"}
  {"type":"turn.started"}
  {"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}   ← 反复出现，60 秒内没有终态事件
  ```
  即使 stdin 是 `/dev/null`，stderr 也会打 `Reading additional input from stdin...`。
- 工具调用、改文件、步骤清单、终态事件、token 用量：**旧仓没解析过 codex 的 JSONL，没查成**。Mirasim 快照里 codex 的工具形如 `{id:"exec-<uuid>", name:"shell", status:"done"}`（WD `docs/evidence/1370-astra-relay-execution.json`）。
- 中继会话的用量走 Mirasim 账本（§八）。

### 3.4 真开工 / 真完成

- **真开工**：`thread.started` + `turn.started` 只表示受理；连续的 `Reconnecting…` 表示上游不通、还没开工；第一个工作项（命令或改文件）才算开工（事件名没查成）。
- **真完成**：旧判据是 Mirasim 快照 `done` + 无 `error` + 无 `incomplete`，中继路由另要账本里起针之后有 2xx 行（WD `scripts/lib/mirasim-runtime.mjs:736-845`）。断流的会话也显示 `done`（判例 `reviewer-session-dies-upstream-stream`），所以必须叠加交付判据。

### 3.5 常见失败与报错原文

| 原文 | 出处 |
|---|---|
| `stream disconnected before completion: stream closed before response.completed`（6 小时 10 个 codex 会话 9 个带它；activeMs 316 / 167 秒才被掐） | 判例 `reviewer-session-dies-upstream-stream` |
| `codex app-server 'initialize' timed out` | WD `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:11` |
| `ERROR: Reconnecting... 1/5` 后 60 秒 timeout 124，没有最终消息 | WD `NEW-MACHINE.md` §7e |
| `Reconnecting... waiting for network (Connection failed: error sending request)` | 本机实跑 |
| `Selected model is at capacity. Please try …`（快照 phase 仍是 done） | WD `mirasim-runtime.mjs:768-776` |
| `Unsupported tool type: namespace`；Responses 口 `high demand` | AGS `docs/MIRASIM.md:287-307`（非 GPT 卡） |
| `spawn prep slow: mirasim-record (codex) 58117ms / 40242ms` | WD `mirasim-runtime.mjs:184-186` |
| `MCP client for filesystem failed to start`（启动告警，是否主因没验） | 判例 `dispatch-accepted-vs-worker-started` |

### 3.6 凭据（只写种类）

- `CODEX_HOME` 下：`auth.json`（`OPENAI_API_KEY` 或登录态，**只有一个 key 字段**）、`config.toml`（`model_provider / base_url / wire_api`）、`rules/default.rules`（批准过的 prefix_rule）（WD `host/machine/INDEX.md:45-49`）。
- 每把 key 一个 `CODEX_HOME`（目录 0700、文件 0600）；key 原件放机器本地配置，不进 git（WD `INDEX.md:50-53`；`NEW-MACHINE.md` §7e）。
- 经 Mirasim 中继时，凭据是 Mirasim 的设备签名：设备私钥在 Mirasim 的设置里，逐请求签 `x-mirasim-sig/-ts/-nonce`（AGS `docs/DECISIONS.md` §71）。

### 3.7 已知的坑 → 测试用例

- **CX-01** 给定两把 key 要分给两个账号池，当都写进同一个 `CODEX_HOME` 的 `auth.json`，应当被拒：`auth.json` 只有一个 `OPENAI_API_KEY` 字段，后写的会静默盖掉先写的。每个账号池独立一个 `CODEX_HOME`，起会话后核对会话头里的 provider 和账号池一致。（WD `NEW-MACHINE.md` §7e）
- **CX-02** 给定 codex 接一个只实现 chat/completions 的上游，当起会话，应当在选路阶段就拒：codex 强制 Responses API 和 `namespace` 工具类型，硬套只会 400 或空等。（AGS `docs/DECISIONS.md` §39 一；AGS `docs/MIRASIM.md:287-307`；用户 2026-08-29 拍板「codex 只用 GPT」）
- **CX-03** 给定一个 codex 会话报了终态、但带 `stream disconnected…`，当判完成，应当判失败或断流，不判完成。（判例 `reviewer-session-dies-upstream-stream`：#1287 起了 13 次审官会话，一票都没落到 head 上）
- **CX-04** 给定上游不可达，当 `codex exec` 一直在打 `Reconnecting…`，应当由适配器按墙钟上限和「连续 N 次 Reconnecting」判上游不可达并杀进程：它不会自己退出。（WD `NEW-MACHINE.md` §7e：timeout 124 无终态；本机实跑 60 秒无终态）
- **CX-05** 给定宿主给 codex 注入了代理和 CA（`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` 之类），当直起 codex，应当先清掉这些继承下来的注入，除非这条路由本来就要走那个代理。（WD observation 2026-09-18 ③）
- **CX-06** 给定 relay 腿与 pqapi 直连共用一把 key 做健康探针，当判 relay 腿健康，应当按「路由」单独记健康、吃真流量：同机同时段 pqapi 探针绿而 relay 生产回合 2 ok / 6 error。（WD `scripts/lib/provider-probe.mjs:99-104`；判例 `breaker-must-eat-real-traffic`，#1342）
- **CX-07** 给定上游一次 5xx 或断流，当回合失败，应当由我们在外层按路由重试有界次数：Mirasim 的 codex 回合 `attempts=1`，7 天 645 条里 48% 上游失败、一次即丢。（WD observation 2026-09-18 ②）
- **CX-08** 给定池化的 app-server 进程，当按 `/proc/<pid>/cwd` 判「树里还有没有进程」，应当知道它的 cwd 不在工作树里，会漏判；而它曾 6.5 小时 0 秒 CPU 地占着一棵树，收树连失败 18 轮。→ 新系统每个子任务起独立的 `codex exec` 进程，cwd 就是工作树，按进程组回收。（WD `scripts/lib/tree-lease.mjs:3`；WD `docs/observations/2026-09-14-盘面在跳但单向冻结.md:28`）
- **CX-09** 给定跑过很多会话的 `CODEX_HOME`，当统计 `.tmp/`，应当被回收：曾攒到 11109 个目录，拖慢同盘所有文件遍历。（WD `host/machine/INDEX.md:46`）
- **CX-10** 给定机器有负载，当 codex 起会话报 `initialize timed out`，应当按「这条路由暂时起不来」换路由或退避，不把整单卡死。（WD `docs/decisions/2026-09-24-…md:11`：盲设计题一臂就这样阵亡）
- **CX-11** 给定错误正文含 `at capacity / overloaded / 429`，当分类，应当判「繁忙」并让这条路由对所有任务一起降级（路由级熔断），不让每个任务各自重试。（WD `scripts/lib/channel-concurrency.mjs:581-589`；WD `docs/decisions/2026-09-24-…md` 结论 11）

**说明书约束**：`exec` 会读 stdin（管道没关就会等）；`--no-daemon` 只出现在顶层 `codex --help`，`exec` 是否挂到共享 daemon 没查成；`exec --help` 里没有 `-a/--ask-for-approval`。

---

## 四、cursor-agent

### 4.1 旧系统怎么用的

- 只走 ACP：`cursor-agent --trust acp`（WD `scripts/lib/acp-runtime.mjs:10`）。在役档 `cursor-acp-composer`（`composer-2.5[fast=true]`）、`cursor-acp-grok-4.6`（`grok-4.6[effort=high,fast=true]`）、`cursor-acp-grok-4.7`（`grok-4.7[context=256k,reasoning_effort=high,fast=true]`），都是 `route=local`（WD `docs/execution-profiles.json`）。Grok 模型改走 Cursor 的起因是 grok.com 402（同文件 `cursor-acp-grok-4.6` 的 reason）。
- 二进制不在 PATH 上：`~/.local/share/cursor-agent/versions/{current, <版本>}/cursor-agent`，先找 `current`，再按版本号倒序（WD `acp-runtime.mjs:220-235`；WD `scripts/lib/launch-binary.mjs:37-50`）。

### 4.2 怎么无头起

- **ACP**（旧系统在用，§九）：`cursor-agent --trust acp`。
- **print 模式**（旧系统没用过，本机 `cursor-agent --help` 2026.09.23）：
  ```bash
  cursor-agent -p --output-format stream-json --force --trust \
    --workspace <工作树> --model '<ACP 目录里的原文串>' "<prompt>"
  # 可选：--stream-partial-output、--sandbox disabled、--approve-mcps、--resume <chatId>
  # 认证：已登录态，或 --api-key / CURSOR_API_KEY；端点 -e / CURSOR_API_ENDPOINT
  ```
  help 原文：`-p, --print … Has access to all tools, including write and shell`；`--force` / `--yolo`：「Force allow commands unless explicitly denied」；`--trust`：「Trust the current workspace without prompting」。`-p` 下模型串接不接受 ACP 的方括号写法：help 举例 `'claude-opus-4-8[context=1m,effort=high,fast=false]'`，但没实测。

### 4.3 输出与事件

- ACP：`session/update` 里的 `agent_message_chunk`、`tool_call{kind: read|edit|execute|other, title, status}`、`tool_call_update`；阻塞请求 `session/request_permission`、`cursor/ask_question`、`cursor/create_plan`（带 `plan` 与 `todos`）（WD runner:17, 38-43, 584-596；WD `docs/evidence/1174-cursor-worktree-commit.json`）。
- **执行工具没有 rawInput**：shell 命令写在 tool 的 `title` 里、用反引号包着，有时前缀 `cd <工作树> &&`；提交信息写成 `"$(cat <<'EOF' … EOF)"`（WD runner:87-94, 306-314）。
- `-p` 的 stream-json：`system/init` 带 model / session，终态 `result` 带 request_id 和 usage（WD `scripts/lib/execution-usage.mjs:898-899`）；其余字段没查成：本机离线探针在出任何 JSON 之前就失败了（见 4.5）。
- **用量不在 ACP 流里**：旧系统用 Cursor Dashboard API `GetCurrentPeriodUsage / GetFilteredUsageEvents` 采样（WD `execution-usage.mjs:620-735`）；本地 SQLite 里存的是上下文窗口的 token，不是计费用量，不许当花费用（同文件 :861-865）。Cursor 有两个独立用量池：`grok-*-fast` 计入「Cursor Models 池」，kimi 等第三方走「Other 池」（AGS `docs/MIRASIM.md:58-67`）。

### 4.4 真开工 / 真完成

- **ACP**：`session/new` 成功且模型回读一致后记 `acceptedAt`，但这时 prompt 还没发（runner:756-761）；第一条 `session/update` 才算开工。
- **完成**：`session/prompt` 返回 `stopReason=end_turn` → done；`cancelled` → 取消；其它 → `prompt_incomplete`（runner:761-768）；再加进程清理核实 + 交付判据。

### 4.5 常见失败与报错原文

| 原文 | 出处 |
|---|---|
| `✗ Failed to reach the Cursor API. Check that your proxy (http://<回环>:7890/) is reachable.`（stderr、退出 1、没有任何 JSON） | 本机实跑（`-p --output-format stream-json`，不可达端点） |
| `Requested concrete model ID is absent from the ACP model catalog`（`model_unavailable`） | WD `docs/evidence/1576-grok-4.7-probe.json`；runner:736 |
| `agent_unconfigured`（新工作树弹 Workspace Trust） | WD `docs/cli-notes/cursor.md:15`（#649） |
| `Invalid params`（ACP 握手停在 authenticate） | AGS `docs/DECISIONS.md:950-956` |
| `ACP model catalog has no match` | AGS `docs/DECISIONS.md:957-972` |
| `503 system cpu overloaded`（ACP 会话不散场，撑满 cgroup） | AGS `docs/DECISIONS.md:974-977` |
| `spawn E2BIG` | AGS `docs/DECISIONS.md:679-690` |

### 4.6 凭据（只写种类）

- 登录态文件（含 accessToken；Dashboard 采样读它，WD `INDEX.md:55`；`execution-usage.mjs:650-651`）。
- 登录：`cursor-agent login`，要真 TTY 和浏览器；`cursor-agent status / whoami` 查状态（WD `NEW-MACHINE.md` §7c）。也可用 `--api-key` / `CURSOR_API_KEY`（help）。
- 国内 IP 下模型选择器只剩 Grok / Composer / Kimi / GLM，要走代理才看得到别的（WD `NEW-MACHINE.md` §7c）。

### 4.7 已知的坑 → 测试用例

- **CU-01** 给定一棵新工作树，当只带 `--force`、不带 `--trust` 起 cursor-agent，应当预期被 Workspace Trust 拦下；适配器固定带 `--trust`。（WD `docs/cli-notes/cursor.md:15`，#649 / #648）
- **CU-02** 给定 ACP 目录的模型串和 `cursor-agent models` 列表不同名，当按列表名或按旧版本的形状去猜 ACP 串，应当被拒 `model_unavailable`；起会话前从 `session/new` 回来的目录里取原文。（WD `docs/evidence/1576-grok-4.7-probe.json`：照 4.6 形状猜成 `grok-4.7[effort=high,fast=true]` 被拒，实际是 `grok-4.7[context=256k,reasoning_effort=high,fast=true]`；AGS `docs/DECISIONS.md` §38 坑 2）
- **CU-03** 给定 Cursor 升级删掉了旧版本目录，当按钉死的版本目录起 cursor-agent，应当起不来；解析顺序固定为 `current` → 最新数字目录。（WD `scripts/lib/launch-binary.mjs:29-35`）
- **CU-04** 给定为了隔离把 HOME 改到别处，当起 cursor-agent，应当仍能读到登录态，读不到就当场报 `auth_required`，不许卡在握手。（AGS `docs/DECISIONS.md:950-956`：`CHAT_ONLY_WORKSPACE=true` 覆盖 HOME，ACP 握手停在 authenticate）
- **CU-05** 给定 prompt 超过 128KB，当起会话，应当走 stdin 或文件，不拼进 argv；验收用例必须带一个 ≥128KB 的 prompt。（AGS `docs/DECISIONS.md:679-690`，`spawn E2BIG`）
- **CU-06** 给定工具报「写文件成功」，当判交付，应当在本机工作树里读回产物（`git diff` 非空）才算：曾经工具实际跑在另一台机器的工作区，本机什么都没有，而且看起来是成功的。（AGS `docs/MIRASIM.md:178-186`；AGS `docs/DECISIONS.md:928-947`）
- **CU-07** 给定一个 ACP 会话结束，当回收，应当核实它的进程树已经清空：一条 ACP 会话 = 一个常驻 cursor-agent 外加 `typescript-language-server`，不散场的话十个请求就把 400M 的 cgroup 撑满。（AGS `docs/DECISIONS.md:974-977`）
- **CU-08** 给定要记 Cursor 的花费，当读本地 SQLite 的 token 字段，应当被拒（那是上下文窗口，不是计费）；花费只认 Dashboard API，而且它的事件窗和分页有上限，拿不全时如实标「不完整」。（WD `execution-usage.mjs:44-50, 861-865`：VPS 2026-09-24 每轮都带 `window_incomplete`）
- **CU-09** 给定 ACP 的执行权限请求，当按命令判放行，应当从 `title` 解析命令（没有 rawInput），并能处理 `cd <树> &&` 前缀和 heredoc 提交信息。（WD runner:87-94, 306-314；夹具 WD `docs/evidence/1174-cursor-worktree-commit.json`）

---

## 五、Grok 命令行（Grok Build）

### 5.1 旧系统怎么用的

- 在役档 `grok-mirasim-native`（grok-4.6）、`grok-mirasim-native-4.7`：`backend=mirasim, route=local, provider=xai-native`，吃本机 grok.com 订阅登录态（WD `docs/execution-profiles.json`；证据 `docs/evidence/1174-grok-native-execution.json`、`1576-grok-4.7-probe.json`）。
- Mirasim 起 grok 的实录（Windows 桌面机）：`cmd /d /s /c "<npm 全局>\grok.CMD agent --no-leader stdio"` → node → `grok.exe agent --no-leader stdio`，也就是 **ACP stdio**（WD `docs/GROK-MIRASIM-FIX.md:32-49`）。VPS 上的形态没实看。
- WD 的 ACP 表里有 grok 条目（`grok agent --no-leader stdio`，`GROK_DISABLE_AUTOUPDATER=1`，WD `acp-runtime.mjs:12`），但没有启用的档用它。

### 5.2 怎么无头起

```bash
cd <工作树>
GROK_DISABLE_AUTOUPDATER=1 \
grok -p "<prompt>" --output-format streaming-json \
  --always-approve -m grok-4.7 --reasoning-effort high \
  --cwd <工作树> --no-auto-update [--max-turns N] [--session-id <uuid>]
# 长 prompt：--prompt-file <file>（无头模式不读 stdin）
# 续跑：grok -p "继续…" --resume <sessionId>
# ACP：grok agent --always-approve --no-leader stdio
```

依据：本机 `grok --help`、`grok agent --help`（1.0.41）；随装文档 `14-headless-mode.md`（选项表 :19-46、stdin :395-407、退出码 :559-566、更新提示写 stderr :654）、`15-agent-mode.md`（`grok agent --always-approve stdio`，也可以在 `session/new` 里带 `_meta.yoloMode:true`）。模型别写死：CLI 目录默认值 2026-09-24 是 grok-4.7（WD `docs/cli-notes/grok.md:20`）。

### 5.3 输出与事件（随装文档，旧仓没跑过）

- `streaming-json`：每行一个带 `type` 的对象：`thought`、`text`、`tool_call{toolCallId, title, kind, status, toolName, rawInput, content, locations}`、`tool_call_update{status, rawOutput}`、`usage{messageId, stopReason, usage}`（每次模型回复一行）、`plan{entries}`、`available_commands`、`end`（**永远是最后一行**，带 stopReason / sessionId / usage / num_turns / modelUsage，cost 可能没有）、`error{message}`；另有 `max_turns_reached`、`auto_compact_*`，文档说明事件表不封闭（`14-headless-mode.md:212-247`）。
- `json`：结束后输出单个对象（text、stopReason、sessionId、usage、modelUsage、total_cost_usd），带 `usage_is_incomplete / cost_is_partial` 的缺数标记；`input_tokens` 只算没命中缓存的部分（`:129-204`）。
- 失败：`{"type":"error","message":"Couldn't start session: ..."}`，退出码非零（`:205-210`）。
- 退出码：`0` 成功、`1` 认证 / 网络 / 运行错误、`130` SIGINT、`143` SIGTERM；被打断时已经改的文件不回滚（`:559-566, 677-686`）。

### 5.4 真开工 / 真完成

- **开工**：第一条 `thought`、`tool_call` 或 `text`。经 Mirasim 时看快照 phase 进入 `streaming`。
- **完成**：`end.stopReason=end_turn` + 退出码 0 + 交付判据；出现 `error` 或退出码非零就是失败。

### 5.5 常见失败与报错原文

| 原文 | 含义 | 出处 |
|---|---|---|
| `shell.turn.inference_retry :: request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (Connect): tcp connect error: deadline has elapsed`（在 `~/.grok/logs/unified.jsonl` 里） | 没走代理（DNS 污染） | WD `docs/GROK-MIRASIM-FIX.md:56-66` |
| 界面「等待模型响应」/ `Waiting for response…`，下行计数定死不动 | 同上；TUI 不报错也不超时 | 判例 `orca-daemon-stale-env`；判例 `tui-hint-line-is-the-mode-oracle` |
| `unexpected argument`，退出 2 | 旗标放在子命令后面 | WD `docs/cli-notes/grok.md:19` |
| grok.com 402；撞周限 | 订阅额度 | WD `execution-profiles.json`（`cursor-acp-grok-4.6` 的 reason）；AGS `docs/MIRASIM-CHANNELS.md:32` |
| `403 You have run out of credits or need a Grok subscription` | 额度 / 订阅 | WD `docs/evidence/1460-pi-legs-carrier-and-account.json` |
| 会话记录 `runDetail: "Interrupted by user."` | 我们自己停的 | `<VPS>` 会话记录（2026-09-24 只读） |

### 5.6 凭据（只写种类）

- grok 家目录（`GROK_HOME` 可改）下：`auth.json`（OAuth 或 API 凭据）、`config.toml`（`[ui] permission_mode`、`[models] default_reasoning_effort`；**不写** `[models] default`）、日志 `logs/unified.jsonl`、会话 `sessions/`（WD `INDEX.md:36-39, 56`；随装文档 `14-headless-mode.md:604-621`）。
- 也可以用 `XAI_API_KEY` 环境变量，或 `GROK_HOME` 改家目录（随装文档 :539-555）。登录：`grok login`，或者无浏览器的 `grok login --device-auth`（:570-579）。

### 5.7 已知的坑 → 测试用例

- **GK-01** 给定 xAI 端点被 DNS 污染的网络，当不带代理起 grok，应当在 N 秒内判「上游不可达」（看 `unified.jsonl` 的 `tcp connect error`，或者一直没有输出），不许干等：TUI 既不报错也不超时。Linux VPS 直连是通的，不需要代理。（WD `docs/GROK-MIRASIM-FIX.md:10-22, 202-207`；判例 `orca-daemon-stale-env`）
- **GK-02** 给定宿主按绝对路径调一个不带代理的壳，或者用的是启动时就定死的 env，当起 grok，应当仍然拿到正确的代理：适配器每次 spawn 显式给 env，并用二进制的绝对路径（在日志里打出实际路径）。（WD `docs/GROK-MIRASIM-FIX.md` §0、§3.4；判例 `orca-daemon-stale-env` 撞 2 次，第二次是 PATH）
- **GK-03** 给定参数构造器，当把旗标放在子命令之后，应当被单测拦下（grok 会报 `unexpected argument` 并退出 2）。（WD `docs/cli-notes/grok.md:19`；WD `tests/grok-shim.test.js`）
- **GK-04** 给定要免确认，当用 `--permission-mode auto`，应当被拒：它每执行一次外部命令还是要确认一次；要用 `--always-approve`（等价于 `--permission-mode bypassPermissions`）。（判例 `grok-native-launch-trap`：一晚上叫醒帅三次）
- **GK-05** 给定壳或配置里手写了模型 id，当 CLI 的默认值已经换代，应当由体检判红：本机壳和 `config.toml` 都钉着 grok-4.6，而目录默认早已是 4.7。模型只从路由表来，起会话后回读 `end` 里的实际模型。（WD `NEW-MACHINE.md` §7；WD `docs/cli-notes/grok.md:13, 20`）
- **GK-06** 给定 Grok 的 auto 模式会硬拦 `git push`（要人回一句授权词），当会话需要推送，应当由引擎来推，会话里不推；会话里 push 失败不算任务失败。（WD `docs/cli-notes/grok.md:13, 17`；WD `NEW-MACHINE.md` §7 末条）
- **GK-07** 给定长流跑到一半被掐（首字节 11–116 秒都到了，断点散在 10–36 分钟），当算这条路由的成功率，应当把断流单列、不进分母：grok 46 条回合里 20 条 incomplete、0 条限流或鉴权码，熔断器却据此把一条当天真干出活的腿判死。（WD `scripts/lib/turn-outcomes.mjs:23-28`，#1386）
- **GK-08** 给定 grok.com 回 402 或撞周限，当分类，应当判「账号额度」（停这个账号池），不是「上游抖动」。（WD `execution-profiles.json` reason；WD `scripts/lib/failure-class.mjs:12-15`：xAI 额度用完被记成 23/145 的成功率，而同模型走 Cursor 好好的）
- **GK-09** 给定装机，当从 npm 镜像装 `@xai-official/grok@latest`，应当被拦：npmmirror 的 `latest` 标签指向只有 macOS 的 0.1.4；要钉版本并走官方源，或者直接用自更新二进制。（WD `NEW-MACHINE.md` §7 第 1 条）
- **GK-10** 给定无头模式，当适配器要给 grok 发任务，应当只用 `-p` / `--prompt-file` 或 ACP，**不许**往 TUI 里注入文本：TUI 首启的 opt-in 横幅会吃掉注入，`\n` 会被拆成 N 条消息，todo 确认态会停着等回车。（判例 `grok-tui-optin-banner-trap`、`tui-newline-per-agent`、`tui-hint-line-is-the-mode-oracle`）

**风险（没查成）**：旧用量采集器从 `~/.grok/sessions/<cwd>/<会话>/updates.jsonl` 读 `turn_completed`（WD `execution-usage.mjs:841-857`），而 1.0.41 的随装文档说 `sessions/` 是 SQLite（`14-headless-mode.md:613`）。版本漂移后旧读法可能已经读不到数据，新系统不要沿用。

---

## 六、pi

### 6.1 旧系统怎么用的

- 在役档 `pi-mirasim-relay-kimi-k3`：`backend=mirasim, route=cloud, modelSelection=server-default`。起会话**不带 model**，吃服务端全局默认 `agents.pi.model`（= kimi-k3），accepted 之后回读快照里的 model 核对，不符就停会话、拒起（WD `docs/execution-profiles.json` 该条；WD `mirasim-runtime.mjs:400-456, 1371-1404`）。
- 23 条 opencode-go 的 pi-native 档全部停用（用户 2026-09-20 拍板弃用）；commandcode、windsurf 档停用。
- Mirasim 起 pi 的形态：无头 RPC `['-e', <网关 url>, '--mode', 'rpc', '--session-id', <id>]`，**不带 --model**，只有 TUI 形态才加 `--model`（WD `docs/evidence/1460-pi-legs-carrier-and-account.json` 的 `mechanism.piSpawnArgs`）；进程命令行里有 `pi-coding-agent` 和 `--mode rpc`（AGS `deploy/mirasim-session-reap.mjs:24-44`）。

### 6.2 怎么无头起

```bash
cd <工作树>
pi -p --provider <provider> --model <provider>/<model-id> --thinking high \
   [--mode json] [--session-dir <dir>] "<prompt>"
# 冒烟：pi --no-tools --no-session -p "只回复：OK"
# 凭据体检：pi auth check --provider <provider> --json   → {"status":"ready",…}
```

依据：本机 `pi --help`（0.87.1）：`--mode text|json|rpc`、`-p/--print`、`--session-dir`、`--thinking`、`PI_CODING_AGENT_DIR`、`PI_OFFLINE`；WD `NEW-MACHINE.md` §6 的三条验证命令；AGS `deploy/mirasim-native-baseline.mjs:88-91`（`pi -p --provider gw --model <MODEL> --api-key <KEY> <prompt>`）。npm 包必须是 `@earendil-works/pi-coding-agent`（WD `NEW-MACHINE.md` §6）。

### 6.3 输出与事件

- `--mode json` / `--mode rpc` 的事件格式：**没查成**。
- 会话档案：`~/.pi/agent/sessions/--<cwd 编码>--/<ISO 时间>_<uuid>.jsonl`，里面有 `message`（`provider / stopReason / err`）和 `model_change` 事件（判例 `pi-silent-provider-fallback`；WD `docs/evidence/1460-…json` 的 `piSessionFile`）。**判「实际用了哪条通道」的真相源是这里的 provider 字段和 `model_change` 事件，不是启动命令**（同判例）。
- token 用量：没查成（旧系统走 Mirasim 账本）。

### 6.4 真开工 / 真完成

- 旧判据全靠 Mirasim 快照（§八）。pi 做完 4 个工具动作后卡住、没有任何错误字样，干等了 30 分钟才被服务端判停（WD `execution-runtime.mjs:60-62`，#1608 g1）→ 按进展判停滞（GEN-05）。
- 直起时的完成信号：没查成；至少要看退出码 + 会话 jsonl 最后一条的 `stopReason` + 交付判据。

### 6.5 常见失败与报错原文

| 原文 | 出处 |
|---|---|
| `402 Insufficient Balance`（请求其实被静默切到了另一个 provider） | 判例 `pi-silent-provider-fallback` |
| `503 status code (no body)` | 同上 |
| `Error: Model "deepseek-v4-flash" is ambiguous across providers: …` | 判例 `tui-newline-per-agent` |
| `403 RegionError`；`not available in your region` | WD `docs/evidence/1460-…json`；判例 `pi-opencode-go-provider` |
| `400 MissingSessionID`（opencode-go 缺 `x-opencode-session` 头，长得和「key 不对」一样） | WD `scripts/lib/execution-pi-provider.mjs:191-201` |
| `pi turn stalled past 30 minutes`（快照 phase 仍是 done） | WD `mirasim-runtime.mjs:768-776` |
| `pi rpc timed out after 30s` | AGS `docs/ops/MIRASIM-PI-STALLED-2026-08-31.md` |
| `403 You have run out of credits or need a Grok subscription`（落回默认腿之后） | WD `docs/evidence/1460-…json` |
| `credentials_not_configured` | WD `NEW-MACHINE.md` §6 |

### 6.6 凭据（只写种类）

- pi 配置目录下：`auth.json`（各 provider 的 api_key）、`models.json`（自定义 provider）、`settings.json`（`defaultProvider / defaultModel`）、`models-store.json`（目录缓存）、`pi-gateway.json`（退役网关扩展）（WD `INDEX.md:148`；WD `NEW-MACHINE.md` §6）。
- 环境变量：`PI_CODING_AGENT_DIR` 改配置目录（和执行时的目录对不上会把路由带偏，WD `execution-pi-provider.mjs:139-141`）；各家 `*_API_KEY`（`pi --help`）。

### 6.7 已知的坑 → 测试用例

- **PI-01** 给定两个 provider 下有同名 model id，当主 provider 报一次 503，应当**不会**悄悄切到另一个 provider：pi 会在 1 毫秒内自动切到同 id 的别家，不问不报。适配器起会话后读会话 jsonl 的 provider 与 `model_change`，和路由不一致就停。（判例 `pi-silent-provider-fallback`）
- **PI-02** 给定经 Mirasim 起 pi，当点名 model 且不是 `profile:<BYOK 档 id>` 的写法，应当拒起：服务端会把它静默置成 null，pi 落回 `settings.json` 的默认腿（已退役网关）然后 403，而记录显示「点名成功」。（WD `docs/evidence/1460-…json`；WD `mirasim-runtime.mjs:362-398`；判例 `mirasim-channels-and-user-model-selection`）
- **PI-03** 给定一台 Mirasim 服务端，当路由表里有两条「Mirasim × pi」的路由指向不同模型，应当被配置校验拒掉：同一台服务端同一时刻只有一个 pi 默认模型。（AGS `docs/MIRASIM-CHANNELS.md:78-88`）
- **PI-04** 给定 pi 的 `settings.json` 默认腿指向已退役的上游，当任何一次「没点名」发生，应当当场报错，不许落到死腿上。（WD `docs/evidence/1460-…json`：落回 `gw/grok-4.6` → 403）
- **PI-05** 给定 opencode-go 渠道，当健康探针不带 `x-opencode-session` 头，应当被判「没查成」而不是「腿死了」。（WD `execution-pi-provider.mjs:191-201`，#1460：补上头之后同一请求 200）
- **PI-06** 给定 Mirasim 按停滞判定掐掉一个 pi 会话，当回收，应当核实 pi RPC 子进程也退了：原生 RPC 进程不会跟着退，会变成孤儿，之后「继续」会打到失效的 RPC 上。（AGS `docs/ops/MIRASIM-PI-STALLED-2026-08-31.md`；AGS `docs/DECISIONS.md` §43）
- **PI-07** 给定装机，当装的是 `@mariozechner/pi-coding-agent`，应当被体检拦下：它和正确的包抢同一个 `pi` 命令，而且 stdin 关闭时 `--version` 一个字都不打，宿主会判「无法运行」。（WD `NEW-MACHINE.md` §6 第 1 条，2026-09-02 实咬）
- **PI-08** 给定 deepseek 模型，当用 `--tools` 裁掉 bash，应当被拒：裁掉后模型仍会幻觉调用 bash，把工具调用标记当正文吐出来。（WD `NEW-MACHINE.md` §6）
- **PI-09** 给定一个由代码注册的 provider，当往 `models-store.json` 写条目想「造」一个 provider，应当被拒：写了会被静默忽略。（WD `docs/cli-notes/commandcode.md:20`；WD `execution-pi-provider.mjs:4`）
- **PI-10** 给定 pi 会话，当用「transcript 条数」判开工，应当被拒：pi 不上报 transcript（实测 0 条，而它已经推了 commit）。判开工看产出。（判例 `dispatch-accepted-vs-worker-started`）

---

## 七、dsh（DeepSeek Harness）

### 7.1 旧系统怎么用的

- 档 `dsh-mirasim-relay-deepseek-flash` **停用**。经 Mirasim 起（从报错原文 `dsh web did not become ready within 45s` 推断，服务端起的是 dsh 的 web 形态）：点名 `deepseek-flash` 后两针活干完了（读、改、提交都在），但会话一直到不了终态，等满 420 秒才以 `done + incomplete` 收场；第三针报 `dsh web did not become ready within 45s`，零产出（WD `docs/evidence/1576-dsh-relay-pinned-model.json`）。
- 不点名模型时报 `fetch failed`（WD `docs/evidence/1576-dsh-relay-fetch-failed.json`）。日志里的 `no dsh account on this machine; routing this session through the relay` 是正常降级，不需要 DeepSeek 账号（WD `execution-profiles.json` 该条 reason）。

### 7.2 怎么无头起

```bash
cd <工作树>
DSH_HOME=<专用目录> <上游 key 的环境变量>=… \
dsh --profile headless "<task>"
```

- 本机 `dsh --profile headless --help`：「Answer one task, stream reasoning to stderr, print the final assistant message, and exit.」
- 配置：`$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<id>`（`apiKeyEnv / api / baseURL / models[]`）与 `agent-default-model`（AGS `deploy/mirasim-native-baseline.mjs:46-80`）。`--patch` 能叠加补丁层，`--dump-config` 能打印合成后的配置（本机 `dsh --help`）。

### 7.3 输出与事件

- **没有结构化事件流**：推理写 stderr，stdout 只有最终一条助手消息（上面的 help 原文）。工具调用、步骤清单、token 用量一律读不到。→ dsh 的进度只能靠 `fleet` 命令和 git 动作；用量只能从上游侧拿。
- 经 Mirasim 时，快照里有 usage（例：`inputTokens 251 / outputTokens 183 / cachedInputTokens 14080`，WD `docs/evidence/1576-dsh-relay-pinned-model.json`）。

### 7.4 真开工 / 真完成

- 直起：只有进程退出码 + stdout 的最终消息 + 交付判据。开工只能看工作树有没有动（没查成更好的办法）。

### 7.5 常见失败与报错原文

| 原文 | 出处 |
|---|---|
| `dsh web did not become ready within 45s` | WD `docs/evidence/1576-dsh-relay-pinned-model.json` |
| `turn failed: fetch failed`（快照 `error:"fetch failed"`、`incomplete:true`） | WD `docs/evidence/1576-dsh-relay-fetch-failed.json` |
| 启动即报错（`healProfilesModuleFallback`：profiles 下的 node_modules 必须是符号链接） | AGS `deploy/mirasim-native-baseline.mjs:50-52`；AGS `docs/DECISIONS.md` §39 三 |

### 7.6 凭据（只写种类）

- `$DSH_HOME/settings.yaml`（默认 `~/.dsh/`）里的 `apiKeyEnv` 指定从哪个环境变量读 key；`~/.dsh/profiles/`。经 Mirasim 中继时不需要 DeepSeek 账号（WD `execution-profiles.json`）。

### 7.7 已知的坑 → 测试用例

- **DS-01** 给定本机 `~/.dsh/settings.yaml` 已有默认模型，当用 `--patch` 或 `OPENAI_BASE_URL` 想改上游，应当不生效：settings.yaml 会盖掉 `--patch`，`OPENAI_BASE_URL` 它根本不读。适配器用独立的 `DSH_HOME` 写全配置。（AGS `deploy/mirasim-native-baseline.mjs:46-49`）
- **DS-02** 给定独立的 `DSH_HOME`，当 `profiles/` 用拷贝而不是符号链接（Windows 用 junction），应当被体检拦下：拷贝会把本该是链接的 `node_modules` 解成真目录，dsh 一启动就报错。（AGS `deploy/mirasim-native-baseline.mjs:50-52`，2026-08-29 踩过）
- **DS-03** 给定 dsh 路由，当模型写成界面标签 `v4.1-flash` 或 `deepseek-v4.1-flash`，应当被拒：模型 id 是 `deepseek-flash`；不点名则 `fetch failed`。（WD `docs/evidence/1576-dsh-relay-*.json`；AGS `docs/MIRASIM-CHANNELS.md:64-72`）
- **DS-04** 给定产物已经提交、会话却迟迟没有终态，当超过 N 秒，应当按交付判据收尾，不等满步长上限：两针干完活的会话都等满 420 秒才收场，放进 fleet 交接要等满单步 30 分钟。（WD `docs/evidence/1576-dsh-relay-pinned-model.json`；WD `execution-profiles.json` 该条 reason）
- **DS-05** 给定流断了、最后一句回复没出来，当活其实已经做完（71 秒就提交了），应当先「续一句」请它收尾，而不是换一条路由从头做。（WD `packages/fleet/src/activities.mjs:777-778`，2026-09-21 DSH 实测）
- **DS-06** 给定写任务书，当点名具体工具名（`bash`、`write`），应当被评审拦下：dsh 在 Windows 上的 shell 工具叫 `pwsh`，Claude Code 叫 `Bash`；写死工具名等于在考「像不像 pi」。（AGS `docs/DECISIONS.md` §38 三，测量 bug 2）

---

## 附、Kimi Code（设计 §三 第 8 条的验收要用它）

- **旧系统**：在役档 `kimi-mirasim-native-k3`（`backend=mirasim`、不点名模型、快照回 `kimi-code/k3`；走 Kimi Code 自己的账号，不经中继）。真跑证据：Read + Write + Bash 三个工具、提交成功、97 秒（WD `docs/evidence/1576-kimi-k3-worktree-commit.json`）。Mirasim 快照里的 toolCall **不给 kind**，只有 `title / status`（同文件 `note`）。
- **无头起**（本机 0.40.1 与 VPS 2.1.1 的 `kimi --help` 里下面这些选项一致）：
  ```bash
  cd <工作树>
  kimi -p "<prompt>" --output-format stream-json --auto [-m <别名>] [--add-dir <dir>]
  # ACP：kimi acp（`--login` 走设备码登录）
  ```
  help 原文：`--yolo`「Ask When Needed mode：… risky actions, questions, and plans still ask」；`--auto`「Never Ask mode：never interrupts you」。无人值守要用 `--auto`。
- **输出格式、完成信号、token**：没查成。
- **凭据**：`kimi login`（设备码流程）；默认模型在 `config.toml` 的 `default_model`（help 原文）；凭据文件的具体位置没查成。子代理投影目录 `~/.kimi-code/agents`（WD `INDEX.md:40`）。
- **坑 → 测试用例**：
  - **KM-01** 给定一条不点名模型的路由，当起会话，应当先在配置里声明期望模型，起后回读快照或事件里的实际模型核对，不符就停：kimi 档最早按「不声明模型」立，被运行时判 `invalid execution profile` 整条腿起不来；而没有声明值就没有起后核对，模型被换掉发现不了。（WD `execution-profiles.json` 该条 `modelSelectionNote`）
  - **KM-02** 给定默认模型的出处没查清（服务端全局默认还是 kimi CLI 自己的配置），当核对不符，应当只报「观测值不是声明值」，不编一个「去哪个旋钮改回来」。（同上）
- **注意**：本机和 VPS 的 Kimi Code 版本差很大（0.40.1 vs 2.1.1），参数与输出格式以 VPS 上实跑为准。

---

## 八、Mirasim 运行时接口（ws）

> 新系统里 Mirasim 只该留作「中继额度」路由的插头（结论 7）。下面既是这层的接口说明，也是为什么不该让它承担更多的证据。

### 8.1 服务与准入

- systemd `mirasim-server.service`：`<安装根>/current/node server.cjs --port 4316 --host <回环> --no-open --workdir ~/mirasim-work`，`User=<服务用户>`，环境变量 `MIRASIM_NO_AGENT_EGRESS=1`、`MIRASIM_ACCOUNT_USAGE_PROBE=0`、`MIRASIM_OPEN_BROWSER=0`，`MemoryHigh=2.5G / MemoryMax=4G`，`OOMPolicy=continue`（WD `host/machine/systemd/mirasim-server.service`）。
- 用中继额度要先注册设备：ws `relayEmailCode` → 用户给验证码 → `relayEmailVerify`；`setRelayMode {mode: local|cloud|auto}`（AGS `docs/DECISIONS.md` §72）。中继的触发策略（VPS 现值）是 `mode:auto, threshold:0.95, on5h, on7d, reactive`：**自带订阅优先**，5h / 7d 窗用到 95% 或当场被拒才切中转（AGS `docs/MIRASIM-CHANNELS.md:74`）。

### 8.2 帧协议（WD `scripts/lib/mirasim-runtime.mjs`）

| 动作 | 发 | 收 | 行 |
|---|---|---|---|
| 连接 | 读服务端写在本机的回环令牌文件（服务每次起停都换）→ `ws://<回环>:<端口>/ws?token=<令牌>` | — | 904-990 |
| 握手 | `{type:'clientHello'}` + `{type:'getState'}`（state 帧**不会自己推**） | `{type:'state', state:{version, workdir, home, platform, agentsAvailable[]}}` | 992-997, 329-360 |
| 起会话 / 续跑 | `{type:'prompt', prompt, agent, workdir, [sessionKey=续跑], [model], [effort], [route: local\|cloud\|null(=auto)], clientRef}` | `{type:'accepted', sessionKey:'<agent>:<uuid>', taskId}` 或 `{type:'error', message}`（等 30 秒） | 1316-1361 |
| 读 | **新开一条连接** `{type:'subscribe', sessionKey}` | `{type:'snapshot', sessionKey, seq, snapshot:{phase\|runState, text, toolCalls[{id,name,status}], error, incomplete, model, interactions[], activity, updatedAt, reasoning}}` 或 `{type:'session', patch:{full:{…}}}` | 1485-1525；`execution-runtime.mjs:65-73` |
| 名单 | `{type:'listSessions', scope:'global', limit}`（256 起翻倍） | `{type:'sessions', sessions[], hasMore}`；只有 `hasMore:false` 才算完整 | 1622-1661 |
| 应答 | `{type:'interact', promptId, action:'answer', value}` | 只在失败时回 `error` | 1528-1553 |
| 停 | `{type:'stop', sessionKey}` | 只在失败时回 `error` | 1555-1568 |
| 工作区 | `listWorkspaces` / `saveWorkspace` / `addWorktree{path,branch,base,reqId}` | `workspaces` / `worktreeAdded{ok,path,error}` | 1130-1206 |
| 配置 | `getConfig`、`applyConfig{config, dryRun}`、`setAgentLaunch{agent, command}`（不回帧）、`getModelLayer`、`getModelRoster` | `config` / `configApplied{changes[]}` | AGS `docs/MIRASIM-CHANNELS.md` 文末；AGS `deploy/reclaude-mirasim.mjs`（setLaunch） |

- 执行体（VPS 0.0.337 的 `state.agentsAvailable`）：`claude / codex / kimi / grok / pi / gui`（AGS `docs/MIRASIM-CHANNELS.md:21`），dsh 是后来装的。
- 服务端怎么起各家 CLI：claude 见 §2.1；codex 是池化的 app-server + MITM 代理；pi 是 `-e <网关> --mode rpc --session-id`；grok 是 `grok agent --no-leader stdio`（Windows 桌面机实录）；dsh 是 web 形态（据报错原文推断）；kimi 没查成。

### 8.3 旁路数据（判完工和记账用）

- 账本：`~/.mirasim/traffic/<会话 uuid>/index-*.ndjson`，每次上游调用一行（`ts, status, upstreamHost, viaRelay, leg…`）（mirasim-runtime.mjs:855-879）；按月汇总 `~/.mirasim/insights/usage-<YYYY-MM>.ndjson`、`session-usage-*.ndjson`（WD `execution-usage.mjs:814-817`）。
- 事件：`~/.mirasim/analytics/events-<日>.ndjson`（`turn.submit` 带 agent / model，`turn.finish` 带 ok / errorCode / agent / model / sessionId）、`~/.mirasim/diag/ev-<UTC 小时>.ndjson`（WD `turn-outcomes.mjs:10-13, 29-33`）。
- journal：`MIRASIM_AGENT_TURN_TIMING {agent, startedAt, mode, outcome, stages{totalMs}}`，**不带 sessionKey**，服务用户默认读不到（mirasim-runtime.mjs:690-713, 881-900）。
- 会话档案：`~/.mirasim/sessions/<agent>/<id>/record.json`，键为 `agent, sessionId, workspacePath, workdir, createdAt, updatedAt, title, runState, runDetail, mintedHere, runPid, runStartedAt, nativeSessionId, preview`（`<VPS>` 2026-09-24 只读）。
- 中继额度窗：relay `/v1/limits`（5h / 7d / 7d_fable，AGS `docs/DECISIONS.md` §71），或 ws `getRelay`（WD `INDEX.md:98`）。

### 8.4 真开工 / 真完成

- **accepted ≠ 开工**。快照 phase 从 `queued` 走到 `streaming`、`text` 或 `toolCalls` 在长才算开工；pi 的 `model` 要在 accepted 之后约 1.9 秒才出现在快照里（mirasim-runtime.mjs:1083-1088）。
- **完成**（WD `mirasim-runtime.mjs:736-845` + `execution-runtime.mjs:115-149`）：快照必须回帧 → phase ∈ {done, complete, completed} → 没有 `incomplete` → **没有 `error`**（done 带死因 = 失败）→ 中继路由还要账本里起针之后有 2xx 行 → 有可观察的产出。名单预览（partial）里的 completed 不许当完工。

### 8.5 常见失败与报错原文

`连不上回环 ws`；`连上了但没收到 state 帧，契约没查成——不派`；`契约断言不通过，拒派：…`；`服务端没有 <agent> 这个执行体`；`起会话没查成：没收到 prompt 的应答帧`；`服务端拒了这一针：<message>`；`续跑返回了不同的 sessionKey`；`<agent> turn stalled past 30 minutes`；`Selected model is at capacity. Please try …`；`no <agent> account on this machine; routing this session through the relay`；合成 422「本机没有这个智能体的账号」；`Interrupted by user.`。（WD `mirasim-runtime.mjs` 各处；WD `docs/evidence/*`；`<VPS>` 会话记录）

### 8.6 凭据（只写种类）

- 回环 ws 令牌文件（服务起停就换）；Mirasim 设置文件（设备私钥、中继登录、`agentLaunch`、`piModel`、`claudeAskTool`…；宿主会拿内存态覆写，**只能经 ws `applyConfig` 改**）；keys 目录；MITM 证书目录（WD `INDEX.md:126-141`；AGS `docs/MIRASIM-CHANNELS.md:88`）。

### 8.7 已知的坑 → 测试用例

- **MS-01** 给定服务端被升级器自动升了版本，当适配器钉着一个手打的版本号，应当不会整条链被拒：0.0.282 → 0.0.307 那次契约断言全部不符，96 次派工被拒、11 单卡死，报警还因为同源失效没人知道。→ 版本读 `current/VERSION`，「在役进程自报 ≠ 升级器 promote 的版本」判红。（WD `mirasim-runtime.mjs:51-63, 79-114`）
- **MS-02** 给定新连接，当只等服务端推 state 帧，应当超时：必须先发 `clientHello` + `getState`。（mirasim-runtime.mjs:992-997，「连上干等只等到超时」）
- **MS-03** 给定发 prompt 的那条连接，当只听它自己收到的推送来判完工，应当判不出：推送不保证送到发起连接，我方只见 queued，服务端 2.7 秒就干完了。读状态必须新开连接 `subscribe`。（AGS `docs/DECISIONS.md` §72；WD `mirasim-runtime.mjs:21-26`）
- **MS-04** 给定一个刚起的会话，当用 `getSnapshot` 读，应当读不到（只有服务端缓存了这条会话才回帧）：实测连读 13 次全空，而账本里它 3.2 秒就 200 了。（mirasim-runtime.mjs:1479-1482）
- **MS-05** 给定会话名单，当读 `runState` 字段判状态，应当读不到（名单里的真字段是 state / phase / observedState）：只读 runState 让「在役审官」数恒为满、复审票一张都拉不动。（WD `execution-states.mjs:66-91`；mirasim-runtime.mjs:624-628）
- **MS-06** 给定名单 `hasMore:true`、截断或超时，当有人拿它判「这棵树上没有会话」，应当判「没查成」：残缺名单里的「没有」只是「没看见」，下游会据此误删、误派。（mirasim-runtime.mjs:549-574, 1616-1661，#1336）
- **MS-07** 给定机器负载高（例如 20），当按快照的 6 秒预算读名单，应当不会把「慢」判成「死」：名单和握手用单独的 30 秒预算，探活连红就重启正是这么来的。（mirasim-runtime.mjs:147-152, 1066-1079）
- **MS-08** 给定服务端正在起一个 codex 会话，当另一路建连，应当重试到约 60–90 秒而不是 1.2 秒就放弃：起一个 codex 会话就把单线程事件循环堵 40–58 秒，fleet 冒烟单 #1560 当场死在 planning。（mirasim-runtime.mjs:182-191）
- **MS-09** 给定 `route=local` 而本机没有那个执行体的 Mirasim 账号，当起会话，应当预期合成 422、零请求。（WD `docs/evidence/1521-fable-relay-execution.json`）
- **MS-10** 给定快照 `phase=done`，当 `error` 非空（例如 `pi turn stalled past 30 minutes`、`Selected model is at capacity…`），应当判失败：死因只写在 error 里，incomplete 标记不稳定；2026-09-07 一天静默搁浅 11 次（3 个工人 + 8 个审官），所有真交付的会话 error 都是 null。（mirasim-runtime.mjs:768-785，#1121）
- **MS-11** 给定会话状态是 `incomplete`（上游断流打死的常态），当判「这棵树还被占着吗」，应当判终态：终态表曾有四份手打副本互相不一致，结果一边永久占树、一边该扫不扫，实测卡了 56 分钟。（WD `execution-states.mjs:1-23, 49-63`）
- **MS-12** 给定名单里某会话 `open:false`，当判它是否结束，应当不采信：无头在跑的 grok 可能就是 `open:false`，照它判终态会让指挥官杀掉自己的工人。（WD `execution-runtime.mjs:916-920`）
- **MS-13** 给定 `record.json` 的 `runPid`，当拿它判会话进程死活，应当被拒：它是 mirasim-server 自己的 pid（实测五条 running 记录的 runPid 全是服务进程）。（WD `scripts/lib/dispatch/lease.mjs:14-18`）
- **MS-14** 给定服务端升级重启后忘了会话（读回 missing），当判占用，应当能了结：曾有一棵树被连服务端都不认得的租约占住 17 小时（9 条里 8 条是这种）。（WD `execution-runtime.mjs:514-521`，#1420）
- **MS-15** 给定刚发了 `stop`，当立刻读状态，应当预期它还没翻终态：约 3 秒后才翻；旧代码只等 3×100 毫秒就判「验不过」，把租约写回 stopping 占住那棵树，要等下次起会话或每日收树才了结。（WD `execution-runtime.mjs:36-40`）
- **MS-16** 给定 `stop` 或 `interact` 发出后短窗内没有 error 帧，当判「送到了」，应当再核实连接还活着并回读状态：连接断了时等待函数同样回 null，那是「没查成」不是成功。（mirasim-runtime.mjs:1541-1547, 1558-1564，PR #884 审官实咬）
- **MS-17** 给定要续跑，当发 `{type:'continue'}` 或带 `continueFrom` 字段，应当不起作用（前者没有回帧，后者被忽略）；正确形态是同一 prompt 帧带上已有 sessionKey，服务端回同一个 key。本地登记要能接管同 key，否则撞 `already registered`，而 prompt 已经发出去了。（mirasim-runtime.mjs:1326-1329；WD `execution-runtime.mjs:418-433`，#1493）
- **MS-18** 给定 prompt 已发出但没收到 accepted 帧，当处理失败，应当按「工作目录 + 起针时间窗」去 `~/.mirasim/sessions/<agent>/*/record.json` 对账找回会话，不许重发（重发会烧两次额度）；明确被拒的才标「确定没起」。（mirasim-runtime.mjs:1417-1427, 1448-1469，#1174）
- **MS-19** 给定 Mirasim 起 claude，当它往 `--settings` 注入 `ANTHROPIC_BASE_URL`，应当知道这会架空 reclaude；给 codex app-server 注入代理和 CA，会让 `config.toml` 的上游失效；借用执行体的出网配置（reclaude 代理），会让 reclaude 设备被解绑。（AGS `deploy/reclaude-mirasim/strip.go:10-15`；WD observation 2026-09-18 ③；WD `mirasim-server.service` 注释）
- **MS-20** 给定改了用户级 env 或 PATH，当不重启 Mirasim 就起会话，应当预期新配置不生效：服务端的 env 在启动那一刻就定死了。（WD observation「五步」真凶段；WD `docs/GROK-MIRASIM-FIX.md` §3.4）
- **MS-21** 给定要改 `agentLaunch`，当有在途回合，应当拒改或等空闲：改启动命令会重建 driver，把所有在途回合杀掉（一次杀两个，其中一个跑了 4.5 小时）。（AGS `docs/RECLAUDE-IN-MIRASIM.md:50-63`；判例 `mirasim-overrides-reclaude-upstream` 第五次）
- **MS-22** 给定要改 Mirasim 设置，当直接写 `setting.json`，应当被拒：宿主会用内存态覆写回去；只能经 ws `applyConfig`（带 dryRun）。（AGS `docs/MIRASIM-CHANNELS.md:88`）
- **MS-23** 给定工作区仓库挂着很多 worktree，当测起会话耗时，应当看到它随树数变坏：服务端单线程、对每棵树轮询 git，162 棵树时平均挂 67 个 git 子进程、主线程 CPU 50%、起会话堵 58 秒、探针连红。（判例 `worktree-pileup-starves-mirasim` 撞 2 次，#1570）
- **MS-24** 给定服务端跑久了，当看内存和 CPU，应当有上限和告警：用量回填不收敛（每 3 分钟「补齐 N 行」、下一轮仍是 N），CPU 85%、每小时约 3.3 万次重复查询；跑 4 天涨到 6.8G 后 ws 静默瘫痪。（WD observation 2026-09-18 ①；WD `mirasim-server.service` 注释）
- **MS-25** 给定所有执行体子进程都在服务的 cgroup 里，当一个失控执行体触发 OOM，应当只死那一个会话：默认 `OOMPolicy=stop` 会把整个服务连同全部会话一起带走（09-22 有过 3.5G 峰值）。（WD `mirasim-server.service`；WD `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md` 结论 1）
- **MS-26** 给定 ws 探活，当只 ping state 帧，应当判不出「listSessions 单口退化」：state 在、起会话也通，但名单帧不回，只 ping state 会整晚判活。（WD `scripts/lib/mirasim-ws-probe.mjs:1-16`）
- **MS-27** 给定 `route=auto`（或没指定 route），当判这次会话走的是哪条上游，应当以服务端 journal 的 routing 行或账本的 `upstreamHost / viaRelay` 为准，不按「会话成功了」推断。（判例 `mirasim-overrides-reclaude-upstream` 第二次：一次「成功」的探针其实走了中继）
- **MS-28** 给定想用 Mirasim 中继额度，当走任何反代或桥接，应当被拒：官方原话「可供共享账号，但是要用我们的客户端」「不支持反代」「反代会风控」。（AGS `docs/DECISIONS.md:2233-2244`）

---

## 九、ACP（Agent Client Protocol，含 devin）

### 9.1 各家入口

| 执行体 | 命令 | 出处 |
|---|---|---|
| cursor | `cursor-agent --trust acp` | WD `acp-runtime.mjs:10`；本机 `cursor-agent acp --help` |
| devin | `devin --respect-workspace-trust false acp` | WD `acp-runtime.mjs:11` |
| grok | `grok agent --no-leader stdio`（env `GROK_DISABLE_AUTOUPDATER=1`；要免确认就加 `--always-approve`） | WD `acp-runtime.mjs:12`；随装文档 `15-agent-mode.md` |
| kimi | `kimi acp`（`--login` 走设备码登录） | 本机 `kimi acp --help`（旧系统没用过） |

- 在役：`cursor-acp-composer / -grok-4.6 / -grok-4.7`、`devin-acp-deepseek`（`deepseek-v4-flash-max`）。`devin-acp-default` 停用：握手不报模型身份（WD `execution-profiles.json`）。ACP 档一律 `route=local`（WD `execution-catalog.mjs:175`）。

### 9.2 协议要点（旧 runner 的实现）

- **按行分隔的 JSON-RPC 2.0**，不是 LSP 的 Content-Length 帧；单帧上限 8MB（WD `scripts/lib/acp-client.mjs:13-18, 45-60`）。
- `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false, writeTextFile:false}, terminal:false}}`，协议版本不是 1 就拒（runner:713-714）。
- `session/new {cwd, mcpServers}`；续跑用 `session/load {sessionId, cwd, mcpServers}`，前提是 `agentCapabilities.loadSession === true`，而且回来的 sessionId 必须是原来那个（runner:718-730）。
- **模型钉定**：从 `configOptions` 里找 `category==='model'` 或 `id==='model'` 的选项，用 `session/set_config_option`，没有就用 `session/set_model`；然后回读 `currentModelId / currentValue`，必须是具体的 id（不许 auto / default / pool / best），会话中途被改就判 `model_mismatch`（runner:527-537, 732-742；`acp-runtime.mjs:215-218`）。
- **effort**：`configOptions` 里 `effort / reasoning_effort / reasoning / thought_level` 那一项；没有就要求它编在模型 id 的方括号里（runner:743-753）。
- `acceptedAt` 在模型核对通过之后、`session/prompt` 发出之前写（runner:756-761）；`session/prompt` 不设超时（runner:761）。
- 结束：`stopReason=end_turn` → done；`cancelled` → cancelled；其他 → `prompt_incomplete`；prompt 结束时还有没答的交互 → `unresolved_interaction`（runner:762-768）；执行体在出结果前退出 → 给 50 毫秒把 stdout 读完再判 `agent_exited`（runner:703-707）。
- 更新：只收 `agent_message_chunk`（拼正文，上限 4MB）和 `tool_call / tool_call_update`，**`plan` 与 `agent_thought_chunk` 被丢弃**（runner:550-576）。usage：凡是键名像 usage / tokens 的消息都原样追加进 `usage.ndjson`（runner:431-437, 539-548）。devin 的 usage 实例：`inputTokens 20866 / outputTokens 62 / totalTokens 20928`（WD `docs/evidence/1174-devin-acp-model-pinning.json`）。
- 阻塞请求：`session/request_permission`（选项 kind：`allow_once / reject_once / reject_always`）、cursor 专有的 `cursor/ask_question`、`cursor/create_plan`；不认识的阻塞扩展方法一律回 -32601 并结束会话 `unsupported_interaction`；devin 的 `cognition.ai/*` 通知记下但不阻塞（runner:16-17, 577-606）。
- 进程：runner 以 detached 方式 spawn，再 spawn 一个自己当「进程组看守」，看守再 spawn CLI；用 `/proc/<pid>/stat` 的启动节拍 + `boot_id` 认进程身份，只在 Linux 上可用；状态单写者、原子改名写 `status.json`，控制走「inbox / receipts」文件（WD `acp-runtime.mjs:58-152, 403-511`；runner:439-458, 637-689）。

### 9.3 常见失败与报错原文

- 旧 runner 自己的失败码（WD `acp-runtime.mjs`、runner）：`protocol_mismatch`（「ACP server did not negotiate protocol version 1」）、`model_unavailable`（「Requested concrete model ID is absent from the ACP model catalog」）、`model_unverified`、`model_mismatch`、`unsupported_effort`、`effort_mismatch`、`resume_unsupported`（「did not advertise session/load」）、`session_mismatch`、`unsupported_interaction`、`unresolved_interaction`、`agent_exited`（「ACP agent exited before a prompt result」）、`agent_spawn_failed`、`prompt_incomplete`、`startup_timeout`（「ACP runner did not accept the session in time」）、`workdir_locked`、`runner_lost`、`cleanup_failed`、`unsupported_platform`（「Durable ACP requires Linux process identity checks」）。
- 认证类：错误码或文案命中 `auth | unauthenticated | login required | not logged in` 时记 `auth_required`（runner:522-525）；cursor 读不到登录态时握手停在 authenticate，回 `Invalid params`（AGS `docs/DECISIONS.md:950-956`）。
- devin（TUI 时代的实录，ACP 下的对应形态没查成）：`Exited with code 0` / `Connection lost` / `send a message to continue retrying`，而卡片仍显示 in-progress——这就是工人已经死了（判例 `devin-connection-lost-is-dead`）。

### 9.4 凭据（只写种类）

- 用各 CLI 自己的登录态（位置见 WD `INDEX.md:55-58, 149`）。devin：`devin auth` 登录，`devin auth status` 查（WD `NEW-MACHINE.md` §7d）。
- 旧 runner 每个会话一个状态目录（0700），其中 `request.json` 带 agentEnv，属私有执行状态，不许进日志或仓（WD `acp-runtime.mjs:419-466`）。

### 9.5 已知的坑 → 测试用例

- **ACP-01** 给定 devin，当 `session/new` 之后不钉模型，应当预期落在握手默认值（2026-09-14 是 swe-2-high，更早是 swe-1-7-medium）；必须 `set_config_option` 后回读 `currentValue` 等于请求值。（WD `docs/evidence/1174-devin-acp-model-pinning.json`）
- **ACP-02** 给定 devin 的权限请求只带 toolCallId、不带 kind，当按 kind 判放行，应当回溯之前 `session/update` 宣告的同一 tool_call 取 kind；取不到就拒，不猜。（runner:181-194）
- **ACP-03** 给定 devin 的执行请求，当找命令，应当读 `_meta['cognition.ai/editableCommand']`，并认 `git -C <dir>` 形态（目录必须是工作树）。（runner:179, 315-319, 346-353）
- **ACP-04** 给定真实会话里的只读命令（`git log …; ls …`、`… 2>/dev/null`、`git diff HEAD~2`、`grep -n 'a/b' file`、`sed -n '/x/,/y/p'`），当过权限判定，应当放行：这几种形态各自都被错拒过（`;` 只认 `&&` 的那次，报错还把白名单里的 git 列成「不在白名单」；`2>/dev/null` 复核会话实咬 4 次；`~` 整词拒掉 `HEAD~2`；grep / sed 的模式里的 `/` 被当成树外路径，#1595 一次会话 3 次被拒里有 1 次是它）。（runner:81-83, 130-138, 256-260, 330-333）
- **ACP-05** 给定 `cat <树外的机器人凭据文件>`（或任何带树外路径参数的白名单命令），当过权限判定，应当被拒：前缀只判命令名时它会被当「只读巡检」放行。（runner:244-246，2026-09-18 发现）
- **ACP-06** 给定无人值守，当权限请求没有规则能放行，应当替人拒一次（`reject_once`）而不是挂着等，同一会话最多代拒 8 次：执行者给脚本加 +x 换了 8 种写法被拒 8 次；任务书要求跑的命令闸却不放，工人停手发问、活做完没提交。（runner:403-420；判例 `silent-refusal-makes-agents-probe`，#1560 g3；闸 WD `packages/fleet/test/taskbook-vs-gate.test.mjs`）
- **ACP-07** 给定任务书写着「提交前先跑 X」，当 X 不在权限白名单里，应当由测试拦下：任务书要求的命令必须都过得了默认策略。（WD `acp-interaction-policy.mjs:63-65`，#1560 g3）
- **ACP-08** 给定续跑，当按「key 有没有变」判「续上了没有」，应当判错：ACP 每次尝试都换一个新 key（Mirasim 则回同一个 key）；判据是运行时的回执，不是 key 相同。（WD `packages/fleet/src/activities.mjs:734-737`，#1493；判例 `wiring-tests-dont-prove-backend-contract`：单测 71/71 绿，真跑四条腿一条都没用上）
- **ACP-09** 给定一个 ACP 会话结束，当判「清理干净了」，应当核实进程组（含自立门户的子进程）全部退出、没有幸存者，再释放工作树锁。（WD `acp-runtime.mjs:99-152`；AGS `docs/DECISIONS.md:974-977`）
- **ACP-10** 给定执行体要问人（cursor 有原生 `cursor/ask_question`，其他家没有），当需要提问，应当有统一入口：旧系统为此注入了一个 MCP 提问工具 `dao_ask_user_question`。新系统用 `fleet ask` 命令替代。（WD `scripts/acp-interaction-mcp.mjs`；WD `docs/evidence/1174-cursor-question.json`）
- **ACP-11** 给定 ACP 客户端回错误给执行体，当异常信息里可能带凭据，应当只回固定文案，不把原始异常写到线上。（WD `acp-client.mjs:79-83`）

---

## 十、跨插头的通用坑 → 测试用例

- **GEN-01 三态**：给定任何「查一下」的结果（名单、租约、账本、版本、进程扫描），当没读到或读不完整，应当返回「没查成」，不许折成「空」或「没事」。（旧仓通篇；例：WD `mirasim-runtime.mjs:1616-1619`「绝不回空数组：下游拿『0 个在跑』会一次把上游池子拉满」）
- **GEN-02 失败原因不许写死**：给定起会话失败，当落执行记录，应当带上分类后的真实原因（我方 / 账号 / 上游 / 认不出）和脱敏后的原文：旧代码一律写 `backend_launch_unconfirmed`，Grok 121 次失败里 83 次贴着它，真因（xAI 额度用完）当场丢掉，还被当面说错一次。（WD `execution-runtime.mjs:20-29, 552`；WD `failure-class.mjs:9-24`；判例 `placeholder-looks-like-a-reason`，闸在 WD `tests/execution-runtime.test.js`）
- **GEN-03 模型只记观测值**：给定起会话，当记录「实际模型」，应当只写从快照或事件里观测到的值，起针那一刻写 null：旧写法把请求值回显成 actualModel，pi 实际跑的是另一个模型而记录显示点名成功。（WD `execution-runtime.mjs:394-397`，#1460）
- **GEN-04 续跑只续同一条路由**：给定上一轮换过路由，当续跑，应当核对执行档，不符就开新会话：否则提交前缀和跨厂判定全跟着错。（WD `execution-runtime.mjs:1047-1053`，#1493 / #1608 g1）
- **GEN-05 按进展判停滞**：给定会话在跑、没有工具在执行、进度指纹（正文长度、推理长度、工具数与状态、activity、更新时间、seq）连续 360 秒不变，应当判停滞；有工具在跑（例如测试跑十几分钟）不计。360 秒的依据：7 天 384 个健康会话的单次模型调用 p95 为 140–229 秒、最大 320 秒。（WD `execution-runtime.mjs:60-73`；WD `packages/fleet/src/limits.mjs:20-27`，#1499）
- **GEN-06 完成 = 交付**：给定执行体报完成，当判「交了活」，应当要求相对**此刻**目标分支有自己的提交（`rev-list --count origin/<目标>..HEAD > 0`）且相对合并基有内容差异（`diff --quiet origin/<目标>...HEAD` 退出 1 且 stderr 为空）：一次执行者零产出、树被快进到新 master，HEAD 变了就被当成新活，一路 CI 绿、审查无发现、合并、关单。（WD `activities.mjs:282-297, 1061-1070`；判例 `completed-is-not-delivered`，#1572）
- **GEN-07 系统改提交先问发没发布**：给定系统要 amend 提交（例如对齐前缀），当那个提交已在远端，应当不改：改了就和远端永久分叉，之后每次推送都 non-fast-forward。（WD `activities.mjs:1078-1083`；判例 `system-amend-rewrites-published-commit`）
- **GEN-08 测试碰不到真执行体**：给定单元测试进程，当调到起会话的代码，应当结构性地拒绝（默认拦、只有生产入口显式放行）：2026-09-08 的 14 个假会话就是子进程 env 被整份换成瘦对象后放出去的。（WD `mirasim-runtime.mjs:263-320`，#565 / #1152）
- **GEN-09 长 prompt 不走 argv、不塞 TUI**：给定 prompt 超过十几 KB，当交给执行体，应当走 stdin 或文件：拼进 argv 超 128KB 就 `spawn E2BIG`；塞进 TUI 会折成 `[Pasted Content N chars]` 永不提交（「从任何机器可读状态看都是在岗，实际零执行」）。（AGS `docs/DECISIONS.md:679-690`；判例 `dispatch-accepted-vs-worker-started` 撞 4 次、`codex-inject-stuck-as-paste`）
- **GEN-10 按本会话过滤事件**：给定广播或共享的事件流，当判完工，应当只认本会话 id 的事件：曾把广播里别人的 `phase:"done"` 当成自己的，十个模型全判 0/4。（AGS `docs/DECISIONS.md` §38 三，测量 bug 3）
- **GEN-11 解析完整输出**：给定判分或解析，当读的是被截断的控制台输出（300 字），应当被拒，改读完整 stdout 或文件：话多的模型把 JSON 放在最后，就被切掉判成失败。（AGS `docs/DECISIONS.md` §38 三，测量 bug 1）
- **GEN-12 每次 spawn 显式给 env**：给定长驻宿主（Orca 守护、Mirasim、编排进程），当经它起执行体，应当用现读的配置构造 env，不继承宿主启动时的环境块：Orca 终端守护进程跨重启存活，喂了近一周的陈旧 env，排查两小时。（判例 `orca-daemon-stale-env` 撞 2 次；§二 CC-11、§五 GK-02）
- **GEN-13 凭据隔离**：给定执行体以 bypass 或 always-approve 模式运行，当它尝试读机器人私钥、上游 key、Mirasim keys 这类树外凭据，应当读不到（独立用户或沙箱，文件权限挡住）。（ACP-05；WD `dao-fleet-worker.service` 与 `mirasim-server.service` 同为 `User=<服务用户>`）
- **GEN-14 断流单列**：给定回合以 `incomplete / timeout` 结束，当算路由成功率，应当记账、写原因，但不进分母；两条独立的路由同时同形状地断，说明坏的是共用的传输层。（WD `turn-outcomes.mjs:23-28`，#1386）
- **GEN-15 自杀不算上游失败**：给定我们自己发的停止（`interrupted / aborted`，5 秒内紧跟一条我们的 `turn.stop`），当算失败率，应当扣除：236 条 interrupted 里 231 条是自己停的。（WD `turn-outcomes.mjs:15-17`）
- **GEN-16 等人单列一态**：给定会话停在等人回答，当处理，应当单独成一态（重试只会再问一遍），并记下它问了什么：#1560 g1 连起 11 个会话全停在等人，事后查不出问了什么。（WD `activities.mjs:259-275`）
- **GEN-17 真跑验收**：给定一个插头的单测全绿，当宣布可用，应当至少有一针真后端的端到端（续跑用「第一轮记暗号、续跑轮问暗号」证明上下文真接上了）：假后端是按写代码的人对后端的想象造的。（判例 `wiring-tests-dont-prove-backend-contract` 撞 2 次；设计 §三 第 8 条「验收时 Kimi 和 Cursor 各跑一条小任务测插头」正好对上）
- **GEN-18 Windows 开发机起 .cmd 包装**：给定在 Windows 上 spawn `pi / dsh / claude` 这类 `.cmd` 包装，当 `shell:false`，应当预期 EINVAL；当 `shell:true`，多行 prompt 的换行会被 cmd.exe 当成命令分隔符，只剩第一行。要直接 spawn 包装里的真入口。（AGS `docs/DECISIONS.md` §39 三；AGS `deploy/mirasim-native-baseline.mjs:134-148`）——只影响本地开发，VPS 上不适用。

---

## 十一、旧系统起一个会话的完整调用链，以及哪些层是多余的

### 11.1 调用链（fleet 活动 → 进程，摘要）

旧系统起一个会话：Temporal 工作流 `fleetTaskWorkflowV2`（WD `packages/fleet/src/workflows.mjs:36-67`；活动 `maximumAttempts:1`）→ 占全机执行槽（`machine-slots.mjs`，同时执行 ≤ floor(核数/2)）→ `prepare` 建树（`activities.mjs:664-680`：`git worktree add` + 分支标记 + 控制面钩子，`execution-runtime.mjs:91-114, 1075-1081`）→ 活动 `lead / execute / selfReview / review` 里的 `runSession`（`activities.mjs:684-722`：主腿 + 候补的换腿链，共享一份等待总量，`limits.mjs`）→ `runSessionOnce`（`activities.mjs:723-858`）：返工时续跑；先按租约收树（树锁①，`:597-605`）、按全局名单收本树残留会话（`:580-592`）→ `execution-runtime.startSession`（`execution-runtime.mjs:465-567`）：测试隔离闸（第 1 次）、按 mtime 重读执行目录（`:356-400`）、flock 准入锁 + 租约 + 会话登记 + `/proc` 扫描（树锁②，`execution-fence.mjs:58-102`、`lease-gc.mjs`）、上一会话没了结就先停掉 → 后端：

- **Mirasim**（`mirasim-runtime.mjs:1208-1429`）：测试隔离闸（第 2 次）→ 服务端默认模型的核对准备 → 再扫一遍 `/proc`（树锁③）→ O_EXCL 占用锁（树锁④）→ 渠道并发预占（读路由表腿上限 + `/proc` 在途 + 熔断表 + 派工账本 + 会话登记，锁内预占）→ 建连（8 次指数退避）→ 读令牌 → ws → `clientHello/getState` → 契约断言 → `prompt` 帧 → 等 accepted（30 秒）→ 服务端默认模型的路由再 `subscribe`×30 回读模型 → 退渠道槽、退占用锁。服务端（混淆的 `server.cjs`，单线程）再起 CLI：claude 是 `agentLaunch=reclaude → claude -p stream-json … --settings <tmp>`；codex 是池化 `codex app-server`（MITM 代理）；pi 是 `pi -e <网关> --mode rpc --session-id <id>`；grok 是 `<壳> grok agent --no-leader stdio`；dsh 是 web 形态（据报错推断）；kimi 没查成。
- **ACP**（`acp-runtime.mjs:403-511`）：目录改名锁（树锁⑤）→ 写 `context.json / request.json / status.json` → detached 起 runner，runner 再起自己当进程组看守，看守起 CLI（`cursor-agent --trust acp` / `devin … acp` / `grok agent --no-leader stdio`）→ runner 依次发 `initialize`、`session/new`（带 MCP 提问工具）、`session/set_config_option`、`session/prompt` → 权限策略与 inbox 轮询 → 写 `status.json`；调用方轮询 `acceptedAt`（30 秒）。

等完工（WD `execution-runtime.mjs:1010-1046`）：每 1.5 秒读一次会话（Mirasim 每次新开 ws `subscribe`；ACP 读 `status.json`）+ 账本交叉核 + 进度指纹判停滞。停滞先续一句、再卡就停会话换腿；状态未知再等 3×120 秒；上游瞬时错误同会话续跑 ≤2 次；停会话 = stop 帧 + `/proc` 杀进程 + 5 次回读终态（ACP：inbox stop → SIGTERM / SIGKILL 进程组）（WD `execution-runtime.mjs:617-739`）。`execute` 之后：交付判据 → 前缀对齐（未发布才 amend）→ push → `gh pr create`（WD `activities.mjs:1061-1127`）。

规模：只算「起、读、停一个会话」的库文件（execution-runtime 1085、mirasim-runtime 1733、acp-runtime 552、acp-session-runner 801、acp-client 140、acp-interaction-policy 105、acp-interaction-mcp 73、execution-fence 116、execution-states 151、dispatch/lease 436、lease-gc 405、tree-lease 73、tree-occupancy 163、channel-concurrency 987、execution-pi-provider 254、execution-catalog 484、dispatch/launch 251）合计约 **7.8k 行**，还不含 activities 里的 runSession 与测试。

### 11.2 哪些层是多余的（旧系统里该丢掉的）

| 层 | 旧代码 | 为什么当初要它 | 新系统 | 理由 |
|---|---|---|---|---|
| 五道树占用闸（①–⑤）+ 租约回收判据 | activities.mjs:580-605；execution-runtime.mjs:465-567, 740-841；dispatch/lease.mjs；lease-gc.mjs；tree-lease / tree-occupancy；acp-runtime.mjs:154-188 | 「一棵树同时只一个会话」：2026-09-06 六小时起了 137 个会话、一棵树 20 个（lease.mjs:3-11） | **删**：一个子任务一棵工作树、一条工作流、一个会话 id，由 Temporal 独占；进程归 cgroup scope，「谁创建谁回收」（设计 §十六） | 这些层自己出过一串事故：#1420（占树 9 小时 / 17 小时）、#1350（每轮 117 条在同一行抛掉）、#1735（长寿 worker 自己没确认的启动锁死树，直到重启）、#1174 缺陷二（看门狗刷新时钟，宽限永远到不了）、incomplete 占树 56 分钟 |
| 渠道并发闸（锁内预占） | mirasim-runtime.mjs:1284-1313；channel-concurrency.mjs（987 行） | pqapi 并发上限 2 被顶到 3–4，落回 429（:1292-1293） | **并入引擎**：每个账号池一条队列（设计 §九「并发」） | 每次起会话都读路由表 + /proc + 熔断表 + 账本，是在补「没有中心调度」的洞 |
| 测试隔离闸重复两次 | execution-runtime.mjs:274-279；mirasim-runtime.mjs:1217-1220 | #565：14 个假会话泄漏 | **一处**：适配器构造时注入 spawn 函数，测试给假的 | 两处判据只会漂 |
| Mirasim 作为通用执行面 | mirasim-runtime.mjs 全文 | 用户拍板「除 reclaude 外所有腿都走 Mirasim 的 Linux 载体」（方向定于 2026-09-04 的 AGS DECISIONS §72 与 #880，2026-09-05 重申；判例 `mirasim-replaces-orca-except-reclaude`） | **只留「中继额度」路由的薄插头**；其余直起官方 CLI（设计 §三 第 12 条） | §八的 MS-01…28 大多是在对付这一层：私有混淆协议、版本严格相等、快照不推给发起连接、pi 模型静默丢弃、runPid 是服务进程、open≠结束、done 带死因、单线程轮询 worktree、注入代理和 settings |
| 完工账本交叉核 + journal | mirasim-runtime.mjs:736-845, 855-900 | 快照说 done 不可信（§72） | 直起 CLI 后**删**（用终态事件 + 退出码）；中继路由保留 | 直起时终态信号来自进程本身 |
| ACP 双进程 + 文件收件箱 IPC | acp-runtime.mjs:403-511；runner:439-458, 637-689 | 会话要比调用方活得久；收尾要核实进程身份 | **可简化**：保留 ACP 插头的话，runner 放进引擎工人进程，回收交给 cgroup scope，耐久交给 Temporal | 50 毫秒一轮的文件轮询、单写者 status.json 都是为「调用方会死」设计的；新架构里这由 Temporal 兜 |
| ACP 权限判定器（约 360 行 shell 解析 + 白名单） | runner:60-362；acp-interaction-policy.mjs | ACP 执行体逐条请求权限；无人值守没人答 | **先做凭据隔离（GEN-13），再删**：改用各家的 always-approve（cursor `--force`、grok `--always-approve` 或 `_meta.yoloMode`） | 白名单是目前唯一挡「cat 读树外凭据」的东西，隔离没落地前不能删；它也反复误拒真实命令（ACP-04、ACP-06） |
| Orca 残留的死代码 | dispatch/launch.mjs 的 `agentStartSpec / orcaKnownAgentId / applyDaoTraceToLaunch / preflightWorkerSlate` | Orca 时代的起法 | **删** | grep：只在 `scripts/dao.mjs` 和 `scripts/lib/dao-cmd.mjs` 里被 re-export，没有任何调用点 |
| 两份「起什么命令」的真相 | `docs/execution-profiles.json` 的 `agents.cli`（只有 dao-check / server-check 读，agent-clis.mjs、launch-binary.mjs）；`acp-runtime.mjs:9-13` 的 `ACP_PROFILES` 写死命令；Mirasim 自己的 `agentLaunch` | #1460：启动模板随 Orca 退役 | **一处插头定义**（命令、参数、env、二进制解析规则），检查器读同一处 | 同一件事三处各说一半；检查器验的名字和真正起的命令不是同一份 |
| 每次起会话重读并全量校验执行目录 | execution-runtime.mjs:248-260；execution-catalog.mjs:150-220 | 长寿 worker 用了内存里的旧目录，当场 Authentication required（#1608 g1） | **配置进 Postgres**（设计 §四），适配器只收解析好的「路由」对象 | 热更新由数据库通知解决，不靠文件 mtime |
| pi 原生 provider 准备器 | execution-pi-provider.mjs（254 行） | opencode-go 23 档直连 | **删** | 那 23 档已按用户 2026-09-20 拍板全部停用 |

**必须保留的能力**（换个地方实现，不是删）：进程组 / cgroup 级回收与核实；起会话后回读实际模型；失败原因分类（按下一步动作）；按进展判停滞；交付判据；凭据隔离；路由级熔断（吃真流量）。

---

## 十二、没查成的（开发时逐个真跑，结果写回本手册）

| 插头 | 要实测的 |
|---|---|
| Claude Code | `tool_use` / `tool_result` 与 `result` 帧的完整字段；无头模式下有没有能被动读取的步骤清单（2.1.281 无 TodoWrite）；额度用满时的退出码与 `result.is_error`；`--session-id` + `--resume` 的续跑在 reclaude 下是否可用 |
| codex | `exec --json` 的 item 类型（命令、改文件、计划）、`turn.completed` 的 usage 字段、失败终态事件；`exec` 会不会挂到共享 daemon（`--no-daemon` 只出现在顶层 help） |
| cursor-agent | `-p --output-format stream-json` 的事件全集与 usage；`-p` 下模型串接不接受 ACP 的方括号写法；`-p` 的额度与认证报错原文 |
| Grok | streaming-json 真实样本（文档有，旧仓没跑过）；1.0.41 会话存储改成 SQLite 之后，旧采集器读 `updates.jsonl` 的办法是否已失效；OAuth 订阅路径的额度窗口从哪读 |
| pi | `--mode json` 事件格式；直起时的完成信号与 token 用量 |
| dsh | 是否有比 headless 更结构化的输出方式；token 用量 |
| Kimi Code | `-p --output-format stream-json` 的事件格式与完成信号；凭据文件位置；默认模型的出处；Mirasim 起 kimi 的方式 |
| Mirasim | 服务端的 30 分钟回合看门狗能不能配置；kimi / dsh 会话的进程形态 |
| 全部 | 各家无头模式下「额度用尽」的退出码与报错原文（目前只有 reclaude 有第一手样本） |
