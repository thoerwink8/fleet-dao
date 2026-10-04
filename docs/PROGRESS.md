# 进度（本机恢复与重做前置）

> 一行一条、带日期和对应提交。规矩在 `AGENTS.md` 通用段「进度也要落盘」。

## 现在状态（2026-10-05 起的索引，接手先读这一节）

- **怎么读这个文件**：先看本节，再看「生效中的临时调整」和「创始人引导（待处理）」（开会话钩子读这两节，所以它们一直在本文件里），再往下是 10-04、10-05 的日志（新的在前）。更早的（10-04 凌晨及以前）已原样搬进 `docs/archive/`，目录在文末「归档目录」。计划、先后、谁在做以 GitHub 为准：`pnpm plan`。
- **归档的规矩**：一节里写的活做完了（PR 合了、单关了、还欠的有单号），就把整节原样搬进 `docs/archive/progress-<月-日>.md`，只搬不改字，并在文末「归档目录」补一行；本文件只留还在办的和最近一两天的。`agents/test/progress-structure.test.ts` 钉住：两个钩子要读的节还在本文件里、读得出来，归档目录和归档页对得上。
- **现在最要紧的几件**（摘自下面各节，细节看原节；做到哪以 `pnpm plan` 和 GitHub 为准）：
  1. 创始人 10-05 01:30 交的四件事（v3 收尾与 WSL 跑通、任意子代理、臃肿与 CI 优化、驾驶舱 e2e 与首页流程图）：见「创始人引导」第一条。臃肿这件的母单是 #901，文档与仓体量的审查在 `specs/901-项目瘦身与提速/文档与仓体量审查.md`，本文件的归档是它的第一刀。
  2. #194 拼车自动切独享：四路（#891、#892、#893、#894）已合；还没验证的几项在「#194 剩下的活拆成四路并行」和「方案 4.7」两节；「核对不上不往拼车派」没做，单 #896。
  3. v3 的关键路径是 #452 本机演练（它跑通才能真机验 #76、#157、#59、#345，才发第一版）：逐张单真剩什么、卡在谁看「2026-10-05 v3 剩余盘点」节；10-04 晚的卡点在「2026-10-04 晚（无人值守队列…）」节的加粗段；演练仓 GitHub App、WSL 演练环境起来的记录在归档页 `progress-2026-10-04.md`。
  4. #777 法国巡检仓要创始人在 GitHub 上建空仓、装 App：见「2026-10-04（#777 …）」节的「还欠」。
  5. 本机 Mirasim 的平台额度：#873 已合，真扣费还没验：见「已开着的会话切不到平台额度」。Mirasim 接入的验证证据另有两处在归档页 `progress-2026-10-02.md`（「Mirasim 切换与一条命令迁移，实施」「Mirasim 自有 / 平台切换与 macOS，先调研出方案」），`docs/reclaude-in-mirasim.md` 说的「以进度中的证据为准」指这几处。
- **旧引用对照**：「创始人引导」和各节里写的「见下面『演练仓 GitHub App 建好了』」「PROGRESS 10-04『本机演练环境起来了』」「10-03 下午」「10-03 06:55」这类，指的是已搬走的节，到文末「归档目录」按标题找。
- **引导节的数现在是真数**：开会话钩子数的是没写「已处理」三个字的条，所以写成「已办」「已合」的条也会被数进去。2026-10-05 逐条核过一次（对 PR、主线文件、单子状态），办完的 48 条整条搬进归档页 `docs/archive/progress-inbox-2026-10.md`、每块后面附证据，本节只留 6 条还在办的（开场报的数就是它）。往后办完当场标「已处理」或整条搬走；`agents/test/progress-structure.test.ts` 拦「写着已办、已合、已完成却没标已处理」的条。

## 生效中的临时调整

> 五列：内容｜当时为什么｜谁拍的（原话和日期）｜撤回条件｜最迟复查日期。撤回就删行（git 有历史）。规矩在 `AGENTS.md` 通用段「我拍了板，当场记进项目里记决定的地方」（日期一律 YYYY-MM-DD 北京时间）。

| 内容 | 当时为什么 | 谁拍的（原话和日期） | 撤回条件 | 最迟复查日期 |
|---|---|---|---|---|
| 法国引擎关闭：不再派单、不接新活，`/etc/fleet-dao/release.env` 的 `FLEET_SERVICES` 只留 `fleet-api`；期望配置写在 `deploy/france/desired-config.json` 的【临时】段 | 引擎 3 天半只做完 12 张单（真需求 4 张）、写码会话成功率 38%；流程重做前不再让它接活 | 创始人 2026-09-29 叫停引擎、要改成三段一条龙（原话：「要删的东西都要删」）；10-02 拍板「继续关着，到 #452 演练三连跑通 + 你说过那句『开』才再评估」(docs/decisions/0011-…md 第 2 条)；10-03 补：「法国vps很久都没跑了，你随时可以更新，但是我建议v3上线前,法国不要跑流程」（所以法国没有旧代码在跑，能随时发版落迁移；v3 上线前仍不开流程） | 演练过 + 创始人说「开」；撤回做法：改回 `fleet-engine fleet-api`、发布一轮，再把 `canary`、`route-probe`、`hourly-reconcile`、`github-reconcile` 四个 Temporal 定时任务用 `fleet-temporal schedule toggle --unpause` 恢复；原定 10-05 复查，按 0011 第 2 条续到 10-15（#452 还没跑通） | 2026-10-15 |

## 2026-10-05 #901 子单：驾驶舱发信号的断链（Sonnet 5.5 子代理，分支 `fix/signal-chain`，`Refs #901` 不写 Closes，chain-first）

做到哪：断链证实了（先写红的测试 `packages/api/test/signal-chain.test.ts`：后端发的是 `req:<仓>#<号>` + `stop/resume/pause`，引擎只有 `task:<仓>#<号>` + `taskContinue/taskAbandon/taskRouteWake`），并用一次性脚本把真的 api 发信号函数接到真 Temporal 测试服务端上的真任务工作流跑通了（没提交）。修法：信号名和参数形状收进 `shared/task-signals.ts`（引擎 `defineSignal` 和后端共用）；后端改发 `task:` 编号 + `taskContinue`（继续）/`taskAbandon`（叫停，reason 缺省补一句）；引擎没有接收处的信号（pause、reroute、answer、requireApproval、agentEvent）不再发，暂停和换路由回 409 `action_not_supported`、回答只落库、fleet 命令只写库、碰人闸的提问回 409 `hold_not_supported`；`workflow_gone` 409 和「拼不出编号」404 都带人话原因。同根的引擎侧读法顺手修一处：每小时对账的工作树清扫认的是 `req:`，任务工作流等 CI/合并时没开着的会话，树会被当残留删（`worktree-sweep.ts` 改认 `task:`，有测试）。删了 shared 的 `REQUIREMENT_WORKFLOW_TYPE`、`FUSION_WORKFLOW_TYPE`、`AGENT_EVENT_WAKE_KINDS`；`requirementWorkflowId` 不能删：每小时对账认旧批准提醒还在拼它。
下一步：盯 CI 合并。还没验证：真环境（法国引擎关着）；驾驶舱前端的「暂停」「换路由」按钮还在，点了会看到 409 的话（前端没动，#856 说它们本来就没页面入口）。同根没修的（要另开单）：`alert-sweep.ts` 的挂起提醒只认 `req|sub` 前缀、读 `status` 查询，任务工作流报的 `task:…:park:N` 不会被自动撤；`hourly-reconcile` 对账读任务工作流的查询名是 `taskStatus` 不是 `status`。

## 2026-10-05 驾驶舱首页恢复流程图（母单 #902，Sonnet 5.5 子代理，分支 `feat/902-home-flow`，PR #914）

做到哪：后端（`/api/home` 补 segment / worker / lastEvent / flow、store 新增批量读三段流水）、前端（react-flow 三泳道流水线图、卡片重做、读不到带重试）、测试、真实画面（1920×1080 / 1366×768 + 对照，在 `_tmp/home-flow/`）、体积和构建时间实测都做完，CI 全绿；下一步：自动合并。还没验证：真库真引擎写的 runs 行上流水线图长什么样（只在内存库、PGlite 和假后端上验过）、深色主题和手机宽度的图；best-practice-first 六步记录（业界对照、代价表、版面验收三问）在 `specs/902-驾驶舱首页流程图/方案.md`。react-flow 代价：全站 js+css gzip 354.8 → 417.5 KB（+62.7 KB，只在首页路由加载），客户端构建 1.73 → 4.54 s。
- 在跑的那块的卡片 = 原来的列表卡，换成三条泳道里的卡；没有再并存一份列表（同一张单只在一处出现）。
- 老单（runs 里一笔三段流水都没记、状态也推不出）segment 是 null，落进第四条「还没分段」泳道，不猜。

## 2026-10-05 四件小事：#761 对题不计、#336 巡检收单连 PR、#339 备份重复卡、删 elkjs（Sonnet 5.5 子代理，一件一个 PR，同时最多 2 个）

- **#761 做完了、PR 待开**（分支 `fix/761-scope-unmetered`）：选了「不计」——对题在创始人和指挥官的对话里做，开单脚本读不到那个会话的起止/模型/token、本机也写不进法国库，凑空行是假数。任务页「三段」对题行写「在对话里做的，不计」和原因，主页对题泳道头写「在对话里做的，不计耗时」；名单和文案在 `packages/web/src/lib/segments.ts` 的 `SEGMENT_UNMETERED`（只有 scope），以后 runs 里有对题行（#553 意图归纳）照常显示并注明只含引擎起的会话；`docs/design.md` 第八节写明。没验证：真库上长什么样。
- #336、#339、elkjs：还没开始。

## 创始人引导（待处理）

> 创始人插话给的引导、修正、决定落在这里（通用段「你的引导必须落盘」那条），别只留在对话里。办完标「已处理」或删掉；只管这一次会话怎么干的**不记**（决定 0013）。
>
> 已标「已处理」的原话（整条都处理完的）、以及办完了但没标「已处理」的（逐条核过证据，附在每块后面）2026-10-05 搬到了 `docs/archive/progress-inbox-2026-10.md`，一个字没改；这一节只留还没办完的和他最近说的。写着「已办」「已合」的条必须标「已处理」或搬走，否则测试红。

