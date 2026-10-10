# 决定索引

一行一份。状态以各份头部「现状」那行为准，改了那行同时改这里。

| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](0001-plan-design-ops.md) | plan、design、ops 整套改法 | 部分被替代：plan 部分以 0015 为准；design、ops 拆分没落地 |
| [0002](0002-fusion.md) | Fusion：主脑指挥帮手，别家模型挑错 | 被 0010 替代 |
| [0003](0003-fusion-flow.md) | Fusion 流程定稿 | 被 0010 替代 |
| [0004](0004-vps-and-rebuild-prereqs.md) | 换 VPS 与重做之前的前置五件 | 已执行完，历史 |
| [0005](0005-agent-permissions-loosest.md) | 各家 AI 权限尽量宽松，Claude 保持 auto | 生效 |
| [0006](0006-discussion-model-order.md) | 讨论与第二意见的模型顺序 GPT → Grok → Claude → DeepSeek → Kimi（2026-10-05 起），全走无头 | 生效 |
| [0007](0007-new-machine-and-hygiene.md) | 新电脑一键配好、卫生检查不卡流程、规矩自动同步 | 生效 |
| [0008](0008-discuss-via-grok-4.7.md) | 讨论和第二意见改走本机 Grok 4.7 | 失效（一时情况、自相矛盾），以 0006 为准 |
| [0009](0009-v3-implementation-plan.md) | v3 实现排期 | 已完成，历史 |
| [0010](0010-three-segment-flow.md) | 三段一条龙（对题 → 动手 → 验收），替代 Fusion | 生效；第 6 条 PR 三栏被 0015 改成四栏 |
| [0011](0011-founder-7-questions-2026-10-02.md) | 7 件人闸：发布按版本走 GitHub Actions 等 | 生效；派活开关没做，由排空代替 |
| [0012](0012-mirasim-routing-and-migration.md) | Mirasim 额度来源切换、Mac 支持、一条命令迁移 | 生效 |
| [0013](0013-session-directives.md) | 只管这一次会话的话不落盘 | 生效 |
| [0014](0014-progress-on-github.md) | 进度以 GitHub 为准 | 生效；计划快照被 0015 改成 `pnpm plan` 现读 |
| [0015](0015-github-one-home.md) | GitHub 上一个事实一个家 | 生效 |
| [0016](0016-review-gate-structural-and-after-merge.md) | 第二意见有终点：ci.yml 结构比对、CI 判法先合后审 | 被 0023 替代 |
| [0017](0017-fable-only-in-founder-main-session.md) | Fable 只在创始人本机主对话里由他自己选 | 第 2 条「永不用 Fable」、第 4 条生效；第 2 条「只用 Opus 或 Sonnet」被 0034 取代；第 1、3 条被 0033 取代 |
| [0018](0018-org-switch-9-answers-2026-10-04.md) | 切号方案 9 条背景的回答 | 生效 |
| [0019](0019-founder-2026-10-05-five-answers.md) | 10-05 五件：发 v3、删追问库表、不做脱开、5 秒限时、被封号 | 生效 |
| [0020](0020-founder-2026-10-05-chain-breaks.md) | 断链三条：关单自动收口、里程碑关前搬单、开单先查旧单 | 生效 |
| [0021](0021-slim-before-replacing-temporal.md) | 引擎先瘦身（定时任务摘出 Temporal、失败规则表、看门狗），不直接换掉 Temporal；B 只放行「只加代码、假环境」 | 生效 |
| [0022](0022-retire-local-wsl.md) | 撤掉本机 WSL 演练台：机器注销、仓里删本机档机制；往后只剩法国 + 本机指挥官 | 生效 |
| [0023](0023-drop-second-opinion-gate.md) | 去掉「先审后合」这道合并闸：所有 PR 只看 CI（引擎 PR 的冷验收照旧）；风险是迁移误删表只靠 CI | 生效 |
| [0024](0024-subagent-by-default.md) | 派活默认用 Agent 子代理（Mirasim 面板里看得见）；脱离会话的工人只留无人值守、过夜、超 40 分钟的例外，起它要 `--detached` 理由 | 生效；子代理用 Sonnet 那半句由 0034 取代 |
| [0025](0025-subagent-lane-and-queue.md) | 子代理走自己的一道（钩子不套主会话的等待上限、催送、自动无人值守）；指挥官按队列派活；读代码先查 codegraph 索引 | 生效；「自动无人值守」那一层由 0026 从主会话也删掉 |
| [0026](0026-unattended-is-a-worker.md) | 无人值守改走脱离会话的工人；收尾钩子不再挡，起后台活不再自动开 | 生效；「这一轮结束、收尾不拦」由 0028 替代，工人那一层和「起后台活不自动开」保留；空壳函数和欠账账本由 0027 删掉 |
| [0027](0027-drop-shell-owed-and-channel.md) | 删掉收尾空壳和欠账账本；失败重试用完就停下，不再换渠道；通用段再砍短 | 生效 |
| [0028](0028-unattended-holds-the-turn.md) | 无人值守时会话这一轮不结束：只有自己跑了 `unattended.mjs on` 才挡收尾，盯工人（`watch --wait 55`）、记进度；12 小时、20 次空转、工人都收口等自动放行；工人那一层保留 | 生效 |
| [0029](0029-e2e-nightly-full-pr-changed-pages.md) | e2e 拆开：回归每夜在主线全量跑，PR 只点改动页（#1186）；「页面点验」和 CI 的 e2e 分开叫 | 采纳；第 3 条待 #1186 落地 |
| [0030](0030-unattended-uses-subagents.md) | 无人值守、过夜也用 Agent 子代理，不脱离会话；脱离的工人只在创始人明说时用 | 采纳；替代 0024 的无人值守例外和 0026、0028 的工人那一层 |
| [0031](0031-engine-intake-gate.md) | 引擎拉单门加判断：改 .github/workflows 的、被开着的 PR 引用的单不拉；pr:open --new-issue 自动贴本机做；单关了撤任务（#1194、#1197、#1198、#1199） | 采纳 |
| [0032](0032-release-by-main-commit.md) | 发版的单位是主线上的一个提交，里程碑只管计划；发版后恢复发版前的引擎状态；删掉 v<N> 标记、发布 PR、CHANGELOG 自动节那一层（替代 0011 里按版本发的一半） | 采纳 |
| [0033](0033-fable-in-catalog-founder-only-opens.md) | Fable 进目录，默认关着、不在任何用途里；只有创始人本人在驾驶舱能打开、配进用途，引擎、临时指挥官、命令行、机器通行证一律不能（取代 0017 第 1、3 条，母单 #1354） | 采纳 |
| [0034](0034-subagent-by-cost-effectiveness.md) | 子代理按性价比分 Haiku 5.5、Sonnet 5.5、Opus 5.5 三档：Haiku 一次没证据就升、其余同档两次失败升，派时写明模型、汇报实际 id；默认值仍只许 Opus 或 Sonnet；无人值守的监控以巡查脚本为主，`ALERT` 且有变化才叫短命 Haiku（部分取代 0017 第 2 条，「永不用 Fable」保留，#1372） | 采纳；Haiku 那一档的判据、`model: "haiku"` 的派法、「一次没证据就升」被 0035 取代 |
| [0035](0035-haiku55-by-checkable-output.md) | Haiku 5.5 按「产出能被脚本或一条命令核对」用：别名 `haiku` 在本机是 4.5，真 5.5 走 `subagent_type: "haiku55"` 并核对实际 id；先 Haiku、核对不过再升 Sonnet；交代写全硬规矩；先砍固定开销；引擎侧由创始人在驾驶舱配（部分取代 0034） | 采纳 |
| [0036](0036-project-subagents-default.md) | 本仓的 16 个子代理（Haiku 6、Sonnet 6、Opus 4）写进仓里 `.claude/agents/fleet-*.md`，派活默认用它们；模型用完整 id、tools 白名单、带 Edit 的进独立工作树、汇报首行写模型 id；`.claude/agents/` 进标准路径（补充 0034、0035） | 采纳 |
| [0038](0038-public-repo.md) | 仓：fleet-dao 公开，三样并进来，两个旧仓只读存档 | 采纳，未复核 |
| [0039](0039-engine-and-cockpit.md) | 结构：一个仓两块，引擎和驾驶舱共用一个数据库 | 采纳，未复核 |
| [0040](0040-github-issue-is-source.md) | 任务：以 GitHub issue 为准，驾驶舱是它的驾驶舱 | 采纳，未复核 |
| [0041](0041-start-unless-human-gate.md) | 放行：AI 直接开工，只有对外发布、花钱、删数据、改标准停下等人 | 采纳，未复核 |
| [0042](0042-two-founders-feishu.md) | 人：两位创始人用飞书登录，写 GitHub 由机器人代发 | 采纳，未复核 |
| [0043](0043-hong-kong-facade.md) | 访问：香港当门面，法国不对外开端口，域名用 DigitalPlat | 采纳，未复核 |
| [0044](0044-feishu-and-inbox.md) | 通知：飞书机器人加驾驶舱提醒中心 | 采纳，未复核 |
| [0045](0045-model-policy.md) | 模型：构建期用 Opus，判断先用 Jev，子代理分三档且永不用 Fable | 采纳，未复核 |
| [0046](0046-dispatch-mix.md) | 派工模型：渠道、族、模型、执行方式、阶段自由组合，GPT 不碰界面 | 采纳，未复核 |
| [0047](0047-ranking-with-explore.md) | 推荐：人排先后，额度和战绩微调，大约一成用来试探 | 采纳，未复核 |
| [0048](0048-idle-must-not-invent-work.md) | 闲置：渠道空了按序找活，不许 AI 自己编活 | 采纳，未复核 |
| [0049](0049-official-cli-first.md) | 接法：优先官方命令行，够不到再套自己的写码外壳 | 采纳，未复核 |
| [0050](0050-temporal-postgres-jev.md) | 底座：Temporal、Postgres、Jev | 采纳，未复核 |
| [0051](0051-france-hong-kong-ha.md) | 高可用：法国干活、香港门面，各自一条命令重建，加看门狗和每晚备份 | 采纳，未复核 |
