# 数据与判断手册（Postgres 表、Jev、驾驶舱要的数据）

> **设计数据库表（`packages/db`）、接 Jev 判断题服务、做驾驶舱各页（`packages/api`、`packages/web`）之前读。** 对应设计 §四「为什么用 Postgres」、§六「断链怎么被发现」、§十「额度与账单」、§十一「Jev」、§十五「驾驶舱」、§十六「30 本账」「226 条记忆」两行。
> 讲清旧系统的账到底有多少、每本账的去留、旧数据的真实形状与分布、Postgres 表草案与保留期、Jev 的接口 / 题型 / 边界 / 实测准确度、旧看板可借的信息结构、驾驶舱每一页要什么数据；坑逐条写成测试用例。
> 来源：旧系统审计切片 s7（2026-09-24；VPS 本地时钟已过 09-25 01:00）。旧仓基线 windsurf-dao `b1ebd88d`（本机与 VPS 是同一个提交）。取数：本机读代码和 `~/.dao`；VPS 以服务用户身份只读（SQLite 一律只读打开）；gh 只读 1 次（windsurf-dao#818 正文与评论）。全仓记法见 [README](README.md)。
> 记法：没写仓名的 `文件:行` 都指 windsurf-dao 仓；`design §N` 指 fleet-dao `docs/design.md` 第 N 节；「VPS 读数」是 2026-09-24 当晚的读数，会随时间变；旧单一律写 `windsurf-dao#N`；「判例」指旧维护者的判例记忆（不公开）。

---

## 〇、先看结论

1. **「30 本账」不止 30 处。** VPS 的 `~/.dao` 顶层实有 78 项，登记表只覆盖其中 17 项。派工次数账 `ledger.db`、Jev 的花费账、金丝雀账、打标报告、飞书对话记录、控制面库都不在登记表里（§1.1）。迁移和「删掉 30 本账」要按真实落点来盘，不能只看登记表。
2. **战绩基本要从零攒。** fleet 时间线只有 38 行。带轮次和分数的新格式只有 14 行，其中 12 行以「卡住」收场；Jev 给的质量分只有 1 条。老的点将台事件账从 2026-09-18 起就没人写了。新系统的「额度和战绩自动微调」（design §3-10）开张时没有能用的样本，所以第一天就得在 Postgres 里按「子任务 × 阶段 × 路由」记账，样本不够时不改排序（§1.6、§2）。
3. **「花了多少」大部分读不到。** 用量库约 40 万行，只有 Cursor 那一路带金额。中转账本里 42% 的行有 token，但一行金额都没有。Claude 订阅只有窗口百分比。48 份执行档里定价已知的只有 4 份；13 个账号池里「付不付费」只知道 1 个。所以账单只能走「订阅月费按月摊 + 按量路由按实价」，账号池的计费方式要设成必填（§1.4、§5「账单」）。
4. **Jev 在线上判得准不准，基本没有真值。** 能和标准答案比的只有 3 道金丝雀题，每道 20 题；其中「重试判定」掉到 90%，基线是 100%，已经被自动停用。13 道影子题里，VPS 近 7 天只有 4 道有样本，没有一道攒到 50 条的切换线。离线考题的数字比较有参考价值：没见过的报错说法 18/18，正则只有 8/18；「15 ≥ 2×8 吗」这种贴线算术题，把握度只有 0.45。新系统要让驾驶舱「看得到它判得准不准」（design §11），就得把每次判断的**事后真值**一起落表：人改判、结局回填、金丝雀（§3）。
5. **Temporal 只留 30 天。** VPS 实测保留期是 720 小时。design §15.1 写的是「回放数据来自 Temporal 历史」，超过 30 天就回放不了，战绩也一样。回放和战绩要从 Postgres 的步骤表和状态变化表读（§2、§6-A10）。
6. **测试写进真账本的事还在发生。** `tests/fleet-timeline.test.js` 靠改 `HOME` 把家目录挪到临时目录。可 Windows 上 `os.homedir()` 读的是 `USERPROFILE`，所以本机 09-22 到 09-24 的真账本里多了 24 行假调用（输入是测试夹具 `issue:17 / w/done`）。断言只查临时目录，所以测试一直是绿的（§6-G1）。新系统的测试要用独立的库，生产连接串不能有默认值。
7. **派单器的现场读数印证了「没人盯就停」。** VPS 最近一轮：执行槽 3 个一个都没占，6 道闸全过，结果一张单都没派。跳过的 45 张里，41 张是因为缺一个「只有人能贴」的 `triage/accepted` 标签（§1.5）。

---

## 一、旧账盘点

### 1.1 数量核对

| 口径 | 数 | 出处 |
|---|---|---|
| 登记表 | 30 本（另有 2 条忽略） | `docs/stores/registry.json`、`docs/stores/README.md:6` |
| VPS `~/.dao` 顶层实有 | 78 项 | VPS `ls -1A` |
| 其中被登记表的顶层路径覆盖 | 17 项 | 同上对比 |
| 登记表外的有状态落点（举例） | `dispatcher/`（`ledger.db`、`last.json`）、`control-plane.db`、`judge-spend/`、`judge-canary/`、`judge-triage/`、`judge-mismatch/`、`hub-chat/`、`master-sentinel/`、`leg-expiry.json`、`leg-catalog/alive.json`、`broadcast-digest.json`、`board-watch.json`、`progress-watch.json`、`board-stuck.json`、`feishu-groups.json`、`feishu-threads.json` | VPS `ls`；各落点的说明在 `host/machine/INDEX.md:66-123` |
| 写方已退役、文件还躺在盘上 | `provider-health.json`、`provider-breaker.json`、`gh-events.json` | `host/machine/INDEX.md:116`、`:118`、`:120` |
| 登记表外、仓里也 grep 不到写方 | `judge-shadow/recall-gate.jsonl`（1 行，2026-09-22） | VPS 读数；`grep -rn recall-gate` 在 `docs/jev`、`scripts`、`host/skills` 里都没有结果 |
| 其余 | 探针目录、日志、临时脚本、PR 正文草稿等杂物，约 20 项 | VPS `ls` |

### 1.2 登记表 30 本逐本判去留

「要形状，不搬数据」的意思是：新表照着旧的字段设计，旧数据不导入。

| # | id | 是什么 | 新系统 | 落到哪 | 依据 |
|---|---|---|---|---|---|
| 1 | execution-usage-rows | 用量一条一文件（已退役） | 丢 | — | `docs/stores/registry.json:9-19`；教训见 §6-B1 |
| 2 | execution-usage-db | 用量库 `usage.db` | 要形状，不搬数据 | `usage_events`、`quota_readings` | §1.4 |
| 3 | execution-usage-checkpoints | 采集游标 | 丢这个形态 | 真有外部源要轮询时，放 `job_runs` 的游标字段 | `registry.json:36-47` |
| 4 | execution-usage-collection | 采集器每轮的结果 | 要语义 | `job_runs`（成 / 部分 / 没查成 + 缺口码） | `registry.json:48-59`、`INDEX.md:100` |
| 5 | execution-usage-pool-quota | 额度快照的跨进程缓存 | 丢（Postgres 本身就是共享读数） | `quota_readings` 的「每窗口最新一条」视图 | `scripts/lib/pool-quota.mjs:8-15` |
| 6 | execution-usage-quota-alarm | 额度到 80% 报警的去重账 | 要语义 | `notifications.dedupe_key` + `notification_deliveries.message_id` | `INDEX.md:102` |
| 7 | execution-sessions | 会话记录（一会话一文件，VPS 有 1224 份） | 要 | `sessions` | §1.6 |
| 8 | ledger-events | 点将台事件账（2160 份，09-18 起停写） | 要类型设计，不搬数据 | `task_steps`、`scorecards`、`audit_log` | §1.6 |
| 9 | issue-gateway-idempotency | GitHub 写操作的幂等键 | 要 | `idempotency_keys` | `registry.json:109-121` |
| 10 | judge-shadow | Jev 影子对照账 | 要 | `judge_calls`（模式 = 影子）+ `judge_truths` | §3 |
| 11 | judge-calls | Jev 逐次调用留痕（保 7 天） | 要，保留期加长 | `judge_calls` | §3、§2.3 |
| 12 | preflight | 派前探针日志 | 丢这个形态 | `route_probes` | `registry.json:148-160` |
| 13 | unit-fresh | systemd 单元新鲜度 | 丢（新系统不用 systemd 定时器） | `job_runs.last_success_at` | `INDEX.md:68` |
| 14 | execution-acp | ACP 会话工作区 | 丢 | —（谁创建谁回收，design §16） | `registry.json:174-186` |
| 15 | execution-acp-sessions | 同上 | 丢 | — | `registry.json:187-199` |
| 16 | execution-native | 原生执行的中间产物 | 丢 | — | `registry.json:200-212` |
| 17 | execution-usage-config | 采集阈值配置 | 丢这个形态 | `settings` | `registry.json:213-224` |
| 18 | apps | GitHub App 私钥等凭据 | 要，但不进库 | 机器本地配置 + 加密备份（design §14） | `INDEX.md:70` |
| 19 | fleet-timeline | 任务时间线（旧的战绩长期档案） | 要形状 | `task_steps`、`scorecards` | `scripts/lib/fleet-timeline.mjs:1-11` |
| 20 | debt | P2/P3 审查意见的「债册子」 | 丢这个形态 | `review_findings`（状态 = 未处理） | `INDEX.md:78` |
| 21 | execution-leases | 会话租约 | 丢 | Temporal 活动心跳 + `sessions` 的进程字段 | `registry.json:261-273` |
| 22 | archive-cancelled-trees | 取消时把脏树存档 | 要语义 | `artifacts`（补丁存盘或 R2，库里只记路径） | `INDEX.md:94`；windsurf-dao#1753、#1745 |
| 23 | fleet-escalations | 卡住时的上报载荷 | 要 | `escalations` | `packages/fleet/src/escalation.mjs:1-12`；windsurf-dao#1714 |
| 24 | model-discovery | 新模型扫描出的提案 | 要 | `model_candidates` | `INDEX.md:83` |
| 25 | fleet-handoff | fusion 模式主副手交接 | 丢 | — | `registry.json:311-323` |
| 26 | mirasim | 审官会话登记 | 丢 | `sessions` | `registry.json:324-336` |
| 27 | worktree-gc | 收树日志 | 丢 | `task_state_changes`（回收事件） | `INDEX.md:111` |
| 28 | temporal | Temporal 的 SQLite 库 | 外部系统 | Temporal 自己在 Postgres 里的库 | `registry.json:350-361` |
| 29 | store-retire | 账本清理器的执行留痕 | 丢 | `job_runs` | `INDEX.md:112` |
| 30 | commander | 指挥官快照（已退役） | 丢 | — | `registry.json:375-386`；windsurf-dao#1793（曾堆 1610 份、2.1GB 没人清） |

