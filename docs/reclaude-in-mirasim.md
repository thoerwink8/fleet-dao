# Mirasim 里让 claude「自有」会话吃 reclaude 订阅

> 给谁看：在装了 reclaude 的桌面机上，要让 Mirasim 起的 claude 会话（路由选「自有」的）走 reclaude 订阅的 AI 或人。
> 一次配置，之后由 ai-gateway-stack 仓 `deploy/machine-check.mjs` 的 `reclaude-launch-bare` / `reclaude-shim-missing` 两道闸兜着。
>
> **两份文档**：本文＝**reclaude 迁移指南**（怎么装、怎么换机、服务器上怎么装）；
> 姊妹篇 `docs/reclaude-self-check.md`＝**防封环境自检指南**（先清旧账号 id，再照那四步查）。
> 可以清理下旧账号绑定的 id 和痕迹：reclaude 使用前那个 Claude 账号留在本机 Claude 配置和 memory 里的，按姊妹篇第 1 节清。本文不写步骤。
>
> **脚本在哪**：本文提到的启动器、脚本都在 ai-gateway-stack 仓（`deploy/reclaude-mirasim.mjs`、`deploy/reclaude-mirasim/`、`deploy/machine-check.mjs`）；下面写 `deploy/…` 的都是那个仓里的路径，在那个仓的 checkout 里跑。本仓只放这两份文档。
>
> 更早散在 ai-gateway-stack `docs/MIRASIM.md` 与 windsurf-dao `docs/observations/2026-09-*` 的 reclaude 笔记是历史判例，要结论来这两份。

## 0. 判据：什么样才算接上了

看 reclaude 的启动器日志 `%LOCALAPPDATA%\reclaude-mirasim\launch.log`（每次起 claude 一行，写明判了哪条路）和
reclaude 日志 `~/.reclaude/logs/daemon.log`：

- 接上了：launch.log 那行 `route=local（自有）… settingsStripped=true`，daemon.log **没有**新的 `event: non-cc-client`，
  会话的 `modelUsage` 里 provider 是 `firstParty`
- 没接上：Mirasim 流量账本 `~/.mirasim/traffic/<会话>/index-0.ndjson` 出现 `upstreamHost=api.anthropic.com` +
  `status=400` + `errorCode=non_cc_client`（随后整会话降到 `relay.mirasim.ai`）

**别看账本判「接上了」**：接上之后请求不再经过 Mirasim 网关，账本里这些会话的用量显示「未知」，这是预期。

## 1. 原理：为什么启动命令写 `reclaude` 不够

`~/.mirasim/setting.json` 的 `agentLaunch.claude.command = reclaude` 只决定**用哪个程序**起 claude。
Mirasim（0.0.354 起）还会把自己网关的地址写进 `--settings <临时文件>` 的 env：

```json
{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<端口>/<会话令牌>","ANTHROPIC_AUTH_TOKEN":"…","ANTHROPIC_API_KEY":"…"}}
```

reclaude 只清进程 env（2026-09-19 验过），清不到这个文件 ⇒ claude 把请求交给 Mirasim 网关 ⇒ 网关以 `Mirasim.exe`
身份转发 ⇒ reclaude 服务端认出不是 Claude Code 本体，回 `400 仅支持 Claude Code 客户端访问 reclaude 网关`
（`non_cc_client`），**并上报**（`~/.reclaude/state.json` 的 `leak_report: true`）。这类上报攒多了会解绑设备
（2026-09-21 VPS 实咬）。

所以不能让「自有」流量经过 Mirasim 网关——想让它过 reclaude 的客户端校验，唯一的办法是伪装请求特征，**不做**。

## 2. 做法：reclaude-mirasim 启动器

ai-gateway-stack 仓 `deploy/reclaude-mirasim/`（Go，无依赖）。Mirasim 起它，它再起同目录的 reclaude，其余参数、stdio、退出码原样透传：

- 只有**这个会话的路由是「自有」**（`~/.mirasim/plugin-index/*.json` 的 `routes["claude:<会话>"]` 为 `local`，
  或没标过——Mirasim 自己也是先试自有）**且模型是 Claude 家的**时，才剥掉 `--settings` 里指向本机回环地址的
  `ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY`（写一份剥过的临时副本，不改 Mirasim 的原文件）并清进程 env 同名变量。
  claude 于是回落到 `~/.claude/settings.json` 里 reclaude 写的代理 + OAuth 占位令牌，走真订阅。
