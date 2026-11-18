---
name: mirasim-sessions
description: 创始人指定「用 mirasim 开会话干活、做完回报」时读：开会话前先查老会话、一件活一棵工作树、收回报、验收、合并后删工作树和会话。
---

# `mirasim-sessions`：用 mirasim 会话当工人

干活方式由创始人在会话里指定，指定后这个会话一直照着走，直到他提出新方式（#3915）。他指定「开 mirasim 会话干、做完回报」时照本技能做，不再派 Agent 子代理。下面的 atom 都经 `mcp__mirasim__mirasim` 的 `call` 调。

## 开会话之前先查老会话

- 查已有会话：`listSessions`（`workdir` 填仓根，`limit` 给小）。干活的会话是 omp（mirasim 里的 agent 名是 `kimi`，启动方式经 ACP 到 omp），要看本机会话目录 `~/.mirasim/sessions/kimi/<会话 id>/record.json`（里面有 `title`、`workdir`、`runState`、`nativeSessionId`，原生记录在 `~/.omp/agent/sessions/`），再对上 `getTurnFacts`（给 `taskId`）看这一轮。同一件活的后续（返工、补验证、修 CI、改约束）发回原会话：`prompt` 带它的 `sessionKey`。只有新的一件活才开新会话。
- mirasim 的会话列表就是账，不另记清单。侧栏名在派的同时改好，见下。

## 开会话

- 派活一律用本技能目录里的 `scripts/dispatch.mjs`，不要自己先 `prompt` 再 `renameSession`：漏改名侧栏看不懂，多调一次 `prompt` 会再开一个会话（2026-11-15 两次漏改名、一次重派）。一条命令只调一次 `prompt`，拿到会话号立刻改名。改名用 prompt 接受帧上的会话号；没有接受帧才在同 agent、同目录里取最新的。拿不到会话号就退出码 1、不重派。
- 派活交代必须带回报去向。`--report-to` 优先；没给时读本进程的 `MIRASIM_SESSION_KEY`（mirasim 起会话就写上，形如 `claude:<会话号>`）。两个都没有才猜：本机 claude 会话里正在跑、工作目录是 fleet-dao 仓根或其 `.claude/worktrees/<名>`、标题不是无人值守心跳的那一个（多个取最近更新）。猜不到就退出码 2，一次都不派，并写明要补 `--report-to`。心跳会话自己的 key 不是指挥会话，心跳里派活要显式 `--report-to` 指向指挥会话。
- 编码任务在派之前建好工作树，`--workdir` 指这棵已经在的树，不要指仓根，也不要在交代里叫工人自己 `git worktree add`。只读、不改代码的会话可以把 `--workdir` 指主检出。`dispatch.mjs` 没有读写标记，不看交代正文，拦不住「另建树」；调用方自己把编码任务的 `--workdir` 指到真树。

```
node scripts/dispatch.mjs --title "【omp】#单号 一句中文" --workdir <主检出>/.claude/worktrees/<单号>-<短名> --prompt "<交代>" [--report-to <指挥会话key>]
```

- 给在跑或已收轮的会话发后续消息（返工、补验证、接着做），一律用 `scripts/send.mjs --to <会话key> --file <消息文件>`，不要裸调 `prompt`：它会把「回报，必做」和指挥会话号追加到每条消息末尾。只靠开场交代里的那一段，会话做完第二件事时会忘（11-16 #33 做完开了 PR 却没回报，我的后续消息里只写了「回报」两个字）。
- **干活的会话一律是 omp，不用原版 pi**（2026-11-16 创始人定）。mirasim 里 omp 的 agent 名是 `kimi`（启动方式经 ACP 到 omp），脚本默认 `--agent kimi`，`--agent pi` 直接退出码 2。omp 用的模型由它自己的配置（`~/.omp/agent/config.yml` 的角色，指向 `gateway/group/smart`）定，不要给 kimi 传 `--model`：ACP 不认 `set_model`，会话开场就报错（11-16 实测）。原因：我们的 omp 定制（单轮输出上限、技能目录、结束前检查扩展，在配置仓里）只管 omp；原版 pi 读另一套配置，今天派的 pi 会话没吃到这些，还出现过工具调用名字为空导致整轮被停的事。
- 标题写 `【omp】`，和实际一致。