### 1.3 登记表外、新系统也要的数据

| 旧落点 | 内容 | 新表 |
|---|---|---|
| `dispatcher/ledger.db` | 同一张单派了几次、每天派几张 | `subtasks.dispatch_count` + 每日视图 |
| `dispatcher/last.json` | 每轮 6 道闸的读数 + 每张单跳过的原因码 | `dispatch_decisions` |
| `judge-spend/` | Jev 每日 token 与次数、每任务上限、当日缓存 | 从 `judge_calls` 聚合出来，不另存一本账 |
| `judge-canary/` | 金丝雀准确率与停用标记 | `judge_canary_runs` |
| `judge-triage/` | 打标器报告，以及和人贴标签的对照 | `judge_calls` + `judge_truths` |
| `hub-chat/` | 飞书总控群对话（问句、意图、回复、落到哪张单） | `feishu_messages` |
| `broadcast-digest.json` | 日报队列 | `notifications`（级别 = 日报） |
| `leg-expiry.json`、`leg-catalog/alive.json` | 路由探针的实测结果 | `route_probes` |
| `control-plane.db` | Mirasim 握手可不可达 | `route_probes`（渠道可达） |
| `master-sentinel/` | 主线哨兵的复核与回退记录 | 删（design §16 改成合并队列），语义进 `merge_queue` |

### 1.4 `usage.db`：字段与实测分布

**库表**（`scripts/lib/usage-store.mjs:22-42`）：一张 `rows` 表。`id` 是内容的 sha256 主键；`row` 存原样 JSON，是唯一真相源；另有 11 个索引投影列：`schema`、`source`、`agent`、`task_id`、`session_id`、`model`、`provider`、`timestamp`、`kind`、`scope`、`written_at`。建了 4 个索引：agent、task_id、timestamp、(scope, timestamp)。库开了 WAL，schema 版本记在 `PRAGMA user_version`（=1）。

**行 JSON 的字段**（`scripts/lib/execution-usage.mjs:304-323`）：

- 身份与归属：`source`、`agent`、`taskId`、`attemptId`、`sessionKey`、`sessionId`、`turnId`、`profileId`、`accountPoolId`、`accountId`（只存 `acct:<sha256>`，`:267-270`）、`route`、`apiSource`
- 厂商与模型：`provider`、`reportedProvider`、`billingSource`、`model`、`reportedModel`
- 语义：`kind`（delta / cumulative / unknown）、`scope`（call / turn / session / account）、`counterEpoch`、`timestamp`
- 数值：`metrics{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, durationMs}`、`estimate{amount, unit}`、`charge{amount, unit}`、`balance{amount, unit}`
- 额度：`allowance{spent, limit, unit, window, sharedWith}`、`accountingWindow{start, end, complete}`
- 去重：`identity`、`aliases[]`（多来源同一次调用靠并查集合并，`:1075-1105`）
- 自评：`completeness{tokens, charge, semantics, attribution, identity}`

**VPS 读数**（约 0.9GB，约 40 万行，时间跨度 2026-09-02 到 09-24）：

| source | scope / kind | 行数 | 挂到任务的 | 带金额的 | 带 token 的 |
|---|---|---|---|---|---|
| cursor-account | session / cumulative | 210,623 | 全部 | 210,776（本行与下一行合计） | 同左 |
| cursor-account | account / cumulative | 3,620 | 0 | ↑ | ↑ |
| mirasim-ledger | call / delta | 108,828 | 44,646（41%） | 0 | 45,732（42%） |
| mirasim-traffic | call / delta | 74,685 | 45,367 | 0 | 0 |
| mirasim-session | session / cumulative | 937 | 595 | 0 | 937 |
| devin-acp | call / unknown | 627 | 627 | 0 | 0 |
| grok-native | turn / delta | 482 | 0 | 0（估算 440） | 448 |
| native-status | session / cumulative | 278 | 278 | 0 | 0 |
| mirasim-relay-account | account / cumulative | 231 | 0 | 0 | 0 |
| reclaude-org-switch | account / cumulative | 17（09-24 才开始记） | 0 | 0 | 0 |

从这张表能读出四件事：

- **只有 Cursor 那一路有金额**，来自 Cursor 的 Dashboard 接口。其余渠道的「花了多少」只能靠订阅摊销来算。
- **Cursor 的会话累计快照占全库 53%**：同一个会话每采一次就追加一条累计值。新表对累计值要按会话 upsert，只留最新一条（§6-B6）。
- **中转的账本和流量记的是同一批调用**，靠别名合并；流量那一路一行 token 都没有。
- **额度快照（scope = account）只有 3 个来源**：Cursor、中转账号、Claude 订阅。xAI、Kimi 等池子没有读数来源（§5「额度」）。

VPS 上的额度快照缓存（`pool-quota.json`，2026-09-24 17:21Z）：

| 池 | 窗口 | 已用 | 离清零 |
|---|---|---|---|
| Cursor 订阅 | 月度美元额度 | 约 56% | 到 10-16 |
| 中转（anthropic / openai / other 三个池共用一个窗口） | 7 天点数 | 约 56% | 到 09-29 |
| Claude 订阅（reclaude） | 7 天窗口 | **0%** | 到 09-26 |

Claude 订阅窗口已用 0%，正是 design §2 说的「派工从不走 Claude 订阅那条线」。另外有一条 Cursor 快照的 `accountPoolId` 是空的，归不到任何一个池。

### 1.5 `ledger.db`（派工次数账）与派单器报告

- 库表（`scripts/lib/dispatcher/ledger.mjs:19-22`）：`items(key TEXT 主键 = "仓#单号", count INT, at TEXT)`、`days(day TEXT 主键, count INT)`。同一张单最多派 3 次（`:1`，`DISPATCH_LIMIT`）；自增是单键原子操作（`:168-199`）。
- VPS 读数：10 张单、共 13 次派工。09-22 派了 8 次，09-23 派了 4 次，09-24 派了 1 次。
- 派单器最近一轮报告（`dispatcher/last.json`，2026-09-24T17:22Z）：
  - 6 道闸全过：可用内存 9.6G（下限 1.5G），Mirasim 常驻内存 582M（上限 3G），工作树 4 棵（上限 20），腿健康，在途 0（上限 5），今日已派 1（上限 20）。
  - 执行槽 3 个一个都没占，这一轮**派出 0 张**。
  - 跳过 45 张：`no-accepted` 41 张（原因写的是「没有 triage/accepted（只有人能贴）」），`local-lane` 3 张，`manual` 1 张。

对驾驶舱来说，这份报告的形状（每道闸 `{name, value, limit, pass, unscanned}`，加上每张单 `{issue, why, code}`）正好能回答 design §4 说的「排队的任务在驾驶舱写明在等什么」。

### 1.6 其它值得照着设计的数据形状

**会话记录**（VPS 样本的字段）：`recordKey`、`sessionKey`、`launchId`、`attemptId`、`backend`、`agent`、`model`、**`requestedModel` 和 `actualModel`**、`profileId`、`provider`、`accountPoolId`、`actualVendor`、`route`、`taskId`、`issue`、`pr`、`workdir`、`createdAt / startedAt / updatedAt`、`state`、`launchState`、`observedState`、`taskCompleted`、`owner{pid, …}`、`vendorTaskId`、`recovered`、`failure{class, kind, detail, retryAt}`、`cleanupVerified`。