- 2026-10-05 约 01:30「进入无人值守模式，现在有3件事情：1. v3流程需要把剩下任务都完成，wsl需要跑通 2. 可以开任意个subagent 3. 仔细审查整个项目，项目臃肿+ci流程慢，需要优化重构各个模块和流程 4. 驾驶舱需要和后端搭配，站在用户角度上e2e；驾驶舱的首页react-flow怎么没了」——**办中**：已开无人值守；第一批并行子代理（Sonnet 5.5）：WSL 演练跑通（#452 链）、v3 剩余单盘点、CI 提速、代码臃肿审查、文档与仓臃肿审查、驾驶舱 e2e（用户视角）、驾驶舱首页流程图恢复；审查类先出报告再切片实施（碰架构的先过 `discuss`）。react-flow 的答案：看板是 #556（#612）按 `goals.md` E 节「一屏三块」有意删的，`@xyflow/react` 依赖还留在 `packages/web/package.json` 没人用（臃肿一项）；他问「怎么没了」按「要恢复流程可视化」办，首页保留三块、加一张三段流程图，不恢复旧的多人看板。
- 2026-10-04 夜 18 条审查的余项（从搬走的那条里摘出来，原话在 `docs/archive/progress-inbox-2026-10.md`）：18 条逐条对过 PR，都合进主线了；只剩一件要等上线后核——#854 把线上令牌按用途降权了，这版上线后第一次换令牌，看健康页 `github_app` 自检是否仍绿；读分支规则那个接口要不要 `administration` 读，没法在真 GitHub 上验，保守留了只读。
- （2026-10-04 约 08:50，对晨报第 3 点的回话；同组办完的条已搬进归档页）「第三点，我完全同意你的看法，选形态 A。我希望，当我和群聊的内容反馈到 GitHub 或讨论信息里时，能有一个总结的功能。关于这个总结功能，我觉得可以这样处理：1. 在开始做任务时，将讨论步骤进行意图识别，汇总成可识别的信息；2. 或者根本不需要总结，直接把原文喂给指挥官。具体看你认为哪一种方式比较合适。」——#553 第 4 条定形态 A；归纳方式由我定（见「已定」：原话原样全给指挥官，归纳在开单那一刻由指挥官做、写回卡和单，法国不起归纳会话）。**做中**。
- （2026-10-04 约 08:50，对晨报第 4 点的回话；同组办完的条已搬进归档页）「我觉得 4 点都是要删的，但我不知道为什么历史没删。不管历史怎么样，你先把历史删掉。」——我的理解：#553 第 4 问「删旧飞书四张表」连历史数据一起删、不导旧草稿进意图（选项 2）；删表仍照先例：代码不读了再单独迁移 PR。**做中**（随飞书改造）。
- （2026-10-04 约 06:45，回「要你拍的 8 件」的第 4 条；同组办完的条已搬进归档页。文中「已开单 #819」是笔误，#819 是别的 PR，实际开的单是 #820，还开着、一行没开工）「4.我很纠结，如果真跑通了限制发到法国其实可以；然后我们引擎缺少了 wsl和vps两个环境的驾驶舱，另外还需要一个按钮，可以暂时中止所有任务，随时可以开启；需要全局中止和单个任务中止；由中止就要由恢复」——首版发布：**先等 #452 三连跑通**，跑通了发到法国可以（他犹豫的点在「限制发到法国」）；**新需求（已开单 #819）**：① 驾驶舱缺 WSL 和 VPS 两个环境的视图；② 暂停/恢复按钮：全局中止所有任务 + 单个任务中止，**中止必须配同级的恢复**（随时能开）。他这条是设计意图，具体做进哪张单由我定（已挂 #819，并进 #509 驾驶舱那一支）。
- （2026-10-04 约 06:45，回「要你拍的 8 件」；同组办完的条已搬进归档页。**和 v3 剩余盘点第五节第 3 条对不上**：这里说应用版本 1.0.3 已发布，盘点说三步还没做，要对着飞书后台核一次）「飞鼠你帮我操作浏览器，我帮你登录」——**飞书开发者后台已在办**：他登录后我操作。已做完两项权限（`im:message.group_msg` 从没有到**已开通**；`im:message:readonly` 本来就有）、订了撤回事件 `im.message.recalled_v1`、**应用版本 1.0.3 已发布**（15:07，免审通过）。

## WSL 不让它睡：为什么、怎么做（2026-10-04 查证）

**为什么**：#452 演练的引擎跑在 `fleet-local` 里，WSL 没人连着几分钟就整台停、引擎跟着停（PROGRESS 10-04「本机演练环境起来了」第 ④ 条）。演练要它一直跑。

**根子是两个键，不是一个**（2026-10-04 查 WSL 官方文档 + microsoft/WSL 的 issue 核过）：

1. `instanceIdleTimeout`：一个**发行版**没有活跃用户进程后能待多久，到点这个实例就关了（默认 8000 毫秒）。
2. `vmIdleTimeout`：**所有**发行版都没了之后，WSL 那个虚拟机进程还能留多久（默认 60000 毫秒）。

只写 `vmIdleTimeout=-1` 不管用——那管的是「东西都已经没了之后别再收」，拦不住发行版先被空闲关掉。两个都要设。

**本机 WSL 版本**：2.6.3.0（`wsl --version` 读的）。

**怎么做**（你自己在 Windows 上，管理员 PowerShell）：

1. 看有没有这个文件：`%UserProfile%\.wslconfig`。**这台机器现在没有**（我查过，`C:\Users\Administrator\.wslconfig` 不存在）。
2. 新建（或编辑）它，加两段：

   ```ini
   [general]
   instanceIdleTimeout=-1

   [wsl2]
   vmIdleTimeout=-1
   ```

   已经有别的段（比如 `[wsl2]` 下已有的 `memory`、`processors`、`networkingMode`）就**加进去、别整份覆盖**——仓里 `deploy/local/wslconfig.example` 是 fleet-local 的那份样例（16G / 8 线程 / 镜像网络），可以照它合。**注意**：`.wslconfig` 的注释用 `#` 还是 `;` 各版本说法不一，最稳是不写注释；写了报「unknown key」之类就把注释去掉再来。
3. 改完跑一次 `wsl --shutdown` 才生效（**这一下会把 fleet-local 连同里面的引擎一起停掉重启**，所以挑没在跑演练的时候做）。
4. 验证：跑 `wsl -d fleet-local -- systemctl is-active fleet-engine`，然后关掉所有 WSL 窗口、等十分钟以上，再跑一次同一条命令。回 `active` = 成了；回别的或报连不上 = 没成。

**如果两个键设了还停**（issue #13291 有人报过这种情况，WSL 新版本改过空闲回收行为）：兜底是「留一个进程在实例里」——`wsl --exec dbus-launch true`（这条起的进程挂在实例的 PID 2 下，能吊住整个发行版；Windows 重启后要重跑一次），或者干脆跑演练那几次**留一个 wsl 窗口开着别关**，实测窗口开着就不回收。备选 `tmux new -d` 也行。这三条都不用改配置、不用 `wsl --shutdown`。

## 2026-10-05 创始人引导节清扫（Sonnet 5.5 子代理，分支 `docs/progress-inbox-sweep`）

做到哪：引导节 53 条（含子条，钩子原来报 47 条没处理）逐条核过，48 条整条搬进 `docs/archive/progress-inbox-2026-10.md`（每块附「已办」证据一行，原话没改），留 6 条在原节；开会话钩子现在报 6 条。`progress-structure.test.ts` 加了「写着已办/已合/已完成却没标已处理」的拦截（先造出失败再修）。WSL 那段操作说明从引导节里的小标题升成独立一节。下一步：这 6 条各自的活（见引导节）。没验证：第 81 条（飞书开发者后台 1.0.3 已发布）和盘点第五节第 3 条对不上，要对着飞书后台核；#854 令牌降权上线后的健康页自检；#820 一行没开工。

## 2026-10-05 文档与仓体量审查 + PROGRESS 归档（#901，Sonnet 5.5 子代理，分支 `chore/901-docs-slim`，PR #910）

做到哪：审查报告 `specs/901-项目瘦身与提速/文档与仓体量审查.md` 写完；本文件 209 KB / 800 多行 → 约 80 KB，历史节原样搬进 `docs/archive/`（搬前搬后逐行核过，丢 0 行）；钉骨架的测试 `agents/test/progress-structure.test.ts`、欠账检查跳过 `docs/archive/`、删了没人引用的 `.claude/handoff-2026-09-25.md`。下一步：盯 #910 的 CI 到合并；design/ops 拆分按报告第 4.4 节 P0、P1 起（未开工）。还没验证：合并后下一个新会话开场的钩子输出是否是「创始人引导还有 47 条没处理」且不报临时调整表问题（现在只在临时 git 仓里用真文件验过）。

## 2026-10-05 #878 #883 #884 Store 内存版对齐库版（Sonnet 5.5 子代理，分支 `fix/878-883-884-memory-store-align`，PR #917）

做到哪：`memory-store.ts` 的 `listUsers`（创建时刻再 id，内存用户加了可选 `createdAt` 只用来排序、读出去不带）、`listBans`（写入先后＝库里自增编号，交副本）、`listRuns`/`listAsks`/`listPendingAsks`（时刻再 id）、`listPullRequests`（merged 没合并时刻排最后、编号倒序兜底）已和 `pg-store.ts` 对齐；`store-contract.ts` 加了「列表的顺序与副本」6 条，先在内存版上看过 5 条红（listBans 顺序那条本来就对）再修绿。内存版、pg 版（本机 PGlite）各 112 条全绿，CI 全绿。下一步：自动合并。还没验证：无。

## 2026-10-05 #857 web 写方法同步抛错（Sonnet 5.5 子代理，分支 `fix/857-web-write-async`）

做到哪：`packages/web/src/api/http.ts` 里 `createDemoLink`、`updateRouteEffort` 改成 async，校验失败返回被拒的 Promise；`http-writes.test.ts` 那条故意造出失败的测试改成不套包装直接调、同步抛就判失败（旧代码下三条红）。单上说的第三个 `updateDemoDefault` 在主线上本来就是 async，没改，只补了一条它的坏请求体用例。web 的 api、demo、page-writes 共 150 条过。还没验证：无。

## 2026-10-05 #901 第三阶段：纯重构方案（① shared 小工具、③ web-api 拆分、⑤ github 变纯、⑥ 跨包路径；Sonnet 5.5 子代理，分支 `slim/901-refactor-plan`，PR #920，`Refs #901` 不写 Closes）

做到哪：方案写完并过了别家挑错（GPT、Kimi 各一份有效意见；前两轮四家都超 30 秒没答完，已在方案第 7 节照实写），`specs/901-项目瘦身与提速/重构方案.md`。下一步：方案进主线 → 按方案第 5 节的 PR 表依次实施（`packages/conventions/test/package-boundaries.test.ts` 与 shared/util 纯加 → ⑤ → ⑥ → ③ → ① 各包替换，每片一类）。还没验证：方案里的数字来自本机脚本读代码；零安装区（CI 的 changes/check job、agents-sync、mirasim-reclaude、bridge.ts）的清单读自 workflow 和文档，没逐个在无 node_modules 的环境里跑过；`import.meta.resolve` 取桥接脚本在法国真机上的路径没在本机验（只能合并后随部署看）。

## 2026-10-05 #789 + #805 小单（Sonnet 5.5 子代理，PR #924，分支 `fix/789-805-conventions-small`；#857 已在 #919 合并）

做到哪：代码和测试写完、conventions 两个测试文件 60 条过、biome 和 `tsc -b packages/conventions` 过，PR 已开挂自动合并。#789：预检不再猜「起不来」的报错长什么样，改成看「命令真跑到检查了没有」的证据（biome 的 `Checked N files in`、tsc 的 `error TS`），退出码非 0 又没证据就退 2「没查成，先 pnpm install」；启动器文件不在时直接报起不来、不再经 cmd 起一个不存在的路径（那就是 `The system cannot find the path specified.` 退 1 的来源，本机复现过）。#805：「提醒过」改成正文里单独的记号（分支加头），留言成功才记，留言失败下一轮照样再留。下一步：盯 CI。本机 conventions 全包跑时 ci-cache 的 3 条起进程测试超时（负载，和本改动无关），交 CI 判。还没验证：真 GitHub 上巡检单 #784 的下一轮（旧正文没有跟踪行，按「列过的算提醒过」处理一次，之后才按新记号）。

## 2026-10-05 #901 代码层臃肿审查（Sonnet 5.5 子代理，分支 `slim/901-*`，`Refs #901` 不写 Closes）

做到哪：第一阶段报告（`specs/901-项目瘦身与提速/代码臃肿审查.md`，#904）和第二阶段三片都已合并：S1 #911（-966 行）、S2 #913（-284 行）、S3 #916（约 -230 行），结果表在报告「第二阶段结果」。下一步：报告第七节「需要方案」九条（共用小工具收进 shared、Store 两份实现、web-api.ts 拆分、adapters 的 codex/shell 渠道去留等）要指挥官让别家挑错后再派；第九节的断链单独开单。还没验证：报告第九节的疑似断链（驾驶舱发 `req:` 工作流信号、引擎只认 `task:`）只是读代码推断，没有在真 Temporal 上跑；`elkjs`、`@xyflow/react` 没删（别家在做首页流程图）。