- `agent`、`model`、`effort` 照创始人指定的，`route` 用 `local`（走个人账号，不扣 Mirasim 额度）。宿主端口按 `--port` → `MIRASIM_HOST_PORT` → `~/.mirasim/run/local-<端口>.token`（有 4970 优先）取，脚本都找不到就退出码 2、不调：不带端口时 mirasim 的命令行不连正在跑的宿主，而是起一次性私服，子会话随命令退出一起死（#4075）。版本读 `~/.mirasim/app/state.json` 里 `good` 的那一版，不写死。
- 走个人账号要整机路由是「自有」（`setRelayMode {mode: "local"}`）。派之前先 `getCatalog {agent}` 确认要的模型在目录里；会话报「只有平台提供」（422）或目录里没有，先 `getCatalog {agent, refresh: true}` 刷新再发，不换成差一档的模型凑合。刷新本身也会探残（本机网络一抖：grok-4.7 标 `routeByModel: relay`、`ownOnlyModels` 里没有 fast）：看到残的就再刷，刷到正常再发，别据此判「这个模型只剩平台」，以本机 `grok models` 列出的为准。grok 一律 `grok-4.7` + `route: "local"`。不要写 `grok-4.7-low-fast`、`grok-4.7-high-fast`、`grok-4.7-build-fast`，也不要开 priority。`dispatch.mjs` 遇到 grok 的 `-fast` id（`grok-4.7-low-fast`、`grok-4.7-high-fast`、`grok-4.7-build-fast`，可带 `@500k`）退出码 2，不派。
- 488 次是路由加上的快档，不是调用方点了另一个模型（11-16 往前 24 小时 `magpie usage`；法国这台 magpie `0.1.4263`）。cursor 渠道 `grok-4.7@500k` 1661 次里 488 次 `tier_sent=priority`，模型名仍是 `grok-4.7`。这一版网关的 `fast=`（以及某个 agent 的 fast pick）只在送出时加 `service_tier=priority`，不改模型 id；cursor 插件再按这个档去选快变体，用量里的模型名保持原样。模型自己的速度若开了快档，这 1661 次会全是 priority，所以不是那一条。讨论脚本原来的 `grok-4.7-low-fast` 会单独成一行模型 id，汇总里没有这一行，对不上这 488 次。
- 30 次 `grok-4.7-high-fast`（约 30.06 美元）是调用方点名这个 id，不是 `fast=` 替选。`fast=` 加不出这个模型名：它留下的是 `grok-4.7@500k` 加 priority，就是上面那 488 次。本仓和已部署的 fleet-dao 生产代码都没有 `grok-4.7-high-fast`（讨论脚本旧偏好是 `grok-4.7-low-fast`）。`group/grok-pool` 的权重对得上的是 grok 渠道那两行（下面），不是 cursor 渠道这 30 次。
- `grok-4.7-build-fast@500k`（grok 渠道）1097 次、0 错，中位 8.0 秒、首字 5.4 秒；同渠道 `grok-4.7` 是 1978 次、中位 6.0 秒、首字 3.7 秒。花费 148.5 美元对 149.4 美元，单次 148.5/1097 对 149.4/1978，约 1.8 倍。次数比约 1:1.8，就是池里 1 比 2 的两名成员，慢且贵的那名是 `grok-4.7-build-fast`。从 `group/grok-pool` 移出，不留权重当后备。Grok Build 周额度这次 usage 里没有。
- 交代照 commander「派活」写全（单号、要改什么、怎么算做完、别碰什么、跑哪些测试），另加四条：
  1. 自己干，不派子代理。
  2. 工作目录已经是 `.claude/worktrees/<单号>-<短名>`、分支 `local/<单号>-<短名>`。不要再 `git worktree add`，也不要改主检出。不往别的会话的分支推，依赖别人的 PR 就基于那个分支开自己的，对方合了再 rebase。
  3. PR 开好、本机检查过了就停，不开自动合并、不自己合，也不等 CI；`pr:open` 顺手开了自动合并就 `gh pr merge <PR> --disable-auto` 摘掉。合并归验收的人，不然没验收的改动会先进主线（#3950 就是先合了、返工只能另开 #3951，还带红了主线 #3953）。
  4. 回报去向由 `scripts/dispatch.mjs` 写进交代，不要再手写一套。做完或卡住时，把正文写进文件，运行交代里的 `scripts/report.mjs --to <指挥会话key> --title <活名> --file <正文>`，看到输出 ok 才算发出。正文写做到哪、PR 号、头提交、`git ls-remote` 和 `gh pr view` 的输出、验证命令和真实结果、没做的和原因。不许写「CI 绿了再回报」然后收轮。命令超过约 60 秒会被钩子自动转后台：让会话把测试按单个文件分开跑、每条命令尽量 60 秒内，同一条查看命令最多连发 2 次，连续 8 次相同调用系统会停掉整轮（11-16 #11 实测），停了就既不提交也不回报；不许丢到后台再收轮。会话自己回报覆盖不了它自己被停、崩溃、模型报错（11-16 还有一例开场 422），所以每轮巡检先跑 `node scripts/sweep.mjs --repo <主检出>`（只列可收、要人看、孤儿，以及这个仓里没人认的工作树，不加 `--apply`），再跑 `node scripts/check-reports.mjs`，有 ALERT 行就读该会话最后一轮，插队让它接着做或重派。
