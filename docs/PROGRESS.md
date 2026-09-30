# 进度（本机恢复与重做前置）

> 一行一条、带日期和对应提交。规矩在 `AGENTS.md` 通用段「进度也要落盘」。

## 2026-09-30 / 10-01（本机，指挥官会话）

- **Grok 在本机修好了**（2026-09-30）。原因：C 盘事故把 `~/.grok/auth.json` 冲掉，且 Grok 只认代理环境变量、不读 Windows 系统代理。做法：1) `grok login --device-auth` 重新登录（创始人本人在浏览器确认）；2) 给这台机器的用户级环境加 `HTTP_PROXY` / `HTTPS_PROXY = http://127.0.0.1:7890`（Clash 混合口），`NO_PROXY` 原有值不动。**法国 VPS 直连能通，不需要这段配置。** 验证：只带用户级环境变量跑 `grok -p …` 返回 OK，模型 `grok-4.7`。没验证的：Mirasim 里新开 Grok 会话（要人在界面上点）。
- **Mirasim 的「平台 / 自有」两个额度来源按钮：机制没坏，是两边都没配好。** 查到的：`~/.mirasim/plugin-index/<机器>.json` 的 `routes` 按**会话**记路由，本机 262 条里 `cloud` 233 / `local` 29；本会话被钉在 `cloud`，所以每次调用都进 `relay.mirasim.ai`（`~/.mirasim/traffic/<会话>/index-0.ndjson` 494 行全部 `viaRelay=true`、`accountId=null`）。「自有」那条路要求「本机有该智能体的账号凭据」，`setting.json` 的 `agent_accounts` 是空的。
- **reclaude 设备身份对不上（未修完）。** `reclaude status`：`device signing key fingerprint mismatch (disk=06cbad…, device.json=dd8583…)`；守护进程 09-29 12:23 起（pid 55760），`device.json` 是 09-29/30 重建的。处方是 `reclaude stop && reclaude`（重启守护进程）。**创始人 2026-10-01 同意自己跑这条**，因为这一轮的所有出网都走守护进程的 59822，停它=本会话失网。
- **启动器没问题。** `docs/reclaude-in-mirasim.md` 那套在跑：`%LOCALAPPDATA%\reclaude-mirasim\launch.log` 里 `route=local（自有） settingsStripped=true` 出现过 27 次（最近 09-30 15:48），`route=cloud（平台），原样放行` 2 次（最近 09-30 23:43，即本会话被切到平台那次）。Clash 里**没有**需要撤的 `Mirasim.exe → reclaude` 进程规则，只有 `reclaude.ai → DIRECT` 域名规则。
- **Grok 代理那段会影响 reclude 吗：会。** 用户级 `HTTPS_PROXY` 会让 `reclaude` 守护进程的重连尝试也经 Clash；守护进程的 `tunnel error` / `intercept sync` 超时从 09-30 22:36 前后开始变密。修完设备身份后如果还刷错误，先试撤掉这两行（`[Environment]::SetEnvironmentVariable('HTTPS_PROXY',$null,'User')`）。
- **待办（按顺序）**：① 创始人跑 `reclaude stop && reclaude`；② 核 `reclaude status` 的 `last_error` 清空、`leaks` 正常；③ 把要在 Mirasim 里用「自有」的会话路由从 `cloud` 切回 `local`（**只对新起的 claude 进程生效**，文档第 5 节）；④ 轮换我在查询时打进对话的 `ANTHROPIC_AUTH_TOKEN` 前缀（会话令牌，短效）。
- **主线没动**：这一天的分析（GPT 会话做了什么、原计划现状、GitHub 单与 PR、本机在途工作树、需求核读进度）跑在子任务里，结论出来后写进 `specs/509-需求梳理/` 和这张表。计划本体仍是 `docs/goals.md`（三段一条龙 + 副手 + 删除清单 + 换法国 VPS 前先在本机演练台调优）。