## 2026-10-05 v3 剩余盘点（Sonnet 5.5 子代理，只读盘点；创始人 10-05「v3流程需要把剩下任务都完成」）

做到哪：v3 里程碑开着的 27 张和未排期里相关的单都逐张读过正文、对过合并的 PR 和主线代码。已关 4 张（有证据）：#574（5 条「怎么算做完」逐条对上，#680 #681 #716 #722 #734 #753）、#61（goals.md 附表已定「关闭由别的原因」，判断题后端已读两层，#753）、#354（ops 那句过期说明已不在）、#465（#792）。下一步：指挥官按下面「先后」派工。没验证：WSL（fleet-local）和法国真机现状我没碰（#452 有别家在做）；下面「卡在法国真机」的结论来自单上评论和 PROGRESS 记录，不是我现场查的。没动代码，只改了本文件。

**关键路径**：#452 演练三连跑通 → #632 关 → #554 关 → 写 CHANGELOG 的 Unreleased（现在是空的，`pnpm publish:pr` 见空会拒发）→ 创始人发 v3 首版（人闸：对外发布）→ 法国收到版本标记（#618、#593 真机自证）→ 法国引擎评估重开（#777 先做）→ #509 关。

### 一、v3 里程碑开着的单

| 单号 | 真剩什么 | 大小 | 卡在谁 | 建议谁来做 | 先后 |
|---|---|---|---|---|---|
| #452 | 演练仓三连跑通（别家在做，不重复盘） | M | WSL 常开（创始人）、探针探通 | 别家子代理 | 1 |
| #632 | 只剩「判据 1：没人插手连续 3 次从拉起到合并关单」，代码全合（#633–#643） | S（等） | #452 | 随 #452 关 | 跟 1 |
| #554 母单 | 只剩子单 #632 | S | #632 | 指挥官关 | 跟 1 |
| #731 | 判据 2「引擎起的探针会话探通一次」；1、3 已在机器上验过 | S（等） | #452 同一台机器 | #452 子代理顺手验 | 跟 1 |
| #786 | #816 已合；剩 fleet-local 真发一版验取代码和装依赖都走代理，并删两处临时垫片（发布用裸仓的 `[http] proxy`、fleet 家目录 `.npmrc` 的 proxy） | S | #452 子代理 | #452 子代理 | 跟 1 |
| #216 | 只剩「真 runs 数据核一遍」（写侧 #760、读侧 #728 #736 全合） | S（等） | #452 | 随 #452 核 | 跟 1 |
| #450 母单 | 子单 #452 #618 #727 #786 #803 关齐 + ops 写明（第十三节已有） | S | 子单 | 指挥官关 | 末 |
| #453 | 旧方案已被决定 0011 第 3、4 条取代，单上写着「#618 关时一起关」；唯一留下的一条已拆成 #727 | S | #618 | 指挥官随 #618 关 | 末 |
| #618 | 法国真机：打出 `v<N>` 标记后真发一次，看「停派活→等收尾→部署→恢复」（引擎关着时只写跳过）；已装到法国，当前每轮报 marker-none | S（等） | 创始人确认发版 | 创始人发、法国验 | 发版后 |
| #593 | 真机自证：发布 PR 合并后 Actions 七步走完（tag、Release、关里程碑、飞书）；代码和测试都合了（#597 #726 #839） | S（等） | 创始人确认发版 | 同上 | 发版后 |
| #323 | 只剩法国真机验第四节「发布时照期望写」；代码、文档全合（#344 #360 #747 #751 #840） | S（等） | 法国引擎关着、要发版 | 发版后法国验 | 发版后 |
| #194 母单 | 真机：拼车真用满一次；法国库撤 `pool-hold:claude-solo`（等法国引擎连上）；发布后看日志有没有「额度留量线：…按种子装进去了」；#896 另算 | S（等） | 自然事件 + 法国 | 无动作 | 发版后 |
| #59、#157、#303（未排期） | 代码都合（#291 #298 #721 #737 #846 #891），只差同一条法国真用满核对，已由 #194 承接。建议三张随 #194 一起关（指挥官定） | S | #194 | 指挥官 | 随 #194 |
| #76 | 驾驶舱已接（#837）。剩：法国放 `quota.json`（创始人的凭据）；Grok、Cursor 池在法国怎么读没定（读不到照实报） | S + 外部动作 | 创始人 | 创始人放文件 | 发版前后均可 |
| #345 | 法国装 Mirasim 服务并登录（创始人点桌面端）→ 打开 DeepSeek Flash 路由 → 补结果.md。决定 0012 第 3 条仍认「法国直接 reclaude + 无头 Mirasim cloud」。不挡 v3 主线 | S + 外部动作 | 创始人 | 创始人，后做 | 低 |
| #777 | 代码已合（#838，检查钉住两边不许相同）；剩外部动作：建公开空仓 `thoerwink8/fleet-dao-canary-fr`、法国两个 App 装上、`fleet-dao-canary` 简介改「本机演练仓」、关该仓 #26–#35。是法国引擎重开的前置 | S + 外部动作 | 创始人（GitHub 账号） | 创始人，或他授权后 AI 在他浏览器里代建（同 #452 两个 App 的先例，问他） | 引擎重开前 |
| #872 | 启动器侧已做（#873）；根子在 Mirasim 客户端没把「切平台」记进路由索引，仓里修不了，单上要求写明交给谁。建议改标题成「交给 Mirasim 方」后留着，或指挥官定关 | S | Mirasim 方 | 创始人转告 | 低 |
| #553 | 见下「#553 拆法」：PR-1、PR-2 已合；PR-4（`pnpm intents`）没开始，commander 技能说明已在引用它；PR-3、PR-5 按方案要等飞书 R1/R2 在法国跑稳 | PR-4 S/M；PR-3 L；PR-5 M | PR-3/5 卡创始人发版和删数据点头 | 本机子代理（PR-4） | PR-4 先做 |
| #820 | 一行没开工：全局中止/恢复、单任务中止/恢复、驾驶舱分看 WSL 和法国两环境；`engine_dispatch_paused` 开关代码里并不存在（发布排空走 `drain.ts`，不是它） | L | 无 | 本机子代理，先出方案分 3 片 | 2 |
| #878 #883 #884 | 仍真实存在（读了 `memory-store.ts` 现状：`listUsers`/`listBans` 直接交出内部数组、`listRuns`/`listAsks`/`listPendingAsks` 只按时间排、merged 排序拿 `updatedAt` 顶）。三张同两个文件，合成一个 PR | S | 无 | 本机子代理 | 1（审查要求 V3 前做完） |
| #901、#902 | 别家在做 | — | — | — | — |
| #509 母单 | 所有子单关 + `goals.md` §六逐条对上已删（这一条建议派一个子代理核一遍，S） | S | 上面各条 | 指挥官关 | 末 |

### 二、未排期里和 v3 有关的（不含已关的四张）

| 单号 | 真剩什么 | 大小 | 卡在谁 | 建议 | 先后 |
|---|---|---|---|---|---|
| #800 | 驾驶舱路由页和换路由选项判「池满」没算已选定未开跑的（#757 之后） | S | 无 | 本机子代理（界面活，不给 GPT） | 1 |
| #896 | 拼车登记核对不上时选路不往拼车派（#194 第二意见转合并后的那条，必做） | S/M | 无 | 本机子代理 | 1 |
| #802 | 自动发布没有版本标记时不收尾上一轮，健康页 deploy_lag 一直红 | S | 无 | 本机子代理 | 1 |
| #803 + #788 | 本机档健康页 feishu_gateway 报红、发布还去香港取 `/healthz`；`france.sh` 读回那行在本机档仍写「pilot 连不上」。同在 `deploy/`，合一个 PR | S/M | 无 | 本机子代理 | 1 |
| #761 | 对题段 runs 里永远「没记」：定记法或明写「不计」 | S/M | 无 | 本机子代理 | 2 |
| #789、#805 | 预检把「biome 起不来」报成格式没过；分支体检留言失败下一轮不重留。同在 `packages/conventions`，合一个 PR | S | 无 | 本机子代理 | 2 |
| #857 | web 三个写方法同步抛错 | S | 无 | 本机子代理 | 3 |
| #856 | 暂停/继续/叫停/换模型快捷操作和渠道开关没页面入口：先判是有意撤掉还是漏了；第 1 处会被 #820 覆盖 | S/M | #820 | 并进 #820 的方案 | 随 #820 |
| #727 | 驾驶舱前端包「本机构建一次、法国原样用」二选一写明理由：构建输入逐项钉死，或 release.yml 构建一次挂成 Release 附件两边取同一份（后者更好但要设计，构建里带的机器值要改成运行时读） | M/L | 要先设计 | 本机子代理先出方案 | 发版后 |
| #754 第二步 | 删旧平铺路由表的迁移 PR：第一步（#830）已合、表还在。删数据 | S | 创始人点头 | 创始人点头后子代理 | 等拍 |
| #336 | 巡检收掉上一轮留下的单时没关它开的 PR（`jobs/canary.ts` 的 `cleanLeftovers` 只关单） | S | 无 | 本机子代理，法国引擎重开前做 | 3 |
| #339 | 备份巡查和看门狗重复推两张卡，删巡查里 `fleet-backup.sh` 的 `watch_fresh` 那段 | S | 无 | 本机子代理 | 3 |
| #795 | 飞书意图补三块（外人说话拒收记录、外人进群提醒、接口用量上报降级） | M | 排在 R1 之后 | 本机子代理 | 发版后 |
| #766 | 「主线红/生产挂」改走群机器人 webhook（`goals.md` 要求，旧推送退役后无处落） | M | #553 PR-3 退旧之前要有 | 本机子代理 | PR-3 前 |
| #790 | 法国和 WSL 会话用户用托管设置 `deniedModels` 禁 Fable（决定 0017 到动作必经）；托管设置路径我没核，要查官方文档 | M | 无 | 本机子代理（碰钉住规矩的测试时是改标准） | 3 |
| #826 | `worker.mjs` 能起脱离会话的 Claude 工人 | M | 无 | 本机子代理（改技能说明里那句是改标准） | 3 |
| #746 | 整池暂停做成带原因、撤回条件、复查日期的库内开关 | M | 无 | 本机子代理 | 法国引擎重开前 |
| #705、#707 | 先审后合推新头自动起第二意见；`pnpm flow:stats` | M | 无 | 本机子代理 | 3 |
| #706、#353、#264、#718 | CI/本机测试偶发超时家族（#718 改的是钉住规矩的测试，改标准要创始人同意） | M | 无 | 归 #901 的 CI 臃肿审查，别重复开工 | 并入 #901 |
| #372 | 自动发布自更新（改 root 一侧的信任边界，按规矩要先讨论再别家挑错、创始人拍） | L | 创始人拍 | 暂不派 | 低 |
| #405、#292、#49、#37、#40、#48、#79、#118、#182、#282、#139、#140、#192、#232 | 旧积压，和 v3 上线无关，不动 | — | — | 不动 | — |
| #135 | `goals.md` 附表已写「关闭由别的原因」（GitLab 以后再做），但没关。我不替创始人关，列给指挥官 | S | 指挥官 | 指挥官定 | — |
| #31 #45 #91 #197 #42 | 被 #553 形态 A 取代（决定出处：`specs/553-对题/方案.md` 末节、创始人 10-04 约 08:50「选形态 A」）；方案写定 PR-3 合并时关 #91 #45 #31 #197，#42 等 R1 真断一次后端补漏验过再关 | S | #553 PR-3 | 随 PR-3 | 随 PR-3 |
| #131 #132 #133 #195 | `goals.md` 第七节唯一未定：个人用之后「项目与标准」还做不做、做多重 | — | 创始人拍 | 问创始人 | 无 |
| #34 #78 #198 | 旧系统退役：停旧飞书应用（创始人在飞书后台）、旧服务停用、数据删不删问他 | — | 创始人 | 创始人 | 无 |