VPS 1224 份记录的状态分布：`stopped/done` 648，`stopped/failed` 155，`rejected` 84，`stopped/completed` 85，`stopped/running` 83，`stopped/unknown` 55，`stopped/incomplete` 32，其余零散。带失败原因的 137 份里，**117 份（85%）归不了类**（`unknown:no-reason` 82、`unknown:unrecognized` 35）；上游 16 份，账号 3 份，我方 1 份。错误分类弱，和 design §12「先认结构化信号，再认已知文本，最后交 Jev」对得上。

**点将台事件类型**（`schemas/events.schema.json`，写入规矩在 `scripts/lib/event-writer.mjs:1-12`：一事件一文件、写一次不可改、纠错另立撤回事件）：

- `job.opened`：`task_class, work_type, scale, risk, reversible, candidate_models, selected, why`
- `job.dispatch`：`model, model_version, price_snapshot, decision_id, reviewer, branch, repo`
- `job.meter`：`token_in, token_out, cache_hit, usd_cash`
- `job.handoff`：`from_model, to_model, reason`
- `job.closed`：`success, rework, usd_cash, usd_economic, merged_by`
- `attr.rule / attr.llm / attr.human`：失败责任拆成四份——模型、任务书、协调、环境——加上把握度和证据
- `sub.usage`：`included_tokens, used_tokens, quota_left`
- `decision.pending / decision.resolved`、`session.state`、`incident`、`audit.*`

VPS 实有：`job.dispatch` 1249、`job.opened` 284、`job.closed` 271、`attr.rule` 259、`job.handoff` 83、`session.milestone` 11、另有两类各 1 条。**`job.meter` 和 `sub.usage` 一条都没有**，也就是说，每单花了多少钱从来没进过这本账。最后一条事件写于 2026-09-18，之后写方停了，可登记表还写着「永久、仓内最成熟的一套」（`registry.json:97-108`）。

**时间线分数**（`scripts/lib/fleet-timeline.mjs:21-37`、`:76-96`）：每条分数是 `{name, value, dataType, role(lead / executor / reviewer), source(code / judge / human), rubric_version, evidence_ref, at}`。judge 分必须带 `rubric_version`，human 分必须带证据链接。代码算的分有：`rounds`、`p1_total`、`p2_total`、`ci_red`、`rework_rounds`、`resolved`、`lead_time_ms`、`change_failed`（最后这项是占位，一律 null）。

VPS 时间线 38 行：completed 10，blocked 21，cancelled 6，terminated 1。新格式（schema 2）14 行，其中 blocked 12 行。judge 分只有 1 条（quality = low，拖累来自 executor）。

**卡住上报载荷**（`packages/fleet/src/escalation.mjs:1-12`、`:32-50`）：`taskId, repository, issue, generation, phase, state, blockedReason, failureClass, loop, attempts{round, reviewRounds, reviewRoundsUsed, otherRounds, …}, evidence`（只放判据，不放叙述）、`candidates`、`options ∈ {retry, swap-leg, cancel, accept-as-is}`。

**issue 网关审计**（VPS 共 4711 行）：`ts, host, action, idempotency_key, repo, bot, ok, stage, error, url, number, replay, author`。写完要回读作者，拿到 URL 不算成功（`scripts/lib/issue-gateway.mjs:1-6`）。

---

## 二、Postgres 表草案

### 2.1 原则（每条都对应一个旧坑）

1. **一件事只存一处**；派生出来的只做视图。读视图的地方要能自证覆盖：视图的行数对不上源，就报缺口（§6-A4）。
2. **每张表都写明写方和应该多久写一次**。每小时对账时查「写方失联」。旧的健康表、熔断表、点将台，都是写方悄悄没了、读方还在用（§6-A2）。
3. **读出来的东西一律三态**：有、查过确实没有、没查成（外加「部分没查成」）。前端不许把「没查成」画成绿色（`scripts/lib/now-board.mjs:45-77`）。
4. **钱用整数分加币种，token 用 bigint，时间用 timestamptz；「不知道」存 NULL，不存 0**（`scripts/lib/usage-store.mjs:49`；`scripts/lib/execution-usage.mjs:238-242`）。
5. **账号只存不透明标识**（`scripts/lib/execution-usage.mjs:267-270`）。邮箱、组织编号、密钥不进这些业务表；密钥放机器本地配置（design §14）。
6. **追加型的表都要写明保留期和理由**，照旧登记表「保留期按条判」的做法（`docs/stores/README.md:8`），并用测试钉住。
7. **测试用独立的库或 schema，连接串没有默认值**（§6-G1）。
8. **「请求的」和「实际的」分两列存**，比如请求模型和实际模型（§6-B8）。

### 2.2 表清单

★ = 首批就要，巡检任务（design §6「断链怎么被发现」第 3 条）要跑通，离不开这些表。

**配置：调度台、渠道、模型**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ channels | id, name, kind（订阅 / 接口 / 中转）, billing（套餐内 / 按量）, status | 人（设置页） | 调度、渠道页 |
| ★ account_pools | id, channel_id, label（占位名）, **paid（必填）**, billing_unit, monthly_fee_cents, currency, quota_source（怎么读额度；读不到就写 null 加原因）, windows（jsonb，比如 5 小时滚动、周窗）, shared_group, concurrency_limit, declared_until（有效期）, status, paused_until, pause_reason, pause_evidence | 人；AI 帅位可以暂停 | 调度、额度页、账单页 |
| ★ models | id（规范 id）, family, display_name, tier, capabilities, pricing（jsonb，带「已知 / 未知」和来源）, status（在册 / 候选 / 退役）, discovered_at | 人、模型扫描 | 模型目录、调度 |
| ★ executors | id（claude-code / codex / cursor-agent / grok / 接口外壳）, can_write, can_resume, progress_log_format, tested_version | 人 | 调度、插头 |
| ★ routes | id, pool_id, model_id, executor_id, expected_model_id, billing, enabled | 人；AI 帅位可以下架 | 调度、各页 |
| ★ stage_types | id（分诊 / 规划 / 写码 / UI / 测试 / 审查 / 调研 / 判断）, needs（jsonb，比如「要能改文件」） | 人 | 调度 |
| ★ route_orders | stage_type, position, route_id, enabled, pinned_by（人钉住的，AI 帅位不许动） | 人、AI 帅位 | 调度 |
| bans | family 或 model, stage_type（或「全部」）, reason, decided_by | 人 | 调度（过滤） |
| spend_caps | pool 或 route, month, cap_cents | 人 | 调度、账单 |
| ★ config_versions | id, at, actor, reason, diff（jsonb）, reverted_by, reverted_at | 驾驶舱后端 | 调度台（一键撤回）、操作记录 |
| model_candidates | model_id, source, judge_answers, code_checks, state | 模型扫描 | 模型目录 |

**任务：GitHub 镜像加引擎**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ repos | full_name, enabled, default_branch, interaction_limit_until | 人、续期任务 | 各页 |
| ★ gh_issues | repo, number, title, state, author, labels, body_hash, updated_at, synced_at | GitHub 事件接收 + 每小时对账 | 驾驶舱（不直接查 GitHub） |
| ★ gh_prs | repo, number, head_sha, state, draft, mergeable, checks_state, files, synced_at | 同上 | 任务页、合并队列 |
| ★ requirements | id, repo, issue_number, spec_dir, proposer_member_id, understood_as, status, workflow_id | 引擎 | 看板、任务页 |
| ★ subtasks | id, requirement_id, title, touches（jsonb，会动哪些地方）, depends_on, status, dispatch_count, branch, pr_number, workflow_id, estimate_minutes | 引擎（规划那一步） | 看板、调度（防撞车） |
| ★ task_steps | id, subtask_id, step, route_id, attempt, queued_at, started_at, ended_at, outcome, failure_class, why_route（一句话原因） | 引擎工人 | 看板、回放、战绩 |
| ★ task_state_changes | entity, entity_id, from_state, to_state, at, cause | 引擎 | 回放、停滞判断 |
| ★ human_gates | id, subtask_id, kind（发布 / 花钱 / 删数据 / 改规则）, asked_at, decided_by, decision, decided_at, via | 引擎、驾驶舱、飞书 | 总览、通知 |
| escalations | 载荷照 §1.6 的形状, resolution, resolved_by | 引擎 | 任务页、通知 |
| review_findings | pr, round, session_id, severity, file, line, detail, fingerprint, status | 第二意见会话 | 任务页、战绩 |
| merge_queue | repo, pr_number, position, state, retest_sha, enqueued_at, merged_at | 引擎 | 任务页、总览 |
| dispatch_decisions | at, subtask_id, gates（jsonb）, candidates（jsonb，含淘汰原因）, chosen_route, explore, why | 引擎 | 调度台、任务页 |

