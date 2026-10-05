# 0011 创始人对 7 件人闸的拍板（2026-10-02 北京时间 10:30 前后）

- 日期：2026-10-02 上午（北京时间 10:30 前后；落盘提交 `b5dda3f8` 在 10:37。原稿把时间写成「UTC 10:3x / 北京 18:3x」，是把北京时间当成了 UTC，2026-10-02 下午复核时改正）
- 谁拍的：创始人
- 状态：已采纳
- 现状（2026-10-05 回写）：生效。第 4 条「追加」里的派活开关 `engine_dispatch_paused` 没做，发布时停接活、等手头活收完由排空（`packages/engine/src/drain*.ts`）做。
- 关联：docs/decisions/0009-v3-implementation-plan.md（W3 待拍）、specs/450/453/323/450-454/227，
  deploy/france/desired-config.json，ops.md 第九节「自动发布」，deploy/release.sh

## 原话

```
1-1，但不要重启
2-1
3-1
4-1，我希望github actions通过后可以暂停派活，然后引擎手头活都干完后，自动部署到引擎，然后接着进行活和派活
5-1
6-1
7-1
```

## 决定（7 条）

1. **WSL 修复**：**照装**（D:\Tools\wsl-installer\repair-wsl.ps1），**但完成也不重启**。若 MSI 输出 3010「要重启才完全生效」就**先不重启**，装完先查 wsl --status 通不通，照实报给创始人；重启只由创始人自己做。
2. **法国引擎**：**继续关着**，不要现在改回 fleet-engine。等 #452 演练仓在本机环境三连跑通 + 创始人说「开」之后，才再评估打开。
3. **法国发布机制**：**按版本、创始人确认**（对应选项 1）。废除「主线每 merge 自动发布到法国」。意思是：发布 = 创始人拍一版「release/vN」PR 合主线 → GitHub Actions 拿 tag → GitHub Release → 关里程碑 → 飞书 → deploy/france.sh 抓期望版本拉实际。急修仍可指挥官带理由绕过、事后补演练。
4. **#227 发布机制**：**走 GitHub Actions（不是 deploy/release.sh 法国 root）**。落地会碰 .github/workflows/（先审后合），由「merge『发布 vN』PR」触发 GITHUB_TOKEN 打 tag/Release/关 milestone/推飞书。
   - **追加**（4 的引申，创始人原话）：「**github actions 通过后可以暂停派活，然后引擎手头活都干完后，自动部署到引擎，然后接着进行活和派活**」。release.yml 在合主线并出 tag 后：①**暂停引擎派活**（数据库 flipswitch：engine_dispatch_paused=true，engine 看到这个就停接活）；②**等手头在跑的全跑完**（引擎手上在跑的会话全部收完尾，等多久有上限）；③**拉新期望版本到法国**（deploy/france.sh 已能按 desired-config 拉期望版本）；④**回到派活**（engine_dispatch_paused=false）。这个闸的形状照 AGENTS.md 本仓段第八行「暂停派的闸」+ specs/323 的设计——具体切片走 #453 重写。
5. **飞书在发布里默认推**：推荐默认推（FLEET_FEISHU 未配就写「没配飞书，未通知」不报错）。
6. **#454 关成留史**：意图已被取代的三块（#509 删两个模式、#561 内存准入、#194 切号） + 推送令牌由 #450 母单 W4 切片（小号 GitHub App）承接。**关**。
7. **#323「开关放哪」**：**留在法国库当指令、不进仓**（推荐选项 1，OpenGitOps 的例外）。按 ops.md、design.md 第九节的同一条改：开关的期望和现状不一致对账照期望改；#323 边界定。#556-7 文档对齐切片里收进去。

## 前后冲突修正

- 法国引擎重开：`docs/PROGRESS.md`「生效中的临时调整」表第一行的撤回条件按第 2 条改为「#452 演练三连跑通 + 创始人说『开』」。（原稿写成「决定 0007 第 2 条」；0007 第 2 条讲的是 GitHub 账号当总钥匙，和引擎无关，复核时改正。）
- specs/169-Fusion形态/需求.md 行 278、333 的「撤回条件：本机环境里的引擎能接活（#452 演练连续跑通）后」**和上面不冲突**，按：先演练过、再由创始人说「开」两步走。
- specs/450-本机环境/需求.md 残留「WSL 里的 Grok 普通模式工人」按 #454 关留史改写为「本机档起小号 GitHub App 的引擎工人」。

## 落地切片（归哪张单）

| 决定 | 落地 | 新单/沿用 |
|---|---|---|
| 1 WSL | 你回机器边点 UAC 那一次（本机，指挥官通知） | #450 母单下的切片 |
| 2 法国引擎 | docs/PROGRESS.md「生效中的临时调整」表**到期变化前续期**（撤回条件更新） + deploy/france/desired-config.json 的 FLEET_SERVICES 只留 fleet-api 暂不动 | 不另开（#323 开关在那边的队） |
| 3 法国发布机制 | **新单 + PR**：把「自动跟随主线发布」改「按版本创始人确认 publish.yml」 | #453 重写 + 新单（具体设计拍由 GPT 挑错） |
| 4 GitHub Actions | 新 workflow（.github/workflows/release.yml）：merge『发布 vN』PR → tag/release/关 milestone/推飞书（先审后合） | #227 下半重写切片 |
| 4 引擎暂停派活/恢复派活 | engine 代码停派闸（flipswitch）→ 等手头 settle → 部署 → 恢复 | #453 重写的一部分；**新单**：engine-dispatch-flipswitch |
| 5 飞书默认推 | release.yml 里写 FLEET_FEISHU 未配就标「没配」不报错 | 同 #227 下半 |
| 6 #454 关留史 | gh issue close 454（已关成 not_planned）；#450 母单 W4 改小号 GitHub App | 不另开 |
| 7 #323 开关放哪 | #556-7 文档对齐切片把这条写进 ops.md / design.md | #323、#556-7 |