### 三、#553 拆法（建议，指挥官定）

PR-1（#781）、PR-2（#787 #793 #813）已合。PR-4 现在就能做：它不依赖飞书上线，而 `agents/skills/commander/SKILL.md` 起步那一条已经在叫指挥官跑 `pnpm intents`，现在 `package.json` 里没有这个脚本。PR-3（退旧）、PR-5（删表）按方案要等 R1/R2（法国、香港跑稳）、PR-5 还要创始人看行数点头，不可能在 v3 首版前合完。建议：v3 里 #553 只收 PR-4 + R1 发布；PR-3、PR-5 拆成新单挂 v4 或明写未排期，#553 随之关。这是改版本归属，我没动，等指挥官定。本机还留着两棵半成品工作树：`agent-a43733d98aecf79c9`（分支 `chore/553-retire-feishu-drafts`，一个只在本地的 WIP 提交 b46bf851，PR-3 的一半，没推）、`agent-a96bc63c3957397dc`（#786 已合进 #816，这棵已过时）。

### 四、对「②真没做」S/M 单的实施要点（可直接派）

- **A 批 一个 PR「Store 内存版对齐库版」（#878 #883 #884）**：改 `packages/store/src/memory-store.ts`——`listPullRequests`（merged 合并时刻为空排最后、按编号倒序兜底，不拿 `updatedAt` 顶）、`listRuns`（`queuedAt` 再 id）、`listAsks`/`listPendingAsks`（`askedAt` 再 id，用 `paging.ts` 的 `byAtThenId`/`compareIds`）、`listBans`（按 id、返回副本）、`listUsers`（内存用户没有创建时刻，先加一个写入序号当创建先后，再按它和 id 排，返回副本）；`packages/store/test/store-contract.ts` 只加不改：并列时刻/并列编号、合并时刻为空且更新最新、写入先后与排序相反、改返回值不影响后续读。做完：两套实现都过新契约；故意把内存版改回原样，对应契约变红。
- **#800**：`packages/api/src/routing-layers.ts` 的 `routeView` 和 `RoutingLayerRouteSchema`（`packages/shared`）加「已选定未开跑数」，来自 `RouteCandidate.reserved`（`packages/db/src/queries/candidates.ts`）；`packages/web/src/routes/routing.tsx` 和 `components/task-actions.tsx` 按「在跑 + 已选定」之和判满，并写明几个是已选定；`api/mock/server.ts` 跟上。做完：上限 3、1 在跑 2 预占，接口给两个数，两处都显示满。
- **#896**：`packages/engine/src/real/carpool-cap.ts` 已有核对，把结果（`carpool-cap:registry` 提醒是否开着）带进 `routing/filter.ts` / `real/store-ports.ts`：核对不上（没登记、写坏、库里没拼车池、对不上）时不往带拼车组织类型的池派新活，原因写进派工理由；提醒撤掉恢复。测试各造一次失败；数值仍只在两份 desired-config，代码不留默认数。
- **#802**：`deploy/france/auto-release/lib.mjs` 一轮主流程里，`settleDangling` 现在排在 `markerStep`（读版本标记）之后，标记读不到就提前返回走不到收尾；把收尾挪到读标记之前（发布锁空且在用的不是它则记没成并报警，锁还占着照等）。`deploy/test/auto-release.test.mjs` 加：读数留一轮 `running`、发布锁空、没有任何版本标记，一轮后必须被收成 failed 并报警；只加测试不改代码时它必须红。
- **#803 + #788**：`packages/api/src/main.ts`（`feishuGateway` 只看有没通行证）改成本机档（`FLEET_FEISHU_LOGIN=off`）时报「未接」；`deploy/release.sh` 本机档不去香港取 `/healthz`，用 `deploy/lib/profile.sh` 的 `skip_local` 写明；`deploy/france.sh` 防火墙读回那行（约 1370–1380 行）本机档不提 pilot，复用 `profile_skips_user`。测试：本机档照样查网关、照样去香港取时要红，法国输出一字不变；`deploy/test/` 照 #779 给 `session-ports.test.sh` 加的六种情形写。
- **#761**：二选一由实施者定并写进 PR 正文：最省事是任务页对「对题」段显示「在对话里做的，不计」及原因（`packages/web/src/routes/tasks.$taskId.tsx`、`packages/shared/src/segment-runs.ts` 的 `readSegmentRun`）；要记数则由 `pnpm issue:new` 开单那一刻写一笔，本机读不到法国库就明说没记、不写 0。做完：该格不再永远「没记」，读不到/写不进各有失败测试。
- **#789 + #805**：`packages/conventions/src/prepare-push.ts` 判「没查成」改成看证据（biome 有没有真跑到检查、JSON 输出在不在），不靠猜 stderr 字符串；新工作树不装依赖直接 push 的复现要写进 PR 正文；退 2 含「没查成」，真格式错仍退 1。`branch-hygiene.ts` 的「提醒过没有」单独记（正文带记号，留言成功才记），测试：第一轮正文写成留言失败，第二轮必须再留。
- **#857**：`packages/web/src/api/http.ts` 的 `createDemoLink`、`updateRouteEffort`、`updateDemoDefault` 改成 async（或包进 `Promise.reject`），测试：同步抛错变成被拒的 Promise，请求体约定不变。
- **#553 PR-4（2026-10-04 拆成两片，第一片 `pnpm intents` 已做、等合；`issue:new --intent` 还没做）**：`pnpm intents [list] [--all] [--json] | show <号>` 在 `packages/conventions/src/intents.ts` + `bin/intents.ts`，经 ssh 跑 `fleet-api intent list|show --json`、按 shared 的 `IntentCli*` 认回来再打；读不到（没配 ssh 退 2，连不上/超时/法国没跑成/认不出退 1）一律打「读不到：原因」，空列表才写「0 条」；测试 `packages/conventions/test/intents.test.ts`（方案 C1–C4）。**还没验证**：没在真法国上跑过（这台没配 `france-ssh`，法国也要先发含 PR-1 的版本）；`link`/`drop` 子命令没做（`issue:new --intent` 做好时由它调 `fleet-api intent link`，`drop` 先用法国上 `fleet-api intent drop`）。**下一片**：`issue:new --intent 42[,43] [--only 42:1,3] --summary-file`（C5–C8）。原计划如下：`package.json` 加 `intents` 脚本，经 `~/.fleet-dao/france-ssh`（和 `agents/skills/commander/scripts/france.mjs` 同一条路）跑 `fleet-api intent list|show|link|drop`（后端 `packages/api/src/intent-cli.ts` 已有）；`packages/conventions/src/issue-new.ts` 加 `--intent 42[,43] [--only 42:1,3] --summary-file`：「## 原话」原样照抄、另起「## AI 归纳」、末尾带 `<!-- fleet:intent 42 -->`、开完调 `intent link` 写回，没写回成退出码 4 并打出补写命令；读不到明说不说「没有」。测试照方案 C1–C8。
- **#336**：`packages/engine/src/jobs/canary.ts` 的 `cleanLeftovers` 关单前先关这张单开过的 PR（留一句为什么），关不掉写进本轮备注、不挡本轮；测试：留下的单带开着的 PR 收完是关的；故意让关 PR 失败，本轮照常开单且备注写明。
- **#339**：删 `deploy/backup/fleet-backup.sh` 里 `watch_fresh` 中「没开跑」那段（`backup.stale:<编号>`），保留「没做成」；配一条测试或读回：备份停了只出看门狗一张卡。
- **#754 第二步**：一个只放迁移的 PR 删旧「按阶段平铺」路由表（照 #556-4 先例，drizzle-kit 生成、不手写），PR 正文列开 PR 那一刻库里行数，创始人点头才挂自动合并，且先审后合。
- 其余 M 级（#795 #766 #790 #826 #746 #705 #707 #727）要点都在各单「已知的模块」「怎么算做完」里，已经写得可直接派；#790 的托管设置文件路径、#727 的构建输入是否机器相关两处要实施者先核实。
- **CHANGELOG（没有单，S）**：发版前把 v3 要对外说的写进 `CHANGELOG.md` 的 `[Unreleased]`（白话、按 Keep a Changelog 小标题），否则 `pnpm publish:pr` 拒发。

### 五、创始人本人要做的外部动作

1. WSL 常开（#452）：WSL 闲着几分钟会整台自停，引擎、Temporal 跟着停。改 Windows 头：在 `%UserProfile%\.wslconfig` 的 `[wsl2]` 里调闲置时限（参考 `deploy/local/wslconfig.example`，改完 `wsl --shutdown`），或开机起一个一直不退的 `wsl -d fleet-local`（docs/ops.md 第十三节）。具体键值我没在这台上试过。
2. 发 v3 首版（人闸：对外发布，#593 #618 #323 一起在这次验）：#452 过了、CHANGELOG 写好之后，在 `release/v3` 分支跑 `pnpm publish:pr`（或驾驶舱「更新日志」页的发布按钮，只给命令不替你发）；合并发布 PR 后 `release.yml` 自动收尾。
3. 飞书开发者后台三步（#553 PR-2 上线前，不做这版上了也不生效）：开 `im.message.group_msg`、`im:message:readonly` 权限，订阅 `im.message.recalled_v1`，「创建版本并发布」。这一版是对外发布，跟 v3 同一次确认。
4. #777：GitHub 新建公开空仓 `thoerwink8/fleet-dao-canary-fr`、法国两个 App 装上去、`fleet-dao-canary` 简介改「本机演练仓」、关该仓 #26–#35（`gh issue close -R thoerwink8/fleet-dao-canary <号>`）；或授权 AI 在你的浏览器里代建（同上次两个 App）。
5. #76：往法国放额度配置文件 `quota.json`（位置和格式见 docs/ops.md 第九节，要你的 reclaude Key；ssh contabo，root）。
6. #345（可后做）：Mirasim 桌面端新建 SSH 远程连接，目标 `fleet-agent-carpool@<法国地址>`（地址用 `ssh -G contabo` 取，别贴进对话），key 或 agent 认证，点连接；验证 `bash deploy/france.sh --check`。
7. 要你拍板的（不是外部动作）：#754 删旧路由表（删数据）；#553 PR-5 删飞书四张表（看行数）；#131–#133/#195 个人用还做不做；法国引擎重开（临时调整表第一行，最迟复查 2026-10-15）；#553 拆法（上面第三节）。#34/#78 旧系统退役也在你手上。

## 2026-10-05 #452 本机演练（fleet-local）跑通（Sonnet 5.5 子代理，创始人 10-05 01:30「wsl需要跑通」）

