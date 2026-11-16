---
name: mirasim-sessions
description: 创始人指定「用 mirasim 开会话干活、做完回报」时读：开会话前先查老会话、一件活一棵工作树、收回报、验收、合并后删工作树和会话。
---

# `mirasim-sessions`：用 mirasim 会话当工人

干活方式由创始人在会话里指定，指定后这个会话一直照着走，直到他提出新方式（#3915）。他指定「开 mirasim 会话干、做完回报」时照本技能做，不再派 Agent 子代理。下面的 atom 都经 `mcp__mirasim__mirasim` 的 `call` 调。

## 开会话之前先查老会话

- 查已有会话：`listSessions`（`workdir` 填仓根，`limit` 给小）。它不列 pi 会话。查 pi 要看本机会话目录 `~/.mirasim/sessions/pi/<会话 id>/record.json`（里面有 `title`、`workdir`、`runState`），再对上 `getTurnFacts`（给 `taskId`）看这一轮。同一件活的后续（返工、补验证、修 CI、改约束）发回原会话：`prompt` 带它的 `sessionKey`。只有新的一件活才开新会话。
- mirasim 的会话列表就是账，不另记清单。侧栏名在派的同时改好，见下。

## 开会话

- 派活一律用本技能目录里的 `scripts/dispatch.mjs`，不要自己先 `prompt` 再 `renameSession`：漏改名侧栏看不懂，多调一次 `prompt` 会再开一个会话（2026-11-15 两次漏改名、一次重派）。一条命令只调一次 `prompt`，拿到会话号立刻改名。改名用 prompt 接受帧上的会话号；没有接受帧才在同 agent、同目录里取最新的。拿不到会话号就退出码 1、不重派。
- 派活交代必须带回报去向。不给 `--report-to` 时，脚本在本机 claude 会话目录里找正在跑、工作目录以 fleet-dao 结尾、标题不是无人值守心跳的那一个（多个取最近更新），把「回报，必做」追加到交代末尾，指到同目录的 `scripts/report.mjs`。找不到指挥会话就退出码 2，一次都不派。

```
node scripts/dispatch.mjs --title "【pi】#单号 一句中文" --workdir <仓根> --prompt "<交代>" [--agent pi] [--model <模型>] [--effort <档>] [--route local] [--report-to <指挥会话key>]
```

- `agent`、`model`、`effort` 照创始人指定的，`route` 用 `local`（走个人账号，不扣 Mirasim 额度）。没给 `--port` 时用环境变量 `MIRASIM_HOST_PORT`；会话里两个都没有就不带端口。版本读 `~/.mirasim/app/state.json` 里 `good` 的那一版，不写死。
- 走个人账号要整机路由是「自有」（`setRelayMode {mode: "local"}`）。派之前先 `getCatalog {agent}` 确认要的模型在目录里；会话报「只有平台提供」（422）或目录里没有，先 `getCatalog {agent, refresh: true}` 刷新再发，不换成差一档的模型凑合。刷新本身也会探残（本机网络一抖：grok-4.7 标 `routeByModel: relay`、`ownOnlyModels` 里没有 fast）：看到残的就再刷，刷到正常再发，别据此判「这个模型只剩平台」，以本机 `grok models` 列出的为准。grok 一律 `grok-4.7` + `route: "local"`。
- 交代照 commander「派活」写全（单号、要改什么、怎么算做完、别碰什么、跑哪些测试），另加四条：
  1. 自己干，不派子代理。
  2. 一件活一棵工作树 `.claude/worktrees/<单号>-<短名>`、分支 `local/<单号>-<短名>`；不往别的会话的分支推，依赖别人的 PR 就基于那个分支开自己的，对方合了再 rebase。
  3. PR 开好、本机检查过了就停，不开自动合并、不自己合，也不等 CI；`pr:open` 顺手开了自动合并就 `gh pr merge <PR> --disable-auto` 摘掉。合并归验收的人，不然没验收的改动会先进主线（#3950 就是先合了、返工只能另开 #3951，还带红了主线 #3953）。
  4. 回报去向由 `scripts/dispatch.mjs` 写进交代，不要再手写一套。做完或卡住时，把正文写进文件，运行交代里的 `scripts/report.mjs --to <指挥会话key> --title <活名> --file <正文>`，看到输出 ok 才算发出。正文写做到哪、PR 号、头提交、`git ls-remote` 和 `gh pr view` 的输出、验证命令和真实结果、没做的和原因。不许写「CI 绿了再回报」然后收轮。长命令前台跑、套 timeout、每段不超过 10 分钟，不许丢到后台再收轮。
