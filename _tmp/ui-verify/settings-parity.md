## 功能对照表（改前 → 现在）

改前＝主线 1c3fa294 的设置页（`routes/settings.tsx` 和它专属的 `components/repo-dispatch.tsx`、`repo-groom.tsx`、`engine-master.tsx` 的 `EngineMasterRelation`、`pool-holds.tsx`、`credentials-section.tsx`）。测试文件都在 `packages/web/src/` 下，e2e 在 `packages/web/e2e/specs/`。

结论：一项都没丢。收进悬停、ⓘ、「⋯」、展开的都写了怎么找到。

### 页头和整页

| 改前的功能 / 信息 | 现在在哪 | 怎么找到 | 哪条测试守着 |
|---|---|---|---|
| 标题「设置」 | 原处 | 直接看 | e2e `05-settings` |
| 一行说明「运行设置和仓库开关存在后端…外观只存在这台浏览器里」 | 标题下一行短说明「仓库开关、运行设置、提醒、登录和外观。」；原句（加版本号、仓库行怎么用）在 ⓘ | 点标题旁 ⓘ | `test/settings-1917`「各节说明一行不折…页头长说明在 ⓘ」 |
| 刷新 + 最后更新 + 过期标记 | 页头固定槽位（`Page refresh`），样子不变 | 直接看 | `test/refresh-settings` 两条 |
| 左侧页内导航（桌面竖排、手机吸顶横滑）六个锚点 | 原样 | 直接看 | `routes/settings.test`「页内导航有六个锚点…」 |
| 各节标题 + 图标 + 说明 | 原样；说明一行不折，放不下截断、整句在悬停 | 悬停说明 | `test/settings-1917`「各节说明一行不折」 |

### 仓库一节

| 改前的功能 / 信息 | 现在在哪 | 怎么找到 | 哪条测试守着 |
|---|---|---|---|
| 总开关和接活关系的一段话 + 总开关现状 + 去法国页链接 | 一行：状态点 +「总开关现在关着」（不让位）+ 关系一句（截断，整句悬停）+ 行尾「去法国页开关」 | 直接看，悬停看全句 | `test/engine-master`（「总开关关＝全停」等原断言不变）、`components/engine-master.test`、`test/settings-1917`「…一行不折」、e2e `07b-env` |
| 仓列表 / 接活开关读失败合成一条红横幅 + 重试 + 「上次读到的，可能不全」 | 原样（横幅改成和别的节一样宽） | 自动 | `routes/settings.test` 四条、`test/review-fixes` |
| 「还没有仓」（真读到空列表才说） | EmptyState 同一句 | 自动 | `test/review-fixes` 两条 |
| 仓名（悬停全名）、主线分支 | 仓名一行（截断，悬停全名）；主线在下一行小字 | 直接看 | `routes/settings.test`「仓名带悬停全名」 |
| 接活状态「接活中 / 关着」（状态点 + 字） | 行里唯一的状态（`StatusBadge variant=dot`）；手机上挪进小字最前 | 直接看 | e2e `05-settings`（`dispatch-state` 文本）、`test/settings-1917` |
| 「10月9日 02:03 开的」/「只有本机 fleet-api dispatch-issue 点名派」（原来只在 2xl 宽才写，其余悬停） | 状态和按钮的悬停 + 读屏 | 悬停状态或按钮 | `components/repo-groom.test`「关着的说明是新规则」、e2e `05-settings`（`toContainText('开的')`）、`test/settings-1917` |
| 开启 / 关闭按钮（二次确认、toast、操作记录） | 原样，行尾第一个按钮 | 直接点 | e2e `05-settings`「仓库一节让 AI 接活…」 |
| 整理状态点 + 「做成了 50 分钟前 / 整理中 / 还没整理过」 | 仓名下一行小字「整理 做成了 50 分钟前」（整理中黄字、没做成红字）；一行只留一个状态，整理不再另画状态点 | 直接看 | `components/repo-groom.test`（整理中、做成了） |
| 今日剩余 N/3 | 小字里（`groom-quota-*`）；手机上小字截断时，展开后标题旁补一份 | 直接看 / 点仓名 | `components/repo-groom.test`「今日剩余…」 |
| 「引擎总开关关着，不整理」（每行都写一遍） | 整理按钮的悬停 + 读屏；页上那一行已写总开关关着，不在每行重复 | 悬停「整理」 | `components/repo-groom.test`「引擎总开关关着：…置灰，旁边写明不整理」 |
| 「详情 ›」按钮展开整理记录 | 点仓名展开（仓名旁的 › 转向），读屏名字不变「X 的整理详情」 | 点仓名 | `components/repo-groom.test`（openDetails）、`test/settings-1917`「点仓名展开…」 |
| 整理记录：最近一次、单号链接、更早几次、长说明摘要 +「展开」 | 原样，放进 `RowDetail`（和仓名对齐，不再画虚线框）；手机上单号链接点击区 40 高 | 点仓名 | `components/repo-groom.test`「今日剩余、最近一次…」「长说明默认折叠」 |
| 记录没读成 / 被拒的原话 / 有 N 条没读懂 | 原样，自动展开 | 自动 | `components/repo-groom.test`「记录没读成」、409/429/503 四条 |
| 「整理」按钮（确认框、可填原因、置灰规则） | 原样，行尾第二个按钮，和开关按钮同宽（`min-w-16`）同一行 | 直接点 | `components/repo-groom.test`、`test/leftovers-1910`（断言换成等价的「同宽、同一个 RowFrame、相邻」，见 PR 说明） |

