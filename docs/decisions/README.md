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
| [0017](0017-fable-only-in-founder-main-session.md) | Fable 只在创始人本机主对话里由他自己选 | 生效 |
| [0018](0018-org-switch-9-answers-2026-10-04.md) | 切号方案 9 条背景的回答 | 生效 |
| [0019](0019-founder-2026-10-05-five-answers.md) | 10-05 五件：发 v3、删追问库表、不做脱开、5 秒限时、被封号 | 生效 |
| [0020](0020-founder-2026-10-05-chain-breaks.md) | 断链三条：关单自动收口、里程碑关前搬单、开单先查旧单 | 生效 |
| [0021](0021-slim-before-replacing-temporal.md) | 引擎先瘦身（定时任务摘出 Temporal、失败规则表、看门狗），不直接换掉 Temporal；B 只放行「只加代码、假环境」 | 生效 |
| [0022](0022-retire-local-wsl.md) | 撤掉本机 WSL 演练台：机器注销、仓里删本机档机制；往后只剩法国 + 本机指挥官 | 生效 |
| [0023](0023-drop-second-opinion-gate.md) | 去掉「先审后合」这道合并闸：所有 PR 只看 CI（引擎 PR 的冷验收照旧）；风险是迁移误删表只靠 CI | 生效 |
| [0024](0024-subagent-by-default.md) | 派活默认用 Agent 子代理（Mirasim 面板里看得见）；脱离会话的工人只留无人值守、过夜、超 40 分钟的例外，起它要 `--detached` 理由 | 生效 |
| [0025](0025-subagent-lane-and-queue.md) | 子代理走自己的一道（钩子不套主会话的等待上限、催送、自动无人值守）；指挥官按队列派活；读代码先查 codegraph 索引 | 生效；「自动无人值守」那一层由 0026 从主会话也删掉 |
| [0026](0026-unattended-is-a-worker.md) | 无人值守改走脱离会话的工人；收尾钩子不再挡，起后台活不再自动开 | 生效；「这一轮结束、收尾不拦」由 0028 替代，工人那一层和「起后台活不自动开」保留；空壳函数和欠账账本由 0027 删掉 |
| [0027](0027-drop-shell-owed-and-channel.md) | 删掉收尾空壳和欠账账本；失败重试用完就停下，不再换渠道；通用段再砍短 | 生效 |
| [0028](0028-unattended-holds-the-turn.md) | 无人值守时会话这一轮不结束：只有自己跑了 `unattended.mjs on` 才挡收尾，盯工人（`watch --wait 55`）、记进度；12 小时、20 次空转、工人都收口等自动放行；工人那一层保留 | 生效 |
| [0029](0029-e2e-nightly-full-pr-changed-pages.md) | e2e 拆开：回归每夜在主线全量跑，PR 只点改动页（#1186）；「页面点验」和 CI 的 e2e 分开叫 | 采纳；第 3 条待 #1186 落地 |
| [0030](0030-unattended-uses-subagents.md) | 无人值守、过夜也用 Agent 子代理，不脱离会话；脱离的工人只在创始人明说时用 | 采纳；替代 0024 的无人值守例外和 0026、0028 的工人那一层 |
| [0031](0031-engine-intake-gate.md) | 引擎拉单门加判断：改 .github/workflows 的、被开着的 PR 引用的单不拉；pr:open --new-issue 自动贴本机做；单关了撤任务（#1194、#1197、#1198、#1199） | 采纳 |
| [0032](0032-release-by-main-commit.md) | 发版的单位是主线上的一个提交，里程碑只管计划；发版后恢复发版前的引擎状态；删掉 v<N> 标记、发布 PR、CHANGELOG 自动节那一层（替代 0011 里按版本发的一半） | 采纳 |