- 关键约束（授权边界、别碰哪些分支、验收标准）在开会话的第一条里写全。`steer` 只有部分 agent 吃，grok 不吃。给在跑的子会话发任何新消息（补充、返工、回报转发），都用 `prompt` 再 `stopAndRun {sessionKey, ref}`（`ref` 填那条 `prompt` 的 `clientRef`）才会送达（2026-11-16 创始人：每次都要插队才收得到）；代价是它正在跑的那条命令被打断，所以尽量攒成一条再发。它已经 done 的会话直接 `prompt` 即可，不用插队。
- 交代里给时限。子会话易在测试上越绕越远（降并发、加跳过、逐条追断言，#3988 的第二棒真遇到）；到点用上面的 `stopAndRun` 让它收尾，只报现状。
- 长时间没回报：`listSessions` 看它的 `runState`、`failed`（pi 不在这份列表里，改看会话目录的 `record.json` 加 `getTurnFacts`）。grok 进程会异常退出（`grok exited`），退了就不会回报，发回原会话重跑。
- 参考外部产品时写清授权边界：闭源软件和非开源许可（源码可见但限商用）的代码、样式一行都不进仓，只参考思路；MIT、Apache 类的库可以直接用。

## 指挥会话自己

- 派完就收轮。回报是作为新消息排进指挥会话的队列的，指挥会话一轮不结束，回报就进不来。
- 进无人值守：`node ~/.fleet-dao/hooks/unattended.mjs on` 照样跑，mirasim 托管的会话它不拦收轮；同时开一个 30 分钟心跳定时任务（`mcp__mirasim__schedule_task`，`cron` 用 `*/30 * * * *`，`prompt` 写「无人值守心跳：打开 `mirasim-sessions` 技能的 `heartbeat.md`，把占位换成这一轮的仓和指挥会话，查子会话回报和队列，有活就接着派」，`once` 不设）。清单本身是本技能目录的 `heartbeat.md`，不含具体单号、内网地址和盘符路径。`on` 不排心跳，心跳没排上就收轮，这个会话没人叫醒。接续就靠子会话回报和这个心跳。收工（`unattended.mjs done`）后把心跳定时任务停掉。
- 会话太长要换棒：照 `commander-handoff`。
- 不轮询。要看状态用 `getTurnFacts`（给 `taskId`）或小 `limit` 的 `listSessions`（pi 会话不在 `listSessions` 里，见上面「先查老会话」）；mirasim 的返回常常很大，只抽要的字段。

## 换一台机器

脚本和心跳模板都在本技能目录，跟仓走，不放 `_tmp/`：

- 派活：`scripts/dispatch.mjs`（测试在 `agents/test/mirasim-dispatch.test.ts`：缺参数不调 prompt，找不到指挥会话不派，接受帧的会话号用来改名）
- 回报：`scripts/report.mjs`（测试在 `agents/test/mirasim-report.test.ts`）
- 收尾：`scripts/close.mjs`
- 心跳：`heartbeat.md`

装到各家技能目录用仓里的 `pnpm agents:sync`（整个技能目录一起装，包括 `scripts/` 和 `heartbeat.md`）。通用做法在 magpie 的记忆里，换机登录同一账号后按关键词搜；Claude 项目记忆目录只留这一台机器的事。哪一条记忆收进哪里，见 `docs/4040-memory-triage.md`。

核对（装完或换机跑一次）：

```
node <仓根>/agents/skills/mirasim-sessions/scripts/dispatch.mjs
```

不带参数应退出码 2，并打印用法。记忆用 magpie 搜「换一台机器要拿同一套派活脚本」。

## 验收

回报说做完后，指挥会话自己核，不照抄回报：

1. PR 的 CI 全绿、合并闸过：回报或巡检一进来就现查 `gh pr checks <PR>`，不靠跨轮的后台 `--watch`（新消息进来 mirasim 会重起指挥会话进程，后台任务跟着被停，11-14 实测）。
2. 对着交代里「怎么算做完」逐条核；截图自己看。拿假模型、假环境代替真的跑出来的，不算过。
3. 不过：发回原会话返工，写明哪一条没过。
4. 过了：指挥会话自己合（`gh pr merge <PR> --squash`），合进去再清理。

## 合并后清理

验收过了要收单时，用本技能目录里的 `scripts/close.mjs` 一条做完，不要分步手工删：

```
node scripts/close.mjs --repo <主检出> --branch <分支> [--pr <号>|--mr <号>] [--session <sessionKey>]
```

- 按序：合并（GitHub 用 `gh`，GitLab 用这个仓远端自己的地址和令牌，脚本里不写地址）→ 主检出快进到合并后的默认分支，再推其余远端（推送地址是 DISABLED，或 `git remote get-url --push` 失败的远端跳过，输出写明跳过了哪个）→ 先拆工作树里的目录联接和目录软链（只拆不跟），核主检出依赖目录项数没变，再删工作树和本地、远端分支 → 给了 `--session` 就删会话，没给就打印「不适用」。
- 先核再删：分支已在默认分支里，或 MR/PR 已合；工作树没有未提交改动；联接拆完后没有剩余联接。有一件不满足就停，不删。
- 某一步失败就停，退出码非 0，输出停在哪一步、下一步怎么手工接。重跑同一条命令会跳过已经做成的步骤。
- 不要直接 `git worktree remove` 或 `removeWorktree`：Windows 上工作树里的依赖目录常常是指回主检出的目录联接，跟着联接会把主检出的依赖删空。
- 单的租约在 PR 合并后自动收，不跑 `pnpm work done`；挂了「本机做」的单尤其不许 `--release`：它会把单退回法国队列、摘掉「本机做」，引擎会把同一件活再做一遍（2026-11-13 真出过，#3981）。