**结果（10-05 02:47）：演练仓全流程在 fleet-local 跑通一次，`drill` 打印「全流程巡检第 36 轮：通过（巡检单 #40）」**：开单 01:59:39（2 秒）→ 收单 02:03:51（4 分 12 秒）→ 动手（Grok 写码）→ 开 PR #41、CI、冷验收（换 Claude 验）、合并、关单、记账 02:18:16（动手到合并共 14 分 25 秒，其中建工作树抓主线被直连断开重试了几次）→ 驾驶舱显示 02:46:48（28 分 31 秒，原因见下 PR #922）；一共 47 分 11 秒；巡检备注「收掉了上一轮留下的 #38」。canary 仓 PR #39（上一轮卡在验收、发「继续」后验收、CI、合并走完）、#41 都是 MERGED。证据：fleet-local 上 `/root/drill2.log`、库里 `canary_runs` 第 36 行（verdict pass）。**没验证**：drill 进程的退出码——我包命令时 `$?` 被 PowerShell 展开成了 `True`，没有拿到真数字，只能凭输出「通过」（`packages/engine/src/bin/drill.ts` 通过时退出 0）；要硬证据再跑一次 `node packages/engine/src/bin/drill.ts; echo $?`（一轮约 47 分钟，主要花在每 5 分钟的拉单、巡检每 2 分钟看一次）。
做到哪、下一步：`deploy_lag` 绿要 `install.sh` 把新的自动发布脚本装到 `/usr/local/lib/fleet-dao/auto-release/`（#903 只改了仓里）并等它跑下一轮收尾（02:47 已重装，结果见 #452 评论）；拼车恢复后把会话用户切回拼车；`.wslconfig` 空闲超时（这台没有这份文件，本次用 `wsl -d fleet-local --exec sleep infinity` 在 Windows 侧留一个进程吊住，Windows 重启后要重跑）。
**演练挖出的四个真缺口（都已修、已合）**：① #903（#802）自动发布收尾排在读版本标记之后，没有标记的机器永远不收尾；② #907（#803）本机档健康页 `feishu_gateway` 一直等不会来的网关、发布还去香港取 `/healthz`；③ #912 引擎自己的 git（建工作树抓主线）和 `reclaude org list` 没走本机档登记的代理，直连 github.com 断连时建工作树 145 秒连不上、Claude 池整轮不探（#786 同一个根）；④ #922 巡检「驾驶舱显示」要 PR 编号，只从任务工作流的查询里拿，任务做得快、工作流已经不在跑就永远拿不到、到 30 分钟期限才断。
- 已做（机器上）：① `/srv/fleet-dao` 快进到主线、`bash deploy/release.sh` 第一次停在目录装载（`/etc/fleet-dao/catalog.json` 里还有旧的 `stages`，装载器不再读它并拒装）→ 备份到 `/root/catalog.json.bak-20261005` 后删掉 `stages` 段（权限 root:fleet 640 没变）→ 第二次发成，在用 `f07ddb035320`，迁移 31 → 35；② `deploy/local/install.sh` 重跑（`fleet-agent-scope` 等带上 #816 的代理）；③ `users` 表补创始人一行（`thoerwink8` / 211872110，`github_events` 转绿）；④ `fleet-agent-scope org-use solo --user fleet-agent-carpool`（WSL 里的会话用户，不是本机主会话）：拼车组织（org 324）现在 `reclaude -p` 回 `400 当前绑定账号暂不可用，系统将自动处理`，引擎按 AU1 记「账号被封」不派，solo 组织（org 5380）`-p` 回 OK、`claude-solo:opus-5.5` 探通；⑤ 手动 `fleet-temporal schedule trigger route-probe` 让探针立刻重探，向卡住的任务发 `taskContinue`。
- 为什么要两家：验收必须换一家模型，grok 动手后只剩 claude 能验；Cursor 密钥没放、Mirasim 没装，都要创始人。
- 机器上现在在用 `e0ede51949c2`（含 #903 #912 #922，#907 的 feishu_gateway 也不再红）；`/etc/fleet-dao/catalog.json` 里 `claude-carpool.maxConcurrency` 4 → 2（备份 `/root/catalog.json.bak2-20261005`）对上本机档登记的拼车并发 2。
- 机器上还剩的小红：`quota.json` 没有（reclaude API Key 本机 09-29 清盘后不在，拼车盯读读不到，`session_org` 项因此红，不挡演练）；`canary` 项的老红随这一轮通过会自己转绿。
- 要创始人做（外部动作）：① 拼车组织账号恢复前会话用户留在独享；恢复后在 fleet-local 里 `sudo /usr/local/sbin/fleet-agent-scope org-use carpool --user fleet-agent-carpool` 切回（或告诉我）。② 想让 WSL 不靠常驻进程也不停：`%UserProfile%\.wslconfig` 按本档「WSL 不让它睡」那节改（他自己的 Windows，我没碰）。③ 要用 Cursor 路由：在 cursor.com/dashboard/api 生成密钥，按 ops 第五节「会话用户的 Cursor 密钥」放进去。

## 2026-10-04 已开着的会话切不到平台额度（只记进度）

会话 `claude:1aedaaec-91ac-4245-a8d5-13d628b767b2`，本机 Mirasim `0.0.411`。做到哪：链查完，这条会话的钉没写上。下一步：没有新的启动器改动（当场切不到平台、又不杀会话，主线已有 #873）。还没验证：真扣费。Mirasim 会自己更新，下面的界面和注入只对 `0.0.411` 这一次成立。

- 写方：桌面点选发 `setSessionRoute`。正好是 `cloud` 或 `local` 才写入；`null`（跟随全局）会删掉这条钉。已开着的会话发消息不带 `route`。界面用「本会话的钉，没有就用全局档」画高亮。全局 `failover.enabled=true` 时，没钉住也显示平台。
- 存放处：`~/.mirasim/plugin-index/QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg.json` 的 `routes`。2026-10-04 21:36 没有这条键（当时 445 条 `cloud`、34 条 `local`；同日复查 447 / 34，键仍没有）。同一模型的 `claude:a79e3d2d-c99b-4484-bf11-7df25e0c9949` 是 `cloud`。
- 读方：没有键就是 `default`。这条会话 19:57 到 21:36 共 8 次全是 `event=launch route=default generation=1`，没有 `event=switch`、没有 `event=reject`。正在用的设置文件没有 `env`。对照那条钉了 `cloud` 的，拉起时设置里有回环地址和令牌，日志是 `route=cloud`。
- 断点：21:02:51 到 21:03:19 有 4 次 `setSessionRoute`，诊断不记 route 的值，之后索引里仍然没有这条键，所以最后一次生效的不是 `cloud` 也不是 `local`。没钉住的 Claude 不注入网关。启动器没有丢掉一份已经给过的网关。
- e2e（另起 `claude:8ab4102d-ef34-4f23-ab97-23a978c574c6`，临时目录，没碰上面那条，没切号）：不钉时 `route=default`、回复 PING、没有平台账本；钉 `local` 后新进程 `route=local`、回复 LOCAL、设置无网关；钉 `cloud` 后新进程 `route=cloud`、设置有回环和令牌、账本 `viaRelay=true`、主机 `relay.mirasim.ai`、状态 200、回复 CLOUD。四次都是 `generation=1`。再钉回 `local` 时进程是 `route=local`，回复是空的（脚本紧接着 stop）。
- 启动器不读、不锁 Mirasim 的版本，只认索引里的 `local` / `cloud`，以及 `--settings` 里的回环地址和令牌（形状自 `0.0.354`）。下一版改了点选是否写钉、没钉住注不注入、令牌还在不在 `--settings`，这条结论就作废。明确的 `cloud` 若不再带令牌，启动器会拒绝，不会退回自有。各台机器的 Mirasim 版本可以不同，同步启动器不会把界面行为拉齐。
- 主线 #873（`671158af`）已合：自有起的进程当场切平台、活着的参数里没有网关时，退回这条消息并明说办法（`event=refuse-switch`），不杀会话。这次 e2e 没走到那条，因为钉上 `cloud` 之后 Mirasim 重开了进程，新进程的设置里带了网关。创始人 2026-10-04 22:30：「mirasim版本随时更新的，你考虑到了吗」。

## 2026-10-05 #901 母单：CI 与测试耗时那一条腿（Sonnet 5.5 子代理，别家在做代码/文档臃肿审查）

创始人 2026-10-05：「项目臃肿+ci流程慢，需要优化重构各个模块和流程」。做到哪：量完、做完能做的，全部在 `specs/901-项目瘦身与提速/CI耗时实测.md`。已合：#905（耗时表刷新 + `ci:timings` 取几轮中位数，全量 PR 最慢测试台中位 87→75 秒，噪声大）。量过没接：并行进程数、台内排序（#906 实验，已关）、Temporal 测试服务端下载（1 秒）、主线 lint 复用（不到门槛）、台数 8→10（和排队反着来）。开了 #921（耗时表自动保鲜，挂 #901）。还欠创始人定：多个会话同时开 PR 时慢的是免费档 20 个并发槽排队和主线复用被「合并前主线又动过」打掉（实测表第 6 条），合并队列、升套餐、再压 job 数三选一，没挑之前不动。还没验证：下一个全量 PR 轮的真实数字（补进实测表第 1 条「后」那一列）。

## 2026-10-05 #194 方案 4.3「切完当场叫醒等路由的活」（Sonnet 5.5 子代理，分支 `feat/194-wake-routes`）

做到哪：代码、测试写完（见下），PR 待开；下一步：开 PR（`Refs #194`）、挂自动合并、盯 CI。还没验证：法国真 Temporal 上的叫醒（测试服务端没有高级可见性、列在跑的工作流那一步只在假客户端上测；`workflow.list` 本身引擎拉单已在用）。
- 做法：任务工作流新加信号 `taskRouteWake`（`task-contract.ts`）；选路排队和验收等空位改用 `pauseForRoute`（`workflows/task-runtime.ts`，问选路之前取记号，问的那一刻到的叫醒不丢，叫醒后选不到回去再等、不空转）；发信一侧 `real/route-wake.ts`（切号两条路各接一次：当场切号 `probeNow` 之后、探针那一轮 `after` 核对之后）；收信人不在略过，收信失败、列不出在跑的工作流报警 `route-wake:signal`、全部成功再撤；2 分钟上限留作兜底。方案-v2 第十一节那一行、`docs/design.md` 切号那段已改成「做了」。
- 测试：`test/task-route-wake.test.ts`（Temporal 测试服务端）、`test/real/route-wake.test.ts`。

## 2026-10-05 #194 方案 4.7「拼车并发总上限登记 + 配置检查 + 对账显示」+「上线前要核」（Sonnet 5.5 子代理，分支 `feat/194-concurrency-cap`，`Refs #194`，先审后合：碰了 `deploy/france/desired-config.json`）

做到哪：代码、测试、文档都写完并推了，PR 待开（开出来后补 PR 号、第二意见）；下一步：开 PR、走 `discuss` 的「审 PR」、过了挂自动合并、盯 CI。还没验证：法国、本机真机上发布后 `engine.env` 里真的带上两项、引擎起来核的结果（法国引擎关着，复查 10-15）；驾驶舱额度页的对账在真库、真读数上的样子（只在内存库测试里验过）。
- 登记（done）：`deploy/france/desired-config.json`、`deploy/local/desired-config.json` 的 `engine.env` 各加 `FLEET_CARPOOL_MAX_CONCURRENCY`（法国 4、本机档 2）、`FLEET_CARPOOL_TOTAL_CAP`（6，两边逐字一样）；数值只在这两份里，代码没有默认数（创始人说留量线不许写死，这里同一个做法）。已定默认：总上限 6、法国 4、WSL 演练台 2、创始人本机固定独享不登记。
- 配置检查（done）：`deploy/france/auto-release/config.mjs` 的 `carpoolCapProblems`（每台公开正整数、总上限一致、加起来不超）、`unregisteredDesiredFiles`（`deploy/*/desired-config.json` 没登记进 `PROFILE_DESIRED` 就红），都由 `diff-local` 调；测试 `deploy/test/config.test.mjs`。
- 引擎起来核（done）：`packages/engine/src/real/carpool-cap.ts`，`registerJobs` 里调；对不上、没登记、写坏了、库里没有拼车池推 `carpool-cap:registry`，对上了撤；测试 `test/real/carpool-cap.test.ts`。
- 对账显示（done）：`db/src/queries/carpool-spend.ts`、`api/src/carpool-reconcile-view.ts`、`shared` 的 `CarpoolReconcileViewSchema`（`PoolsResponse.carpoolReconcile`）、`web/src/components/carpool-reconcile.tsx`（额度页切号现状下面）；只显示、不报警。「差得多」的线是显示用的经验值（差额至少 $2 且至少占接口已用的 25%，`RECONCILE_MIN_GAP_*`），只决定那一句话怎么写，不触发动作；没记到花费的会话按本窗已记会话的平均估，没有已记会话可估就写「说不准」，不往别的设备上猜。
- 上线前要核（done）：① 盯读账本认不出原来只记「没跑成」、不推 `session-org:ledger`（只有切号那条路推）——已补（`real/carpool-watch.ts`），测试 `test/real/carpool-watch-ledger.test.ts`（账本认不出推提醒、修好撤；库读不了照常抛、不冒充账本认不出）；② 额度配置 `/etc/fleet-dao/quota.json` 是手放的文件、不在期望里（`desired-config` 只管三份环境文件和 `france.env`），所以没法把 `reclaude-carpool` 池补进去；缺它时盯读当场推 `carpool-api`（`test/real/carpool-api.test.ts` 钉着），ops 第九节写明；③ ops 第五节登录步骤补了「设备名额 4 台已满」一句。
- 方案-v2 第十一节 4.7 行、11.4 已改成「做了」；第 19 条写「部分」：核对不上时选路不往拼车派没做（第二意见第 3 轮转合并后处理），开了未排期单 #896。第二意见：GPT 系（gpt-6-luna）审了 3 轮（第 1 轮 `staleSince` 旧读数不对账、第 2 轮多拼车池读数混算，都已改；第 3 轮过，1 条转合并后即 #896）。PR #894 已合。