- 查路由用的 id 和命令行里的 id **不是同一个**：`routes` 的键是 **Mirasim 的会话 id**，而 claude 的命令行里
  （`--resume` / `--session-id`）是 **claude 自己的会话 id**。两个不同的会话（接着别的原生会话起的那些）按
  命令行里的 id 查不到 routes，启动器就按 `~/.mirasim/sessions/claude/<Mirasim 会话 id>/record.json` 里写着的
  `nativeSessionId` 反查一次，拿 Mirasim 的会话 id 再查（2026-09-26 实咬：`claude:541a1e89…` 选了「平台」，
  命令行里是 `--resume 478c5147…`，查不到就落进「未标」兜底当自有，剥了注入烧掉拼车号额度）。
  每次启动那行日志都带 `sid=<命令行的 id>` 和反查到的 Mirasim 会话 id，判错时照它查。
- 路由是「平台」（`cloud`）或模型是别家的：**一个字节不动**，照旧走 Mirasim 网关 → 中继。
- 子进程挂在 `KILL_ON_JOB_CLOSE` 的 Job 里：Mirasim 杀启动器时整棵树跟着退（实测 cmd/ping/conhost 全退）。

## 3. 装 / 查 / 撤

在 ai-gateway-stack 仓里跑：

```bash
node deploy/reclaude-mirasim.mjs                    # 只读：启动命令现在指谁
node deploy/reclaude-mirasim.mjs apply --when-idle  # 编译到 ~/.local/bin/reclaude-mirasim.exe，等没有在途回合再切
node deploy/reclaude-mirasim.mjs off --when-idle    # 撤回裸 reclaude
```

**切启动命令会让 Mirasim 重建 claude driver，把所有在跑的 claude 回合杀掉**（2026-09-24 实咬：切一次杀两个，
其中一个跑了 4.5 小时，报 `claude exited 1: 同步配置…`）。所以脚本见到在途回合（`~/.mirasim/sessions/claude/*/record.json`
的 `runState=running`）默认拒绝；`--when-idle` 连续两次（间隔 15 秒）看到一个都没有才切，最多等 6 小时。

改走 Mirasim 的 ws `setAgentLaunch`（界面「智能体配置 → 启动命令」同一条路），不手改 setting.json。
生效范围：新起的 claude 进程。

启动器按「**同目录的 reclaude**」找目标，找不到才退到 PATH。所以要保证 `~/.local/bin` 下有一份 `reclaude.exe`
（本机 reclaude 装在别处时，在那儿建个指过去的符号链接；`reclaude-mirasim.mjs` 也以这份的存在为前置条件），
或者给启动器设 `RECLAUDE_MIRASIM_TARGET`。

## 4. 服务器（Linux）上怎么装

服务器上有 Mirasim + reclaude，但**通常没有 Go**，所以是「别处交叉编译 → 拷过去 → `--no-build`」三步。
`reclaude-mirasim.mjs` 在没 Go 又没加 `--no-build` 时会大声失败并给出交叉编译命令，不会静默跳过编译。

```bash
# 1. 在有 Go 的机器上（Windows PowerShell 写 $env:GOOS="linux"; $env:GOARCH="amd64"）
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o reclaude-mirasim ./deploy/reclaude-mirasim
# 2. 拷到 reclaude 同目录——启动器按「同目录的 reclaude」找目标
scp reclaude-mirasim root@<server>:/root/.local/bin/
# 3. 在服务器上切启动命令（有在途回合就先等，理由见上一节）
cd /srv/projects/ai-gateway-stack        # 服务器上那份 checkout，ags-sync.timer 跟着 origin/master
node deploy/reclaude-mirasim.mjs apply --no-build --when-idle
```

验收（Linux 的日志在 `~/.cache/reclaude-mirasim/launch.log`，因为启动器用 `os.UserCacheDir()`）：

```bash
tail -3 ~/.cache/reclaude-mirasim/launch.log   # 要有 route=local（自有）… settingsStripped=true
node deploy/machine-check.mjs | grep -i reclaude   # reclaude-launch-bare / reclaude-shim-missing 转绿
```

2026-09-24 在一台 VPS 上就是这么装的：`go` 不在 PATH 里，先在本机交叉编译，再 `apply --no-build`。

## 5. 已知边界

- 会话中途在界面上切「自有 / 平台」：已经起着的 claude 进程保持起它时的判法，下次重起进程才按新路由。
- 还没起过原生会话的会话（记录里 `nativeSessionId` 还空着）按「自有」兜底——和 Mirasim 自己的默认一致；
  这种会话的日志那行写 `route 未标`，判错的话照两个 id 去对。
- 走启动器的「自有」会话在 Mirasim 用量统计里显示「未知」（绕过了它的网关），额度看 reclaude 面板。
- Clash 里那条 `Mirasim.exe + api.anthropic.com → reclaude` 分流（ai-gateway-stack PR #37）在这个方案下**不需要**：自有会话已不经 Mirasim 出网。
  留着它，漏网的 Mirasim 自有请求会以非 Claude Code 身份撞 reclaude——建议撤掉。
