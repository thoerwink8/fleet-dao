# Mirasim 里用 reclaude

Windows 和 macOS 的 Mirasim 里，让 Claude 经 reclaude 起，只要改一个设置：**Mirasim 设置 → Agents → Claude 的启动命令，填 reclaude 的绝对路径**（Windows 一般是 `C:\Users\<你>\.local\bin\reclaude.exe`，Mac 是 `~/.local/bin/reclaude` 展开后的绝对路径）。不用别的启动器、迁移命令或对账命令，本仓也不再带它们（[决定 0112](decisions/0112-mirasim-direct-reclaude.md)）。reclaude 须已安装并登录；`reclaude --version` 第一行应带 `(Claude Code)`，Mirasim 就是靠它认版本。

## 自有 / 平台怎么分

按会话选「自有」还是「平台」由 Mirasim 自己做，不需要我们插手：

- 自有：Mirasim 不往进程里注入平台网关，进程链是 `Mirasim → reclaude → claude`，用量走 reclaude 自己的额度；Mirasim 账本里没有这条会话的用量。
- 平台：Mirasim 重起该会话的进程并注入网关，账本里是 `viaRelay=true` 的 `POST /v1/messages`。
- 跟随全局的新会话按全局档位走，同样由 Mirasim 决定。

2026-10-22 在 Mirasim 0.0.576 上实测的证据（自有、切平台、跟随全局三个真实回合，以及版本探测）在决定 0112 里。看某个会话实际走了哪份额度，直接看 `~/.mirasim/traffic/<会话 ID>/index-*.ndjson` 里 `/v1/messages` 的 `viaRelay`：`true` 是平台中继，`false` 或没有记录是自有。进程名叫 reclaude、界面写「平台」都不能单独证明额度来源。

## 别填错的后果

- **填裸 `claude`、清空，或升级后被改回去**：Claude 不经 reclaude。没有人再提醒（自动迁移和漂移提示已删），要自己看一眼这个设置。
- **别删启动命令**：删了就是裸 claude，自有额度没有了。
- Mirasim 的「Claude Code 升级失败」提示（设置里 `cli.claude.minVersion` 比 reclaude 背后那份 claude 新）：Mirasim 按启动命令探 `--version`、跑 `update`，实际就是 `reclaude --version` 和 `reclaude update`。升级走 `reclaude update`；reclaude 还没发到那一版时只能等。不要照提示清掉启动命令。
- 单会话启动覆盖（`setSessionLaunch`，plugin-index 的 `launches`）只用于终端窗格，不影响回合的额度。

## 0092 那条坑：别在 env 里放改模型的键

Mirasim 自己决定给不给网关（读 0.0.498 的 `server.cjs` 查到）：`~/.claude/settings.json` 的 env 里有任一改模型的键（`CLAUDE_CODE_SUBAGENT_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`），又有 reclaude 写的指向回环的 `HTTPS_PROXY` 加 `NODE_EXTRA_CA_CERTS`，又设了 claude 启动命令（填 reclaude 就算），它就判 claude 被拦截（`via=intercept`），不给跟随全局的会话注入平台网关；界面显示「平台」，实际花自有额度。

所以启动命令是 reclaude（或还没换掉的旧启动器）的桌面机上，同步工具不写子代理默认模型键、已有的删掉，子代理默认模型改在 Mirasim 设置里管（[决定 0092](decisions/0092-no-subagent-model-env-on-launcher-desktops.md)、[决定 0112](decisions/0112-mirasim-direct-reclaude.md)）。别的改模型的键同步不碰，症状是「跟随全局的会话显示平台、账本却没有 relay」，手动从 env 里删掉，重开会话生效。

## 还在用旧启动器的机器

旧的 `mirasim-reclaude` / `reclaude-mirasim` 不再维护，也不再自动迁移。照上面手改一次启动命令即可：在 Mirasim 设置里把启动命令换成 reclaude 的绝对路径，换完新回合起生效（Mirasim 会重起进程，在途回合结束后再改更稳）。旧文件和 `~/.fleet-dao/mirasim-reclaude/` 下的旧记录可以留着，也可以自行删掉。

## 服务器（Linux）与 Fleet

法国维持两个明确入口：自有 Claude 直接由 reclaude 起，无头 Mirasim 固定 `cloud`。账号池、渠道切换与额度耗尽后的任务接续由 Fleet/Temporal 控制。Fleet 接收 Mirasim 的平台成功结果前核账本：至少有计费模型请求的 2xx，成功模型调用全部为 `viaRelay=true`；成功直连或混合来源拒绝平台成功入账，坏行、缺来源字段或读失败返回「没查成」。本地 `messages/count_tokens` 与 `v1/models` 辅助请求不能证明模型成功，也不误判成串账。