**会话与进度**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ sessions | id, subtask_id, stage_type, route_id, executor, **requested_model, actual_model**, vendor_session_id（续会话用）, worktree, pid 或 cgroup, started_at, last_progress_at, ended_at, state, failure_class, failure_detail（原文）, retry_at | 引擎工人 | 看板「此刻」、任务页、战绩、额度 |
| session_events | session_id, seq, at, kind（改文件 / 跑测试 / 命令 / 消息）, payload | 插头（读各家命令行的过程记录） | 直播、停滞判断 |
| ★ progress_steps | session_id, idx, text, state（未开始 / 进行中 / 完成）, updated_at | `fleet plan` | 看板进度条、issue 进度段 |
| progress_notes | session_id, at, text | `fleet say` | 任务页 |
| task_questions | requirement_id, session_id, question, answer, answered_by, via, asked_at, answered_at | `fleet ask`、飞书、issue | 任务页、通知 |

**用量、额度、账单**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ usage_events | session_id, route_id, pool_id, model, source, scope, kind, tokens_in / out / cache_read / cache_write / reasoning, duration_ms, charge_cents, estimate_cents, unit, observed_at, identity, aliases | 插头、采集任务 | 账单、战绩的成本列 |
| ★ quota_readings | pool_id 或 shared_group, window（5h / 7d / 月 / 点数）, used, limit, unit, resets_at, observed_at, source | 额度探测的定时任务 | 调度（过滤 + 快清零的往前提）、额度页 |
| quota_limits_learned | pool_id, window, limit, evidence, at | 引擎（撞到限额时） | 额度页、调度 |
| subscriptions | pool_id, fee_cents, currency, billing_day, valid_from, valid_to | 人（设置页，不进 git） | 账单 |
| cost_by_task（物化视图） | subtask, month, metered_cents, amortized_cents | 定时刷新 | 账单、战绩 |

**战绩**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ scorecards | subtask_id, stage_type, route_id, name, value, data_type, source（代码 / Jev / 人）, rubric_version, evidence_ref, at | 引擎收尾、Jev、人 | 战绩页、调度微调 |
| route_stats（物化视图） | route_id, stage_type, window, samples, success_rate, streak, cooldown_until, quality_mean, known（样本 ≥ 5 才算）, trend | 定时刷新 | 调度、战绩页 |

**Jev**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| judge_questions | id, where, qtype, options, max_effect（只报告 / 建议 / 否决）, confidence_line, on_unscanned, mode（在岗 / 影子 / 已停）, route_id | 人 | 引擎、Jev 页 |
| ★ judge_calls | id, at, question_id, subject, model（实际版本号）, ok, reason, ms, input_tokens, usd_micros, cached, answers, confidence, state_hash, state_head, state_ref | Jev 客户端 | Jev 页、战绩 |
| judge_truths | call_id, truth, source（人改判 / 结局回填 / 金丝雀）, at, by | 驾驶舱「改判」、收尾对账、金丝雀 | Jev 页（算准确率） |
| judge_canary_runs | question_id, at, asked, total, accuracy, baseline, stopped | 金丝雀定时任务 | Jev 页、客户端（停用开关） |

**通知与飞书**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ notifications | id, level（要人拍 / 卡住报警 / 日报）, subject, dedupe_key, title, body, link, created_at, resolved_at | 引擎、AI 帅位 | 通知中心、飞书 |
| ★ notification_deliveries | notification_id, channel, target（占位名）, message_id, delivered_at, error, attempts | 飞书插头 | 通知中心（没有 message_id 就算没送到） |
| follows | member_id, requirement_id | 人 | 飞书推送 |
| feishu_messages | at, chat（占位名）, member_id, text_head, intent, reply_card, landed_to, latency_ms | 飞书机器人 | 飞书端到端自测、通知中心 |

**人与审计**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ members | id, display_name, role（创始人 / 协作者 / 机器人）, access_email（只给登录鉴权用，页面上打掩码）, feishu_user, github_login（可以为空）, active | 人 | 权限、白名单 |
| permissions | role, action, allowed | 人 | 驾驶舱后端 |
| ★ audit_log | at, actor（成员 / AI 帅位 / 引擎）, action, target, before, after, reason, via, ok, error, github_url, idempotency_key | 驾驶舱后端、引擎、帅位 | 操作记录、撤回 |
| idempotency_keys | key, action, repo, result_url, at | GitHub 写入层 | 同上 |

**运维**

| 表 | 关键字段 | 谁写 | 谁读 |
|---|---|---|---|
| ★ scheduled_jobs | id, name, schedule, expect_every | 部署脚本 | 定时任务页 |
| ★ job_runs | job_id, started_at, ended_at, outcome（成 / 找到 N 条 / 没查成）, found, why, gaps | 各定时任务 | 定时任务页、看门狗 |
| route_probes | route_id, at, state（通 / 不通 / 没探）, why, latency_ms | 探测任务 | 调度（36 小时内的失败才淘汰，`scripts/lib/leg-choice.mjs:55-56`）、渠道页 |
| reconcile_findings | at, check, subject, expected, actual, auto_fixed | 每小时对账 | 总览、通知 |
| artifacts | subtask_id, kind, storage_path, bytes, expires_at | 引擎 | 任务页 |
| settings | key, value（jsonb）, version | 人 | 各处 |

### 2.3 保留期建议（要创始人拍）

- **永久**：配置和它的版本、任务、子任务、步骤、状态变化、`scorecards`、`audit_log`、`judge_truths`、`escalations`。这里面有「Temporal 只留 30 天」之后唯一的长期记录（`docs/stores/registry.json:243`）。
- **90 天**：`usage_events` 明细。旧系统的理由是跨月对账（`registry.json:26-29`）。按月汇总的数永久留。
- **30 天**：`session_events`（直播过程，量大）、`idempotency_keys`（`registry.json:113-117`）。
- **`judge_calls`**：旧系统保 7 天，是用户 2026-09-22 拍的（`registry.json:139-143`）。可要算准确率得跨周看，建议带真值的行永久留、其余留 90 天。
- 大表按月分区，过期就整个分区删，不逐行 DELETE。

---

## 三、Jev

### 3.1 模型与接口

| 项 | 值 | 出处 |
|---|---|---|
| 服务 | TypeSafe System One，`POST https://api.typesafe.ai/v1/systemone`，请求体 `{state, model, questions}` | `scripts/lib/judge-client.mjs:15`、`:268` |
| 模型 | `jev-latest`（**没钉版本**） | `judge-client.mjs:16` |
| 超时 | 8 秒 | `judge-client.mjs:17` |
| 密钥 | 从本机文件读，不打印、不进返回值 | `judge-client.mjs:8`、`:18` |
| 回包 | `answers{题号: {noul} 或 {choice, confidence}}` 加上 `usage.input_tokens` | `judge-client.mjs:275-276`、`:292-294` |
| 价格 | 每百万输入 token 0.042 美元，输出不计费 | `judge-client.mjs:23` |
| 延迟 | 离线实测单次 0.25–0.8 秒；VPS 生产各题平均 365–1430 毫秒 | `docs/exams/2026-09-21-judgment-model-where/question.md:22`；VPS `jev-calls` 读数 |
| 没成的原因 | `no-key / budget / budget-stop / task-cap / canary-stop / stale / timeout / network / http-<码> / bad-json / no-answers` | `judge-client.mjs:199` |
| 预算 | 日上限 0.30 美元；每任务每天 0.02 美元；同一题同一输入当天只问一次；花到日上限的 80% 起按顺序停题 | `judge-client.mjs:24-25`；`docs/jev/registry.json` 的 budget 节 |

两处不一致：

- **版本没钉。** 2026-09-22 的盲设计题三家的共识里有「版本钉死」（`docs/exams/2026-09-22-jev-in-loop/result.md` D 轴），客户端却一直用 `jev-latest`。金丝雀就是用来抓这种漂移的。新系统应该在 `judge_calls.model` 里记下实际响应的版本号，版本变了就触发一次金丝雀复测。
- **文案里手写的上限和代码对不上。** Jev 登记页有三处写着「受 judge-client 每日 $0.10 总上限」（`docs/jev/README.md:102`、`:206`、`:223`），代码里的值是 0.30（`judge-client.mjs:24`），同一页的预算表写的也是 0.30（`README.md:13`）。

### 3.2 题型与 20 处接线在新系统的去留

题型有三种（`docs/jev/README.md:396`）：**noul**（是非题，给概率）、**choice**（单选，带把握度）、**score**（打分）。20 处接线里没有一处用 score；2026-09-21 盲设计题三家也都说「打分题几乎没人用」（`docs/exams/2026-09-21-judgment-model-where/result.md` I 轴）。

