---
name: mirasim-sessions
description: 创始人指定「用 mirasim 开会话干活、做完回报」时读：开会话前先查老会话、一件活一棵工作树、收回报、验收、合并后删工作树和会话。
---

# `mirasim-sessions`：用 mirasim 会话当工人

干活方式由创始人在会话里指定，指定后这个会话一直照着走，直到他提出新方式（#3915）。他指定「开 mirasim 会话干、做完回报」时照本技能做，不再派 Agent 子代理。下面的 atom 都经 `mcp__mirasim__mirasim` 的 `call` 调。

## 开会话之前先查老会话

- `listSessions`（`workdir` 填仓根，`limit` 给小）看已有会话。同一件活的后续（返工、补验证、修 CI、改约束）发回原会话：`prompt` 带它的 `sessionKey`。只有新的一件活才开新会话。
- 开出来的会话用 `renameSession` 改名成 `[#单号] 短名`。mirasim 的会话列表就是账，不另记清单。

## 开会话

- `prompt`：`sessionKey: null`，`workdir` 填仓根，`agent`、`model`、`effort` 照创始人指定的，`route: "local"`（走个人账号，不扣 Mirasim 额度）。
- 走个人账号要整机路由是「自有」（`setRelayMode {mode: "local"}`）。派之前先 `getCatalog {agent}` 确认要的模型在目录里；会话报「只有平台提供」（422）或目录里没有，先 `getCatalog {agent, refresh: true}` 刷新再发，不换成差一档的模型凑合。grok 一律 `grok-4.7` + `route: "local"`。
- 交代照 commander「派活」写全（单号、要改什么、怎么算做完、别碰什么、跑哪些测试），另加四条：
  1. 自己干，不派子代理。
  2. 一件活一棵工作树 `.claude/worktrees/<单号>-<短名>`、分支 `local/<单号>-<短名>`；不往别的会话的分支推，依赖别人的 PR 就基于那个分支开自己的，对方合了再 rebase。
  3. PR 开好、本机检查过了就停，不开自动合并、不自己合，也不等 CI；`pr:open` 顺手开了自动合并就 `gh pr merge <PR> --disable-auto` 摘掉。合并归验收的人，不然没验收的改动会先进主线（#3950 就是先合了、返工只能另开 #3951，还带红了主线 #3953）。
  4. 回报：推完 PR 或卡在只有创始人能拍的事上，在同一轮里马上调 `prompt {clientRef, sessionKey: "<指挥会话的 key>", prompt: "[<活名> 回报] …"}`，写做到哪、PR 号、验证命令和真实结果、没做的和原因、要创始人拍的。小进度不发。交代里把这个 key 写死：指挥官自己的 key 用 `listSessions {workdir}` 找自己标题那一条；换棒（`commander-handoff`）后新交代写新 key。不许写「CI 绿了再回报」然后收轮：执行会话收了轮就没人叫醒它，回报永远发不出来。CI 归指挥会话盯。
- 关键约束（授权边界、别碰哪些分支、验收标准）在开会话的第一条里写全。中途补的话只是排进它的队列；`steer` 只有部分 agent 吃，grok 不吃（2026-11-12 实测）。要改交代：`prompt` 排队，再 `stopAndRun {sessionKey, ref}`（`ref` 是那条 `prompt` 的 `clientRef`）插队打断。
- 交代里给时限。子会话易在测试上越绕越远（降并发、加跳过、逐条追断言，#3988 的第二棒真遇到）；到点用上面的插队让它收尾，只报现状。
- 长时间没回报：`listSessions` 看它的 `runState`、`failed`。grok 进程会异常退出（`grok exited`），退了就不会回报，发回原会话重跑。
- 参考外部产品时写清授权边界：闭源软件和非开源许可（源码可见但限商用）的代码、样式一行都不进仓，只参考思路；MIT、Apache 类的库可以直接用。

## 指挥会话自己

- 派完就收轮。回报是作为新消息排进指挥会话的队列的，指挥会话一轮不结束，回报就进不来；无人值守的 Stop 钩子把轮续下去，也会卡住回报。
- 会话太长要换棒：照 `commander-handoff`。
- 不轮询。要看状态用 `getTurnFacts`（给 `taskId`）或小 `limit` 的 `listSessions`；mirasim 的返回常常很大，只抽要的字段。

## 验收

回报说做完后，指挥会话自己核，不照抄回报：

1. PR 的 CI 全绿、合并闸过：后台跑 `gh pr checks <PR> --watch`，跑完的通知叫回指挥会话，不轮询。
2. 对着交代里「怎么算做完」逐条核；截图自己看。拿假模型、假环境代替真的跑出来的，不算过。
3. 不过：发回原会话返工，写明哪一条没过。
4. 过了：指挥会话自己合（`gh pr merge <PR> --squash`），合进去再清理。

## 合并后清理

- 先核三件：PR 已合并；工作树没有没提交的改动；没有别的会话还在用这棵树。有一件不满足就不删，报给创始人。
- 删工作树（`removeWorktree` 或 `git worktree remove`）和这件活的本地、远端分支。
- 删会话：`deleteSession {sessionKey}`。
- 单的租约在 PR 合并后自动收，不跑 `pnpm work done`；挂了「本机做」的单尤其不许 `--release`：它会把单退回法国队列、摘掉「本机做」，引擎会把同一件活再做一遍（2026-11-13 真出过，#3981）。