## 2026-10-05 CI 第三轮（创始人 10-04 夜「按照你推荐去做，自我验证，持续优化到最佳」，Sonnet 5.5 子代理）

- 做到哪、数字、怎么量：`docs/ci-speedup-plan.md`「第三轮」。第一块（#876，已合）：合并闸只在改了已有 ci.yml 时装 YAML 依赖 + debt 推主线只留看文件那一半 + `pnpm ci:stats` 量法。第三块（#885）：release 对普通 PR 不起机器 + lint 并行三样记秒数 + 量测结论（「第三轮结果」，停的依据在那里）；第二块（#881，已合，真主线验证过）：主线同树复用，方案在 PR 说明和 ci-speedup-plan 的 D 第 6 点；会改 ci.yml，要走第二意见，合并后要看第一批主线轮次的 `main-reuse` 输出（声明上线前跑的 PR 检查没有声明，会 warning 后全跑，是预期）。量几条（tsc 增量缓存、分片结果缓存主线写 PR 读、固定开销、CLEAN 到 MERGED 的滞后、第二意见自动触发）的结论并进对应 PR 的文档，不单开 PR。还没验证：合并闸改后的真实数字（合并后才生效）。

## 2026-10-04 夜（#865 纠正分层：引擎不再依赖 api，Sonnet 5.5 子代理，三个 PR：#868、#874、最后一块）

- 方案 `specs/865-分层纠正/方案.md`（新包 `@fleet-dao/store`；`PublicHealthError` 和抛它的函数留在 api，`auth.ts`、`health.ts` 不碰）。
- 第 1 步（类型、日志、ids、白名单搬进 store，引擎的白名单和 `User` 改引 store）：#868 已合。第 2 步（两套 Store、契约测试、`testing` 夹具搬进 store；`probeDb` 留 api 的 `db-probe.ts`）：#874 已合。第 3、4 步按创始人 21:34 的开 PR 规矩并成一个 PR（「engine 不再依赖 api」是一整块行为）：进门判法（`github-intake.ts`）、对账、告警现算、线上落后判断搬进 store，`deployLagCheck` 留 api 的 `deploy-lag-check.ts`，引擎全部改引 store 并去掉对 api 的依赖，`high-risk-paths.json` 给搬走的进门判法和白名单补了条目（碰安全，走第二意见）。分层钉子 `packages/conventions/test/package-layers.test.ts` 在这个 PR 里变成零违例。

## 2026-10-04 夜 交接（创始人让结束当前会话、新开会话接着干）

- 无人值守已关。新会话要接着干就让创始人说「进入无人值守」。
- 四个 Sonnet 5.5 代理都被会话重启停掉，现场在各自工作树（先看 git log 和未提交改动再续，SendMessage 续或新开都行）：
  - #553 `chore/553-retire-feishu-drafts`（工作树 agent-a43733d98aecf79c9，未提交 14 个文件、领先 1 提交）：清旧飞书草稿代码；之后另开删旧飞书表的迁移 PR（创始人 08:50 授权，须第二意见）。
  - #194 拼车自动切独享：#845（切片 1）已 CLEAN 待合；#846（切片 2）冲突（DIRTY）要并主线；工作树 agent-a56f81d4090d16f23 分支 `feat/194-pool-reserve`。
  - #786 `fix/786-engine-git-proxy`（工作树 agent-a96bc63c3957397dc，未提交 6 个文件）：本机档发布取代码、装依赖走登记的代理。
  - #820 `feat/820-env-views-abort-resume`（工作树 agent-a8a1e976f84600a39，还没改动）：先写方案 specs/820-*/方案.md 再分切片。
- 等创始人拍：#452 本机演练（fleet-local 里 root 发一版并让 WSL 常开；推荐选 1）、#754 删表迁移、#777 的 GitHub 仓和 App。
- 插话补回（#842、#844）已于 2026-10-04 夜去掉（创始人选「只去掉补回」，PR #870）：`steer-recover.mjs` 删了，新会话开场不再从 Mirasim 记录补插话；消息一到就落盘的钩子（#823）和开场列最近 60 分钟落盘的话（#831、#833）留着。

## 2026-10-05 子代理工作树落后 origin/main（#888 已合）

做到哪：#888 已合、本机已装；用真钩子验过——代理和远端都通时放行（1.7 秒）、远端取不到时 `isolation: worktree` 的子代理被拦（退出码 2）。旁证：之后起的子代理工作树基线都是当时最新的主线（833492b、5c839ad），不再是隔夜的。下一步：无；#895 把真进程测试的超时放宽到 30 秒（Windows 上起钩子加跑 git 要 5 秒多）。

## 2026-10-05 #194 剩下的活拆成四路并行（Sonnet 5.5 子代理，各自工作树，都 `Refs #194` 不写 Closes）

做到哪：四路全部合并——#891（叫醒等路由的活）、#892（读频率与烧速预估）、#893（留量线，线只存在库里、种子只补缺装进库、驾驶舱可配、代码里无 0.8/0.7）、#894（并发总上限登记、配置检查、引擎起来核、驾驶舱对账显示；碰法国配置，第二意见第 2 轮挑了 1 条、改后第 3 轮过）。还没验证：法国发布后看日志有没有「额度留量线：…按种子装进去了」；真机验证要拼车真用满一次；法国库里撤 `pool-hold:claude-solo` 等法国引擎能连上；`7d_model` 没给种子线、「来自种子/改过」只标整项；`quota-read` 和 `carpool-watch` 没合并（拼车池每 15 分钟多读 2 个不花额度的 GET）。本机另有 `pre-push.test.ts` 等十来个测试文件红，看起来是 Windows 上 git 和钩子的环境问题（`user-git.ts` 以会话用户跑 git 只在 Linux 成立），CI 的 Linux 上绿；没逐个确认。

| 片 | 分支 | 碰哪 | 默认值（已定） |
|---|---|---|---|
| 4.8 各渠道留量线 | `feat/194-reserve-line` | routing/filter、org-switch、db 查询、shared 配置类型、设置页 | 默认值放种子数据 `quota-reserve.default.json`（独享 5 小时窗 80%、周窗 70%；拼车、别家不设），装载器只补缺，**代码里不留数值**；驾驶舱每池每窗口可改、可清成不限（创始人 00:50 改的口径） |
| 4.7 拼车并发总上限登记 + 对账显示 + 上线前要核 | `feat/194-concurrency-cap` | deploy 两份 desired-config（法国那份先审后合）、pool-runs、驾驶舱 | 总上限 6，法国 4、本机 WSL 演练台 2 |
| 4.1 读额度频率随情况变 + 退避 + 烧速预估 + 上限变了记一笔 | `feat/194-read-cadence` | carpool-watch、quota-read、驾驶舱额度页 | 平时 5 分钟、紧要 1 分钟；退避 1→2→5 分钟 |
| 4.3 切完当场叫醒等路由的活 | `feat/194-wake-routes` | store-ports、选路等待、工作流信号 | 2 分钟上限留作兜底 |

仍不做：4.7 之外的真机验证要拼车真用满一次；`pool-hold:claude-solo` 在法国库里的撤销要等法国引擎能连上（仓里的旧决定早已标替代）。

## 2026-10-05 子代理工作树落后 origin/main（根子，已处理）

- 根子：子代理（`Agent` 的 `isolation: "worktree"`）的工作树从**本地记着的** `origin/main` 切，建树那一刻不去取远端；取不到时它就停在隔夜的提交上。别家模型工人那条路（`worker.mjs`）建树前本来就 `git fetch origin main`，没这个问题。
- 本机出网：Claude Code、reclaude、Mirasim 经 `HTTP(S)_PROXY=http://127.0.0.1:59822`（听的进程是 `reclaude.exe`，那是它们正经的路）。**不改、不删这个代理**。2026-10-05 在真机（PowerShell）实测：经 59822 `curl https://github.com` 回 200，`git fetch` 带代理 / 不带都通。开会话那次「没查成」的报错是 `over proxy 127.0.0.1 after 0 ms`——连接被拒，是会话刚起来时 reclaude 的口还没在听，不是代理坏了。**教训：网络结论只在 PowerShell 里验，Bash 工具的沙箱网络和真机不是一个网络**（我先用沙箱判成「59822 是死的」，判错了）。
- 做法（`agents/hooks/fresh-main.mjs`）：取远端先照环境原样（走 59822），没成且环境里设着代理，再去掉代理直连取一次；两次的原因都带回去，绝不把没取成说成成功。开会话钩子的 `checkHere` 改用它；调工具前钩子对 `Agent`/`Task` 先 `git fetch origin main`，要建工作树（`isolation: "worktree"`）又两条路都取不到才拦下（说清 origin/main 停在多久以前），不建工作树的不拦。
- 没做：`EnterWorktree`（主会话自己进工作树）不在调工具前钩子的匹配里，要挂得改 `packages/agents-sync/src/targets.ts`（改标准，等创始人点头）；它从开会话那次 fetch 的 origin/main 切，开会话钩子现在两条路都取。`worker.mjs` 的 `stripProxy` 只走直连，这台直连现在通，先不动。

## 2026-10-04 晚（#194 拼车自动切独享，按 `specs/194-拼车自动切换/方案-v2.md` 选项 A 切片，子代理）

- **读额度的频率那一片**（分支 `feat/194-read-cadence`，Refs #194，2026-10-05，子代理 Sonnet 5.5）：4.1 剩下的都做了——退避期（读失败 1 → 2 → 5 分钟）里谁都不砸接口（定时盯读、被拒当场判、切号前后读都看 `readBackoff`），读不到照现有规矩按「读不到」办；每条读数入账时记操作记录：拼车上限变了写「拼车上限从 80 变成 X」（`session-org.limit`，仓里本来就没有写死的 80）、429/5xx/网断进退避前三档各记一笔和退避结束（`session-org.read-backoff`）；判成要切时先现读一次（几秒内刚读过不重读）再重判、切完再现读一次；烧速预估 `shared/src/carpool-burn.ts`（最近 15 分钟，读数少于 2 个、间隔不到 2 分钟、花费为负、最近一次读数太旧、金额认不出一律「还算不出」，不显示 0）：驾驶舱额度页顶上写「按现在的速度约 N 分钟后用满」，引擎也据此在预计 20 分钟内用满时提到 1 分钟读；阈值集中在 `DEFAULT_WATCH_POLICY` / `DEFAULT_BURN_POLICY` 并写明出处（创始人 10-04「留量线不许写死、驾驶舱要能配」：这片只把读频率的数集中成具名常量，驾驶舱可配沿用设置键另起，没做）。**没做**：`quota-read`（15 分钟，写额度表）和 `carpool-watch`（5/1 分钟，写切号账本）没合并，拼车池每 15 分钟多读 2 个 GET，不花额度；读频率阈值驾驶舱可配。**还没验证**：法国真机上 429/5xx 的回包形状（`http` / `throttled` 两类按读取器现有分法记）。

