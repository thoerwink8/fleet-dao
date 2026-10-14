# 决定索引

一决定一文件，只增不改；被推翻时在那份头部标「已被 xx 替代」，不删（决定 0001 第 7 条）。状态以各份头部「状态」「现状」那行为准，改了那行同时改这里。

## 还在管事

| 编号 | 一句话 | 状态 |
|---|---|---|
| [0005](0005-agent-permissions-loosest.md) | 各家 AI 权限尽量宽松，Claude 保持 auto | 生效 |
| [0006](0006-discussion-model-order.md) | 讨论与第二意见的模型顺序 GPT → Grok → Claude → DeepSeek → Kimi（2026-10-05 起），全走无头 | 生效 |
| [0007](0007-new-machine-and-hygiene.md) | 新电脑一键配好、卫生检查不卡流程、规矩自动同步 | 生效 |
| [0010](0010-three-segment-flow.md) | 三段一条龙（对题 → 动手 → 验收），替代 Fusion | 生效；第 6 条 PR 三栏被 0015 改成四栏 |
| [0012](0012-mirasim-routing-and-migration.md) | Mirasim 额度来源切换、Mac 支持、一条命令迁移 | 生效 |
| [0013](0013-session-directives.md) | 只管这一次会话的话不落盘 | 生效 |
| [0015](0015-github-one-home.md) | GitHub 上一个事实一个家 | 生效 |
| [0020](0020-founder-2026-10-05-chain-breaks.md) | 断链三条：关单自动收口、里程碑关前搬单、开单先查旧单 | 生效 |
| [0023](0023-drop-second-opinion-gate.md) | 去掉「先审后合」这道合并闸：所有 PR 只看 CI（引擎 PR 的冷验收照旧）；风险是迁移误删表只靠 CI | 生效 |
| [0025](0025-subagent-lane-and-queue.md) | 子代理走自己的一道（钩子不套主会话的等待上限、催送、自动无人值守）；指挥官按队列派活；读代码先查 codegraph 索引 | 生效；「自动无人值守」那一层由 0026 从主会话也删掉 |
| [0027](0027-drop-shell-owed-and-channel.md) | 删掉收尾空壳和欠账账本；失败重试用完就停下，不再换渠道；通用段再砍短 | 生效；第 4 条「被测试钉住的句子不拆」被 0089 替代 |
| [0029](0029-e2e-nightly-full-pr-changed-pages.md) | e2e 拆开：回归每夜在主线全量跑，PR 只点改动页（#1186）；「页面点验」和 CI 的 e2e 分开叫 | 采纳；第 3 条待 #1186 落地 |
| [0031](0031-engine-intake-gate.md) | 引擎拉单门加判断：改 .github/workflows 的、被开着的 PR 引用的单不拉；pr:open --new-issue 自动贴本机做；单关了撤任务（#1194、#1197、#1198、#1199） | 采纳 |
| [0032](0032-release-by-main-commit.md) | 发版的单位是主线上的一个提交，里程碑只管计划；发版后恢复发版前的引擎状态；删掉 v<N> 标记、发布 PR、CHANGELOG 自动节那一层（替代 0011 里按版本发的一半） | 采纳；第 2 条「入口只有按钮」和「点按钮就是同意」被 0088 替代 |
| [0033](0033-fable-in-catalog-founder-only-opens.md) | Fable 进目录，默认关着、不在任何用途里；只有创始人本人在驾驶舱能打开、配进用途，引擎、临时指挥官、命令行、机器通行证一律不能（取代 0017 第 1、3 条，母单 #1354） | 采纳 |
| [0037](0037-vendor-native-hooks.md) | 各家 AI 的原生钩子由 agents-sync 装；Codex 的信任由同步替本脚本那几条记上 | 采纳 |
| [0038](0038-public-repo.md) | 仓：fleet-dao 公开，三样并进来，两个旧仓只读存档 | 采纳，未复核 |
| [0039](0039-engine-and-cockpit.md) | 结构：一个仓两块，引擎和驾驶舱共用一个数据库 | 采纳，未复核 |
| [0040](0040-github-issue-is-source.md) | 任务：以 GitHub issue 为准，驾驶舱是它的驾驶舱 | 采纳，未复核 |
| [0041](0041-start-unless-human-gate.md) | 放行：AI 直接开工，只有对外发布、花钱、删数据、改标准停下等人 | 采纳，未复核 |
| [0042](0042-two-founders-feishu.md) | 人：两位创始人用飞书登录，写 GitHub 由机器人代发 | 采纳，未复核 |
| [0043](0043-hong-kong-facade.md) | 访问：香港当门面，法国不对外开端口，域名用 DigitalPlat | 采纳，未复核 |
| [0044](0044-feishu-and-inbox.md) | 通知：飞书机器人加驾驶舱提醒中心 | 采纳，未复核 |
| [0046](0046-dispatch-mix.md) | 派工模型：渠道、族、模型、执行方式、阶段自由组合，GPT 不碰界面 | 采纳，未复核 |
| [0048](0048-idle-must-not-invent-work.md) | 闲置：渠道空了按序找活，不许 AI 自己编活 | 生效；「给别的 PR 当第二意见」随 0023 没有了 |
| [0049](0049-official-cli-first.md) | 接法：优先官方命令行，够不到再套自己的写码外壳 | 采纳，未复核 |
| [0050](0050-temporal-postgres-jev.md) | 底座：Temporal、Postgres、Jev | 采纳，未复核 |
| [0051](0051-france-hong-kong-ha.md) | 高可用：法国干活、香港门面，各自一条命令重建，加看门狗和每晚备份 | 采纳，未复核 |
| [0052](0052-tests-on-github-ci.md) | 测试：正式测试跑在 GitHub 的机器上，AI 自己跑的受资源上限约束，每 6 小时一条巡检任务 | 采纳，未复核；「每 6 小时一条巡检任务」被 0093 替代 |
| [0053](0053-france-vps-machine.md) | 机器：用现在这台法国 VPS（6 核 12G，打算续费） | 采纳，未复核 |
| [0054](0054-granularity-and-merge.md) | 颗粒度与合并：版本 → 母单或单独的小单 → 子单 → 块，会改同一块的不同时跑，引擎排合并队列 | 生效；「主导模型」「交审」随 0010、0023 作废 |
| [0055](0055-board-first-screen.md) | 看板首屏：按项目切换，每个项目的全局任务树是首屏，另有总览页 | 采纳，未复核 |
| [0056](0056-ai-commander-permissions.md) | AI 帅位权限：能自己改调度台，改完推通知、一键撤回，创始人钉住的顺序不动 | 生效；帅位改叫指挥官、不设座位（0074），选路顺序以 0076 为准 |
| [0057](0057-what-counts-as-spending.md) | 花钱的定义：套餐额度以内都不算花钱，会让账单多出一笔的才算，按量的先定月度上限 | 采纳，未复核 |
| [0059](0059-spec-docs-layout.md) | 需求文档：issue 是入口与进度，specs/ 每个需求一个文件夹，子任务各一个 PR | 采纳，未复核 |
| [0060](0060-progress-reporting.md) | 进度：统一的汇报进度工具，两级进度，沉默就催，驾驶舱实时、issue 原地更新 | 采纳，未复核 |
| [0061](0061-feishu-behavior.md) | 飞书：记任务、只推三类消息与关注、随时看盘面、回复即追问 | 采纳，未复核；记任务、机器人菜单、需求讨论群被 0090 取代 |
| [0062](0062-ai-flow-interface.md) | AI 与流程的接口：进度先被动读过程记录，主动部分做成 `fleet` 命令而不是 MCP | 采纳，未复核 |
| [0064](0064-execution-mode-capacity.md) | 执行模式与容量：无头，每个子任务一个命令行写码助手进程，起步 6 个并发会话 | 采纳，未复核 |
| [0065](0065-two-machine-split.md) | 两台机器分工：法国干活，香港当门面 | 采纳，未复核 |
| [0066](0066-quota-read-all.md) | 额度必须全读：驾驶舱和调度都用完整额度数据 | 采纳，未复核 |
| [0068](0068-jev-integration.md) | Jev 接入：按场景和性价比接入，先只记不拦 | 采纳，未复核 |
| [0069](0069-secrets-vault-copy.md) | 密钥副本：加密配置副本放私有配套仓 | 采纳，未复核 |
| [0071](0071-debt-not-lost.md) | 欠账不漏：以后要做的事必须落到 issue | 采纳，未复核 |
| [0072](0072-projects-and-standards.md) | 项目与标准：项目模型和标准推送机制 | 采纳，未复核 |
| [0073](0073-test-memory-fix-tests-not-machine.md) | 测试内存先改测试、不加机器 | 采纳，未复核 |
| [0076](0076-route-strictly-by-order.md) | 选路只按顺序：只因额度用完、人关了、报错往后挑；冷验收验不了由冷验收「两家都验」兜 | 采纳 |
| [0080](0080-steer-lineage-owner.md) | 创始人的话和引导按「Mirasim 会话」这条血缘认主：开会话只列同一个 Mirasim 会话换号前收到的话，不再全局广播；待处理引导记主人，只叫主人办，别的会话只计数，无主的先 `pnpm progress:claim` 认领 | 生效（创始人 2026-10-13 统一同意） |
| [0081](0081-pnpm-entry-and-default-shared.md) | 仓合同 `agents/repo-contract.json`（首批：仓根 `pnpm dev/start/stop/check`、AGENTS.md、PROGRESS 两节、`.gitignore` 的 `_tmp/`）：开会话钩子在任何仓里每天最多提醒一次缺项，`pnpm repo:check`、`repo:init` 查和补，只提醒不拦；创始人说的原则默认各仓通用，引导条目标〔范围：通用｜只此仓〕，开会话和收尾钩子提醒 | 生效（#1934） |
| [0082](0082-read-source-before-loosening.md) | 通用段底线补一句：读不到先追数据源；要放宽判据，PR 里贴上游真的不给的证据（#1936 放宽判据凑绿、#1946 才修根子）；`chain-first` 硬规矩跟着写 | 生效（#1949） |
| [0083](0083-present-keeps-the-turn.md) | 人在场还有活就别收这一轮，新话先回，活没干完不许写成收工；删引导中继；流程钩子只留在 fleet-dao 项目设置 | 生效（#1952）；第 1 条被 0089 替代 |
| [0084](0084-progress-table.md) | 进度汇报：「要你拍的」编号在前，「在做的」一张表，带百分比、做到哪、下一步 | 生效（#1952）；第 5 条作废（0089） |
| [0085](0085-plugin-catalog.md) | 别的仓用订阅标记跟上 fleet-dao 的过程钩子，不整份抄；脚本装在 ~/.fleet-dao/hooks | 生效（#1956、#1959） |
| [0086](0086-local-tool-baseline.md) | 本机工具基准：浏览器走官方命令行，CodeGraph 留着；不进同步、不推别的仓 | 创始人 2026-10-12 19:46「按照你的推荐走」 |
| [0087](0087-three-subagent-roles.md) | 子代理只分三个角色：斥候 `Explore`（`claude-haiku-5-5`）、工人 `general-purpose`（`claude-sonnet-5-5`）、设计 `Plan`（`claude-opus-5-5`），同名压住内置的；定义只在 `agents/subagents/` 一份，同步装到每台机器、引擎经 `--agents` 用同一份；写类型不传 `model`、升档才传；16 个 `fleet-*` 和 `haiku55` 全删（取代 0036、0079，部分取代 0034、0035、0077） | 采纳（创始人 2026-10-12 选 A、20:26「2 同意……3 需要都改」） |
| [0088](0088-release-pause-resume-session.md) | 主线绿了就自动发版（两次至少隔 1 小时，按钮保留）；发前 hard 暂停在跑的任务、发完继续，按会话号续上原会话，续不上才开新会话；删掉 one-shot「不许续会话」（部分取代 0032、0019 的排空做法，母单 #2036） | 采纳（创始人 2026-10-13 17:45「你先把这个规则去掉我同意你的拍板」）；「至少隔 1 小时」和发版停整台引擎被 0093 替代 |
| [0089](0089-rules-subtraction.md) | 规则减法：子代理后台跑、派完就收这一轮；删前台等待上限；`Plan`、`general-purpose` 加 `omitClaudeMd`；只钉行为不钉文字；删 6 个第三方技能；拦 `cd && 只读命令`；git/gh 走本机代理（取代 0083 第 1 条、0027 第 4 条，合成 0024、0026、0028、0030、0078） | 采纳，分片落地（创始人 2026-10-13 17:54「都同意……你全都修复掉」）；第 4 条「字数账保留」和第 6 条「拦 cd 加只读命令」被 0091 取代 |
| [0090](0090-intake-in-cockpit.md) | 驾驶舱有「提需求」页（和指挥官聊、两人互聊、拍板后开单）；驾驶舱做成 PWA；飞书只留登录和手机通知；`intents` 表只读保留（取代 509 方案第七节「不建开单界面」和「飞书是最新意图的唯一入口」，部分取代 0061，母单 #2047） | 采纳，分片落地（创始人 2026-10-13 晚「后面就通过 PWA 的方式来实现」「都按照你的推荐走」） |
| [0091](0091-rules-subtraction-round-2.md) | 规则减法第二轮：字数账整套不再保留，不再拦 `cd && 只读命令`，heredoc 正文不触发四条拦截；决定索引 0002、0008、0016 三行订正（取代 0089 第 4 条后半和第 6 条） | 采纳，分包落地（创始人 2026-10-13 18:28 全权授权，#1055 评论 6152391856） |
| [0093](0093-pipeline-redesign.md) | 流程重设计：发版不停引擎、主线绿就发；返工续原会话、引擎自解冲突自跑测试；卡住先自动处理一次；冷验收只判做完标准；E2E 挡发版不挡 PR；删 canary 换没合 PR 报警；merge-gate 判改标准；指挥官侧钩子少空转少误拦（取代 0052 巡检、0088 第 1 条间隔和停整台引擎） | 采纳，分包落地（创始人 2026-10-14 16:30 全权授权，#1055 评论 6164241659） |