| 旧接线 | 旧状态 | 题型 | 最多能引起 | 新系统 | 依据 |
|---|---|---|---|---|---|
| issue-labeler（七道题判活的类型、模块、风险、清不清楚……） | 在岗 | choice + noul | 贴标签 | **留**，改成分诊题 | design §11「分诊」 |
| lead-tier（领队用哪一档） | 在岗 | choice + noul | 建议 | 并进分诊里「多大」那一问 | design §11 |
| pool-veto（哪个池该让路） | 在岗 | choice | 否决 | **删** | design §16「Jev 选路 删」 |
| dispatcher-veto（该不该派、会不会撞模块、单子多重） | 在岗 | noul + choice | 否决 | **删**（撞不撞车改看方案里写明的改动位置，design §6） | design §16 |
| leg-pick（在候选路由里挑一条） | 影子 | choice | 建议 | **删** | design §16 |
| stop-gate（收尾时是不是承诺了下一步却没做） | 在岗 | choice + noul | 否决 | 钩子删；语义改成核实「说做完了是不是真做完了」 | design §11、§16 |
| task-quality（交付质量档 + 主要拖累是谁） | 在岗 | choice | 报告 | **留**，写进 `scorecards` | design §11 |
| pr-acceptance（验收是判据还是口号） | 影子 | choice | 否决 | 改成「PR 是否回应了需求文档」 | design §11 |
| failure-class / launch-failure / retry-verdict / capacity-death / failure-kind（五处失败归因） | 影子 | choice | 报告 | **合成一道**：「下一步该做什么」的残余分类 | design §12 |
| round-loop / p1-vs-contract（审查意见是不是同一条、是不是在质疑任务书） | 影子 | choice | 否决 | 留一道：「第二意见是不是同一条」 | design §5（最多 2 轮） |
| hub-intent / feishu-dedup（群消息意图、判重） | 影子 | choice | 建议 / 否决 | 飞书重做时再评估 | design §15.4 |
| issue-draft（机器开单时把草稿重排进模板） | 影子 | choice + noul | 否决 | **删**（长模板删了） | design §16 |
| priority-mismatch（最新评论要不要改先后） | 只出报告 | choice | 报告 | **删**（先后由人排） | design §3-10 |
| model-discovery（新模型归到哪一族、哪一档） | 影子 | choice | 建议 | **留** | design §16 |

**调用量会怎么变**：VPS 3 天生产调用 638 次，其中要删掉的 dispatcher-veto、pool-veto、leg-pick 三处合计 407 次，占 64%；lead-tier 的 18 次会并进分诊那一问，不再单独调用。

### 3.3 边界（旧系统实测加拍板出来的）

- **能拦不能放**：它的答案只能让流程更保守——不派、不停池、提醒人——不能放行、不能批准合并（`judge-client.mjs:4-7`；`docs/jev/README.md:5`）。
- **没查成不等于「否」**：连不上、限流、超时都返回 `ok:false` 加原因，调用方照原来的行为走，不抛异常（`judge-client.mjs:5-7`）。
- **低把握就是没判出来**。
- **数字比较不交给它**：读数字状态的题，答对时把握度也只有 0.47–0.61；贴线算术只有 0.45（`question.md:32-33`）。
- **钩子里不接**：每次工具调用、每条用户消息都要等它，用户每一步都感觉得到，而且钩子崩了就等于放行。2026-09-21 盲设计题三家共识（`result.md` C、G 轴）；旧 Stop 钩子是唯一的例外。
- **停整个账号池这种动作不能由文字判断来触发**，要有额度读数佐证（`result.md`「三臂都点到」一节）。
- **喂全文，别裁剪**：裁掉正文比追加噪声伤得重（`result.md` length-test）。
- **答了题面以外的选项**，这道题当天退回影子（`judge-client.mjs:281-286`）。
- **金丝雀准确率比基线差超过 5% 就自动停**，复测恢复后再自动解（`scripts/jev-canary.mjs:1-6`）。

### 3.4 调用量与花费（实测）

| 口径 | 数 | 出处 |
|---|---|---|
| VPS 3 天（09-22 到 09-24）留痕总行数 | 1118 行 = 生产 638 次 + 金丝雀复测 480 次 | VPS 逐行统计 |
| 生产调用按题分 | dispatcher-veto 389、stop-gate 78、issue-labeler 55、model-discovery 34、issue-draft 23、priority-mismatch 19、lead-tier 18、pool-veto 14、leg-pick 4、pr-acceptance 1、task-quality 1、caller 为 unknown 的 2 | VPS `node scripts/jev-calls.mjs --days 7` |
| 生产调用没成的 | 8 次：http-529 2 次、超时 4 次、no-key 2 次（后两次是 09-22 测试写进来的，输入为 `"s"`） | 同上；另见 §6-G1 |
| 每日花费（VPS，按输入 token 折算） | 09-21 34 次 / 14 万 token；09-22 211 次 / 51 万；**09-23 593 次 / 142 万（约 0.06 美元）**；09-24 300 次 / 41 万 | VPS `judge-spend/<日期>.json` |
| 本机 | 3 天 156 次，其中 task-quality 那 24 次全是测试夹具（§6-G1） | 本机 `jev-calls` |
| 离预算上限 | 峰值那天约 0.06 美元，是日上限的五分之一；最近 7 天没有因预算被停过的调用 | 同上，「今日无被停」 |

### 3.5 准确度：手上有什么数据

| 来源 | 结果 | 算不算「准确率」 | 出处 |
|---|---|---|---|
| 离线考题：报错分类 | 见过的说法 22 条：Jev 对 20，正则对 21。**没见过的说法 18 条：Jev 对 18，正则对 8**。Jev 错的 2 条都是「限流」和「额度」写在同一句里，把握度 0.5 和 0.67 | 算（有标准答案） | `question.md:30` |
| 离线考题：这张单能不能直接派（18 张真单对人贴的标签） | 把握线 0.5：错放 1、错拦 1；把握线 0.7：错放 0、错拦 8。反例只有 4 张 | 算，但样本太少 | `question.md:31` |
| 离线考题：看门狗式判断 9 例 | 9/9。读文字的题把握度 0.96–0.98；读数字状态的题虽然对了，把握度只有 0.47–0.61 | 算 | `question.md:32` |
| 离线考题：数字规则 8 例 | 8/8，但贴线算术把握度 0.45 | 算 | `question.md:33` |
| 离线考题：输入长度 | 追加约 5 万字无关日志，答案变化 ≤ 0.08；只给相关小节、裁掉其余正文，「有没有只有用户能拍的决定」从 0.76 掉到 0.30 | 算 | `docs/exams/2026-09-21-judgment-model-where/result.md` |
| 金丝雀（VPS，2026-09-24） | hub-intent 100%；priority-mismatch 100%；**retry-verdict 90%，上一轮 85%，基线 100%，状态「已停」** | 算（每道 20 题） | VPS `judge-canary/*.json` |
| 影子对照：model-discovery | 和代码归类一致的 8/28，约 29% | 不算：对照的是代码的启发式，不是真值 | VPS `judge-shadow/model-discovery.jsonl` |
| 影子对照：其余 | leg-pick 1 条（不一致）；issue-draft 23 条（没有对照方）；pr-acceptance 1 条；hub-intent、feishu-dedup、retry-verdict、failure-class、launch-failure、capacity-death、round-loop、p1-vs-contract、failure-kind 近 7 天**零样本**；没有任何一道攒到 50 条的切换线，也没有切换文件 | — | VPS `judge-shadow/`；切换线在 `scripts/lib/judge-shadow.mjs:13-15` |
| 打标器对人贴的标签（09-21 报告，7 张单） | 两边都贴了的 7 个标签全一致，0 处分歧；另外它提了 14 个人没贴的标签，对错判不了 | 部分算，样本太小 | VPS `judge-triage/2026-09-21.json` |
| stop-gate（VPS 78 次） | 判「承诺了没做」29 次，只拦了 1 次（把握度 ≥ 0.7 的只有那 1 次），平均把握度 0.676 | 不算，没有真值 | VPS `judge-shadow/stop-gate.jsonl` |

**结论**：线上能算准确率的只有 3 道金丝雀题；影子账比的是代码或大模型，不是真值。旧留痕只存输入的哈希和前 200 字（`judge-client.mjs:149-151`、`:188-191`），所以金丝雀样本只能人工挑。登记页里大部分题都写着「金丝雀不跑……样本要人工挑，后续单补」（`docs/jev/README.md` 各条）。

### 3.6 新系统对 Jev 数据的要求

1. **每次判断落一行** `judge_calls`，要有：题号、实际模型版本、答案、把握度、成没成加原因、耗时、token、折算的钱、判的是哪个对象（需求 / 子任务 / 会话）。
2. **真值另落一张表** `judge_truths`，三个来源：驾驶舱上人点「改判」；收尾对账回填，比如分诊判「清楚」、后来却追问过，就记一次错；金丝雀。驾驶舱「判得准不准」只从这张表算，把「没判」「判了没真值」「判对 / 判错」分开显示。
3. **输入能复现**：GitHub 来源的题（公开仓），记下 issue 号加 `updated_at` 就能复原全文；飞书私聊只存哈希和摘要。这样生产样本才能直接挑进金丝雀。
4. **影子题要有期限**：比如 14 天攒不够 50 条，日报就报「影子停滞」，别在登记页上永远挂着。
5. **Jev 花费不单独记一本账**，从 `judge_calls` 聚合出来。design §3-21 说套餐内使用不算花钱，但按量的仍要受按量月上限管。

---

## 四、旧看板和驾驶舱雏形：可以借的信息结构

### 4.1 看板 v0（`scripts/lib/board-v0.mjs`，windsurf-dao#1108 落地）

