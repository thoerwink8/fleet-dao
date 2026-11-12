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
- 走个人账号要整机路由是「自有」（`setRelayMode {mode: "local"}`）。会话报「只有平台提供」（422）时，先 `getCatalog {agent, refresh: true}` 刷新模型目录再发；不换成差一档的模型凑合。
- 交代照 commander「派活」写全（单号、要改什么、怎么算做完、别碰什么、跑哪些测试），另加三条：
  1. 自己干，不派子代理。
  2. 一件活一棵工作树 `.claude/worktrees/<单号>-<短名>`、分支 `local/<单号>-<短名>`；不往别的会话的分支推，依赖别人的 PR 就基于那个分支开自己的，对方合了再 rebase。
  3. 回报：做完或卡在只有创始人能拍的事上，调 `prompt {clientRef, sessionKey: "<指挥会话的 key>", prompt: "[<活名> 回报] …"}`，写做到哪、PR 号、验证命令和真实结果、没做的和原因、要创始人拍的。小进度不发。
- 中途要补约束，`prompt` 带 `steer: true`，在它下一步插进去。
- 参考外部产品时写清授权边界：闭源软件和非开源许可（源码可见但限商用）的代码、样式一行都不进仓，只参考思路；MIT、Apache 类的库可以直接用。

## 指挥会话自己

- 派完就收轮。回报是作为新消息排进指挥会话的队列的，指挥会话一轮不结束，回报就进不来。
- 不轮询。要看状态用 `getTurnFacts`（给 `taskId`）或小 `limit` 的 `listSessions`；mirasim 的返回常常很大，只抽要的字段。

## 验收

回报说做完后，指挥会话自己核，不照抄回报：

1. PR 的 CI 全绿、合并闸过（`gh pr checks`）。
2. 对着交代里「怎么算做完」逐条核；截图自己看。拿假模型、假环境代替真的跑出来的，不算过。
3. 不过：发回原会话返工，写明哪一条没过。
4. 过了：等 PR 合并，再清理。

## 合并后清理

- 先核三件：PR 已合并；工作树没有没提交的改动；没有别的会话还在用这棵树。有一件不满足就不删，报给创始人。
- 删工作树（`removeWorktree` 或 `git worktree remove`）和这件活的本地、远端分支。
- 删会话：`deleteSession {sessionKey}`。