### 运行设置、留量线、整池暂停

| 改前的功能 / 信息 | 现在在哪 | 怎么找到 | 哪条测试守着 |
|---|---|---|---|
| 同时跑的会话上限、Jev 每天调用上限、引擎暂不用独享（说明、第几版、谁改的） | 原样（单栏 FieldGroup） | 直接看 | `test/page-writes`、`routes/settings.test`、e2e `05-settings` |
| 读失败只留报错横幅、骨架不在 | 原样 | 自动 | `test/read-failures`、`test/refresh-settings` |
| 留量线说明 +「怎么填」折叠 | 卡头一行说明（截断，悬停全句）；「怎么填」收进卡头右上 ⓘ | 点 ⓘ | `routes/settings.test`「留量线一块…Section 标题」 |
| 线从哪来（种子 / 人改过 / 库里没有，红字） | 原样 | 直接看 | e2e `05-settings`「来自种子」「人在驾驶舱改过」 |
| 存值认不出的红字、渠道没读成 | 原样 | 自动 | — |
| 每池每窗一格、未配置灰色「—」点了才变输入框、窗口名中文 | 原样 | 直接看 | `routes/settings.test` 四条（含 #1871 三条） |
| 整池暂停说明（一长段） | 卡头一行；全文收进卡头 ⓘ（加了一句「改负责人、续期、撤回在行尾⋯」） | 点 ⓘ | `test/settings-1917` |
| 「要人看」标签 | 原样 | 直接看 | `components/pool-holds.test`「过了复查日期…」 |
| 每条暂停：池名、为什么停、负责人、谁拍的、撤回条件、最迟复查（北京时间） | 一行：池名 + 小字「负责人 X · 最迟复查 日期」（北京时间在悬停）+ 一个状态；为什么停、谁拍的、撤回条件在行下明细 | 直接看 | `components/pool-holds.test`「负责人能看能改」 |
| 过了复查日期标红「已过复查日期 N 天 / 今天要复查」 | 行里的状态（红 StatusBadge，role=alert）；没到期写「暂停中」 | 直接看 | `components/pool-holds.test`、`test/settings-1917` |
| 改负责人 / 续期 / 撤回三个按钮 | 行尾「⋯」三项（撤回红字在最后）；点了表单照旧在这一行下面展开 | 点「⋯」 | `components/pool-holds.test` 五条（点按钮改成先开「⋯」再点菜单项，断言不变）、`test/settings-1917`「…收进⋯」 |
| 整份认不出 / 某项认不出 / 旧提醒 / 迁成开关 / 新建表单 | 原样 | 自动 / 直接点 | `components/pool-holds.test` |

### 提醒、账密、外观、关于

| 改前的功能 / 信息 | 现在在哪 | 怎么找到 | 哪条测试守着 |
|---|---|---|---|
| 免打扰时段（开关、起止、保存） | 原样 | 直接看 | `test/page-writes`「免打扰时段…」 |
| 账密现状、说明、表单四栏、保存、去操作记录 | 原样；说明一行不折；四栏装进和别的节一样的 FieldGroup | 直接看 | `components/credentials-section.test` 17 条、e2e `10-credentials` |
| 深浅、密度、主题色、状态色、减少动效 | 原样 | 直接看 | `routes/settings.test`「Graphite、Tokyo Night 不带省略号」 |
| 关于（数据源、登录、接口约定） | 原样 | 直接看 | — |
