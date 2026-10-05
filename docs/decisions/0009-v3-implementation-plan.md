# 0009 v3 实现排期（依据 6 路调研收割）

- 日期：2026-10-02 下午（接手会话后）
- 谁拍的：指挥官（依据创始人 2026-10-01 晚「无人值守推进」+
  2026-10-02 14:49「资源分配：派足够多的 sub agent 和 worker flow，
  24 小时去做这件事情」+ 09-29「要删的东西都要删」）
- 状态：执行中
- 现状（2026-10-05 回写）：已完成，留作历史。v3 已发布（#991，tag `v3`），里程碑 v3 已关，剩下的活归 v4；本份要删的 `docs/plan-rebuild-draft.md` 已删。
- 关联：specs/509-需求梳理/执行计划.md（顺序不变，本决定落实
  在同一步里**谁先谁后、谁做、依赖谁**）；0003-fusion-flow.md（已被取代，
  另开 `0003-retire` 切片处理）；agent 收割报告 w56jpm7sa.output

## 排期表（按依赖，自上而下串行；同一层的并行）

「工时」是单 agent 一次跑完一个切片的估计；切片全部是 ≤1500 行 diff、
每一片单独 PR、CI 绿就合（标过闸门的除外）。

### W0 当下不要做的（关掉、降级、或并入别处）

| 单 | 处置 | 理由 |
|----|----|----|
| #440 | 关掉留史 | 机制（合并队列报警）是 Fusion 概念，#567 又把 #445 已删的加回来；不重启 |
| #489 | 关掉留史（先救 spec 到主线） | PR #564 已修第 1 条；第 2/3 条属旧 Fusion 会话模型，被 #509 取代 |
| #531 | 关成完成（补一行 cli.ts 残留） | PR #568 已合 + 主线已有 结果.md |
| #69 | 改写正文（讨论半已落 discuss skill + 0006）或关掉留史 | goals 附表本来就建议关；讨论半由决定 0006 钉死，「定期巡审」无落点 |
| #454 | 关掉留史（先把「推送令牌只限本仓」挪到 #450 母单 W4 切片） | 「Grok 普通模式」被 #509 删「两个模式」+ #561 内存准入取代；令牌由小号 GitHub App 更干净 |

### W1 文档对齐（无闸门，先做，**和主线并行**）

| ID | 片 | 依赖 | 工时 |
|----|----|----|----|
| decisions-retire | docs/decisions/{0003,0002} 标替代、0008 补记、删 plan-rebuild-draft | — | 30min |
| goals-sec7-finalize | goals.md 第七节 4 条已定搬进七之附、删「不按 0003」过期间门、附录刷新 | — | 20min |
| design-banner-refresh | design.md 行 3 横幅口径指 509 方案 + 5 个旧节加「先别照做」 | — | 30min |
| agents-md-repo-sec | AGENTS.md 本仓段（48、51、52、56 行）同步新口径；**这是唯一一处要改 AGENTS.md** | — | 30min |
| progress-temp-table | docs/PROGRESS.md 加「生效中的临时调整」表（两条 10-05 到期） | agents-md-repo-sec | 15min |
| ops-stale-refs | ops.md 行 571/578/596/608 Fusion + 认领账段收口为现状指针 | — | 40min |

**W1 只做文档，不碰代码、不开单、不改 standard-paths**，全程无闸门。能放进一个 PR（docs/plan）。

### W2 当场修（修完就关单的小件，挂 #509 下新子单）

按 AGENTS.md「发现问题当场修」（不修就关别让新的撞上）：

| ID | 事 | PR |
|----|----|----|
| fix-531-handover-usage | cli.ts:440 的 HANDOVER_USAGE 删 `--term` 字样 | 1 个 |
| s489-spec-salvage | fleet/489-fed73e02c 分支里 spec 捞到主线 | 1 个 |
| fix-354-ops-doc-drift | docs/ops.md 删一句旧 #246 指针 | 已合进 W1 |

每个都很小（10-50 行），3 个 PR 一次跑。

### W3 需要创始人拍的（开单，不动手写）

| 事 | 类 | 备注 |
|----|----|----|
| skills-claim-cleanup（#446 脚本那半）删 claim.mjs/doing.mjs/doing-lib.mjs/seat-lib.mjs + SKILL.md、ops.md、design.md、goals.md 改写 | 改标准 | 已做完：创始人 2026-10-02 批「3. 同意」；PR 正文贴原话 |
| issue-close.ts 补 `--superseded-by` 参数 | 无 | 但改变关单行为，写测试 |
| #227 改走「release PR + GitHub Actions」 | 先审后合 | 单独 PR |
| 删认领账库表 `issue_claims`/seat_*（属于 goals §6 第 4 条删数据） | 删数据 | 离开本 PR 范围 |
| 法国引擎重开（10-05 到期）、法国发布机制形状、飞书推不推、#323 开关放哪、#454 关单 | 四类 | 列进「要我拍的」 |

