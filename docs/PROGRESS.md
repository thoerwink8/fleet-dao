# 进度

> 进度和创始人中途给的引导记在 GitHub 置顶单 **#1055「进度与创始人引导」**，不再写进这个文件：接手先 `pnpm progress:read`；记进度 `pnpm progress:note "一句话"`；记引导 `pnpm progress:directive "原话" --at "时间"`，办完 `pnpm progress:done <评论号>`。开会话钩子读那张单、报没处理的引导。计划和先后看 `pnpm plan`，做成了什么看 PR 和单子评论。
> 这个文件只留下面「生效中的临时调整」表（开会话钩子读它、到期问创始人）；搬走前的状态、引导和归档目录在 `docs/archive/progress-2026-10-05-final.md`（更早的归档页也在 `docs/archive/` 下，目录在那一页末尾）。

## 生效中的临时调整

> 五列：内容｜当时为什么｜谁拍的（原话和日期）｜撤回条件｜最迟复查日期。撤回就删行（git 有历史）。规矩在通用段（`agents/shared-rules.md`）「我拍的板当场记进仓里记决定的地方」那条（日期一律 YYYY-MM-DD 北京时间）。

| 内容 | 当时为什么 | 谁拍的（原话和日期） | 撤回条件 | 最迟复查日期 |
|---|---|---|---|---|
| 法国引擎关闭：不再派单、不接新活，`/etc/fleet-dao/release.env` 的 `FLEET_SERVICES` 只留 `fleet-api`；期望配置写在 `deploy/france/desired-config.json` 的【临时】段 | 引擎 3 天半只做完 12 张单（真需求 4 张）、写码会话成功率 38%；流程重做前不再让它接活 | 创始人 2026-09-29 叫停引擎、要改成三段一条龙（原话：「要删的东西都要删」）；10-02 拍板「继续关着，到 #452 演练三连跑通 + 你说过那句『开』才再评估」(docs/decisions/0011-…md 第 2 条)；10-03 补：「法国vps很久都没跑了，你随时可以更新，但是我建议v3上线前,法国不要跑流程」（所以法国没有旧代码在跑，能随时发版落迁移；v3 上线前仍不开流程） | 演练过 + 创始人说「开」；撤回做法：改回 `fleet-engine fleet-api`、发布一轮，再把 `canary`、`route-probe`、`hourly-reconcile`、`github-reconcile` 四个 Temporal 定时任务用 `fleet-temporal schedule toggle --unpause` 恢复；原定 10-05 复查，按 0011 第 2 条续到 10-15（#452 还没跑通） | 2026-10-15 |