## 历史

已执行完、已被替代的。文件不搬。

| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](0001-plan-design-ops.md) | plan、design、ops 整套改法 | 历史；第 7 条挪到本页开头 |
| [0002](0002-fusion.md) | Fusion：主脑指挥帮手，别家模型挑错 | 被 0003 替代，0003 又被 0010 替代，以 0010 为准 |
| [0003](0003-fusion-flow.md) | Fusion 流程定稿 | 被 0010 替代 |
| [0004](0004-vps-and-rebuild-prereqs.md) | 换 VPS 与重做之前的前置五件 | 历史 |
| [0008](0008-discuss-via-grok-4.7.md) | 讨论和第二意见改走本机 Grok 4.7 无头 | 失效（头部「状态」仍写已采纳，以「现状」行为准：一时情况、自相矛盾），以 0006 为准 |
| [0009](0009-v3-implementation-plan.md) | v3 实现排期 | 历史 |
| [0011](0011-founder-7-questions-2026-10-02.md) | 7 件人闸：发布按版本走 GitHub Actions 等 | 历史 |
| [0014](0014-progress-on-github.md) | 进度以 GitHub 为准 | 历史 |
| [0016](0016-review-gate-structural-and-after-merge.md) | 第二意见不再没有终点：ci.yml 结构比对、审的人只管现实里会出的事、CI 判法先合后审 | 被 0023 替代（先审后合整层去掉，所有 PR 只看 CI） |
| [0017](0017-fable-only-in-founder-main-session.md) | Fable 只在创始人本机主对话里由他自己选 | 被 0033、0034、0087 替代；「永不用 Fable」「主对话由他自己选」写在通用段 |
| [0018](0018-org-switch-9-answers-2026-10-04.md) | 切号方案 9 条背景的回答 | 历史 |
| [0019](0019-founder-2026-10-05-five-answers.md) | 10-05 五件：发 v3、删追问库表、不做脱开、5 秒限时、被封号 | 历史 |
| [0021](0021-slim-before-replacing-temporal.md) | 引擎先瘦身（定时任务摘出 Temporal、失败规则表、看门狗），不直接换掉 Temporal；B 只放行「只加代码、假环境」 | 历史 |
| [0022](0022-retire-local-wsl.md) | 撤掉本机 WSL 演练台：机器注销、仓里删本机档机制；往后只剩法国 + 本机指挥官 | 历史 |
| [0024](0024-subagent-by-default.md) | 派活默认用 Agent 子代理（Mirasim 面板里看得见）；脱离会话的工人只留无人值守、过夜、超 40 分钟的例外，起它要 `--detached` 理由 | 被 0089 替代 |
| [0026](0026-unattended-is-a-worker.md) | 无人值守改走脱离会话的工人；收尾钩子不再挡，起后台活不再自动开 | 被 0089 替代 |
| [0028](0028-unattended-holds-the-turn.md) | 无人值守时会话这一轮不结束：只有自己跑了 `unattended.mjs on` 才挡收尾，盯工人（`watch --wait 55`）、记进度；12 小时、20 次空转、工人都收口等自动放行；工人那一层保留 | 被 0089 替代 |
| [0030](0030-unattended-uses-subagents.md) | 无人值守、过夜也用 Agent 子代理，不脱离会话；脱离的工人只在创始人明说时用 | 被 0089 替代 |
| [0034](0034-subagent-by-cost-effectiveness.md) | 子代理按性价比分 Haiku 5.5、Sonnet 5.5、Opus 5.5 三档：Haiku 一次没证据就升、其余同档两次失败升，派时写明模型、汇报实际 id；默认值仍只许 Opus 或 Sonnet；无人值守的监控以巡查脚本为主，`ALERT` 且有变化才叫短命 Haiku（部分取代 0017 第 2 条，「永不用 Fable」保留，#1372） | 被 0035、0087 替代 |
| [0035](0035-haiku55-by-checkable-output.md) | Haiku 5.5 按「产出能被脚本或一条命令核对」用：别名 `haiku` 在本机是 4.5，真 5.5 走 `subagent_type: "haiku55"` 并核对实际 id；先 Haiku、核对不过再升 Sonnet；交代写全硬规矩；先砍固定开销；引擎侧由创始人在驾驶舱配（部分取代 0034） | 被 0087 替代 |
| [0036](0036-project-subagents-default.md) | 本仓的 16 个子代理（Haiku 6、Sonnet 6、Opus 4）写进仓里 `.claude/agents/fleet-*.md`，派活默认用它们；模型用完整 id、tools 白名单、带 Edit 的进独立工作树、汇报首行写模型 id；`.claude/agents/` 进标准路径（补充 0034、0035） | 已被 0087 替代（第 2 条后半句和第 7 条先前已被 0079 替代） |
| [0045](0045-model-policy.md) | 模型：构建期用 Opus，判断先用 Jev，子代理分三档且永不用 Fable | 被 0033、0087 替代 |
| [0047](0047-ranking-with-explore.md) | 推荐：人排先后，额度和战绩微调，大约一成用来试探 | 被 0076 替代 |
| [0058](0058-old-rules-dropped.md) | 旧规则：旧仓的规则对 fleet-dao 不再算数，规则从零重写 | 历史 |
| [0063](0063-repo-layout.md) | 仓库结构：全部放在 fleet-dao 一个仓 | 历史 |
| [0067](0067-supplementary-needs.md) | 补充需求：旧单审计找出的 10 条 | 历史 |
| [0070](0070-labels-and-milestones.md) | GitHub 上的标签与里程碑 | 历史 |
| [0074](0074-commander-no-seat.md) | 指挥官不设座位、不在库里认领 | 历史 |
| [0075](0075-france-engine-release-by-commit.md) | 法国自家的引擎按主线上的一个提交发布 | 被 0032 替代 |
| [0077](0077-review-screen-effort-high.md) | 评审初筛 `fleet-review-screen` 的 effort 从 medium 调到 high（Haiku 5.5 两道题 medium 10 遍过 8、high 6 遍全过），别的子代理档和 effort 不变（补充 0036） | 已被 0087 替代（`fleet-review-screen` 删了） |
| [0078](0078-steer-reply-and-background-subagents.md) | 引导三条：引导一送到、调工具前先回一句；派 Agent 子代理一律后台跑；引导涉及在跑的子代理用 `SendMessage` 转 | 被 0089 替代 |
| [0079](0079-fleet-subagents-user-level.md) | 16 个 `fleet-*` 子代理的通用版（`agents/subagents/` 下同名，去掉本仓专属的命令和路径）随 `pnpm agents:sync` 和 `haiku55` 一起装到每台机器的 `~/.claude/agents/`，法国也装；`.claude/agents/` 的专属版本仓照用、不往家里装（部分取代 0036） | 已被 0087 替代（原为采纳：创始人 2026-10-11 18:38「1. 装」、20:44「改成通用版，VPS 照装」） |

