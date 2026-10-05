# 进度

> 进度和创始人中途给的引导记在 GitHub 置顶单 **#1055「进度与创始人引导」**，不再写进这个文件：接手先 `pnpm progress:read`；记进度 `pnpm progress:note "一句话"`；记引导 `pnpm progress:directive "原话" --at "时间"`，办完 `pnpm progress:done <评论号>`。开会话钩子读那张单、报没处理的引导。计划和先后看 `pnpm plan`，做成了什么看 PR 和单子评论。
> 这个文件只留下面「生效中的临时调整」表（开会话钩子读它、到期问创始人）；搬走前的状态、引导和归档目录在 `docs/archive/progress-2026-10-05-final.md`（更早的归档页也在 `docs/archive/` 下，目录在那一页末尾）。

## 生效中的临时调整

> 五列：内容｜当时为什么｜谁拍的（原话和日期）｜撤回条件｜最迟复查日期。撤回就删行（git 有历史）。规矩在通用段（`agents/shared-rules.md`）「我拍的板当场记进仓里记决定的地方」那条（日期一律 YYYY-MM-DD 北京时间）。

| 内容 | 当时为什么 | 谁拍的（原话和日期） | 撤回条件 | 最迟复查日期 |
|---|---|---|---|---|

> 已撤回（2026-10-05）：「法国引擎关闭」（进程停着、`FLEET_SERVICES` 只留 `fleet-api`）。撤回的话：创始人 2026-10-05 约 19:10 对「关闭是进程停着，还是进程开着但不接活（待命）」答「2 3 4 6 7 按照你推荐」（推荐＝待命）。现在的状态是「进程开着、各项目接活开关全关」：法国期望 `FLEET_SERVICES=fleet-engine fleet-api`（`deploy/france/desired-config.json`），新的 `v<N>` 发版后各项目自动回到关（`release.sh`，#1050）。待命的代价（创始人知情同意）：路由探针每 15 分钟起一次最短的模型会话、读额度照转。上线时要在法国以 root 把 `canary`、`route-probe`、`hourly-reconcile`、`github-reconcile` 四个被暂停的 Temporal 定时任务 `--unpause`（见 `docs/ops.md`）。