- **一行一个主体**：`{state(绿 / 红 / 没查成), kind(issue / pr / 排队单), id, stage, elapsedHours, model, title, why, startedAt}`；三路数据源各自带 `{state, why, count}`（`board-v0.mjs:283-417`）。
- **阶段**：issue 分 待拍板 / 待消歧 / 已消歧待派 / 在办；PR 分 工人干活 / 等审 / 已红返工 / 已绿待合 / 卡死；排队单分 排队 / 执行中 / 完成 / 失败（`:226-256`）。
- **计时从进入当前阶段算起，不从开单算起**。阶段起点拿不到就空着，也不报超时（`:128-177`）。
- **只有「该有人往下走」的阶段才计超时**；等人拍板、已认输的阶段不算。改之前 43 行红了 39 行，改之后 45 行只红 15 行（windsurf-dao#818，2026-09-08 的评论；`board-v0.mjs:274-281`）。
- **同一主体同一阶段只报一次**；一轮超过 3 条就改发一条摘要（`:419-509`）。
- **给人看的表里，「没查成」单独列一块，不许装成全绿**（`:526-560`）。

### 4.2 `dao now`（`scripts/lib/now-board.mjs`）

- **三段**：已落地 / 在途 / 待你拍（`:1-5`）。
- **每路数据三态**：没查成 / 查过确实没有 / 有；每一段再分 没查成 / 部分没查成 / 空 / 有。这条判据只有一个落点（`:45-77`）。来历：2026-09-04，10 张 PR 零审查被当成「审官坏了」，其实是审官根本没起过，两种处置正好相反（`:9-13`）。
- **过期审查票**：拿审查投在哪个提交上，和 PR 当前的 head 比；比不出来标「判不出」，不当「没过期」（`:15-19`、`:97-140`）。

### 4.3 版本视图（`scripts/lib/stage-board.mjs`）

- 优先级分成 现在做 / 紧接着 / 靠后 三档，直接读 priority 标签；**「未标优先级」单独列，并写明「这是缺口，不是没有」**（`:16-21`、`:61-63`）。
- 视图是算出来的，不手写，因为手写就会漂（`:3-5`）。

### 4.4 windsurf-dao#818：创始人对看板的原话诉求

- 2026-09-03：「可以直接看见卡点」「可以设置降级策略，比如一天内连续撞墙三次自动降级，第二天再重试，当然时间都可以动态调节」。
- 2026-09-04：额度和消耗要当看板的一等公民。
- 2026-09-05：要有一个「AI 自己干了什么」视图，三列——历史的 LLM 查出了什么问题、Token 额度消耗、派的是什么模型，而且**三列要能对到同一次运行**。
- 2026-09-03：所有配置都要预留后台管理接线；状态一律三态，带 `updatedAt`；后台上能点的每个动作，都对应一条现成的命令。
- 2026-09-19 的最终方案是三面墙：任务墙（issue × 代次 × 阶段 × 阻塞原因 × 证据链接）、腿表墙（在役 / 淘汰原因 / 健康 / 到期倒计时 / 价格）、制度墙（PR 积压、机器漂移、闸的三态）。动作要少而明确：恢复 / 取消任务、合 / 关 PR、开关一条腿、回答等人的问题。
- 2026-09-19 摸排出来的缺口：工作流的状态查询**不带每一步用的腿或模型、不带会话 key、不带 PR 号**。现状确认：`packages/fleet/src/workflows.mjs:147` 只返回 `{taskId, state, phase, round, head, reason, failureClass}`，信号只有 resume 和 cancel（`:7-9`）。
- 以上几条的出处都是 gh 只读读到的 windsurf-dao#818 评论。

### 4.5 选路推荐表和派单器报告

- 推荐表（`scripts/lib/leg-choice.mjs:692-712`）：每个候选一行，写排名、族、成本类别、近 7 天成功率（`完成/样本`）、在途 / 上限、理由；**被淘汰的也留在表里，并写明原因**——用户明确要求不许悄悄消失（`:27-29`）。判据按顺序列出来（`:646`）。design §9「写一句为什么派给它」可以直接照这个形状。
- 探索位：7 天里某条路由占比超过 70%，或者有零样本的路由，就按 ε = 0.1 把末位换成一条零样本路由，并记下随机种子（`:657-689`）。这就是 design §3-10「约 10% 试探」的旧实现。
- 派单器报告：见 §1.5，闸读数加每张单的跳过原因码。

### 4.6 旧系统一直没补上的

- 状态查询缺每步的模型、会话 key、PR 号（见上）。新系统直接从 `task_steps` 和 `sessions` 读，不依赖 Temporal 查询。
- 「AI 自己干了什么」要三列对到同一次运行：观察记录里一直没有模型和 token 字段（windsurf-dao#818，2026-09-05）。新系统用 `session_id` 把三样串起来。

---

## 五、驾驶舱每一页要什么数据、从哪张表来

**看板**（design §15.1）
- 要回答：这个仓现在的任务树长什么样；谁在干什么、卡在哪；此刻哪个渠道在干哪个任务。
- 数据：需求 → 子任务 → PR 的树和依赖边；每张卡的一句话状态，比如「Opus 5.5 正在写登录页，已 12 分钟」，由 `models.display_name` + 进行中的 `progress_steps.text` + 当前步骤的已耗时拼出来；进度条是完成步数 / 总步数；迷你时间线来自 `task_steps`；「此刻」面板取运行中的 `sessions`；快捷操作发给 Temporal 的信号；回放用 `task_state_changes`。
- 表：`requirements`、`subtasks`、`gh_prs`、`task_steps`、`task_state_changes`、`sessions`、`progress_steps`、`routes`、`models`、`human_gates`、`escalations`、`members`（「只看我提的」）。
- 注意：**回放不能靠 Temporal 历史**，它只留 30 天（§6-A10）。计时从进入当前阶段算，等人的阶段不计超时（§4.1）。实时刷新靠 Postgres 的通知机制（design §4）。

**总览**
- 要回答：在干几个、卡住几个、等点头几个、今天合并几个、哪些额度快清零；机器还健不健康。
- 数据：design §15.4 置顶盘面卡的五个数；再加定时任务的新鲜度、对账红项、Jev 状态。
- 表：`subtasks`、`escalations`、`human_gates`、`merge_queue`、`quota_readings`、`job_runs`、`reconcile_findings`、`judge_canary_runs`。
- 注意：每个数都要能区分「0」和「没查成」（§4.2）。

**任务**
- 要回答：一个需求从原话到合并的全过程；每一步用的哪条路由、为什么选它、花了多少、耗时多久。
- 数据：原话、AI 理解、需求 / 方案 / 结果文档链接；子任务和改动位置；每一步的路由、原因、耗时、结局；会话直播；追问和回答；第二意见；卡住上报；成本。
- 表：`requirements`、`subtasks`、`task_steps`、`dispatch_decisions`、`sessions`、`session_events`、`progress_steps`、`progress_notes`、`task_questions`、`review_findings`、`escalations`、`usage_events`、`cost_by_task`、`gh_prs`。
- 注意：审查意见必须落 Postgres，不能只在 Temporal 里（windsurf-dao#1714）。

**调度台（路由矩阵）**
- 要回答：每个阶段类型按什么顺序用哪些路由；为什么这样排；AI 帅位动过什么。
- 数据：阶段类型 × 有序路由，可以拖动、开关、钉住；每条路由旁边带实时的额度、并发、战绩、探针状态；禁令；最近的派工原因样本；版本历史和一键撤回。
- 表：`stage_types`、`route_orders`、`routes`、`bans`、`config_versions`、`route_stats`、`quota_readings`、`route_probes`、`dispatch_decisions`、`audit_log`。
- 注意：被淘汰的候选要带原因显示（§4.5）；AI 帅位改完之后要对**每个阶段**都读回一遍，因为拿掉一个抑制条件，可能会放出它碰巧压着的默认值（§6-C5）。

**渠道与账号**
- 要回答：每个渠道和账号池是怎么计费的、有效期到哪、能不能用、并发多少。
- 数据：渠道；池（付不付费、月费、窗口定义、共用组、有效期、状态、暂停原因和证据）；凭据状态（只显示在不在、过没过期，不显示值）；探针。
- 表：`channels`、`account_pools`、`subscriptions`、`route_probes`、`routes`。
- 注意：旧目录 13 个池里 12 个带「待补」，「付不付费」只知道 1 个（`docs/execution-profiles.json` 的 accountPools）；新表要把它设成必填，缺了就在页面上标红。

**模型目录**
- 要回答：有哪些模型、归哪一族、什么档次、能干什么、价格知不知道；有没有新模型等着考。
- 数据：模型、族、档次、能力、定价状态；新模型提案（Jev 归类加代码校验）；新模型考试的结果。
- 表：`models`、`model_candidates`、`scorecards`（考试成绩）。
- 注意：旧的 48 份档里定价已知的只有 4 份，其余都是 unknown；页面要显示「价格未知」，不能显示成 0。