- 片 1「拼车用不了是哪一种、恢复凭什么认」：`packages/engine/src/jobs/carpool-outage.ts` 纯判法 + `test/carpool-outage.test.ts`（被拒分 E1/E2/E3/设备级/限流；E1 连着两次真新读数过切回线 50%、E2 恢复时刻之后的新读数、E3 接口说组织能用；缓存、旧读数、读不成、金额认不出、status 非 active 各造一次失败）。**还没接线**，切号照旧。PR #845（已合）。
- 片 2「切号防来回抖」：`packages/engine/src/jobs/org-switch-guard.ts` 纯判法 + 测试（`decideSwitchBack`：最小停留 20 分钟、E1 读数确认的不受限；白切退避 15→30→60→120→240 分钟、试探撞的从 30 起；连着 3 次白切、5 小时里第 4 次自动切回都转「要人看」；接口读不到时预计恢复时刻过了 15 分钟才试探切回；过预计恢复时刻 30 分钟还在独享另报一条；帮手切号失败按 2/10/30 分钟退避）。已接线（见下一条）。
- 片 3 起「接线 + 账号关 + 驾驶舱」（同一个 PR，#846，分支 `feat/194-switch-guard`，2026-10-04 夜；方案对照表在 `specs/194-拼车自动切换/方案-v2.md` 第十一节）：账本和单飞锁（迁移 0034 `session_org_state`）、总判法 `jobs/org-decision.ts`、账号状态关 `jobs/org-accounts.ts`（创始人 22:30：账号数不固定、切前逐个查、可用 ≤1 不切、0 个渠道不可用）、reclaude 接口原样读数（带 Date/Age、每个组织一个账号）、定时任务 `carpool-watch`（每分钟）、被拒当场交证据、切完当场探、切回宽限 10 分钟、拼车池不按「够收尾」挡、选路等待 10→2 分钟、驾驶舱额度页顶上切号现状、设置页「引擎暂不用独享」。**没做**：4.8 各渠道留量线（要创始人定默认值）、4.7 拼车并发总上限登记和对账、撤 `pool-hold:claude-solo`（要创始人确认一句）、「叫醒」用信号（折中成等待 2 分钟）。**上线前要核**：迁移 0034 上线后引擎第一轮 `carpool-watch` 起不来 / 账本认不出会推 `session-org:ledger`；法国额度配置里要有 `reclaude-carpool` 池（切号读接口用同一把 Key）。

## 2026-10-04（#777 法国巡检仓和本机演练仓分开，Opus 子代理，PR #838，先审后合）

- **仓里做完的**：`deploy/france/desired-config.json` 的 `engine.env` `FLEET_CANARY_REPO` 从私有值（指纹，据 #777 就是演练仓 `fleet-dao-canary`）改成公开值 `thoerwink8/fleet-dao-canary-fr`；`config.mjs` 的 `diffProfiles` 加 `MUST_DIFFER`：两边这一项必须是非空公开值且不一样（不分大小写），一样、写成私有值、空着、两边都删了都判红（`deploy/test/config.test.mjs` 每种各造一次，外加拿两份真文件把本机档改成法国的值必须红）；`docs/ops.md` 第五节、第九节、第十三节跟着改。
- **还欠（要创始人做，外部动作）**：GitHub 上建公开空仓 `thoerwink8/fleet-dao-canary-fr`（名字不同就改期望里那一项）、装法国两个 App、照 ops 第五节「全流程巡检」配齐（纳管、接活开关、`v1 巡检` 里程碑、CI、允许自动合并）；`fleet-dao-canary` 简介改成「本机演练仓」；那边 #26–#35 旧巡检单关掉。合进主线后法国下一次发布会把新仓名写进 `engine.env`（引擎关着，没人读）；法国引擎重开（临时调整表第一行撤回）前先核这几样做完、#777 关了。

- 片「4.8 每个渠道的额度留量线」（分支 `feat/194-reserve-line`，2026-10-05，Sonnet 子代理，Refs #194）：设置键 `engine.quotaReserve`＝`{池编号: {窗口: 比例|null}}`（池就是额度页上的「渠道」一行，沿用 `quota_windows` 的窗口名 5h / 7d / 7d_model…）。**线不写死在代码里**（创始人 2026-10-05 约 00:50：「独享留量线 5 小时窗 80%、周窗 70%，这个不应该写死，应该是驾驶舱可以配置的」，替代了此片早先「代码常量默认值 + 设置覆盖」的做法）：线只存在库里，起始值是种子 `packages/db/quota-reserve.default.json`（独享池 5h 0.8、7d 0.7），由 `bin/routing.ts`（发布时 `load_routing`）调的 `quota-reserve-apply.ts` 只补缺装进库，已有的一个字不动；库里这个池没写＝不限（设置页写「未配置」），库里没有这一行 / 值认不出＝明确失败（选路硬挡、切号不切、推 `session-org:reserve`）。判法在 `packages/shared/src/quota-reserve.ts`（选路、切号、驾驶舱读同一份）。已接：选路 `routing/filter.ts` 的 `reserveBlocks`、切独享 `jobs/org-decision.ts`（到线、读不到 / 认不出不切并进操作记录；读数缺窗口按额度未知仍切）、`store-ports.ts` 读设置交给选路（只加了读设置那几行，没碰等路由那段）、`real/org-plan.ts`、`GET /api/pools` 的 `orgSwitch.soloReserve`（额度页顶上「独享到留量线，活等拼车恢复」）、设置页「各渠道的额度留量线」（每个池每个窗口一行、整项写来自种子还是改过、可清成「不限」）；`shared/test/quota-reserve.test.ts` 有一条扫源码的检查，代码里出现那组默认数值或 `DEFAULT_RESERVE_LINES` 就红。**还没验证**：engine 的 Temporal 全量测试交 CI；法国发布后装载器真装进库（看发布日志「额度留量线：…按种子装进去了」）；真机独享读数是否带 `7d_model` 窗口（种子没给它写线）。**没做**：来源标记只在整项上、没有逐窗口；4.7 并发总上限登记、读频率和烧速、叫醒等路由的活由别的子代理做。

## 2026-10-04 晚（无人值守队列，创始人 20:50「按优先级做完」）

先后按 `pnpm plan`（v3 先后清单）。今晚已合：#823 消息落盘、#829/#832 引导钩子（旧钩子发现并换新）、#830 #754 第一步（只摘触发器，不删表）、#831/#833 开会话列最近的话、#834 起后台活自动开无人值守。清单修了一处：#786 是 #450 的子单不能排在这层，已摘（连同已关的 #769、#807）。

在做（子代理 Opus，各自工作树）：#593 发布 PR 触发 Actions 收尾；#777 法国巡检仓换成不同于演练仓的另一个；#76 定时读额度入库（先查现状）。

卡着等创始人：① #452 本机演练要在 fleet-local 里以 root 发一版并让 WSL 一直开着——安全检查拦过一次，没绕开，等他点头（选 1 两个动作都做、选 2 只发布）；② #754 删表迁移（删数据）；③ WSL 的 .wslconfig（他自己的 Windows 那头）。

排队：#194 拼车自动切独享（方案 v2 他已答完，工作量大）、#323 配置进仓对账、#574 #216 #345 剩的、#820 驾驶舱补环境视图。

## 2026-10-04 晚（#323 配置进仓对账：查现状 + 补本机档报警指错文件，Opus 子代理）

- **现状查清**：单上「怎么算做完」代码那几条都已合——三条故意造出失败的测试和每轮对账报警（#344）、私有值指纹进期望并在法国真机验过手改报警 / 改回自撤（#360，09-27）、运维文档与 AGENTS 本仓段（#344 起，「改期望、等发布」#747）、发布时照期望写 + france.sh 照期望建新机器、删三份样例（#747）、两处引擎注释改指期望（#751）；「开关进仓」按 0011 第 7 条作废（整池暂停正式开关另开 #746 未排期），路由声明进仓归 #574。
- **#840（分支 `fix/323-local-drift-alert-paths`，先审后合）**：本机档（fleet-local）对账报警里「私有值对不上」「多了一项」两种还写死让人改法国那份期望、标题都写「法国配置」，`check` 命令也报成法国那份；改成跟着 `desiredPath` 走（本机档就指 `deploy/local/desired-config.json`、标题写「本机档配置」），配一条故意造出失败的测试（五种报警全出、一处都不许提法国那份）。
- **还欠（要真机，不在本机做）**：法国真机验一轮第四节「发布时照期望写」（法国引擎关着，复查 10-15）；fleet-local 的 `api.env` 补 `FLEET_FEISHU_LOGIN=off` 要人在那台上补一次（#747 记的，这次没上那台核）。这两件做完 #323 可以关。

## 2026-10-04 晚（#593 发布收尾改成可测的代码，Opus 子代理）

- **#839（分支 `fix/593-release-finalize-ts`）**：`release.yml` 里打 tag、建 Release、推飞书那两百行 Bash 搬进 `packages/conventions/src/release-finalize.ts`（七步按死顺序、每步先查 GitHub 现状、做过的跳过、红了后面都不走、七步状态写进 Actions 运行摘要），判定进 `publish-release-logic.ts`（`decideTag`、`decideRelease`、`feishuReplyOk`）；CHANGELOG 改按本次合并的提交读、挪到打 tag 之前。测试钉住「打 tag 已存在 → 跳、其余照走」「建 Release 失败 → 不关里程碑、不推飞书」等。`publish:pr` CLI、`classifyPullRequestClosed`、里程碑核对 #597/#726 早已做完、本次没动。
- **还没验证**：真机自证（第一版「发布 vN」PR 合并 → Actions 走完七步），要创始人拍发第一版；#593 因此不关。驾驶舱「发布 vN」按钮（界面）、法国那一截（#453）不在这张。

## 2026-10-04 晚（#76 定时读额度收尾，Opus 子代理）

- **现状查清**：引擎那一半早已合（#677 `quota-read` 每 15 分钟读、读成按池入库、连着两轮没读成或凭据/配置类当场报；#678 每小时对账第三处 `checkQuotaFreshness`；#679 估算类池接用量记录），测试齐。**缺的是驾驶舱**：`api/src/main.ts` 还挂着 `notWired.quota`，额度页在生产上整块是「待实现 · #76」，拼车 5 小时美元窗口根本看不到。
- **#837（分支 `feat/76-quota-dashboard-wired`）**：去掉额度的「待实现」占位（连同只为它留的 `Deps.notWired`、`PoolsResponse.quotaNotWired`、换模型对话框的 `quotaNotWired` 参数）；额度格的「实读/估算」悬停写读法（`reclaude-carpool` 等）；design 第六节第 4 层、ops（对账提醒怎么处理、`/etc/fleet-dao/quota.json` 进配置清单、「待实现」那段）、adapters 文档跟着写实。
- **还没做 / 没验证**：法国真机（法国引擎关着，复查 10-15；`/etc/fleet-dao/quota.json` 还没放，要创始人的凭据和机器，放上之前 `quota-read:config` 会一直报）；Grok、Cursor 池在法国怎么读（凭据形态没定，读不到照实报没读成）；「发布时核对 quota.json」10-03 判为重复不做，验收原文改不改等关单时创始人定。#76 不关。

## 2026-10-04（#574 剩的代码，Opus 子代理分三个 PR：装载 → 选路 → 界面）