## 第 1–14 条的编号（#1476）

`0037-vendor-native-hooks.md` 已在仓里（#1487 加入）。索引原来没有这一行，上面这张表已补上。本片不改这份已有记录，新文件从 0038 排到 0051。它的开头原文：

> # 0037 各家 AI 的原生钩子由 agents-sync 装；Codex 的信任由同步替本脚本那几条记上
>
> - 日期：2026-10-09（北京时间）
> - 谁拍的：创始人放行做法，细节由做 #232 的会话定。原话在下面。
> - 状态：采纳。#232 分四片落地：Codex（#1487）、Gemini CLI（#1489）、Antigravity（#1500）、Kimi Code（第 4 片）。
> - 关联：`packages/agents-sync/src/targets.ts`（`HOOK_TARGETS`、`HOOK_GAPS`）、`packages/agents-sync/src/hooks-codex.ts`、`agents/hooks/vendor-pretool.mjs`、`agents/hooks/pretool-<家>.mjs`、`agents/test/rules/vendor-pretool.rules.test.ts`、`docs/ops.md` 第五节「钩子」
> - 取代：无。

第三节第 1–14 条对过 0001–0037。0001 是第 37 条，0002 是第 38 条，0003 是第 40 条。0004 到 0037 是后来另拍的事。下面是各文件第一行原文。没有一份的正文是第 1–14 条那一格，所以这 14 条各自新建，结论原文在 0038–0051 的「## 内容」里。