**额度**
- 要回答：每个账号池、每个窗口还剩多少，几点清零，按现在的速度会不会用不完。
- 数据：每个池 × 窗口的已用、上限、单位、清零时刻、读取时刻；共用窗口的标注；撞限额时学到的上限。
- 表：`quota_readings`、`quota_limits_learned`、`account_pools`、`usage_events`（估算消耗速度）。
- 注意：读数超过 30 分钟就判「过期」（design §6 对账），不当现值（§6-B3）；共用窗口不能算成几份（§6-B4）；旧系统只有 Cursor、中转、Claude 订阅三处有读数，其它池要显示「采不到：原因」（`scripts/lib/pool-quota.mjs:130-134`）。

**账单**
- 要回答：这个月花了多少；每完成一个任务的成本；每个订阅浪费了多少额度。
- 数据：订阅月费（在设置里填）；按量路由的实际费用；按任务的分摊；窗口清零时没用掉的额度；按量月上限用到哪了。
- 表：`subscriptions`、`usage_events`、`cost_by_task`、`quota_readings`（算浪费）、`spend_caps`。
- 注意：旧用量库里只有 Cursor 有金额（§1.4），所以「每任务成本」主要靠订阅摊销；要标明哪部分是实价、哪部分是摊的。

**战绩**
- 要回答：每条路由在每个阶段类型上表现怎么样；样本够不够。
- 数据：样本数、近 7 天成功率、连败和冷却、返工轮次、第一级问题数、CI 红次数、交付耗时、Jev 质量分、人工评分、趋势、被试探到的比例。
- 表：`scorecards`、`route_stats`、`task_steps`、`sessions`、`review_findings`。
- 注意：样本少于 5 条的标「样本不足」，不参与排序（`scripts/lib/leg-quality.mjs:3-8`）；分不清原因的失败不计入分母（§6-C1）；旧战绩基本没法用（§1.6）。

**定时任务**
- 要回答：每个定时任务上次什么时候成功；这次是「查了、发现 N 条」还是「没查成」。
- 数据：计划、上次开始和成功的时间、结局、发现数、缺口码、下次运行时间；过期的标红。
- 表：`scheduled_jobs`、`job_runs`。
- 注意：「追平中」「到了设计上限」这类状态不算故障，否则每 5 分钟一次的红都是噪音（windsurf-dao#1231，`scripts/lib/execution-usage.mjs:44-50`）。

**Jev 判断记录**
- 要回答：Jev 在哪些地方判、判了什么、把握多大、判得准不准、花了多少、有没有被停。
- 数据：逐次调用；按题统计次数、成功率、耗时、token、钱；真值对照出来的准确率；金丝雀；在岗 / 影子 / 已停的状态；预算。
- 表：`judge_questions`、`judge_calls`、`judge_truths`、`judge_canary_runs`。
- 注意：见 §3.5、§3.6。

**通知中心**
- 要回答：有什么要我拍的、什么卡住了、日报；每条到底送到了没有。
- 数据：三级通知、去重键、送达状态（飞书的 message_id）、关注列表、免打扰时段。
- 表：`notifications`、`notification_deliveries`、`follows`、`settings`。
- 注意：没拿到 message_id 就算没送到，要重试（`host/machine/INDEX.md:102`）；同一件事同一阶段只报一次（§4.1）。

**成员与权限**
- 要回答：谁能看、谁能批、谁能改调度台；哪些作者的任务算数。
- 数据：成员、角色、飞书绑定、GitHub 登录名（可以没有）、权限矩阵、白名单作者。
- 表：`members`、`permissions`。
- 注意：页面上邮箱打掩码；这些不进公开仓。

**操作记录**
- 要回答：谁在什么时候、通过哪里做了什么，理由是什么；能不能撤回。
- 数据：操作者（人 / AI 帅位 / 引擎）、动作、对象、改前改后、理由、渠道、成败、GitHub 链接、幂等键。
- 表：`audit_log`、`config_versions`、`idempotency_keys`。
- 注意：写 GitHub 要回读作者，拿到 URL 不算成功（`scripts/lib/issue-gateway.mjs:1-6`）。

**设置**
- 要回答：全局参数是多少，谁在什么时候改过。
- 数据：并发上限、资源上限、月费、按量月上限、Jev 预算、保留期、免打扰时段、主题。
- 表：`settings`（带版本）、`subscriptions`、`spend_caps`。
- 注意：页面上展示的数字从配置里读，不在文案里手写（§6-F7）。

---

## 六、坑 → 新系统的测试用例

每条都是真实踩过的，写成「给定……，当……，应当……」，后面附出处。「判例」指 windsurf-dao 协作者本机记忆目录里的同名文件，里面的单号才是耐久的出处。

### A. 状态、账本与「没查成」

1. 给定某个数据源读取失败，当驾驶舱渲染那一块，应当显示「没查成：原因」，不显示「没有」，也不画成绿色。｜2026-09-04：10 张 PR 零审查被当成「审官坏了」，其实是从没起过（`scripts/lib/now-board.mjs:9-13`）
2. 给定一张状态表的写方已经停写，超过了它应该写的周期，当读方拿它做决定，应当判成「过期 / 没查成」并报警，不沿用旧值。｜健康表、熔断表的写方随旧指挥官消失，一条「试探中」停了两天半（`scripts/lib/leg-choice.mjs:15-19`，windsurf-dao#1576）；点将台事件账 09-18 起停写，登记表仍写「永久」（VPS 读数，`docs/stores/registry.json:97-108`）
3. 给定清单里登记的存储形态，当对账，应当和实际形态一致，按实际写不按打算写。｜windsurf-dao#1788：登记成 sqlite，实际还是一会话一文件，清理器报形态不符（`registry.json:94`）；VPS 78 项里只有 17 项被登记覆盖（§1.1）
4. 给定新加的汇总表或视图没有回填历史行，当报表读它，应当拿源的行数去核，报缺口，不报「0 条、完整」。｜windsurf-dao#1794：汇总表是空的，报表却说「complete」；判例 projection-must-prove-coverage
5. 给定存储层在测试环境打不开，当跑测试，应当让测试失败，不许跳过。｜windsurf-dao#1788、#1793：`if (!opened.ok) return` 让 sqlite 那条路一次都没真跑，测试照样全绿；同上判例
6. 给定要清理的对象已经不存在，当清理，应当正常返回并记下「已不存在」，不抛异常进重试循环。｜windsurf-dao#1350：一轮 234 次 ENOENT，0 次成功；判例 gone-object-must-return-not-throw
7. 给定一次启动失败，当记失败原因，应当保存上游的原文或状态码；一个写死的常量不能当作唯一的原因。｜windsurf-dao#1576：Grok 121 次失败里 83 次写着 `backend_launch_unconfirmed`，那是 catch 块写死的；判例 placeholder-looks-like-a-reason
8. 给定工作流完成、PR 已合、issue 已关，但 PR 改的文件和方案零交集，当判任务是否完成，应当判「假完成」。｜windsurf-dao#1560、#1572：合进去的是 master 上早就有的内容；判例 completed-is-not-delivered
9. 给定任务因为审查意见卡住，当驾驶舱显示卡住原因，应当从 Postgres 读到意见原文，不依赖 Temporal 历史。｜windsurf-dao#1714；判例 fleet-blocked-verdicts-live-in-temporal
10. 给定一个 31 天前完成的任务，当看它的战绩和回放，应当还能读到每一步。｜Temporal 保留期 720 小时（VPS 读数；`docs/stores/registry.json:243`；`scripts/lib/fleet-timeline.mjs:3-4`）

### B. 用量与额度

1. 给定用量表有 100 万行，当读某个池的最新额度，应当走索引直查；执行计划里不出现全表扫描，也不受报表行数上限截断。｜旧的一条一文件攒到约 30 万个，读方每轮全树扫描撞上限，6 小时红了 71 次（`registry.json:17`；`scripts/lib/usage-store.mjs:3-5`）
2. 给定最新的额度快照排在报表行数上限之后，当读额度，应当读得到它，不报「没有用量快照」。｜windsurf-dao#1853（`scripts/lib/execution-usage.mjs:1300-1306`）
3. 给定一条额度读数是 3 小时前的、窗口还没结束，当调度判额度够不够，应当判「没查成（采集器可能停了）」，不当「还够」。｜`scripts/lib/pool-quota.mjs:26-31`
4. 给定三个账号池共用一个 7 天窗口，当其中一个池消耗了额度，应当三个池显示同一个读数并标「共用」；调度不能把它当成三份独立的额度。｜`scripts/lib/relay-account-usage.mjs:4-7`；VPS 实测三池共用同一个窗口（§1.4）
5. 给定上游先写一条全 0 的 token 占位、之后再回填，当记账，应当把全 0 占位记成「未知」，不记成「用了 0」。｜`scripts/lib/execution-usage.mjs:238-242`
6. 给定同一个会话每 5 分钟报一次累计值，当写用量，应当每个会话只保留最新的累计值，或者只记增量；行数不能随采样次数线性增长。｜VPS：Cursor 会话累计快照 21 万行，占全库 53%（§1.4）
7. 给定同一会话既有逐次调用的增量、又有会话累计快照，当汇总，应当不重复相加；累计值变小时要记缺口。｜`scripts/lib/execution-usage.mjs:1121-1134`、`:1136-1170`
8. 给定请求的是模型 A、上游实际用的是 B，当记账和记战绩，应当两个都记下来，战绩按实际的算。｜windsurf-dao#567：pi 在 503 后 1 毫秒内静默切到另一家（判例 pi-silent-provider-fallback）；旧会话记录已经有 `requestedModel` 和 `actualModel` 两个字段
9. 给定 Grok 模型是通过 OpenAI 协议的适配器调用的，当记厂商，应当记 xAI，不记 OpenAI。｜windsurf-dao#1174（`scripts/lib/execution-usage.mjs:159-161`）
10. 给定测试注入了一个假时钟，当计算「近 7 天」窗口和保质期，应当全链路都用这一个时钟。｜`scripts/lib/pool-quota.mjs:229-233`：曾把 17 天前的真实快照判成「没有快照」