- **装载，#716 已合**：发布时目录装完接着装路由两层（`deploy/release.sh` 的 `load_routing` → `packages/db/src/bin/routing.ts` → `runRoutingApply`：读这一版带的 `packages/db/routing.default.json`、只补缺写进两张表、日志写补了几行/保持几个），装不成、读不回、装完 0 行都红、不切版本。测试：`packages/db/test/routing-apply-release.test.ts`（真骨架 + 目录样例装得进、再装已齐；骨架读不到、目录没装都明确失败一行不写）、`deploy/test/release-flow.test.sh`「装路由两层」一段（本机 Git Bash 建不了符号链接，「切到哪一版」那几条只在 CI 上验）。
- **选路改读新表，#722 已合**：引擎 `pickRoute` / `stageAllOpen` 的事实改成 `routeFactsForPurpose`（`routingLayers` 摊平：先用途的模型顺序、再模型下的路由顺序），仍交给同一个 `chooseRoute`——死的挡掉写原因、额度未知的排在活的后面、全死回 `waitFor: 'none'` 逐条写原因，配置缺口（用途没配、模型下没路由）写进原因；两层没有「钉住」，一律按没钉住算。路由探针的「在不在用」、切号看的「在用的路由」也改按两层（`routesInUse`）。`stageCandidates` 没有别的调用方，删了，测试改到两层上。新测试：`packages/engine/test/real/store-ports.test.ts`「路由两层选路」四条（第一顺位死了跳到第二、全死明确失败、不知道排后面、配置缺口写进原因）。
- **还读旧平铺表的（这次没切）**：判断题后端 `packages/jev/src/wiring.ts`（判断阶段排第一的开着的路由）、驾驶舱换模型对话框（`GET /routing` 的 `stages`）、commander 的 `france-query.mjs`（`in_use` 列；法国还没跑迁移 0025，先切会让这条查询报错）。删旧表（#556-4）之前要一起切。
- **驾驶舱每层活着吗（分支 `feat/574-routing-layers-cockpit`）**：驾驶舱新页「路由」（`/routing`，调度组第一项；演示版没有）。左列 9 个用途：派不派得出去、模型顺序（每个模型一个活/死/不知道的点）、一句话（首选活着 / 首选不行时顺位第一条活的在哪 / 为什么派不出去）；右边选中用途的每个模型、每条路由，三件事（接得上、额度够、禁令与开关）各写结论和原因、探针多久前探的（过期标「探测过期」）、用满的窗几点清零、池满了写「等空位，不算死」。进页面先看派不出去的，网址 `?purpose=` 可点名。接口 `GET /api/routing/layers`（`packages/api/src/routing-layers.ts`，和选路读同一份 `routingLayers`）：内存版写 `unavailable`、读不到回 503，都不回空列表。顺手修两处：探针「没探」「没通」的原因改照探针自己写的（`routes.probe_detail`）说——原来按量计费不探也说成「挂着的是另一个组织」；`cn()` 认得自定义字号档位——原来字号和颜色放一起时字号被吞（额度页用满的大数字、带颜色的指标卡都中过）。画面：`_tmp/shots-574/`（1920、1366、500 宽，假数据）。
- **还没验证**：法国真发一次（法国引擎关着，上线按版本由创始人确认）；生产目录 `/etc/fleet-dao/catalog.json` 不在仓里，骨架里的路由 id 和它对不对得上没核过——对不上第一次发布会红在「装路由两层」（照设计不吞），发之前用 `france-query` 核一遍 `routes` 表。选路切过去以后，生产上实际的顺序和开关来自骨架（只补缺），不是目录里的阶段顺序：两边不一样的以骨架为准（例如 GPT 5.6 Luna 经 Cursor 那条，平铺里只挂在开 PR 前验证；骨架里它开着，界面、判断以外的用途都排得到，在 Opus 后面；Grok 4.7 在分诊、规划这些用途里也开着、排最后）。

## 2026-10-04（#216 读的那一半 + 驾驶舱，Opus 子代理，两个 PR：后端读 → 驾驶舱）

- **后端读（#728 已合，10-04 05:49）**：`runs` 加 `tier` 列（迁移 0027 只加列加约束，排在 #157 的 0026 `route_id` 之后；取值照 `runner/tier.ts`，引擎 `test/runner/tier.test.ts` 钉三处一致）；Store 加 `listSegmentRuns`（task_id 对上的 + task_id 没记、单号对上的兜底行，标 `matchedBy`；记了别的仓工作流编号的不收）；`shared/src/segment-runs.ts` 的 `readSegmentRun` 认段名、算起止、逐样点名没读到的（段名认不出、起止缺一头、单子结束了还开着、token/花费没记到、动手段没记派工档，各带原因）；`summarizeUsage` 加 `bySegment`（对题/动手/验收 × 模型）、`noQueue`（三段没有排队，不当 0 秒）；任务详情接口带 `segmentRuns`。老单照旧读 `session_runs`。
- **驾驶舱（#736 已合，10-04 06:26；#734 修好 `cn()` 吞自定义字号后，任务页里绕开它的写法在分支 `fix/216-cn-cleanup` 改回 `cn()`）**：`/tasks/:taskId` 任务页（主页「在跑的」卡片、追问的链接早就指到这里，#610 删页后一直 404）。三段的单：顶上四格（总耗时、干活合计、输入当量、花费）＋「三段」表（对题 / 动手 / 验收固定三行，每段按模型再分；只用一个模型的段把模型名写在段名旁边、不重复一行；派工档只有动手分，对题写「不分档」、验收写「冷调用」）＋「每一笔」（结局、起止和耗时、用量、PR、「按单号兜底」、没读到的逐条写原因）；老流程的单照旧是会话时间线＋「时间与用量」；两种都有的，老会话单列一块。数一律用后端算好的（`readSegmentRun`、`summarizeUsage`），假数据（`api/mock`）也过这两个函数。截图 `_tmp/216-desktop.png`（1440 宽）、`_tmp/216-mobile.png`（390 宽），对着 API dev 服务的 memory-store 假数据（#13）截的。测试 `packages/web/src/test/task-page.test.tsx`，每条读不到的路径各造一次。
- **写的那一半（#760 已合，#737 合了之后做，Opus 子代理）**：`RunRecordSchema`/`RunStartSchema` 加 `taskId`（uuid，外键到 tasks）、`tier`（只认 `tier.ts` 三档，且只有动手段能带）、`workflowId`、`prNumber`（正数）、`branch`；`one-shot.ts` 开跑、收场用同一份 `runFields`（收场按编号整行覆盖，漏一样就把开跑写的冲成空），一进来先照 runs 的约束对一遍，对不上报 `BAD_RUN_INPUT`：不起会话、一行不写（不再拖到写库时变成「能重试」的 `RUN_START_FAILED`）；`runs-writer.ts` 写前照同一份 zod 挡、几列都写。动手：`task-segment.ts` 给 tasks.id、单号、`input.tier.tier`、`taskWorkflowId(仓, 单号)`、分支；`RunSegmentInput` 加可选 `prNumber`，`workflows/task.ts` 开了 PR 以后的轮次传（第一轮会话交付之后才开 PR，那一笔没有 PR 号，按设计不补写；重放夹具照过）。验收：`VerifierInvokeInput` 要 `issueNumber`（必填，缺了一进来就抛、不起会话）、`taskId` 定成 tasks.id（uuid）、可选 `workflowId`，由 `task-verify.ts` 经 `cold-verify-run.ts` 的单子那一样（`ColdVerifySpec`）交进去；原来在 `task-verify.ts` 里补单号的那层包装删了；验收不带派工档。对题段引擎里没有会话（对题是指挥官和创始人对话），runs 里不会有引擎写的对题那一行。
- **还没验证**：真 `runs` 数据（等 #452 演练跑出来，#216「怎么算做完」只剩这一条，所以 PR 只写 `#216` 不写 Closes）。

## 归档目录

> 已搬走的节，标题原文如下（按归档页分组，每页里仍是原来的先后）。找一件旧事：先看日期，再进对应的页。

### `docs/archive/progress-inbox-2026-10.md`

- 已标「已处理」的创始人原话（整条处理完的，原样搬来）

### `docs/archive/progress-2026-10-04.md`

- 2026-10-04 凌晨（流程漏洞与自评：创始人「主动发现漏洞、自定优先级、设任务和验收」「看看有没有优化空间」）

### `docs/archive/progress-2026-10-03.md`

- 2026-10-03 晚（第二意见「1+2+3」的第 2 条和第 3 条的补审一侧，分支 `review/labels-rounds-after-merge`）
- 2026-10-03 下午（#76 定时读额度、#574 路由两层；主 agent 直接做，创始人「暂时不开subagent」）
- 2026-10-03 午（删库表 PR-1、Fable 永久、引导落盘）
- 2026-10-03 午（#556-4 删库表 PR-1 已合、PR-2 等上线确认；Fable 永久已合；引导落盘/断链待点头）
- 2026-10-03 早（收拾：断链 PR #668、AGENTS.md 减脂报告、v3 W1）
- 2026-10-03 早（旧检出踩坑复盘：干活检出落后 + 扫过期规矩 + 打断回执）
- 2026-10-03 凌晨（#654 GitHub 瘦身：F2 deploy 切片 + 第二意见不再留会话）

### `docs/archive/progress-2026-10-02.md`

- 2026-10-02 夜（单人收尾：优先级与实现计划，不开子代理和工作流）
- 2026-10-02（未标路由缺平台令牌时拒绝启动）
- 2026-10-02（钩子层不再从打印出来的命令行漏密钥）
- 2026-10-02（验收段 555-2：冷调用接通合并闸）
- 2026-10-02（Mirasim 切换与一条命令迁移，实施）
- 2026-10-02（W4 顺位 9 / #605 / PR #606）
- 2026-10-02（Mirasim 自有 / 平台切换与 macOS，先调研出方案）
- 2026-10-02 补记（当晚的收尾）
- 2026-10-02 00:10（#557 合并；worktree 清理进了开会话钩子）
- 2026-10-02 00:16（删除单侦察中）
- 2026-10-02 07:30（北京时间；三波 workflow 产出，5 张 PR 开、1 张已合）
- 2026-10-02 07:55（北京时间；第一波 PR 已合四张，第二波等着一口气推）
- 2026-10-02 08:00（北京时间；#562 第二意见过程：4 轮 GPT 审 + 1 轮指挥官复核）
- 2026-10-02 08:20（北京时间；第一波的 #531 #553 开成 PR，CI 中合）
- 2026-10-02 08:50（北京时间；#565 #566 挂着红，不是等 CI）
- 2026-10-02 09:10（北京时间；第四波开工前的收尾 + #570 修正 CI 的一个静默漏检）
- 2026-10-02 09:35（北京时间；接手会话后的这一步）
- 2026-10-02 09:40–14:56（kimi-k3 会话：文档对齐、三段骨架、驾驶舱、大删第一片）
- 2026-10-02 15:10 起（复核 kimi-k3 合进主线的改动，本机指挥官会话）

### `docs/archive/progress-2026-10-01.md`

- 2026-09-30 / 10-01（本机，指挥官会话）
- 2026-10-01 凌晨（D0 文档对齐，本机指挥官会话）
- 2026-10-01 上午（创始人拍了四件之后）
- 2026-10-01 上午（创始人第二条回复之后）
- 2026-10-01 上午（创始人第三条回复之后）
- 2026-10-01 下午（权限、保险箱边界、同步换路）
- 2026-10-01 晚上（法国 root 打通、保险箱换钥匙）
- 2026-10-01 深夜（保险箱收窄、跳板别名、换钥匙收尾）
- 2026-10-01 深夜（北京时间 23:30 前后；流程重做：方案定稿、清单清理完）
- 2026-10-01 深夜 23:49（worktree 清理、救回决定 0006）
- 2026-10-01 深夜 23:33（Mirasim 实测全部完成、修了一个真 bug、方案过了一轮挑错）