- `0001-plan-design-ops.md`：0001 plan、design、ops 整套改法
- `0002-fusion.md`：0002 Fusion：主脑指挥帮手，别家模型挑错
- `0003-fusion-flow.md`：0003 Fusion 流程定稿：版本与母单、主导模型带副手、开 PR 前验证
- `0004-vps-and-rebuild-prereqs.md`：0004 换 VPS 与重做之前的前置：2026-09-30 凌晨的五项拍板、补充要求和最终目标
- `0005-agent-permissions-loosest.md`：0005 各家 AI 的权限：尽量宽松、只放不收，Claude 保持 auto
- `0006-discussion-model-order.md`：0006 讨论与独立 Review 的模型顺序和无头调用
- `0007-new-machine-and-hygiene.md`：0007 新电脑一键配好：GitHub 账号当总钥匙，卫生检查不卡流程，改了规矩每台机器自动同步
- `0008-discuss-via-grok-4.7.md`：0008 讨论和第二意见改走本机 Grok 4.7 无头
- `0009-v3-implementation-plan.md`：0009 v3 实现排期（依据 6 路调研收割）
- `0010-three-segment-flow.md`：0010 三段一条龙定稿（指挥官 → 工人 → Review），替代 Fusion
- `0011-founder-7-questions-2026-10-02.md`：0011 创始人对 7 件人闸的拍板（2026-10-02 北京时间 10:30 前后）
- `0012-mirasim-routing-and-migration.md`：0012 Mirasim 额度来源切换、Mac 支持与一条命令迁移
- `0013-session-directives.md`：0013 只管这一次会话的话不落盘（「不开 subagent / workflow」不是规则）
- `0014-progress-on-github.md`：0014 进度以 GitHub 为准；流程步骤能少就少，读文件别占大头
- `0015-github-one-home.md`：0015 GitHub 上一个事实一个家：需求在单子里、交付在 PR 里，没人用的关卡删掉
- `0016-review-gate-structural-and-after-merge.md`：0016 第二意见不再没有终点：ci.yml 结构比对、审的人只管现实里会出的事、CI 判法先合后审
- `0017-fable-only-in-founder-main-session.md`：0017 Fable 只在创始人本机主对话里由他自己选（机器派的会话、子代理、VPS 和 WSL 永不用）
- `0018-org-switch-9-answers-2026-10-04.md`：0018 创始人对切号方案（#194）9 条背景的回答（2026-10-04 北京时间 06:08）
- `0019-founder-2026-10-05-five-answers.md`：0019 创始人对五件待拍板事的回答（2026-10-05 北京时间 07:57）
- `0020-founder-2026-10-05-chain-breaks.md`：0020 创始人对「断链统一」三条的回答（2026-10-05 北京时间 08:50 前后）
- `0021-slim-before-replacing-temporal.md`：0021 引擎先瘦身、不直接换掉 Temporal（创始人 2026-10-05 北京时间约 19:10 拍）
- `0022-retire-local-wsl.md`：0022 撤掉本机 WSL 演练台（创始人 2026-10-06 北京时间 10:21 拍）
- `0023-drop-second-opinion-gate.md`：0023 去掉「先审后合」这道合并闸：所有 PR 只看 CI（创始人 2026-10-06 14:25 拍）
- `0024-subagent-by-default.md`：0024 派活默认用 Agent 子代理，脱离会话的工人只留例外（创始人 2026-10-06 北京时间 15:40 拍）
- `0025-subagent-lane-and-queue.md`：0025 子代理走自己的一道、指挥官按队列派活、代码先查索引（创始人 2026-10-06 北京时间约 17:10 授权，指挥官拍）
- `0026-unattended-is-a-worker.md`：0026 无人值守改走脱离会话的工人，收尾钩子不再挡（创始人 2026-10-06 17:25 选定）
- `0027-drop-shell-owed-and-channel.md`：0027 删掉收尾空壳和欠账账本，失败不再换渠道，通用段再砍短（创始人 2026-10-06 19:15 选定）
- `0028-unattended-holds-the-turn.md`：0028 无人值守时会话这一轮不结束，工人那一层保留（创始人 2026-10-07 约 02:27 选定）
- `0029-e2e-nightly-full-pr-changed-pages.md`：0029 e2e 拆开：回归每夜全量跑，PR 只点改动页（创始人 2026-10-07 14:00 拍）
- `0030-unattended-uses-subagents.md`：0030 无人值守、过夜也用 Agent 子代理，不再脱离会话（创始人 2026-10-07 约 14:35 选定）
- `0031-engine-intake-gate.md`：0031 引擎拉单门加判断：不归引擎的单不拉（创始人 2026-10-07 约 15:30 选定）
- `0032-release-by-main-commit.md`：0032 发版的单位是「主线上的一个提交」，里程碑只管计划（创始人 2026-10-07 夜选定，指挥官落盘）
- `0033-fable-in-catalog-founder-only-opens.md`：0033 Fable 进目录，只有创始人本人能把它配进用途或打开（取代 0017 第 1、3 条）
- `0034-subagent-by-cost-effectiveness.md`：0034 子代理按性价比选模型：Haiku 5.5、Sonnet 5.5、Opus 5.5 三档加升级规则；无人值守的监控以脚本为主（部分取代 0017 第 2 条）
- `0035-haiku55-by-checkable-output.md`：0035 Haiku 5.5 按「产出能被机器核对」用：真 5.5 走 `haiku55` 子代理、先 Haiku 核对不过再升级（部分取代 0034）
- `0036-project-subagents-default.md`：0036 本仓的子代理写进仓里 .claude/agents/，派活默认用它们（补充 0034、0035）
- `0037-vendor-native-hooks.md`：0037 各家 AI 的原生钩子由 agents-sync 装；Codex 的信任由同步替本脚本那几条记上

靠近的几份，全文仍对不上，所以仍新建：

- 第 3 条的全文在 `0040-github-issue-is-source.md`（以 GitHub issue 为准；驾驶舱是它的驾驶舱）。0015 记的是另一件事：需求在单子里、交付在 PR 里，没人用的关卡删掉。
- 第 8 条的全文在 `0045-model-policy.md`（构建期 Opus、判断用 Jev、子代理分档、Fable 谁能开、验收插头）。0017、0033、0034、0035 只收窄 Fable 和子代理档。
- 第 9 条的全文在 `0046-dispatch-mix.md`（渠道、族、模型、执行方式、阶段自由组合，GPT 不碰界面）。0033 只覆盖「只有创始人本人能开 Fable」。
- 第 13 条的全文在 `0050-temporal-postgres-jev.md`（Temporal + Postgres + Jev）。0021 记的是先瘦身、不换掉 Temporal。
- 第 6 条的全文在 `0043-hong-kong-facade.md`，第 14 条的全文在 `0051-france-hong-kong-ha.md`。0004 记的是换 VPS 之前的前置五件。