### C. 选路与战绩

1. 给定一批失败分不清是我方、账号还是上游，当算路由的成功率，应当不计入分母，也不据此把它排后。｜`scripts/lib/leg-choice.mjs:923-930`：Grok 因此被算成 23/61 = 38%，排到第 5
2. 给定一条报错里同时出现「限流」和「额度」，当决定要不要暂停账号池，应当只做短时重试，不停整个池；停池必须有额度读数佐证。｜`scripts/lib/leg-choice.mjs:951-960`：一条报错停了 28 条腿；windsurf-dao#1681；`docs/exams/2026-09-21-judgment-model-where/result.md`
3. 给定探针全通、真实流量却失败了 48%，当判路由健不健康，应当按真实流量判；给定两条路由共用一把熔断键，应当拆开各算各的。｜windsurf-dao#1342；判例 breaker-must-eat-real-traffic
4. 给定长流在传输层被掐断（incomplete），当算路由失败率，应当不算上游失败；所有路由同时变红时，判定是共用层坏了，候选不许被剔空。｜windsurf-dao#1386、PR #1398：16 张单因为「健康表红」全部不派；同上判例
5. 给定 AI 帅位或人改了某个阶段的路由排序，当保存，应当对每个阶段都重算一次推荐并存下变化，不只看改动的那一个。｜windsurf-dao#1666：修写码腿的时候，把审查腿也放成了 Grok，40 分钟后才发现；判例 removing-a-suppressor-unmasks-defaults
6. 给定某条路由某个阶段的样本少于 5 条，当微调排序，应当不动它。｜`scripts/lib/leg-quality.mjs:5-8`（旧规则，VPS 实测样本几乎全不够，§1.6）

### D. 驾驶舱显示与通知

1. 给定一个任务开了 10 小时、进入当前阶段才 1 小时，当算超时，应当按 1 小时算；阶段起点拿不到就不报超时。｜windsurf-dao#1108 审官红项：原来量的是开单时长（windsurf-dao#818，2026-09-08 评论；`scripts/lib/board-v0.mjs:128-177`）
2. 给定任务处在「等人拍板」的阶段，当算超时，应当不算工人超时。｜windsurf-dao#1108：43 行红 39 行 → 45 行红 15 行（`board-v0.mjs:274-281`）
3. 给定同一个任务同一个阶段连续几轮都超时，当发告警，应当只报一次；一轮超过 3 条就改发摘要。｜windsurf-dao#1108（`board-v0.mjs:419-509`）
4. 给定审查意见是投在旧提交上的，当显示 PR 的审查状态，应当标「过期票」；缺提交号的标「判不出」，不当新鲜的。｜`scripts/lib/now-board.mjs:15-19`、`:97-140`
5. 给定飞书发送没有返回 message_id，当记通知状态，应当记「没送到」并重试，不记「已报」。｜`host/machine/INDEX.md:102`
6. 给定会话状态刚变成完成，当读它的最终输出，应当等输出落定再解析，不把自己显示时截断的地方当成数据截断。｜windsurf-dao#1295、#1643、#1645；判例 my-display-cut-is-not-data-truncation

### E. 写 GitHub

1. 给定机器人代发了一条评论，当 GitHub 返回 URL，应当回读作者和内容一致才算成功；同一个幂等键重放，不重复发。｜`scripts/lib/issue-gateway.mjs:1-6`
2. 给定引擎要写的仓不在允许名单里，当交付，应当当场报错，不装成已交付。｜windsurf-dao#1024：名单少一个仓，交卷就被拒，看起来却像派出去了（`issue-gateway.mjs:26-28`）
3. 给定创始人把改动要求写在了评论里，当引擎给会话交代「做什么」，应当读到最新的需求文档或正文；评论里的拍板要先落进文档。｜windsurf-dao#1675：三轮审查都在引用旧正文；判例 decision-in-comment-invisible-to-fleet

### F. Jev

1. 给定 Jev 超时、返回 529 或者没有密钥，当分诊，应当记「没判」并走默认，不当成「不清楚」去追问。｜`scripts/lib/judge-client.mjs:4-7`；VPS 3 天没成 8 次
2. 给定 Jev 回了一个题面里没有的选项，当解析，应当这道题当天退回影子，不采纳。｜`judge-client.mjs:281-286`
3. 给定要判断额度、负载这类数字，当选判断方式，应当由代码比较，不送给 Jev。｜`question.md:32-33`：贴线算术把握度 0.45
4. 给定一次分诊，当准备 Jev 的输入，应当喂整篇需求原文（含评论），不预先裁剪。｜`docs/exams/2026-09-21-judgment-model-where/result.md` 的 length-test：裁剪后从 0.76 掉到 0.30
5. 给定金丝雀准确率比基线差超过 5%，当生产调用这道题，应当返回「已停」并走默认；复测恢复后再自动解停。｜`scripts/jev-canary.mjs:1-6`；VPS 上 retry-verdict 90%，已停
6. 给定 Jev 的回包没带 token 数，当记花费，应当按字符数保守估算，不记 0。｜`judge-client.mjs:276-278`
7. 给定页面或文档要展示某个上限数字，当渲染，应当从配置里读出来，不手写。｜`docs/jev/README.md:102`、`:206`、`:223` 写的是 0.10 美元，代码是 0.30（`judge-client.mjs:24`）；判例 hand-typed-constant-will-be-wrong
8. 给定一道影子题 14 天都没攒够切换样本，当生成日报，应当报「影子停滞」。｜VPS：13 道影子题没有一道到 50 条，其中 9 道近 7 天零样本（§3.5）

### G. 测试卫生

1. 给定一个测试进程，当它跑过任何写账的路径（包括提前返回的「没有密钥」那种路径），应当生产库和真实家目录里零新增行；生产连接串不能有默认值。｜PR #1718 之后 VPS 多出 2 行 `caller=unknown`（判例 test-calls-write-real-home-ledger）；**现场再犯**：`tests/fleet-timeline.test.js:19-26` 用 `HOME` 重定向，Windows 上 `os.homedir()` 读 `USERPROFILE`，本机真账本 09-22 到 09-24 多了 24 行 task-quality 假调用；断言只看临时目录（`:231-232`），所以一直是绿的
2. 给定两份测试并行跑，当它们建临时库或 schema，应当各用各的名字，互不删对方的。｜判例 fixed-name-sandbox-dies-under-concurrent-runners：固定名字的沙盒一并发就互删，是 master 随机红的真因
3. 给定多个工人同时给同一个子任务的派工次数加一，当它们都写完，应当最终计数等于调用次数。｜旧 SQLite 实现在 GitHub runner 上间歇报「库被锁」，windsurf-dao#1814（提交 `723bd9aa4`；`scripts/lib/dispatcher/ledger.mjs:168-172`）；design §4 选 Postgres 正是为了这个

### H. 派工起步

1. 给定白名单作者新开了一个 issue、机器全部空闲，当 GitHub 事件到达，应当几秒内收单进入分诊，不等人贴标签。｜VPS 派单器：执行槽 0/3、闸全过，派出 0 张；45 张里 41 张跳过的原因是「只有人能贴的 triage/accepted」（§1.5）

---

## 七、没查成或存疑

- **hub-intent、feishu-dedup 等影子题是不是在别的机器上跑**：本机和 VPS 近 7 天都没有样本，没查成它们在哪运行。
- **`recall-gate` 影子账的写方**：仓里 grep 不到，没查成。
- **design §16 说「约 30 个 systemd 定时器」**：VPS 按名字过滤（dao-*、miraquota、reclaude 等）只数到 14 个，别的命名可能漏了，没有逐个核对。
- **点将台事件账为什么停写**：推测是随指挥官 2026-09-19 退役一起停的（`registry.json:381`），没去查写方最后的调用点。
- **Cursor 会话累计快照的采样间隔**：「每轮一条」是从行数和注释（`scripts/lib/pool-quota.mjs:27`）推断的，没有逐条核时间戳。
- **retry-verdict 金丝雀停用之后有没有人处置**：没查成。
- **打标器和人工标签的对照只有 09-21 一份报告、7 张单**：之后只有 apply 报告，样本太小，结论只能算参考。
- **本机 task-quality 的 24 行具体是哪次测试运行写的**：从输入夹具锁定到 `tests/fleet-timeline.test.js`，没有把每一行对到具体的某次测试进程。