- 关键约束（授权边界、别碰哪些分支、验收标准）在开会话的第一条里写全。`steer` 只有部分 agent 吃，grok 不吃。给在跑的子会话发任何新消息（补充、返工、回报转发），都用 `scripts/send.mjs` 再 `stopAndRun {sessionKey, ref}`；`ref` 必须取脚本输出 JSON 的 `clientRef`，这是宿主 `accepted` 回执里的编号，不能用调用方生成的编号（#4097：宿主会改写，旧编号插队不生效）。回执缺失或会话不符时脚本报结果未知，先查目标会话和队列，不重发。插队会打断正在跑的命令，尽量攒成一条再发；之后用 `getTurnFacts` 确认新要求实际进入回合，不能仅凭 `ok` 判送达。已经 done 的会话直接用 `scripts/send.mjs` 即可，不用插队。
- 交代里给时限。子会话易在测试上越绕越远（降并发、加跳过、逐条追断言，#3988 的第二棒真遇到）；到点用上面的 `stopAndRun` 让它收尾，只报现状。
- 长时间没回报：`listSessions` 看它的 `runState`、`failed`（omp 会话不一定在这份列表里，改看 `~/.mirasim/sessions/kimi/` 的 `record.json` 加 `getTurnFacts`）。grok 进程会异常退出（`grok exited`），退了就不会回报，发回原会话重跑。
- 参考外部产品时写清授权边界：闭源软件和非开源许可（源码可见但限商用）的代码、样式一行都不进仓，只参考思路；MIT、Apache 类的库可以直接用。
- agent 是 Antigravity、工作目录在 Windows 上时，交代再加下面「Windows 上的 Antigravity」两条。

## Windows 上的 Antigravity

agy 1.5.9 在 Windows 上跑 `run_command` 走 `pwsh`（也认 `powershell.exe`）。mirasim 0.0.425 起 agy 一律带 `windowsHide`（stdio 是管道，进程没有控制台）。stdout 为空时 agy 自己回「No output from the command」。冒烟时 `git --version`、`git log --oneline -1` 退出码是 0，agy 仍这么回；同一条命令把 stdout、stderr 重定向到文件，读文件能看到内容。读文件照常用。本仓钩子只回 `decision`，输出不经过钩子。agy 和 mirasim 的程序都不在本仓，创始人 Windows 上的 pwsh 配置这台机器也改不到。命令能把输出写进文件，空的是 agy 读到的 stdout。来源会话 `local-session 6b9c90a5-451b-4637-a440-a6903e3776a8`，单键 `73b6ed648d1febfb169c30e58db13cb4ec0d906f2e400ecc1ef2db33ee9df983`。

这种会话的交代写死两条：

1. 要看输出的命令把 stdout 和 stderr 重定向到工作树里的文件，再用读文件读回来。
2. 退出码 0 且 agy 报没有输出，按没看到结果处理。Linux、macOS 上的 agy 不写这两条。

## 指挥会话自己

