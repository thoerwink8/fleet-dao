# 进度（本机恢复与重做前置）

> 一行一条、带日期和对应提交。规矩在 `AGENTS.md` 通用段「进度也要落盘」。

## 2026-09-30 / 10-01（本机，指挥官会话）

- **Grok 在本机修好了**（2026-09-30）。原因：C 盘事故把 `~/.grok/auth.json` 冲掉，且 Grok 只认代理环境变量、不读 Windows 系统代理。做法：1) `grok login --device-auth` 重新登录（创始人本人在浏览器确认）；2) 给这台机器的用户级环境加 `HTTP_PROXY` / `HTTPS_PROXY = http://127.0.0.1:7890`（Clash 混合口），`NO_PROXY` 原有值不动。**法国 VPS 直连能通，不需要这段配置。** 验证：只带用户级环境变量跑 `grok -p …` 返回 OK，模型 `grok-4.7`。没验证的：Mirasim 里新开 Grok 会话（要人在界面上点）。
- **Mirasim 的「平台 / 自有」两个额度来源按钮：机制没坏，是两边都没配好。** 查到的：`~/.mirasim/plugin-index/<机器>.json` 的 `routes` 按**会话**记路由，本机 262 条里 `cloud` 233 / `local` 29；本会话被钉在 `cloud`，所以每次调用都进 `relay.mirasim.ai`（`~/.mirasim/traffic/<会话>/index-0.ndjson` 494 行全部 `viaRelay=true`、`accountId=null`）。「自有」那条路要求「本机有该智能体的账号凭据」，`setting.json` 的 `agent_accounts` 是空的。
- **reclaude 设备身份对不上：重启没用，但实测不影响干活（收尾）。** `reclaude status` 报 `device signing key fingerprint mismatch (disk=06cbad…, device.json=dd8583…)`，只影响「账号同步」（额度上报），**不影响发请求**：2026-10-01 00:56 重启守护进程（pid 55760 → 19376）后仍在报，但当场实测 `reclaude -p "…"` 返回 OK，退出码 0。结论：**先不动它**——它是上报链路的毛病，修它要动 reclaude 的账号状态（可能要重新 `reclaude login`），风险大于收益，等哪天真需要看额度再说。
- **启动器没问题。** `docs/reclaude-in-mirasim.md` 那套在跑：`%LOCALAPPDATA%\reclaude-mirasim\launch.log` 里 `route=local（自有） settingsStripped=true` 出现过 27 次（最近 09-30 15:48），`route=cloud（平台），原样放行` 2 次（最近 09-30 23:43，即本会话被切到平台那次）。Clash 里**没有**需要撤的 `Mirasim.exe → reclaude` 进程规则，只有 `reclaude.ai → DIRECT` 域名规则。
- **Grok 代理那段会影响 reclude 吗：会。** 用户级 `HTTPS_PROXY` 会让 `reclaude` 守护进程的重连尝试也经 Clash；守护进程的 `tunnel error` / `intercept sync` 超时从 09-30 22:36 前后开始变密。修完设备身份后如果还刷错误，先试撤掉这两行（`[Environment]::SetEnvironmentVariable('HTTPS_PROXY',$null,'User')`）。
- **待办（按顺序）**：① 创始人跑 `reclaude stop && reclaude`；② 核 `reclaude status` 的 `last_error` 清空、`leaks` 正常；③ 把要在 Mirasim 里用「自有」的会话路由从 `cloud` 切回 `local`（**只对新起的 claude 进程生效**，文档第 5 节）；④ 轮换我在查询时打进对话的 `ANTHROPIC_AUTH_TOKEN` 前缀（会话令牌，短效）。
- **主线没动**：这一天的分析（GPT 会话做了什么、原计划现状、GitHub 单与 PR、本机在途工作树、需求核读进度）跑在子任务里，结论出来后写进 `specs/509-需求梳理/` 和这张表。计划本体仍是 `docs/goals.md`（三段一条龙 + 副手 + 删除清单 + 换法国 VPS 前先在本机演练台调优）。

## 2026-10-01 深夜（D0 文档对齐，本机指挥官会话）

- **Grok 修好之后本机这一轮的产出进了主线/开了 PR**：#523（进度落盘）、#524（决定 0006 + goals 对齐）已合；#525（执行计划草案）、#526（discuss 按写手家族选候选，**改标准，等创始人同意**）CI 全绿；#528（12 张已关单的历史需求加替代指针，19 份文档）、#529（design.md 头部加「重做中」横幅）刚开。
- **必跑检查实测出的坑**：`docs/goals.md` 不在 `doc-pointers.ts` 的 `ALIASES` 表里，所以「`docs/goals.md` 第六节」「`docs/goals.md` 的『要删的，和怎么删』一节」这两种写法**都会被判红**（第二种被当成指本文件的一节），只有不带节号的 `` `docs/goals.md` `` 才过。已实测（223 份文档、0 条问题）。这是替代指针一律不写节号的原因。
- **#475、#481 两张卡死的 PR 诊断完了，等创始人拍**：#475（帅位/认领简化）想做的事主线已经做了（`agents/skills/commander/SKILL.md:10` 现在写着「不设座位、不在库里认领」），而且它要改的 `commander-seat/SKILL.md` 主线已删；#481（删敏感值名单）的前提被 09-30 那条拍板顶掉，方向比主线还松。推荐两张都关掉、内容并进 #509。
- **D0 六份草稿 + 三份独立复核都出来了**（`_tmp/0930/d0-*.md`）。复核一致判「改了再用」，主要问题是：替代指针模板会判红（已改）、#509 正文数字要与 26/33 对齐、未挂里程碑那份有七处账对不上（含一处和决定 0006 相反，不能写进子单验收）。
- **待办**：① 把 #509 的 12 张子单里现在能开的 3 张开出去（`#509` 下现在 0 张）；② #475/#481 等拍；③ #526 等一句「同意」。
