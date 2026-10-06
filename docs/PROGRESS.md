# 进度

> 进度和创始人中途给的引导记在 GitHub 置顶单 **#1055「进度与创始人引导」**，不再写进这个文件：接手先 `pnpm progress:read`；记进度 `pnpm progress:note "一句话"`；记引导 `pnpm progress:directive "原话" --at "时间"`，办完 `pnpm progress:done <评论号>`。开会话钩子读那张单、报没处理的引导。计划和先后看 `pnpm plan`，做成了什么看 PR 和单子评论。
> 这个文件只留下面「生效中的临时调整」表（开会话钩子读它、到期问创始人）；搬走前的状态、引导和归档目录在 `docs/archive/progress-2026-10-05-final.md`（更早的归档页也在 `docs/archive/` 下，目录在那一页末尾）。

## 生效中的临时调整

> 五列：内容｜当时为什么｜谁拍的（原话和日期）｜撤回条件｜最迟复查日期。撤回就删行（git 有历史）。规矩在通用段（`agents/shared-rules.md`）「我拍的板当场记进仓里记决定的地方」那条（日期一律 YYYY-MM-DD 北京时间）。

| 内容 | 当时为什么 | 谁拍的（原话和日期） | 撤回条件 | 最迟复查日期 |
|---|---|---|---|---|

> 已撤回（2026-10-05）：「法国引擎关闭」（进程停着、`FLEET_SERVICES` 只留 `fleet-api`）。撤回的话：创始人 2026-10-05 约 19:10 对「关闭是进程停着，还是进程开着但不接活（待命）」答「2 3 4 6 7 按照你推荐」（推荐＝待命）。现在的状态是「进程开着、各项目接活开关全关」：法国期望 `FLEET_SERVICES=fleet-engine fleet-api`（`deploy/france/desired-config.json`），新的 `v<N>` 发版后各项目自动回到关（`release.sh`，#1050）。待命的代价（创始人知情同意）：路由探针每 15 分钟起一次最短的模型会话、读额度照转。上线不用再手动恢复定时任务：它们是引擎进程里的定时器（#1072），起来自己恢复（见 `docs/ops.md`）。

## v4 真机验收（2026-10-05）

按协调人 `_tmp/WSL-验收名单.md`，6 张需要截图的 v4 单（#1089、#1087、#1050、#618、#901、#820）**都验不了——登录墙拦着**。协调人纠正：驾驶舱在法国 `https://hangdao.dpdns.org`（不是 WSL 本机档，WSL 上根本没起驾驶舱前端）。我（AI）**不能输入登录密码**（协调人明示「如果他还没登，你只截登录页一张，写进 PROGRESS.md 说明『需要创始人登录』」），所以每张目标 URL 都只截到登录页本身，**结果一览如下，需要创始人自己登一次再告诉我截下一步**。

证据截图（都在 `_tmp/verify/`）：

| 单号 | 想验的页面 | 首页 URL | 实际落点 | 截图 | 结论 |
|---|---|---|---|---|---|
| 入口 | 驾驶舱根 | `https://hangdao.dpdns.org/` | `https://hangdao.dpdns.org/login?next=%2F` | `00-cockpit-entry.jpg` | 正常——登录页能打开，只是拦住 |
| #1089 | 路由（每环节模型顺序、渠道顺序、开关渠道） | `…/routing` | `…/login?next=%2Frouting` | `1089-routing-login-wall.jpg` | 未遂——需创始人登录 |
| #1087 | 渠道状态（照 mirastatus 样子） | `…/routing` | `…/login?next=%2Frouting` | `1087-routing-status-login-wall.jpg` | 未遂——需创始人登录 |
| #1050 | 环境页引擎开关胶囊 | `…/environments` | `…/login?next=%2Fenvironments` | `1050-environments-login-wall.jpg` | 未遂——需创始人登录 |
| #618 | 法国发版入口（预检/暂停） | `…/france` | `…/login?next=%2Ffrance` | `618-france-login-wall.jpg` | 未遂——需创始人登录 |
| #901 | 主页是否轻了 | `…/` | `…/login?next=%2F` | `901-home-login-wall.jpg` | 未遂——需创始人登录 |
| #820 | 环境切换器（本机 WSL / 法国 VPS） | `…/environments` | `…/login?next=%2Fenvironments` | `820-env-switch-login-wall.jpg` | 未遂——需创始人登录 |

旁证：试了演示版 `https://hangdao.dpdns.org/demo/`（用假数据、不用登录），它能打开的 6 张里没有我们要的——`demo-check-demo.jpg`、`demo-check-routing.jpg` 能看到演示版没把「路由页」「环境页」「主页真实数据」做成可看的（路由 demo 自己说「演示版没开放这一块」，下面的「额度」「定时任务」「通知中心」「操作记录」「设置」跟我们要验的 6 张都不是同一页）。

登录页正文（`00-cockpit-entry.jpg`）：「驾驶舱只放行创始人。用户名 / 密码 / 用飞书登录」，账号密码登录 API 说回 `{"devLogin":false,"passwordLogin":true}`，说明这台走账密 / 飞书，没有 devLogin 后门。

接下来怎么干：要么创始人在他自己的浏览器登一次，把 6 张页面截给我（或者发到这；只读账号也行）；要么给我一份只读只看的凭据；否则这个验收就到这里，**这 6 张单在 WSL 真机上这一次没能验收**。

协调人指示（`_tmp/WSL-验收名单.md` 末行）：「超时/打不开的先跳过、写清原因」。本段就是按它写的；不开 PR 修、不动登录页、不输密码。