- 派完就收轮。回报是作为新消息排进指挥会话的队列的，指挥会话一轮不结束，回报就进不来。
- 进无人值守：`node ~/.fleet-dao/hooks/unattended.mjs on` 照样跑，mirasim 托管的会话它不拦收轮；同时开一个 30 分钟心跳定时任务（`mcp__mirasim__schedule_task`，`cron` 用 `*/30 * * * *`，`prompt` 写「无人值守心跳：打开 `mirasim-sessions` 技能的 `heartbeat.md`，把占位换成这一轮的仓和指挥会话，查子会话回报和队列，有活就接着派」，`once` 不设）。清单本身是本技能目录的 `heartbeat.md`，不含具体单号、内网地址和盘符路径。`on` 不排心跳，心跳没排上就收轮，这个会话没人叫醒。接续就靠子会话回报和这个心跳。收工（`unattended.mjs done`）后把心跳定时任务停掉。
- 会话太长要换棒：照 `commander-handoff`。
- 不轮询。要看状态用 `getTurnFacts`（给 `taskId`）或小 `limit` 的 `listSessions`（omp 会话以会话目录为准，见上面「先查老会话」）；mirasim 的返回常常很大，只抽要的字段。

## 换一台机器

脚本和心跳模板都在本技能目录，跟仓走，不放 `_tmp/`：

- 派活：`scripts/dispatch.mjs`（测试在 `agents/test/mirasim-dispatch.test.ts`：缺参数不调 prompt，找不到指挥会话不派，接受帧的会话号用来改名）
- 回报：`scripts/report.mjs`（测试在 `agents/test/mirasim-report.test.ts`）
- 扫尾：`scripts/sweep.mjs`（默认只列；`--repo` 默认当前目录所在仓，另列没有会话认领的工作树，判类和会话同一套。`--apply` 收可收和孤儿，收的动作是 `close.mjs`，没人认的工作树不带会话。不另写一条盘点命令。测试在 `agents/test/mirasim-sweep.test.ts`）
- 收尾：`scripts/close.mjs`（单分支也能直接跑；扫尾 `--apply` 走它）
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

每轮先列可收，不靠人记得哪一棵工作树还在。会话从 `~/.mirasim/sessions` 来；没有会话认领的工作树用 `--repo` 指到主检出（人就在这个仓里可以不写，默认当前目录）：

```
node scripts/sweep.mjs --repo <主检出>
```

默认只列、不动。可收（PR 或 MR 已合并、或已关闭，工作树干净且已推）和孤儿会话要收时，同一条加上 `--apply`，`--repo` 跟上面同一个主检出。没人认的可收工作树同样交给 `close.mjs`，不带会话。有未提交、有未推、没有 PR、读不了、认不出分支的算要人看，留着。不另写删法，也不要直接 `git worktree remove`。

单分支仍可直接：

```
node scripts/close.mjs --repo <主检出> --branch <分支> [--pr <号>|--mr <号>] [--session <sessionKey>]
```

- 按序：合并（GitHub 用 `gh`，GitLab 用仓自己的远端地址和令牌，脚本里不写地址）→ 主检出快进到合并后的默认分支，再推其余远端（推送地址是 DISABLED，或 `git remote get-url --push` 失败的远端跳过，输出写明跳过哪个）→ 对给定 `--session` 先通过官方入口读取状态，确认会话已归档、已结束且 `workdir` 精确对应目标工作树，再用 `removeWorktree:false` 释放会话 → 拆工作树里的目录联接和目录软链（只拆不跟），核主检出依赖目录项数没变，再删工作树和本地、远端分支；没有 `--session` 就打印「不适用」。
- 会话状态读不到、目标未归档、仍在运行、身份不对应或释放失败时停在删会话，不删工作树、分支或其它会话；会话已不存在按旧行为继续。释放成功后目录删除失败，记录会话已释放，重跑同一条继续删目标树。
- 快进因历史无共同祖先失败时，报告「主检出没快进：历史无共同祖先」，继续删联接、工作树、分支、会话。这几步不依赖主检出快进。
- PR 或 MR 已关闭且没合并：删工作树，分支留下；若给了会话则只释放已归档、已结束且已核对归属的会话。
- 先核再删：要删分支时，分支已在默认分支里，或 MR/PR 已合并；工作树没有未提交改动；联接拆完后没有剩余联接。有一件不满足就停，不删。
- 不要直接 `git worktree remove` 或 `removeWorktree`：Windows 上工作树里的依赖目录常常是指回主检出的目录联接，跟着联接会把主检出的依赖删空。
- 单的租约在 PR 合并后自动收，不跑 `pnpm work done`；挂了「本机做」的单尤其不许 `--release`：它会把单退回法国队列、摘掉「本机做」，引擎会把同一件活再做一遍（2026-11-13 真出过，#3981）。