### W4 代码实现主线（**只能一条线跑**）

文件冲突带：`packages/engine/src/workflows/`、`packages/engine/src/real/sessions.ts`、`packages/engine/src/decisions/`、`packages/api/src/issue-intake.ts`、`packages/db/src/schema/work.ts`，**相邻切片只能串行**。

按依赖顺序（每一行 = 一个 PR）：

| 顺位 | ID | 单 | 事 | 依赖 | 工时 |
|------|----|----|----|----|----|
| 1 | **554-1** | #554 | 无头一次性子进程段 runner（新模块，**不动 Fusion**） | — | 大 |
| 2 | **554-2** | #554 | done-check 重做到看 CI 绿而非会话自报 | 554-1 | 中 |
| 3 | **554-3** | #554 | 按改动面分档判据（纯函数 tier.ts，无调用方） | 554-1 | 小 |
| 4 | **554-4** | #554 + 暂时挂 #556 | runs 表 schema + 迁移 | 554-1；碰迁移先审后合 | 小 |
| 5 | **555-1** | #555 | 合前一次冷调用 verifier-invoke（新模块） | 554-1 | 大 |
| 6 | **555-2** | #555 | 接通合并闸 verdict | 555-1 | 中 |
| 7 | **555-3** | #555 | verify_rounds 改 runs 表 | 554-4, 555-1 | 小 |
| 8 | **555-4** | #555 | 删除旧 verifyRound + second-opinion 垫片 | 555-2 | 小 |
| 9 | **556-1** | #556 | 删 workflows/{fusion,requirement,subtask,merge-queue,sync-mainline} + decisions/{triage,plan,delivery,verify,merge} | 554-1, 555-2 | 大 |
| 10 | **556-2** | #556 | 删 core/src/{flow,fusion}.ts + flow.default.json | 556-1 | 中 |
| 11 | **556-3** | #556 | 删 API 侧 Fusion 接活 + claim-status + 认领账读写 + seat-store | 556-1 | 大 |
| 12 | **556-4** | #556 | 删 repos.flow_* 列 + jobs/flow-config.ts | 556-2, 556-1；碰迁移先审后合 | 小 |
| 13 | **556-5** | #556 | runs 表补 segment 归类列 | 554-4 | 小 |
| 14 | **556-6** | #556 | 写作写入入口；双写 session_runs 保留（**不**在本 PR 删表） | 556-5 | 中 |
| 15 | **556-7** | #556 | 文档对齐（ops + design 第五九十五十六节） | 556-1, 556-3 | 小 |

### W5 并行轨道（**不踩 W4 那批文件**）

| 轨道 | 事 | 单子 | 依赖 |
|------|----|----|----|
| **驾驶舱** | tokens → home3 → home-api → changelog → issue-detail → models → delete-board → delete-dispatch → delete-task-detail → delete-soon-members → upgrade-demo | #182 #556 #227 #470 | home3 / home-api 不依赖 W4；delete-* 系列要在 home-api 先合 |
| **路由两层** | routing-two-layer-db → routing-two-layer-engine → quota-scheduler → mirasim-fix-routes → discuss-light → effort-config → usage-by-segment → org-switch-wrap | #76 #194 #345 #470 #69 #216 | routing-two-layer-db 可即时；engine 要在 554-1 之后 |
| **演练场** | #450 母单重写怎么算做完 → W5 演练子单 → #323 配置进仓对账 | #450 #465 #323 | 需 WSL 修（要创始人点 UAC）+ W4 落了 3-5 张 |

## 原则（已经拍的，不重问）

1. **先建新、后删旧**（#450 执行计划第 3 步原话「同一个 PR 删掉 Fusion 0–7 步」是说**删除和新建合在同一个 PR**；但#568 时已经验证「先小步建新、多 PR 上线，再一个 PR 删旧」更安全）。本排期用后者：W4 顺位 1-8 全是**新建不接管**，9-15 才是删除。
2. **一个会话一个切片、一个 PR**——防止「同一文件被两个 agent 同时改」。
3. **CI 绿就合**，除闸门（先审后合 / 改标准 / 四类）须另走。
4. **每片必须带「怎么算做完 + 怎么验」**——因为验收本来就靠它。
5. **删数据一律单独清单**（goals §6 第 4 条），永不在同一个 PR 里把删表混进来。

## 顺手要做的杂项

- GitHub 仓 settings 开 `delete_branch_on_merge = true`（修 365 个分支堆积的根因；不是标准、不是数据，不需要拍；但仓库设置本身要不要主理人改留给指挥官定）——已合并的 365 个分支用脚本一次删（squash 全在 main + refs/pull/N/head）。
- `#217` 单已存在（「检测机器 session 数量从而节制调度」），这条额度收割的教训挂在它下面。
