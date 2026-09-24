# 错误与卡住处理手册（错误分流 · 卡住处理 · 资源隔离）

> **实现错误分类与处置（「下一步该做什么」动作表）、卡住判定与自愈、路由熔断、会话资源隔离与准入之前读。** 对应设计 §十二「卡住与自愈」、§十三「资源」、§四「执行模式与容量」、§十一 Jev「错误分流」一行。
> 讲清旧系统在哪几处「看文字定处置」、各自怎么判、生产上真实的失败分布与结构化错误码、新系统的 11 类动作表草案、真实报错样本夹具、资源隔离做到哪了与准入经验值；坑逐条写成测试用例。
> 来源：旧系统审计切片 s4（2026-09-25）。审计对象：windsurf-dao（HEAD `b1ebd88d`）、ai-gateway-stack（HEAD `33d3ce4`）；VPS 只读读回时刻 2026-09-25 01:24–01:50（+08:00）。全仓记法见 [README](README.md)。
>
> - 出处写法：`文件:行` 默认指 windsurf-dao 仓；`windsurf-dao#N` 是 issue/PR；提交写短哈希；「VPS 读回」是当时只读命令的输出摘录。
> - 「fleet 任务 #N gM」指 windsurf-dao#N 那张单的第 M 代工作流，不是那张单本身的内容。
> - 「memory `名字`」「判例」都指旧维护者的判例记忆（不公开，只为追溯）；「决定」指 windsurf-dao `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md`，「臂」指那次盲设计题各家模型给的建议值。
> - 脱敏：服务用户家目录写成 `~`；IP、主机名、请求 ID、消息 ID、会话 UUID、账号池名、仓库所有者一律不写。

---

## 0. 一页结论

1. **5 个分类函数是哪 5 个**：windsurf-dao#1805（`11d534e6a`）的提交正文逐个点名：fleet 的 `classifyStepFailure`、`classifyFailure`、`classifyLaunchFailure`、`classifyFallbackError`、`classifyStatusFailure`。其中 **`classifyLaunchFailure` 在全仓没有任何非测试调用方**（`scripts/dao.mjs:31-32` 只 import），却在 #1787 挂了 Jev 影子、在 #1805 补了「繁忙」——给死代码打补丁。真正在跑的是 4 个。
2. **分类器远不止 5 份**：还有 `judgeRetry`、`isCapacityDeath`、`isCapacityError`、`TRANSIENT_UPSTREAM`、`isEnvFailure`、`judgeEscalation`、`classifyTurnOutcome` 至少 7 处在「看文字定处置」。决定文档写「加 CI 闸防第 6 份长出来」（2026-09-24 02:09 合入），同一天 17:01 `loop-guard.mjs` 就长出了 `ENV_DETAIL`（#1818）。把 50 条样本（多数是真机原文）喂给 9 个入口实测，**同一条原文判法普遍不一致**（第 1.5 节）。
3. **生产上「认不出」是大头，影子期其实没开始**：VPS 近 7 天 137 条会话失败里 117 条（85%）落 unknown，其中 82 条连原因都没记；mirasim 自带的结构化错误码里 `other` 占非 ok 结束的 29%。而 5 份 Jev 影子账在 VPS 上**一个文件都没有**：failure-class 的生产调用点没注入 judge（`scripts/lib/execution-runtime.mjs:28`），retry-verdict 随指挥官退役停转，launch-failure 是死代码。
4. **「一条路由繁忙、全体避开」在旧系统里实际不存在**：熔断表最后写于 09-18、健康表冻在 09-20（写方随 windsurf-dao#1523 退役，windsurf-dao#1778 开着没修），键多是退役网关；mirasim 腿起会话时的渠道闸还在读熔断表，但冷却全已过期、等于全放行，而且只有「起会话被拒」才会写它，会话中途的 422 繁忙写不进去。fleet 每个任务各自睡 12×5 分钟。收件箱 31 条卡单存档里 16 条是「审查预算用尽」，不是基础设施错误。
5. **隔离只落了 P0 的一半**：mirasim-server `OOMPolicy=continue`（windsurf-dao#1810）在 VPS 生效；没有 `agents.slice`、没有每 agent scope、没有 PSI 准入。ACP 腿的进程从 fleet worker 里起（`scripts/lib/acp-runtime.mjs:466`），而 fleet worker 单元是默认 `OOMPolicy=stop`、无内存上限。mirasim-server 生效的 `MemoryHigh=3.5GiB` 来自 09-16 手工 `set-property --runtime`，仓内单元写 2.5G，重启就变。**现役派单器没有 CPU/PSI 闸**——题面里的「整机 CPU 85% 闸」只在已退役的指挥官路径上。
6. **每会话内存没有实测过 1.2–1.6G**：旧系统唯一实测（准入样本 344 对相邻读数）是每多一个在途会话 MemAvailable 降 p50 191MB、p90 559MB、最大 1836MB。1.2–1.6G 是三臂给「单 agent MemoryHigh 上限」的建议区间，不是测量值。
7. **mirasim 服务端有 18 个以上结构化错误码**（`cloud_unavailable`、`cloud_exhausted`、`local_no_account`……，多数自带处方），旧系统全部是在渲染后的中文上写正则。新系统应先拿码，拿不到再认文字。

---

## 1. 旧系统的 5 个错误分类函数

### 1.1 认定依据

- 依据 windsurf-dao#1805（`11d534e6a`，2026-09-24）的提交正文：它逐个点名这 5 个函数，并用两条 mirasim 422 原文在每个上跑了改前探针——fleet 判 unscanned、failure-class 判 unknown、next-launch 判 hard、go-fallback 判 null；escalation-apply 判的是 `temporal workflow status` 的 stderr，未改。「决定」里说的「5 个各自独立的错误分类函数」（`:7,26`）就是它们。
- 其中 4 个挂了 Jev 影子（「认不出时旁听」）：retry-verdict（#1721，09-22）、failure-class / launch-failure / capacity-death（#1787，`fd478f883`，09-23）。failure-kind（`packages/fleet/src/failure-kind.mjs`）是 09-24 才加的（#1818）。

### 1.2 五个函数一览

| # | 函数 | 位置 | 输出 | 认不出时 | 生产上谁在用 |
|---|---|---|---|---|---|
| ① | `classifyStepFailure` | `packages/fleet/src/contract.mjs:136-175` | cancelled / stall / blocked / capacity / retryable / queued / unscanned | `unscanned` → 工作流停下等信号 → 进收件箱 | fleet runner（`packages/fleet/src/runner.mjs:558`），现役 |
| ② | `classifyFailure` | `scripts/lib/failure-class.mjs:120-143`（词表 `:33-52`） | ours / account(quota·auth) / upstream(upstream·stall) / unknown(unrecognized·no-reason) | `unknown`，如实记账 | 执行记录（`scripts/lib/execution-runtime.mjs:24-29`）→ 选腿成功率与账号池暂停（`scripts/lib/leg-choice.mjs:930-990`），现役 |
| ③ | `classifyLaunchFailure` | `scripts/lib/next-launch.mjs:181-195`（`HARD_RE`/`TRANSIENT_RE` `:119-120`） | config / hard / transient | 默认 `hard`（当成永久拒模） | **无调用方**：只在 `scripts/dao.mjs:31-32` 被 import，全仓无非测试调用 |
| ④ | `classifyFallbackError` | `host/pi-extensions/go-fallback-core.mjs:105-124` | hard / transient / null | `null` → `planSwitch` 判 ignore（不等也不切） | pi 扩展（VPS `~/.pi/agent/extensions/go-fallback-core.mjs`，09-24 更新），pi 会话里现役 |
| ⑤ | `classifyStatusFailure` | `scripts/lib/escalation-apply.mjs:19-24` | gone / incompatible / 没查成 | `{ok:false}` → 这轮 skip，5 分钟后再来 | 收件箱执行器（`scripts/fleet-escalations-apply.mjs:70`，经 `scripts/server-sync.sh:111-112` 每 5 分钟），现役 |

### 1.3 逐个：分类表与判据顺序

**① `classifyStepFailure`（fleet 步骤失败 → 工作流怎么等）** — 判据按代码顺序，命中即返回：

| 顺序 | 条件 | 结果 | 出处 |
|---|---|---|---|
| 1 | code `CANCELLED` | cancelled | `contract.mjs:138` |
| 2 | code `TIMEOUT` / `STALL` | stall（本步超预算，停下等裁决） | `:142` |
| 3 | code ∈ AUTH_REQUIRED / PERMISSION_DENIED / INVALID_CONTRACT / INVALID_MODEL / UNSUPPORTED_CAPABILITY / MERGE_CONFLICT | blocked | `:144` |
| 4 | code `capacity`（准入锁被饿死，#1748） | capacity | `:148` |
| 5 | reason 含 capacity、容量已满、at capacity、rate limit、too many requests、429、繁忙 之一 | capacity | `:153` |
| 6 | 文本为「admission flock unavailable: ETIMEDOUT 或 timeout」 | retryable | `:157` |
| 7 | reason 含 channel-full 或 maintenance | queued | `:159` |
| 8 | 文本含 econn*、enotfound、eai_again、连不上平台、域名解析、建立连接失败、socket hang up 之一 | retryable | `:162` |
| 9 | code ∈ RATE_LIMITED / TRANSPORT_CLOSED / SERVICE_UNAVAILABLE / DEADLINE_EXCEEDED | retryable | `:163` |
| 10 | code `MirasimUnavailableError` / `busy` | retryable | `:167` |
| 11 | code `AcpRuntimeError` 且 reason 含 timeout | retryable | `:170` |
| 12 | code `WAITING_USER` | blocked | `:172` |
| 13 | reason ∈ lease-held / channel-full / maintenance / launch-uncertain | retryable | `:173` |
| — | 其余 | **unscanned** | `:174` |

- 注意第 5 条与第 9 条的次序：同一个 `RATE_LIMITED`，带「too many requests」字样判 capacity（等 12×5 分钟），不带字样判 retryable（5 次小退避）——同一件事因有没有原文走两条路（第 1.5 节 S51 vs S49）。
- 活动层真正抛出的码很少：`SERVICE_UNAVAILABLE`×28、`UNSUPPORTED_CAPABILITY`×16、`MERGE_CONFLICT`×2、`WAITING_USER`、`PERMISSION_DENIED`、`DEADLINE_EXCEEDED` 各 1（`packages/fleet/src/activities.mjs` 内 `fail(...)` 计数），外加 `asTransientFailure` 转出的 capacity / busy / MirasimUnavailableError（`activities.mjs:40-53`）。
- **真实坑**：Temporal 的 `TimeoutFailure`（活动 StartToClose 到点）没有 `code`，runner 取 `error?.code || error?.cause?.type` 得不到值，落成 `UNKNOWN` → unscanned → 交人（`runner.mjs:555-558`；真实卡单 fleet 任务 #1608 g1 原因 `step-failed:UNKNOWN：activity StartToClose timeout`，VPS 收件箱存档）。第 2 条的 stall 分支对真超时走不到。

**② `classifyFailure`（一次会话失败是谁的问题）** — `failure-class.mjs:120-143`，先窄后宽：

| 顺序 | 类 / kind | 判据 | 恢复时间 |
|---|---|---|---|
| 1 | ours / ours | code ∈ interrupted、aborted、session_exists、contract…（`:33-36`）或 `OURS_TEXT`（`:37`） | — |
| 2 | account / quota（硬） | `QUOTA_TEXT` 命中且有硬字样 402/余额/billing/周限…（`:39,:44`） | `retryAtOf` 读 ISO 时间或「in N minutes/hours」（`:55-65`） |
| 2' | upstream / upstream | 只有软字样（quota/额度）且带限流窗口说法（per minute/每分钟/rate limit）（`:45,:126-127`） | — |
| 3 | account / auth | `AUTH_TEXT`：401/403/unauthorized/登录/凭据…（`:46`） | — |
| 4 | upstream / stall | code `stalled` 或 `no progress for Ns`（`:48,:132`） | — |
| 5 | upstream / upstream | code incomplete/timeout 或 `UPSTREAM_TEXT`：429/overloaded/5xx/timeout/econn/network/断流/满载/繁忙/连不上平台…（`:51-52`） | — |
| — | unknown / unrecognized（有原文）或 no-reason（无原文） | 其余；只在这里旁听 Jev（judge 注入时） | — |

- 用处（`scripts/lib/leg-choice.mjs:930`）：ours、account、legacy 不计入腿的成功率；account 触发**账号池暂停**（见 2.8）。
- 2' 这条是真实事故修出来的：「按分钟限流」被判成额度用完，一条报错停了一个挂着 28 条腿的账号池（`failure-class.mjs:40-43`，`leg-choice.mjs:956`）。

**③ `classifyLaunchFailure`（起会话失败）** — `next-launch.mjs:181-195`：`有待确认提示`→config；`拒模`→hard；空→hard；`agent_unconfigured`→config（#649 实证，`:175-177`）；`HARD_RE`→hard；`读了是空的/没读成`→transient；`TRANSIENT_RE`→transient；其余默认 hard。后续状态机 `advanceLaunchState`（`:201-226`）：config→放弃；transient 第一次同腿重试、第二次按 hard 算；hard 满 2 次→换下一个模型；名单走完→失败。**整套没有生产调用方**。

**④ `classifyFallbackError`（pi 扩展要不要切通道）** — `go-fallback-core.mjs:105-124`：12 条额度/账单正则→hard；22 条过载/限流/5xx/超时/断连/繁忙正则→transient；其余 null。`planSwitch`（`:75-88`）：不是主通道→ignore；null→ignore；transient 且连续 <2 次→wait；否则 switch。默认备用通道为空（`:43`），所以生产上 switch 实际无处可切、错误上浮。

**⑤ `classifyStatusFailure`（查工作流状态失败的 stderr）** — `escalation-apply.mjs:19-24`：`not found`→gone（收走）；`TMPRL1100|Nondeterminism`→incompatible（与现有代码不兼容，只能终止重派，#1633）；其余→没查成（本轮 skip）。

### 1.4 「第 6 份起」：同样在看文字定处置的另外 7 处

| 位置 | 判什么 | 与 5 个函数的关系 |
|---|---|---|
| `scripts/lib/retry-verdict.mjs:34-49,106-137` `judgeRetry` | terminal / retryable / unknown（unknown 按可试） | 只在已退役的指挥官里调用（`scripts/lib/commander-core.mjs:1520,2007`、`commander-verbs.mjs:376`），生产停转 |
| `scripts/lib/dianjiangtai-reviewer-slot.mjs:126-132` `isCapacityDeath` | 审官死因是不是满载/看门狗 → 可否换厂 | 不认「繁忙」 |
| `scripts/lib/channel-concurrency.mjs:581-589` `isCapacityError` | 起会话被拒是否撞容量 → 写熔断表 | 不认「繁忙」、不认 mirasim 422 |
| `packages/fleet/src/activities.mjs:257` `TRANSIENT_UPSTREAM` | 会话结束时要不要换腿 | 不认「繁忙」「连不上平台」 |
| `packages/fleet/src/loop-guard.mjs:116-125` `ENV_DETAIL`/`isEnvFailure` | 环境失败另计、两次即止损 | **决定当天 17:01 新增**（#1818，`981607d38`） |
| `scripts/lib/escalation-inbox.mjs:59,80` `judgeEscalation` 内正则 | 收件箱机械裁决 | 读 blockedReason 字面 |
| `scripts/lib/turn-outcomes.mjs:34-66` `classifyTurnOutcome` | 真实 turn 成败 ok/self/stream/upstream → 熔断 | 用 mirasim 结构化 errorCode，不看文字 |

### 1.5 实测对照：同一条原文，9 个入口各判成什么

方法：在本机 import 旧仓现存的判定函数（不注入 judge、不出网、HOME 指向空目录，跑完确认无写入），把第 5 节的样本逐条喂给 9 个入口：契约 `classifyStepFailure`、分类账 `classifyFailure`、启动 `classifyLaunchFailure`、pi `classifyFallbackError`、重试 `judgeRetry`、死因 `isCapacityDeath`、环境 `isEnvFailure`、熔断 `isCapacityError`、状态 `classifyStatusFailure`。**不是每个入口真的会收到每条原文**——这张对照只说明「知识分裂」：同一条原文在不同入口认识程度不同。逐样本的旧判法已并进第 5 节表的「旧系统（现役入口）怎么判」一列；另有一条只在对照里出现的样本 S51（code `RATE_LIMITED`、没有原文）：契约判 retryable，分类账判 upstream。

要点（错方向或互相矛盾的几处）：
- **S30**：同一条「403 … Internal error」，分类账判账号鉴权（会停整个账号池），pi 扩展判瞬时（重试）。
- **S03**：mirasim 明写「或切换到『平台』」的路由配置问题，被分类账判成账号鉴权失效。
- **S43/S49**：按分钟限流在 pi 与启动分类器里仍是「硬额度 / 永久」，只有分类账修过（#1576 A/B 审查当天修）。
- **S52 vs S51**：额度用尽（insufficient_quota）在契约里判 capacity，会等 12×5 分钟——钱不会等回来；而无原文的 RATE_LIMITED 反而只做 5 次小退避。
- **S14/S15**：活动级超时和活动丢失都进 unscanned（交人）。
- **S01/S23**：共享熔断的指纹（`isCapacityError`）不认中文「繁忙」「容量已满」，所以即使有全局熔断，也不会因这两条而全体避开。

---

## 2. 六个模块的判据

### 2.1 failure-class（`scripts/lib/failure-class.mjs`）

见 1.3 ②。补充：
- 只存分类、错误码、截短 200 字的已脱敏原文（`:24,:124`）；脱敏由调用方负责（`execution-runtime.mjs:24-29` 先 `redact`）。
- 「宁可 unknown，不许猜」（`:22-23`）；Jev 只在 unknown 桶旁听，绝不覆盖 account（`:3-6,:136-141`）。
- 起因：旧记录把起会话失败一律写成常量 `backend_launch_unconfirmed`，Grok 121 次失败 83 次是这个占位，账号额度用完被算成腿坏（`:10-13`；判例 memory `placeholder-looks-like-a-reason`）。

### 2.2 retry-verdict（`scripts/lib/retry-verdict.mjs`）

- 问题只有一个：「成因在重试能改变的范围里吗？」（`:14-17`）
  - terminal（当场交出，不烧名额）：账本没有 / 需人工打标 / 缺 repo·model / ENOENT·no such file·lstat / 找不到卡·不存在 / unverified·disabled·invalid execution profile / not a git repository·bad revision（`:34-41`）。
  - retryable（照常宽限 + 试满）：已有会话进程·already exists / CONFLICTING·mergeable=UNKNOWN / 连不上·timeout·超时·ECONNREFUSED·ETIMEDOUT·EAI_AGAIN / 宽限·grace·held·满载（`:44-49`）。
  - unknown：按可试走，但要报出来（`:18-20,:127-131`）。
- 行为判据（不看词）：同一格连续 2 轮拿回**逐字相同**的原文 → 判「重试不会变」（`SAME_ERROR_ROUNDS_TO_STUCK=2`，`:147,:177-186`）；比较不做归一化（`:169-172`）。
- 起因数据：2026-09-13 七天日志 274 条错误里 54% 是「重试也不会变」的（93 次树已不在、41 次账本缺记录），原机制一律试满 3 次 × 45 分钟宽限，最快两小时后才见人（`:3-11`；windsurf-dao#1237）。
- 自带故意违规正反例（`:218-233`）。

### 2.3 provider-breaker（`scripts/lib/provider-breaker.mjs`）

- 标准断路器：closed —窗口内失败 ≥ `failuresToTrip`→ open（冷却）—到点→ half-open（只放 1 针）—绿→ closed / 红→ open（`:6-11`）。默认窗口 24 小时、3 次开闸、冷却 24 小时、半开 1 针（`:22-27`）。
- 真实 turn 喂闸（windsurf-dao#1342）：窗口内至少 8 条才评、上游失败占比 ≥60% 记一次失败、算率窗口 6 小时（`:35-41`）。60% 取自 2026-09-17 实测：好腿 0–30%、坏腿 52–75%（`:33`）。每个 target 每轮最多记一次（`:352-356`）。
- 只在 half-open 吃绿，closed 不吃绿（否则永远凑不满 3 次）（`:240-241,:307-311`）。
- 健康表过期（>2×探测间隔）就不拿它熔断（`:535-546`）。
- 全部 target 都 open 才报警，6 小时去重，发成功才盖戳（`:257-294,:416-429`）。
- 起会话被上游拒且命中 `isCapacityError` 时，按 2→4→8 轮（±1 轮确定性抖动）冷却（`scripts/lib/channel-concurrency.mjs:592-626`；抖动 windsurf-dao#1230）。
- **生产现状（VPS 读回）**：`~/.dao/provider-breaker.json` 的 `updatedAt` = 2026-09-18T13:40Z，之后无写入；15 个键里多为已退役的 `gw:*`/`leg:*`，5 个 open 的冷却都在 09-19 到期，2 个 half-open。写方有两个：`ingest-*` 只在 `scripts/commander.mjs:606-610` 调，指挥官已退役（VPS 上无 commander 单元、`~/.dao/commander*` 不存在）；另一个是 mirasim 起会话**被上游当场拒绝**且命中 `isCapacityError` 时（`scripts/lib/mirasim-runtime.mjs:1340-1354`），而 422 繁忙是会话开跑后才报的、且 `isCapacityError` 不认「繁忙」，所以写不进来。读方：mirasim 腿起会话的渠道闸（`channel-concurrency.mjs:355-375,793`）与手工派工；fleet 的选腿不读。**到期的 open 会被推进成 half-open，而没人记 probe 事件，半开那一针永远「未用」→ 等于全放行**（`:145-193` 的推进逻辑）。

### 2.4 provider-health（`scripts/lib/provider-health.mjs`）

- 健康表只读：缺失 / 坏 JSON / 过期（>2×间隔）→ unknown，不拦但注明；red → 后置照探，不直接拦；green → 空闲（`:3-9,:57-85`）。
- 熔断表：open 且未到冷却 → 直接拦；half-open → 后置、只探一针；文件缺失 = 无熔断（`:11-15,:88-100,:133-149`）。
- **生产现状**：`~/.dao/provider-health.json` 冻在 2026-09-20 17:09（写方 gw-remote-probe 随 windsurf-dao#1523 退役，`:3-5` 自己写着「过期当 unknown 是常态」）。windsurf-dao#1778（开着）就是在报「有读方无写方」。fleet 现役选腿不读健康表，读的是每天一次的真探针 `~/.dao/leg-expiry.json`（`packages/fleet/src/dispatch-fresh.mjs:70`，`scripts/bootstrap-server.mjs:38-39`）；熔断表只在 mirasim 起会话那道门里被读（见 2.3）。

### 2.5 escalation-inbox（`scripts/lib/escalation-inbox.mjs`）

- 决定只有 5 种：retry / swap-leg / cancel / accept-as-is / ask-human（`:9`）。机械裁决 `judgeEscalation`（`:28-98`），宁可交人不乱拍：

| 条件 | 决定 |
|---|---|
| 原因 `p1-vs-contract` 或 `loop:*` | ask-human |
| 原因含 capacity/429/rate limit，或 failureClass=capacity | retry |
| failureClass=retryable（工作流内退避已用完） | retry（不看轮次，次数由自动重开账封顶） |
| stall 且轮次没用完 | 有同 family 候补→swap-leg，否则 retry |
| stall 且轮次用完 | ask-human |
| blocked 且原因含 WAITING_USER / no new commit、轮次没用完 | retry |
| 原因 ∈ 三条「审查产出不合格」（`:13`）且没用完 | retry（只重审） |
| 原因以 pr-conflicting 开头且没用完 | retry |
| 其余（含 failureClass 为空） | ask-human |

- 轮次用尽的判法：新载荷按「审查轮次」与「其它返工轮次」两本账各判各的（windsurf-dao#1755），老载荷退回旧判法（`:37-46`）。
- 收件箱健康：取不到 = 没查成；有条目躺 ≥24 小时 → 红（`:101-133`）。
- swap-leg 只有判据、没有执行体（VPS 读回的执行器日志里从未出现 swap-leg 动作，见 3.5）。

### 2.6 escalation-apply（`scripts/lib/escalation-apply.mjs` + `scripts/fleet-escalations-apply.mjs`）

- 只出计划（纯函数），发信号在脚本里（`:7`）；经 dao-sync 每 5 分钟跑一次（`host/machine/systemd/dao-sync.timer:7-9`，`scripts/server-sync.sh:111-112`）。
- `planEscalationAction`（`:36-53`）：状态没查成 → skip（不动）；工作流不在 → archive；不兼容（TMPRL1100）→ hold 并点名「只能终止重派」；已不在卡住态 → archive；机械裁决不是 retry → hold；自动重开账读不成 → skip；已自动重开 ≥2 次 → hold（`AUTO_RESUME_LIMIT=2`，`:12`）；否则 resume。
- 单已关、工作流还卡着 → cancel（不兼容的除外）（`:62-68`）。
- hold 通知：拿到飞书回的 messageId 才算送达（windsurf-dao#1842，`2ea6df5a8`）。此前走「入队即回执」的日报队列，而队列唯一的发送者已随指挥官退役——VPS 上 6 条记着「已通知」，群里一条没到。

### 2.7 附：fleet 工作流内的自动等待与换腿链

- 卡住后的自动等待（`packages/fleet/src/decide.mjs:26-31,:104-127`）：

| failureClass | 等法 | 上限 |
|---|---|---|
| capacity | 每次睡 300 秒 | 12 次（约 1 小时） |
| queued | 每次睡 60 秒 | 30 次 |
| retryable | 4 / 8 / 16 / 32 / 64 秒 | 5 次 |
| pending | 每次 60 秒 | 10 次（与 retryable 共用计数） |
| 其余或用完 | 停下等信号 → 收件箱 | — |

- 活动重试：Temporal 层 `maximumAttempts: 1`（`packages/fleet/src/workflows.mjs:63,136`），重试全由上表决定。
- 换腿链（T39 ③，`activities.mjs:684-722`）：主腿 + 同 family 候补；会话以 failed 收场或原文命中 `TRANSIENT_UPSTREAM` 就换下一条；准入锁被饿死（code capacity）不换腿、直接交回长退避（`:711-713`）。整条链共用一份等待总量，至少留一整条腿的时间（`packages/fleet/src/limits.mjs:14-20`）。
- 判卡死：会话在跑、没有工具在执行、进度指纹 360 秒不变（`limits.mjs:21-27`，取自 384 个健康会话：各腿 p95 140–229 秒、最大 320 秒）；换腿前先同会话续一句（`activities.mjs:777-790`，2026-09-21 实测活 71 秒已提交、最后一句没出来）。

### 2.8 附：账号池暂停（`scripts/lib/leg-choice.mjs:930-990`）

- 某池最近一条事件是 account 类失败（后面没有成功）→ 暂停。有上游给的恢复时间（retryAt）照办；没有则 15 分钟起、每连错一次 ×4、封顶 24 小时（15m→1h→4h→16h→24h）（`:940-948,:961-974`）。
- 不存状态，每次从执行记录现算，所以不会留下没人解除的暂停（`:959`）。
- 为什么逐级加长：account 是从文字判出来的，会判错（同日把按分钟限流判成额度用完，一条报错停了 28 条腿）；池一停就没有会话，「一次成功立刻解除」永远等不来（`:950-959`）。

---

## 3. 生产读数（VPS 只读）

### 3.1 执行记录里的失败分布

`~/.dao/execution/sessions/*.json` 共 1214 条（2026-09-17T17:32Z – 09-24T16:34Z，更早的已按 windsurf-dao#1748 归档），带 `failure` 字段的 137 条：

| 类/kind/阶段 | 条数 | 主要原文（脱敏）与腿 |
|---|---|---|
| unknown / no-reason / run | **82** | 全部是 cursor-acp-grok-4.6，code=`failed`，没有任何原文 |
| unknown / unrecognized / launch | **35** | 「连不上回环 ws」10（grok-mirasim-native-4.7）；「起会话没查成：没收到 prompt 的应答帧（没查成）」9（claude-relay-fable-5-1）；「连上了但没收到 state 帧，契约没查成——不派」9（kimi-mirasim-native-k3）；「Requested concrete model ID is absent from the ACP model catalog」7（devin-acp-deepseek） |
| upstream / upstream / run | 8 | 「codex app-server 'initialize' timed out」（codex-relay-gpt-5.6-sol） |
| upstream / upstream / launch | 5 | 「ACP runner did not accept the session in time」3、「ACP initialize timed out」2（cursor-acp-grok-4.7） |
| account / auth / run | 3 | 自有档无账号 422（见 S03）、「Not logged in · Please run /login」、「400 此设备已被解绑…」（均为 reclaude-claude-fable-5-1） |
| upstream / stall / run | 3 | 「no progress for 361s / 360s」（grok-mirasim-native） |
| ours / ours / launch | 1 | 「mirasim 对 agent=pi 只认 model="profile:<模型档 id>"…拒起」 |

- unknown 合计 117/137 = **85%**。判例 memory `judge-model-jev-boundaries` 记着「2026-09-21 VPS 执行记录里有原文但正则认不出的是 0 条，先攒数据」——现在 7 天 35 条，但 failure-class 的影子账一直没开（调用点没注入 judge），所以没攒下任何 Jev 对照。
- 82 条 no-reason：81 条对应的 ACP 状态文件已被回收（没查成）。唯一还在的一条（fleet 任务 #1748 g2 的执行者会话）状态文件显示：会话 `phase=cancelled`、`error=null`，有 3 次 `session/request_permission` 交互，约 2 分钟后被取消——即「agent 请求执行复合 shell 命令的权限、没人批、被停掉」，而记录里只剩 `failed`。

### 3.2 mirasim 的结构化结束码（`turn.finish.errorCode`）

`~/.mirasim/analytics/events-2026-09-17..24.ndjson` 共 935 次 turn 结束，564 次 ok（60%），非 ok 371 次：

| errorCode | 次数 | 主要来自 |
|---|---|---|
| incomplete | 118 | grok 113 |
| other | **107** | codex 60、grok 39 |
| interrupted | 90 | grok 71、claude 13 |
| timeout | 23 | codex 23 |
| overloaded | 16 | codex 16 |
| forbidden | 5 | pi 5 |
| route_refused | 5 | claude 4、pi 1 |
| bad_request | 3 | claude 3 |
| auth | 3 | kimi 3 |
| network | 1 | dsh 1 |

- 事件里只有码和耗时（键：ok、errorCode、durationMs、ttfbMs、turnIndex、turnId、queuedMs），**没有原文**。
- `interrupted/aborted` 多数是我们自己停的：历史上 236 条 interrupted 里 231 条在 5 秒内贴着我们发的 stop（`scripts/lib/turn-outcomes.mjs:15-18`）。`incomplete/timeout` 是长流被掐，不证明腿坏（`:22-27`，windsurf-dao#1386）。

### 3.3 mirasim 服务端自带的结构化错误码

VPS 上 mirasim-server 0.0.355 的 `server.cjs` 里有一张「错误码 → 中英文说明」表（只读 grep）。码名：

`cloud_unavailable`、`cloud_unreachable`、`cloud_exhausted`、`cloud_plan_required`、`cloud_plan_not_served`、`cloud_region_unavailable`、`cloud_unusable`、`cloud_credential_expired`、`cloud_credential_stale`、`cloud_clock_skew`、`cloud_client_unsigned`、`relay_unsigned`、`mint_refused`、`signed_out`、`local_no_account`、`local_own_auth_refused`、`local_relay_only_model`、`local_managed_session`（另有网络太慢、`~/.mirasim` 不可写两条没认出码名）。

按相邻文字对上的几条（其余码与说明的对应是按字面推断）：

| 码 | 说明要点 | 说明里自带的处方 |
|---|---|---|
| cloud_unavailable | 平台服务当前繁忙，本轮已停止 | 切换到「自有」路由 |
| cloud_unreachable | 「平台」档，本机连不上平台（域名解析或建立连接失败） | 检查网络；恢复后下一轮自动继续 |
| cloud_exhausted | 「平台」档，平台额度已用尽 | 等窗口重置自动恢复；或切「自有」 |
| cloud_plan_required / plan_not_served | 账号没有平台额度权益 / 平台未对账号开放 | 切「自有」 |
| local_no_account | 「自有」档，本机没有这个智能体的账号 | 登录自有账号，或切「平台」 |
| local_own_auth_refused | 「自有」档，账号凭据被上游拒绝（401） | 重新登录，或切「平台」 |
| local_relay_only_model | 「自有」档，模型只有平台能提供 | 换模型，或切「平台」 |
| signed_out / cloud_credential_* / mint_refused | 没有可用登录凭据 / 凭据过期 / 设备验证被拒 | 重新登录；或切「自有」 |
| cloud_clock_skew | 本机时间与服务器相差过大 | 开时间自动校准；**重新登录没用** |
| cloud_client_unsigned / relay_unsigned | 需要签名的客户端会话 / 设备验证接口 404/501 | 更新客户端 / 稍后自愈 |

- 这些码在两台机器的 analytics 里都搜不到（0 命中），码能否经会话协议帧带给调用方——**没查成**（见第 9 节）。

### 3.4 收件箱：31 条卡单存档（`~/.dao/fleet-escalations/resolved/`，2026-09-19 – 09-24）

| 卡住原因 | 条数 | failureClass |
|---|---|---|
| review-budget-exhausted（审查轮次用尽） | **16** | 空 |
| check-missing-or-ambiguous:check（多为 PR 冲突导致 CI 不触发） | 3 | unscanned |
| checks-not-scanned-on-head | 2 | unscanned |
| review-not-complete-on-head（审查输出被截断） | 1 | unscanned |
| step-failed:UNKNOWN：activity StartToClose timeout | 1 | unscanned |
| step-failed:UNKNOWN：worker 部署重启：活动随旧进程丢失（execute），立即判失败以免干等 startToClose | 1 | unscanned |
| push failed：控制面明确不可达（reachable=false） | 2 | retryable |
| push failed：[rejected]（推送被拒） | 1 | retryable |
| session release unverified：连不上回环 ws | 1 | retryable |
| TRANSPORT_CLOSED：lead session failed | 1 | retryable |
| busy：executor runtime transient（lease-held） | 1 | retryable |
| DEADLINE_EXCEEDED：executor session unknown after grace | 1 | retryable |

- 过半（16/31）根本不是错误，是审查回路走完了。这正是 Claude 臂的「审查打回与基础设施错误要分两本账」（`docs/exams/2026-09-24-vps-isolation-error-routing/arm-claude-relay-fable-5-1.md:214`）和 windsurf-dao#1755 修的问题（CI 修复轮、自审返工轮吃光审查预算）。

### 3.5 收件箱执行器的动作（dao-sync 日志，2026-09-22 14:30 起约 2.5 天）

| 动作 | 涉及任务数 | 说明 |
|---|---|---|
| archive | 15 | 任务已不在卡住态 |
| hold：认不出的失败类 | **13** | failureClass 为空（审查预算用尽）或 unscanned；其中 3 个任务也出现过「认不出的失败类（retryable）」——`escalation-inbox.mjs:62-68` 的 retryable→retry 分支是 09-24 才补的（fleet 任务 #1755 g1 实咬） |
| skip：工作流状态没查成 | 10（共 **39 次**） | 原文全是 `[fleet] Failed to query Workflow` |
| resume：瞬时故障 | 4 | 准入锁 flock 超时、lease-held、launch-uncertain、push 控制面不可达、push 被拒 |
| hold：已自动重开 2 次仍卡住 | 2 | lease-held / launch-uncertain |
| cancel：单已关 | 2 | — |

- 自动重开账（`~/.dao/fleet-escalations/ledger/auto-resume.json`）：5 个任务，共 7 次。
- 日志留存最早到 2026-09-22 14:29（更早的已轮转；机器自 09-02 起未重启），更早的无从统计。
- 整个窗口里没有出现过 swap-leg 动作。

### 3.6 影子账、熔断、健康：生产上的实际状态

| 东西 | 设计上 | VPS 实际（2026-09-25 读回） |
|---|---|---|
| Jev 影子：failure-class / retry-verdict / launch-failure / capacity-death / failure-kind | 认不出时旁听，攒对照 | `~/.dao/judge-shadow/` 下**这 5 个文件都不存在**（只有 issue-draft、model-discovery、pr-acceptance、recall-gate、stop-gate） |
| 原因 | — | failure-class 生产调用点不传 judge（`execution-runtime.mjs:28`）；retry-verdict 只在退役的指挥官里；launch-failure 死代码；failure-kind（#1818，09-24 17:01）上线后还没有任务走到 noteFailure/escalate |
| 熔断表 | 真实流量开闸、全体避开 | 09-18 起无写入；键多为退役网关；冷却全过期；只剩 mirasim 起会话那道门在读，读到的等于全放行（2.3） |
| 健康表 | 探针写、派工读 | 09-20 起冻结；写方已退役（2.4，windsurf-dao#1778） |

---

## 4. 新系统动作表（草案）

依据：决定文档「三臂一致」第 8–13 条与拍板 D2/D3/D5（`docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:22-68`），fleet-dao 设计第十二节（`design.md:289-297`）。起步数字尽量取旧系统的配置或实测，并注明来源；三臂建议值标「臂」。

### 4.1 管道

```
ErrorEvent { 来源, 阶段, 任务, 路由, 账号池, 模型,
             temporal失败类型?, 退出码?, errno?, http状态?, mirasim码?, turn结束码?, cgroup事件?,
             原文(已脱敏, 全文), 时刻 }
   │
   ├─① 结构化信号（写死，命中即终判）
   ├─② 已知文本（写死，每条规则必须带真实样本夹具；文本里写了处方就照办）
   ├─③ Jev（闭卷选择题，只能在「可逆」的 5 类里选；把握低/超时/没 key = 没判）
   └─④ 兜底梯（与 Jev 不存在时完全一样）
   ↓
classify() → { 类别, via: 结构化|文本|jev|兜底, 规则号, 处方? }  →  act(类别) 唯一执行器
```

硬规矩（都来自真实判错，见第 8 节）：
- 状态码只在语义稳定时单独定类（401、402、429、5xx）。**422 永远不能单凭状态码定类**：mirasim 用 422 表示繁忙、断网、无账号等十几种情况，GitHub 用 422 表示请求校验失败（`packages/fleet/src/loop-guard.mjs:114-117`）。
- **原文必须留全**：旧 runner 只把前 160 字写进卡住原因（`packages/fleet/src/runner.mjs:557`），真实卡单里被拒原因正好被切掉（第 5 节 S17）。分类用全文，展示再截。
- **文本优先于状态码的反例要写进规则**：`400 此设备已被解绑` 是凭据失效；`403 Internal error during token generation` 是上游内部错误。
- 同一条原文从任何入口进来，必须得到同一个类别（决定文档验收第 2 条，`:109`）。

### 4.2 动作表（类别 = 动作，共 11 类）

| 类别 | 动作 | 先认的结构化信号 | 已知文本（夹具见第 5 节） | 起步预算（来源） | 共享状态 | Jev 能判入 |
|---|---|---|---|---|---|---|
| **ours** 我们自己停的 | 不算失败，按编排意图走；不计腿战绩 | Temporal CancelledFailure；turn 码 interrupted/aborted；我们发 stop 后 5 秒内结束 | —— | 不重试 | 腿战绩里扣除（`turn-outcomes.mjs:15-18`） | 否 |
| **gone** 对象已不在 | 当成功收尾、记 gone | ENOENT（目标路径）；工作流 NotFound；已完成 | S33、S48 | 0 次（windsurf-dao#1350） | —— | 否 |
| **retry-here** 原路再试 | 先同会话续一句，再原路短退避 | errno ECONNRESET/EPIPE/ETIMEDOUT；turn 码 incomplete/timeout；非 overloaded 的 5xx；TRANSPORT_CLOSED；startup timeout；mirasim cloud_unreachable | S02、S06–S10、S20、S21、S26、S27、S30 | 续一句 1 次（`activities.mjs:777-790`）→ 4/8/16/32/64 秒最多 5 次（`decide.mjs:29,124`） | 断流不进腿失败率分母（#1386）；**同一时段多条独立腿同形状失败 → 判共用层坏 → 转 wait（全局），不换路** | 是 |
| **switch-route** 换路由 | 立刻换同模型的另一条路；该路由进共享冷却，半开一针恢复 | 429（无余额字样）、503 overloaded、529；turn 码 overloaded、route_refused；mirasim cloud_unavailable / local_no_account / cloud_plan_* / local_relay_only_model | S01、S03、S23、S29、S39*、S43、S44、S49 | 0 等待；冷却起步 10 分钟（Grok 臂）或 2→4→8 轮±1（旧 #1145/#1230）；真实流量 ≥8 条且失败率 ≥60%/6 小时才整路熔断（#1342） | **路由健康表**，全体任务可见 | 是 |
| **wait** 等到某个时刻 | 睡到时间点再试，不占重试预算 | Retry-After；上游给的 retryAt；机器槽/测试槽/准入锁满；渠道满；所有候选路由都在冷却；mirasim cloud_exhausted（等窗口）；GitHub 次级限流 | S16、S19、S22、S36、S39 | 旧：capacity 300 秒×12、queued 60 秒×30（`decide.mjs:27-28`）；有 Retry-After 照办 | —— | 是 |
| **pause-pool** 停账号池 | 停这个池、任务换到别的池继续、异步告警 | 402；401 / 鉴权类 403；mirasim signed_out / cloud_credential_* / mint_refused / local_own_auth_refused | S04、S05、S28、S31、S32、S45、S52 | 有 retryAt 照办，否则 15 分→1 时→4 时→16 时→24 时，一次成功即解除（`leg-choice.mjs:940-974`） | **账号池状态**，全体可见 | **否**（决定 D2） |
| **restart-session** 从检查点重起 | 停掉旧会话，保留树与提交，新会话接着干 | Temporal TimeoutFailure(StartToClose/Heartbeat)；活动随 worker 重启丢失；无进展 360 秒；session unknown after grace；cgroup oom_kill 一次 | S12、S14、S15、S20、S25、审查输出截断 | 同会话续一句 1 次 → 新会话 1 次；链上至少留一整条腿的时间（`limits.mjs:14-20`） | —— | 是 |
| **switch-model** 换模型 | 同角色换另一型号 / 另一厂；目录漂移则把这条腿标下架 | ACP model_unavailable；拒模 | S11、S24（原文处方「try a different model」）、S34、S46、S47 | 立即 | 腿目录状态 | 是 |
| **fix-git** 机械修集成 | 并目标分支 / fetch+rebase 再推 / 等 mergeable 重算 | mergeable=CONFLICTING；MERGE_CONFLICT；push non-fast-forward；PR 零 check 且 CONFLICTING | S17、S35、check-missing | 自动并 1 次 → 回会话解冲突 1 次；mergeable 重算宽限 4×15 秒（`activities.mjs:25-27`） | —— | 否 |
| **rework** 返工 | 把意见交回原会话改 | CI 结论 FAILURE；审查 P1；交付与计划零交集 | review-budget-exhausted（用尽后转 hold） | **独立预算**：审查意见最多 2 轮（`design.md:176`） | —— | 否 |
| **hold** 挂起报警 | 交 AI 帅位诊断；只有人闸四类才等人 | PERMISSION_DENIED（App 无 workflows 权限）；TMPRL1100；ENOSPC；时钟偏差；客户端需签名；契约矛盾（P1 质疑任务书）；兜底梯走完 | S18、S37、S42 | —— | 通知拿到回执才算送达（#1842） | 否 |

\* S39 是 GitHub 次级限流：对 GitHub 调用走 wait（停几分钟、串行），不是换模型路由。

没有「认不出」这一类：认不出 = 进管道第 ③④ 步。

### 4.3 兜底梯与升级

- 认不出（规则 0 命中）：先问 Jev（预算 2 秒，臂）；Jev 判入 retry-here / switch-route / wait / restart-session / switch-model 之一且把握 ≥0.7（旧 Jev 放行线，`docs/jev/registry.json` 各条）才用；否则走兜底梯：**retry-here 1 次 → switch-route 1 次 → switch-model 1 次 → hold**（决定 `:24`，设计 `:294`）。
- 同一指纹再犯，不许停在同一格，升级一格（决定 D2 `:49`）。指纹比较用**逐字原文**，不做归一化（`retry-verdict.mjs:169-175`）；「连续 2 轮逐字相同 = 重试不会变」（`:147`）。
- 单任务自动处置总上限（臂：20 分钟或 8 次动作，Grok 臂 `arm-grok-mirasim-native-4.7.md:139-145`）——旧系统没有这个数，**起步值待实测**。
- 每一次 classify 落一行：原文、类别、via、动作、下一次同任务结果（奏效/同类再犯/别的错）。unknown 与「缺原因」各自单独计数上墙（第 3.1 节那 82 条 no-reason 在旧系统里没人数）。

### 4.4 两本预算账（必须分开）

| 账 | 装什么 | 起步值 | 依据 |
|---|---|---|---|
| 基础设施处置账 | retry-here / switch-route / wait / restart-session / switch-model / fix-git | 见 4.2 | 决定 D2；Claude 臂 F 类 |
| 返工账 | CI 修复、自审返工、审查 P1 | 最多 2 轮，之后交 AI 帅位 | `design.md:176`；windsurf-dao#1755（旧系统 CI 修复轮吃光审查轮次，2026-09-24 五张单同一个死法，`contract.mjs:36-40`） |

- 控制面 / 共用层故障窗内的失败不占任何一本业务账（windsurf-dao#1331，memory `outage-burns-retries`）。

### 4.5 Jev 的边界（照搬已拍的）

- 只输出类别标签，动作由代码表决定；只能判入 5 个可逆类（retry-here、switch-route、wait、restart-session、switch-model）；不许触发 pause-pool、hold、gone、合并、删树（决定 D2 `:40-49`）。
- 超时 / 没 key / 把握低 = 没判，走兜底梯，不停机（`:48`）。
- 喂全文，不裁剪（memory `judge-model-jev-boundaries`：裁掉「无关」正文反而漏判，把握 0.76→0.30）。
- 先影子：每条 Jev 判断与规则/事后奏效的动作对照留档；影子必须真的在生产调用点接上（旧系统的教训是影子挂在没调用方或没注入 judge 的地方，攒了 0 条）。

### 4.6 与 fleet-dao 设计的对应

| 设计文档 | 本表 |
|---|---|
| 「错误按下一步该做什么分类，类别数 = 动作数」 | 11 类 = 11 个动作 |
| 「先认结构化信号，再认已知文本，最后交 Jev」 | 4.1 管道 ①②③ |
| 「兜底阶梯：有界重试 → 换路由 → 换模型 → 挂起并报警」 | 4.3 |
| 「某条路由对一个任务报繁忙，所有任务一起避开它，过一会儿试探恢复」 | switch-route 的共享冷却 + 半开一针；熔断必须吃真实流量、一路一把键、全红即判共用层坏不剔空（memory `breaker-must-eat-real-traffic`） |
| 「按进展判死活，不靠认错误长什么样」 | restart-session 用无进展判据（360 秒），错误字样只用来说明原因 |
| 「停下等人只剩人闸一种情况」 | hold 先交 AI 帅位；只有发布/花钱/删数据/改规则等人 |

### 4.7 旧系统里该丢掉的

- **5 个分类函数 + 7 处「看文字定处置」的散点**（第 1 节）：合成一个 `classify()` + 一张动作表 + 一个执行器；分类模块之外不许再出现匹配错误文本的正则（第 8 节第 13 条）。
- **「认不出 = 停下等人」**（`classifyStepFailure` 的 unscanned → 收件箱）：认不出走 Jev 与兜底梯，不等人。
- **裁决收件箱 + 每 5 分钟的执行器 + 自动重开账**（2.5、2.6）：改成工作流内的兜底梯 + AI 帅位；只有人闸等人。
- **熔断表、健康表这类 JSON 状态文件**（2.3、2.4）：写方一退役，读方就按「过期 = 不拦」静默放行；新系统一张路由健康表进 Postgres，写方失联要报警（第 8 节第 34 条）。
- **挂在没有调用方、或没注入依赖处的 Jev 影子**（3.6）：影子必须真在生产调用点接上，否则一条也攒不下。
- **把 1.2–1.6G 当每会话准入预留**（6.4）：那是单 agent MemoryHigh 的上限建议，不是实测值。

---

## 5. 真实样本夹具清单

来源类型：**生产**＝VPS 执行记录 / 收件箱存档 / 执行器日志；**实遇**＝提交正文、代码注释或判例里写明是真机原文；**测试**＝只在测试里出现、没找到真机出处（可作补充，不可当「真实样本」验收）。

| ID | 原文（脱敏） | 来源 | 旧系统（现役入口）怎么判 | 新类别 | 应触发的动作 |
|---|---|---|---|---|---|
| S01 | `API Error: 422 平台服务当前繁忙，正在处理的请求较多，本轮已停止；如需立即继续，请切换到「自有」路由。` | 实遇：#1805 `11d534e6a`（用户 09-24 本机实遇）；mirasim 码 cloud_unavailable | #1805 前：契约 unscanned（交人）、分类账 unknown、启动 hard、pi null；#1805 后契约 capacity（等 12×5 分钟） | switch-route | 照处方切「自有」路由；平台路由进共享冷却，全体避开 |
| S02 | `422 当前是「平台」档，而本机此刻连不上平台（域名解析或建立连接失败），本轮已停止……[ECONNRESET]` | 实遇：#1805；mirasim 码 cloud_unreachable | #1805 前契约 unscanned；后 retryable | retry-here | 短退避原路重试；若所有路由同时如此 → 判本机断网 → wait（全局），不做无效换路 |
| S03 | `API Error: 422 当前是「自有」档，而本机没有这个智能体的账号，本轮已停止，没有任何请求发往平台。为它登录一个自己的账号，或切换到「平台」。` | 生产：执行记录 1 条（reclaude-claude-fable-5-1）；mirasim 码 local_no_account | 分类账 account/auth（会停账号池）；契约 unscanned | switch-route | 照处方切「平台」；异步提示「这台机没有该 agent 的自有账号」；**不停池** |
| S04 | `Not logged in · Please run /login` | 生产：执行记录 1 条 | 分类账 account/auth | pause-pool | 停该池（逐级加长）＋换池继续＋告警要人重新登录 |
| S05 | `API Error: 400 此设备已被解绑，请在终端重新运行 reclaude 完成登录（请勿在 Claude Code 内使用 /login 登录）（请求 ID: <请求ID>）` | 生产：执行记录 1 条；同类成因见 `host/machine/systemd/mirasim-server.service:31-36`（去掉 NO_AGENT_EGRESS 约 90 秒后设备被解绑，#1521） | 分类账 account/auth | pause-pool | 同 S04；**状态码 400 不能当请求不合法** |
| S06 | `codex app-server 'initialize' timed out` | 生产：执行记录 8 条（codex-relay-gpt-5.6-sol）；也是考卷第四臂阵亡原因（决定 `:11`） | 分类账 upstream | retry-here | 重起 1 次 → switch-route |
| S07 | `ACP runner did not accept the session in time` / `ACP initialize timed out` | 生产：执行记录 3+2 条 | 分类账 upstream | retry-here | 同 S06 |
| S08 | `连不上回环 ws`（及 `session release unverified: 连不上回环 ws`） | 生产：执行记录 10 条；收件箱 fleet 任务 #1338 g1；实测 12 小时红 11 次、每次下一轮自愈（`contract.mjs:164-166`） | 分类账 **unknown**；契约 retryable；重试 retryable | retry-here | 短退避；持续 → 共用层（mirasim 本机服务）告警，先查工作树数量（memory `worktree-pileup-starves-mirasim`），不换路 |
| S09 | `起会话没查成：没收到 prompt 的应答帧（没查成）` | 生产：执行记录 9 条；windsurf-dao#1840 | 分类账 unknown | retry-here | 1 次 → switch-route |
| S10 | `连上了但没收到 state 帧，契约没查成——不派` | 生产：执行记录 9 条 | 分类账 unknown | retry-here | 1 次 → switch-route |
| S11 | `Requested concrete model ID is absent from the ACP model catalog` | 生产：执行记录 7 条（code=model_unavailable）；windsurf-dao#1840 | 分类账 unknown，且这条已被巡检判「下架」的腿仍在派 | switch-model | 立刻换模型；把这条腿标下架，不再派 |
| S12 | `no progress for 361s`（code=stalled） | 生产：执行记录 3 条 | 分类账 upstream/stall | restart-session | 同会话续一句 → 新会话 → switch-model |
| S13 | code=`failed`、原文为空 | 生产：执行记录 82 条；可核的 1 条是 3 次权限请求后被取消 | 分类账 unknown/no-reason | （认不出）→ 兜底梯 | 按兜底梯；**「缺原因」单独计数告警**；ACP 权限请求挂起要落成可读原因 |
| S14 | `step-failed:UNKNOWN：activity StartToClose timeout` | 生产：收件箱 fleet 任务 #1608 g1 | 契约 unscanned → 交人 | restart-session | 查树里有没有进展，从检查点重起，不交人 |
| S15 | `step-failed:UNKNOWN：worker 部署重启：活动随旧进程丢失（execute），立即判失败以免干等 startToClose` | 生产：收件箱 fleet 任务 #1744 g1（产生这句的代码不在仓内） | 契约 unscanned；执行器后来 resume | restart-session | 立即从检查点重跑该活动 |
| S16 | `push failed: 拦下失控会话的对外写：git push 控制面明确不可达（reachable=false）。只读和本地提交不拦。` | 生产：收件箱 fleet 任务 #1318 g1、#1560 g1 | 契约 retryable（占 5 次小退避） | wait | 等控制面恢复再推；不占业务预算 |
| S17 | `push failed: … ! [rejected] HEAD -> <分支> (non-fast-forward)` | 生产：收件箱 fleet 任务 #1748 g2 的原文正好截断在 `! [rejected]`，被拒原因被 160 字上限切掉（`runner.mjs:557`）；non-fast-forward 形态取自测试 `packages/fleet/test/activities.test.mjs:801` | 契约 retryable | fix-git | fetch + 并/变基目标分支再推；原文必须留全 |
| S18 | `[remote rejected] HEAD -> <分支> (refusing to allow a GitHub App to create or update workflow .github/workflows/check.yml without workflows permission)` | 实遇：#1725 真 stderr（`activities.test.mjs:800`；memory `github-app-cannot-push-workflows`） | 修前判 retryable 永远推不上；修后 blocked | hold | 挂起报警；换有权限的推送身份属于改规则/凭据，要人拍 |
| S19 | `executor runtime transient（lease-held）：worktree has an unresolved launch or cleanup` | 生产：收件箱 fleet 任务 #1734 g2（自动重开 2 次后仍卡） | 契约 retryable | wait | 先收掉本树自己的残留会话再起（`activities.mjs:745-751`），不算失败 |
| S20 | `executor session unknown after grace; session stopped to free the tree` | 生产：收件箱 fleet 任务 #1755 g2（DEADLINE_EXCEEDED） | 契约 retryable | restart-session | 从检查点重起 |
| S21 | `lead session failed`（TRANSPORT_CLOSED） | 生产：收件箱 fleet 任务 #1560 g2 | 契约 retryable | retry-here | 短退避 |
| S22 | `execution admission flock unavailable: ETIMEDOUT (2636ms, timeout 2000ms, ~/.dao/execution/admission.lock)` | 生产：windsurf-dao#1802；09-22 三条工作流同因卡住（`contract.test.mjs:176`） | 修前 unscanned（交人）；修后 retryable / capacity | wait | 机器忙，下一轮再来；锁超时要计数上墙 |
| S23 | `gpt-5.6-terra 当前可用容量已满，本次请求未被服务` | 实遇：2026-09-19 relay 三模型同时满（`contract.mjs:151`，`contract.test.mjs:204`） | 契约 capacity；分类账 **unknown** | switch-route | 换路由 + 共享冷却 |
| S24 | `Selected model is at capacity. Please try a different model.` | 实遇：2026-09-07 真会话（`dianjiangtai-reviewer-slot.mjs:122`） | 契约 capacity；pi null | switch-model | 原文处方写的是换模型，照办（决定 D3） |
| S25 | `pi turn stalled past 30 minutes` | 实遇：2026-09-07（`dianjiangtai-reviewer-slot.mjs:123`） | 分类账 unknown | restart-session | 同 S12 |
| S26 | `stream disconnected before completion: stream closed before response.completed` | 实遇：2026-09-17 codex 审官近 6 小时 10 次会话 9 次（memory `reviewer-session-dies-upstream-stream`） | 分类账 upstream（计入腿失败）；启动 hard | retry-here | 续跑同一会话；不进腿失败率分母；多腿同形状 → 共用层 |
| S27 | `503 status code (no body)` | 实遇：2026-08-16 pi 会话日志（memory `pi-silent-provider-fallback`） | pi transient | retry-here | 引擎决定换不换路；**执行工具不许自己静默换 provider** |
| S28 | `402 Insufficient Balance` | 实遇：同上（直连渠道的 402） | 分类账 account/quota；pi hard | pause-pool | 停池 + 告警；**不许自动切到按量计费的路由**（`design.md:51` 花钱定义） |
| S29 | `503 new_api_error: system cpu overloaded` | 测试注明「GLM 网关过载」（`tests/go-fallback.test.js:83-87`） | pi transient | switch-route | 换路由 + 冷却 |
| S30 | `403: Internal error during token generation` | 实遇：2026-09-03 网关连续 403 的判别测试（`tests/go-fallback.test.js:151-170`） | 分类账 **account/auth**；pi **transient** | retry-here | 重试 → 换路由；**不停池** |
| S31 | `GoUsageLimitError: Monthly usage limit reached` | 测试（`tests/go-fallback.test.js:176`） | pi hard | pause-pool | 停到月度重置 |
| S32 | `You've reached your 5-hour usage limit` | 测试（`tests/go-fallback.test.js:97`） | pi hard | pause-pool | 停到 5 小时窗重置（能读出时间就照读） |
| S33 | `session-stop 没查成: ENOENT: no such file or directory, lstat '~/mirasim-worktrees/<仓>/<树>'` | 实遇：2026-09-13 七天日志 93 次（`retry-verdict.mjs:5,220`）；#1350 一轮 234 条 0 成功 | 重试 terminal | gone | 记 gone 正常返回，不重试 |
| S34 | `reviewer-attach 失败：起审官会话没查成：execution profile unverified: <执行档>` | 实遇（`retry-verdict.mjs:222`） | 重试 terminal | switch-model | 换一条已验证的腿；目录问题告警 |
| S35 | `reviewer-attach 失败：先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）` | 实遇：2026-09-14（`retry-verdict.mjs:158`） | 重试 retryable（每 20 分钟白试） | fix-git | 并目标分支 |
| S36 | `mirasim 起会话失败: worktree already has an active or unknown session` | 实遇（`retry-verdict.mjs:227`） | 重试 retryable | wait | 收本树残留再起 |
| S37 | `HTTP 422: Validation Failed`（gh pr create 等） | 实遇（`loop-guard.mjs:116`） | 各入口都不认 | hold | 我们自己的请求数据错，交 AI 帅位；**不许因 422 当成平台繁忙** |
| S38 | `gh: Resource not accessible by integration (HTTP 403)` | 实遇：2026-08-17 GitHub 部分中断期间（memory `github-outage-three-faces`） | 分类账 account/auth | wait | 先查 GitHub 状态页；恢复后仍 403 再 hold |
| S39 | `API rate limit exceeded`（主配额充足） | 实遇：2026-08-16（memory `github-secondary-vs-primary-limit`） | 契约 capacity | wait | 按次级限流：停几分钟、串行，不按主配额重置时间干等 |
| S41 | `[fleet] Failed to query Workflow` | 生产：执行器 2.5 天 skip 39 次 | 状态 没查成（每 5 分钟重来） | retry-here → hold | 有上限，超了告警；状态应读自己的库而不是向工作流发 query |
| S42 | `[fleet] [TMPRL1100] Nondeterminism error: Activity type of scheduled event 'escalate' does not match activity type of activity command 'review'` | 实遇：#1633 真机样本（fleet 任务 #1337 g1，`tests/escalation-apply.test.js:193-194`） | 状态 incompatible → hold | hold | 交 AI 帅位：终止并按检查点重派 |
| S43 | `429 Quota exceeded for requests per minute` | 测试（`tests/failure-class.test.js:25`），对应真实事故「按分钟限流停了 28 条腿」 | 分类账 upstream；pi **hard**；启动 **hard** | switch-route | 换路由/等待；**不停池** |
| S44 | `触发限流：每分钟额度已满，请稍后再试` | 测试（同上） | 分类账 upstream | switch-route | 同 S43 |
| S45 | `账户余额不足，请充值，本周额度已用完` | 测试反例（`tests/failure-class.test.js:54`） | 分类账 account/quota | pause-pool | 停池；**不许被附近的「繁忙」规则拉进 switch-route** |
| S46 | `agent_unconfigured: Workspace Trust not granted` | 测试；状态码 agent_unconfigured 为 #649 实证（`next-launch.mjs:175-177`） | 启动 config | switch-model | 这台机上这条腿不能用：换腿 + 告警修机器配置 |
| S47 | `Cannot use this model` | 测试（`tests/next-launch.test.js:39`） | 启动 hard | switch-model | 换模型 |
| S48 | `workflow not found` | 测试（`tests/escalation-apply.test.js:198`） | 状态 gone | gone | 收走条目 |
| S49 | `429 rate_limit_error` | 测试（`tests/go-fallback.test.js:190`） | 契约 capacity；启动 **hard** | switch-route | 有 Retry-After 先等一次，否则换路由 |
| S52 | `429 insufficient_quota` | 测试（`tests/failure-class.test.js:29`） | 分类账 account/quota；契约 **capacity** | pause-pool | 停池（不是等 1 小时） |
| — | `review-budget-exhausted`（审查轮次用尽） | 生产：收件箱 16 条 | 收件箱「认不出」→ 交人 | rework→hold | 返工账用尽 → 交 AI 帅位诊断，不直接等人 |
| — | `check-missing-or-ambiguous:check` + PR `mergeable=CONFLICTING` | 生产：收件箱 3 条；memory `conflicting-pr-gets-no-ci-runs`（撞 3 次） | 修前 unscanned 交人 | fix-git | 并目标分支 → CI 自然触发 |
| — | `review-not-complete-on-head`（审查结论在 811 字处被截断） | 生产：收件箱 fleet 任务 #1295 g1（`escalation-inbox.mjs:83-86`） | 修后 retry | restart-session | 只重审，不重做执行 |

没有真实样本的类别（**只能写合成用例，验收时标明**）：cgroup `oom_kill`（VPS 三个服务 `memory.events` 全 0、留存日志无内核 OOM）、ENOSPC、时钟偏差、客户端需签名、GitHub 分支保护拒推。

---

## 6. 资源隔离：做到哪了

### 6.1 决定的实施顺序 vs 现状

| 决定里的步骤（`docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:81-103`） | 现状 | 证据 |
|---|---|---|
| P0-1 会话服务 `OOMPolicy=continue` | **已落地并生效** | windsurf-dao#1810（`443cda61`）；`host/machine/systemd/mirasim-server.service:74`；`tests/mirasim-ws-probe.test.js:597-607`；VPS `systemctl show` = continue |
| P0-2 Temporal 并发 12→6（垫片） | **没按原样做**：worker 活动并发仍是 12；改用 #1748 的执行槽（floor(核数/2)=3）与派单器在途上限 8→5（#1767）替代 | `packages/fleet/src/cli.mjs:797-801`；VPS 日志 09-24 三次启动均「并发=12」；`scripts/lib/dispatcher/gates.mjs:10-17` |
| P1-3 建 `agents.slice` + 只开 accounting | **未做**：VPS 上只有 system.slice / user.slice 等，没有 agents.slice；仓内无相关代码 | VPS `systemctl list-units --type=slice`；全仓 grep 无 `agents.slice` |
| P1-4 agent 进独立 scope、迁出会话服务 | **未做**：mirasim 起的 agent 在 `/system.slice/mirasim-server.service`；ACP 腿的 runner 由 fleet worker `spawn(..., {detached:true})` 起，留在 fleet worker 的 cgroup | VPS `ControlGroup`；`scripts/lib/acp-runtime.mjs:466`、`scripts/acp-session-runner.mjs:695` |
| P1-5 soft/hard 限 + 故意作恶用例 | 未做 | —— |
| P2-6 准入加「agent 池内存账本 + PSI」 | **未做**；而且现役派单器根本没有 CPU 闸 | `scripts/lib/dispatcher/gates.mjs:59-72`（闸表：memory / mirasimRss / worktree / legHealthy / inflight + dailyCap）；85% CPU 闸在 `scripts/commander.mjs:501`（指挥官已退役） |
| P3 错误分流收敛 | 未开始；仅 #1805 补字样、#1787 挂影子；决定当天又长出一份（#1818） | 第 1 节 |
| P4 指标面板 | 未做 | —— |

### 6.2 单元与代码（仓内真相 vs 机器真相）

| 单元 | 仓内写的 | VPS 生效值 | 漂移原因 |
|---|---|---|---|
| mirasim-server | `MemoryHigh=2.5G`、`MemoryMax=4G`、`OOMPolicy=continue`、`Restart=always`、`Environment=DAO_TEST_POOL=2`（`mirasim-server.service:57,63,68,69,74`） | MemoryHigh **3.5GiB**、MemoryMax 4GiB、MemorySwapMax 无限、TasksMax 默认 14306、CPUWeight 未设、Delegate=no | `/run/systemd/system.control/mirasim-server.service.d/50-MemoryHigh.conf`：2026-09-16 04:44 由 `systemctl set-property --runtime` 生成；机器 09-02 起没重启过，**下次重启会静默回到 2.5G**；仓内漂移检查只比对单元文件 |
| dao-fleet-worker | —— | 无内存上限、`OOMPolicy=stop`（默认）、Delegate=no | ACP agent 在它的 cgroup 里：该组里任一进程被 OOM 杀，systemd 按默认会停掉整个 worker |
| dao-fleet-temporal | —— | 无上限、`OOMPolicy=stop`；SQLite 持久化；09-19 起运行 | —— |

- 跨仓耦合：ai-gateway-stack 的受控升级器靠「会话服务 cgroup 里没有活进程」判断能否升级（`ai-gateway-stack/deploy/mirasim-managed-update.mjs:397-449,500-525`）。把 agent 迁出会话服务的 cgroup 之后，这个「空闲」判据要一起改，否则升级器会在 agent 还在跑时动手。

### 6.3 VPS 实测读数（2026-09-25 01:24，空闲时段）

| 项 | 读数 |
|---|---|
| 机器 | 6 核；内存 11960MB，已用 2297MB，可用 9663MB；swap 8191MB，已用 338MB；loadavg 1.05 / 1.75 / 1.56 |
| PSI（整机） | cpu some avg10 4.70 / avg60 4.80 / avg300 5.69；memory some 与 full 全 0；io some 0.13 / 1.21 / 3.21，full 0.03 / 1.07 / 2.71 |
| mirasim-server | 当前 668MB，09-24 15:11 以来峰值 2.00GB；任务数（含线程）29，cgroup 里 3 个进程（空闲）；memory.events 全 0；memory.pressure 0 |
| dao-fleet-worker | 当前 126MB，峰值 212MB；memory.events 全 0 |
| dao-fleet-temporal | 当前 154MB，峰值 230MB；memory.events 全 0 |

历史读数（有出处的）：
- 2026-09-08：mirasim-server 跑 4 天膨胀到 6.8G，ws 起会话面静默瘫痪，才加了 MemoryHigh/MemoryMax 垫片（`mirasim-server.service:12-17`）。
- 2026-09-18：主进程 CPU 85% 持续、内存撞 `MemoryHigh=3.5G`、每小时约 3.3 万次重复 relay 查询（`docs/observations/2026-09-18-上报mirasim-回填不收敛与codex不重试.md:20`）。
- 2026-09-22 04:28：一次 3.5G 峰值以 stop-timeout 形式带走会话服务（`mirasim-server.service:72-73`；原始日志已不在留存范围，见第 9 节）。
- 2026-09-20：162 棵工作树时 mirasim 同时挂 67 个 git 子进程、主线程 CPU 50%、起会话准备 58 秒；删到 75 棵后 git 子进程 0、CPU 0%、探针 6.5 秒、全量检查 107→72 秒（memory `worktree-pileup-starves-mirasim`，windsurf-dao#1570）。

### 6.4 每会话内存：旧系统唯一的实测

来源：`~/.dao/admission/samples.ndjson`（指挥官准入采样，2026-09-06 17:51Z – 09-18 13:40Z，1297 条；指挥官退役后停写）。在途数是指挥官从 `/proc` 数的在跑会话（工人、审官都算，`scripts/lib/admission.mjs:205-217`），读数间隔不固定，所以这是粗代理，不是 cgroup 级实测。取相邻两次读数在途数恰好差 1 的 344 对，看 MemAvailable 变化：

| 分位 | 每多一个在途会话，可用内存减少 |
|---|---|
| p25 | 100MB |
| p50 | **191MB** |
| p75 | 364MB |
| p90 | **559MB** |
| 最大 | 1836MB |

- 在途数 0 时 MemAvailable 中位 9221MB；14 个在途时 7072MB；全程最低 3348MB；在途最多 16 个。CPU 真忙比例 p50 0.28、p90 0.84、p99 0.98。
- 旧准入的保守值 400MB/人、注释「实测 RSS 约 180MB」「12 个工人只吃约 2.2G」（`scripts/lib/admission.mjs:40-44`）与此一致。
- **结论**：fleet-dao 设计里「每个会话连同测试先按 1.2–1.6G 估」（`design.md:142`）来自决定 D4 的「单 agent MemoryHigh 1.2–1.6G」（`:64`），那是三臂给的**上限建议**、且明写「不是现在就要用」。拿它当准入预留，6 会话要预留 7.2–9.6G，接近整机可用量；拿实测 p90（约 0.6G）加测试槽控制尖峰，会宽松得多。建议：1.2–1.6G 只作单 agent scope 的 MemoryHigh，准入按实测分位 + 池账本；第一轮照决定先只开 accounting 采数。

---

## 7. 准入闸与测试信号量（windsurf-dao#1748）的经验值

### 7.1 现场（2026-09-22 13:56，6 核 VPS）

- 负载 7 → 15 → 11.6；可运行队列 23；用户态 50%、**系统态 40%**（进程狂开狂关）、IO 等待 7%。
- 分解：一个工作树里同时 13 个 node 测试进程（fleet 任务 #1675 g2）；主仓另一份 109 秒的全量检查（进程池 6）；5 张 fleet 任务同时在执行阶段；mirasim-server 9.5 小时持续半个核（30 棵树）；用量采集器每轮扫 1526 个会话文件（222 个超 7 天）占 20% CPU。
- 后果：准入闸只管放不放新会话，管不了已放进来的会话在树里开多少测试进程；机器一忙，闸自己的锁 2 秒拿不到，fleet 任务 #1734 被记成「没查成」卡住——**闸被它该防的负载饿死**。
- 同日帅位补充：派单器闸表里没有 CPU 准入，14:22 那轮在负载 9 时照样派了 2 张（#1748 评论 2026-09-22T06:32Z）。
- 同日断链：「本机不跑全量、CI 是裁判」（#1583）漏了第 5 处——每 5 分钟的服务器自检在 HEAD 一变时就跑一遍全量（170 秒、3 红），当天合十几个 PR 就跑十几遍（#1748 评论 2026-09-22T06:43Z；memory `rule-fix-missed-fifth-copy`）。

### 7.2 措施与数字

| 措施 | 数字 | 出处 |
|---|---|---|
| 垫片：测试进程池宽度 | `DAO_TEST_POOL=2`（经 mirasim 起的所有会话继承；默认按核数夹在 2..6；非法值回默认并报警） | PR #1750；`mirasim-server.service:57`；`scripts/lib/test-pool.mjs:23-43` |
| 全机测试槽 | 2 槽（`docs/release-policy.json` `budget.machine.testSlots`），flock 文件锁；拿不到**排队**最长 10 分钟；一轮扫完再睡 1 秒（250ms 时两槽每秒起 8 个 flock，正是「系统态 40%」的形状） | `scripts/lib/test-slots.mjs:1-30` |
| fleet 执行阶段封顶 | 同时处于执行阶段的任务 ≤ floor(核数/2) = 3；多的在 prepare 前排队、不吃重试预算；等人之前放槽 | `packages/fleet/src/machine-slots.mjs:1-27`；`workflows.mjs:73-82` |
| 准入锁自保 | 锁 2 秒拿不到 → capacity 类（带 loadavg 趋势）→ 长退避，不换腿 | `contract.mjs:145-148`；`activities.mjs:40-47,711-713` |
| 采集器归档 | 超 7 天的会话文件挪到 `sessions-archive/<年-月>/`，只移不删 | #1847（`e88ca29ab`） |
| worker 活动并发 | 保持核数×2 = 12，只给纯 IO 活动 | `cli.mjs:792-801` |
| 派单器在途上限 | 8 → **5**（8 条同跑时 load 14、回环 ws 反复断连、控制面探针闪红；5 条时 load 3~5） | #1767（`a33580694`）；`gates.mjs:7-17` |
| 派单器其余闸 | 可用内存 ≥1536MB、mirasim RSS <3072MB、工作树 ≤20、腿健康、每日 ≤20 张 | `gates.mjs:13-19,59-72`；`release-policy.json` `budget.per_day.dispatch_max` |
| （已退役的）指挥官准入 | 真 CPU 占用 ≥85% 不收（2026-09-10 起取代 loadavg：IO 型负载下 loadavg 归一 0.57–1.50 而真 CPU 只有 0.24）；内存预留 1536MB；样本不足按 400MB/人；至少 4 对样本；取近 12 对中位数 | `scripts/lib/admission.mjs:1-51,233-331` |

### 7.3 读回与缺口（2026-09-25）

- `mirasim-server` 环境里有 `DAO_TEST_POOL=2`；`~/.dao/test-slots/` 下有 `slot-0.lock`（用过）。
- `~/.dao/fleet/machine-slots.json` **不存在**：执行槽合入（09-24 15:49 +08）、worker 随后三次重启吃到新码之后，还没有新任务进执行阶段，封顶效果没有生产实测（第 9 节）。
- 派单器最近一轮闸读数：可用内存 9644MB、mirasim RSS 582MB、工作树 4、在途 0、当日已派 1/20。
- 准入锁本该毫秒级，09-24 10:14Z 一次耗 2636ms 超时，且失败不计数不落盘（windsurf-dao#1802，开着）。
- 执行槽的集成测试在 PR #1847 上两次 CI 超时：放槽活动还在跑时 worker 被替换，resume/cancel 卡住（修法：先挂等待、再补等放槽；`e88ca29ab` 正文）。

### 7.4 给新系统的经验值（起步用，需实测回调）

| 量 | 旧系统经验 | 建议 |
|---|---|---|
| 同时跑测试 | 2 份（槽）× 池宽 2；3 份并发全量 = 负载 13.79、全红（固定路径互删） | 设计的「2–3 份」可以；测试必须用独占临时目录（memory `fixed-name-sandbox-dies-under-concurrent-runners`） |
| 同时执行的任务 | 3（执行槽）/ 5（在途） | 设计起步 6 会话合理，但先开 accounting 看 p90 内存 |
| 放行判据 | CPU% 在 IO 型负载下误判；现役靠「在途数 + 内存余量 + 槽」 | 设计「看内存与压力，不看整机 CPU」与经验一致；PSI 没有历史数据，先观测 |
| 锁/闸自己的超时 | 2 秒锁在负载 15 时拿不到 | 准入读数失败要落「没查成」并计数，不能把自己饿死 |

---

## 8. 坑 → 新系统测试用例

只收有 issue、判例或提交为证的。格式：给定……，当……，应当……（出处）。

**分类与处置**

1. 给定 mirasim 原文「API Error: 422 平台服务当前繁忙……请切换到「自有」路由。」，当它从任何入口进来，应当判成同一类（换路由）、照处方切「自有」并让平台路由进共享冷却；不得判「没查成/等人」、不得判永久拒模丢腿、不得「既不等也不切」。（windsurf-dao#1805，`11d534e6a`）
2. 给定「422 当前是「平台」档，而本机此刻连不上平台……[ECONNRESET]」，当所有路由同时报这类错误，应当判本机断网 → 全局等待，不做无效换路；单条出现时原路短退避。（#1805；Kimi 臂 E2）
3. 给定「账户余额不足，请充值，本周额度已用完」，当文本里同时有繁忙类字样，应当仍判停池，不得被拉进换路由。（`tests/failure-class.test.js:53-54`，#1805 反例）
4. 给定按分钟限流的原文（「429 Quota exceeded for requests per minute」「触发限流：每分钟额度已满」），当分类，应当判换路由/等待，不得判额度用尽去停账号池。（`failure-class.mjs:40-45`；`leg-choice.mjs:956`「一条报错停了 28 条腿」）
5. 给定一个账号池只凭文字判出的额度失败、没有恢复时间，当决定暂停多久，应当 15 分钟起、每连错 ×4、封顶 24 小时；有上游 retryAt 就照办；一次成功立即解除。（`leg-choice.mjs:940-974`）
6. 给定「API Error: 422 当前是「自有」档，而本机没有这个智能体的账号……或切换到「平台」」，当分类，应当照处方换路由，不得当账号鉴权失效去停池。（VPS 执行记录；旧 `classifyFailure` 判 account/auth）
7. 给定「403: Internal error during token generation」，当分类，应当判上游瞬时错误（重试→换路由），不得因为 403 停池。（`tests/go-fallback.test.js:151-170` 与 `failure-class.mjs:46` 相矛盾）
8. 给定「API Error: 400 此设备已被解绑……」，当分类，应当判凭据失效停池，不得因为 400 判请求不合法。（VPS 执行记录）
9. 给定「HTTP 422: Validation Failed」（GitHub），当分类，应当判我方请求数据错，不得当平台繁忙；422 不得单凭状态码定类。（`loop-guard.mjs:114-117`）
10. 给定「Requested concrete model ID is absent from the ACP model catalog」，当分类，应当换模型并把这条腿标下架，后续不再派；不得归 unknown 继续派。（windsurf-dao#1840）
11. 给定会话以 failed 结束但没有任何原因，应当把「缺原因」单独计数上墙并走兜底梯，不得把它算进某条腿的成功率。（VPS 执行记录 82 条 no-reason）
12. 给定起会话失败，记录里必须落真实原因分类，不得写死占位原因。（`failure-class.mjs:10-13`；memory `placeholder-looks-like-a-reason`：Grok 121 次失败 83 次是占位）
13. 给定在分类模块之外新增一段匹配错误文本的正则，CI 应当报红。（决定 `:100`「防第 6 份长出来」；当天 #1818 `981607d38` 就在 `loop-guard.mjs:116` 长出 `ENV_DETAIL`）
14. 给定一个分类函数或它的影子旁听，当它在生产路径上没有调用方或没注入依赖，检查应当报红。（`classifyLaunchFailure` 无调用方却被 #1787、#1805 修改；`execution-runtime.mjs:28` 不传 judge，VPS 影子账 0 个文件）
14b. 给定一条失败原文超过展示上限，当写进卡住原因与分类，分类必须用全文，截断只发生在展示层。（fleet 任务 #1748 g2 的卡住原因截在 `! [rejected]`，`runner.mjs:557` 只留前 160 字）

**重试与卡住**

15. 给定 Temporal 活动 StartToClose 超时（TimeoutFailure，没有 code），当分类，应当判从检查点重起，不得落 UNKNOWN→没查成→等人。（`runner.mjs:555-558`；fleet 任务 #1608 g1）
16. 给定 worker 重启导致在途活动丢失，应当立即从检查点重跑该活动，不得干等满 startToClose。（fleet 任务 #1744 g1 收件箱存档）
17. 给定在途工作流因代码改动重放不兼容（TMPRL1100），应当点名「终止并重派」，不得每 5 分钟记一次没查成、永远没人知道。（windsurf-dao#1633；`tests/escalation-apply.test.js:193-201`）
18. 给定查工作流状态连续失败（「Failed to query Workflow」），应当有上限并告警；查状态应读自己的库，不依赖工作流 query。（VPS 执行器 2.5 天 skip 39 次）
19. 给定清理的目标已不存在（ENOENT），应当正常返回并记 gone，不得抛错被当「没查成」每轮重来。（windsurf-dao#1350：一轮 234 条 ENOENT、0 成功；memory `gone-object-must-return-not-throw`）
20. 给定成因不在重试范围内的失败（数据缺失、文件已不在、执行档判死），应当当场交出，不得试满 3 次 × 45 分钟宽限才见人。（windsurf-dao#1237；`retry-verdict.mjs:3-11`）
21. 给定同一处连续两轮拿回逐字相同的失败原文，应当判「重试不会变」并升级一格；比较不做归一化。（`retry-verdict.mjs:147-186`，2026-09-14 三句闸拒原文实咬）
22. 给定控制面故障窗内的失败，应当不占业务重试名额；故障恢复后自动解冻。（windsurf-dao#1331；memory `outage-burns-retries`：五张 PR 3 次全撞 ws 断连即永久认输）
23. 给定主腿卡死，退路腿必须还有一整条腿的时间预算，不得主腿吃光活动预算、退路腿 8 分钟就被掐。（`limits.mjs:14-20`；fleet 任务 #1608 g1）
24. 给定会话在跑长工具（测试）期间没有输出，不得判卡死；只有没工具在跑且进度指纹 360 秒不变才判。（`limits.mjs:21-27`）
25. 给定终端/会话画面在转圈（spinner 每次重绘都不同），判活不得用画面指纹，要看「该发生的事有没有发生」。（memory `dispatch-regex-corpus-and-stall`，2026-08-15 挂死 27 分钟三种探头全瞎；`whitelist-fingerprints-cannot-find-unseen-failures`）
26. 给定审查会话以 done 结束但 PR 头上没有晚于交卷的结论，应当判「没审完」重审，不得凭会话状态认定审过。（memory `reviewer-session-dies-upstream-stream`：一张 PR 起 13 次审官、票一次没落）
27. 给定审查输出在中途被截断、JSON 解析不了，应当只重审一次，不重做执行。（`escalation-inbox.mjs:83-90`，fleet 任务 #1295 g1）
28. 给定常驻服务以退出码 0 退出，应当被自动拉起。（memory `clean-exit-is-still-down`；`design.md:302`）
29. 给定 ACP 会话停在权限请求上，记录必须落「等权限」原因并按策略自动答或重起，不得 2 分钟后被取消只记 failed。（VPS：fleet 任务 #1748 g2 执行者会话，3 次 `session/request_permission`）

**熔断与共享状态**

30. 给定一条腿 46 条 turn 里 20 条 incomplete、0 条限流/鉴权码，当计算失败率，断流应当单列、不进分母，不得判这条腿坏。（windsurf-dao#1386）
31. 给定探针绿、真实 turn 6 小时 2 ok / 6 error，应当按真实流量开闸（≥8 条、≥60%、6 小时窗），不得只看探针。（windsurf-dao#1342；memory `breaker-must-eat-real-traffic`）
32. 给定两条传输路径不同的腿，应当各用一把熔断键。（同上）
33. 给定所有候选腿同时判红，应当判共用层坏、旁路并点名，不得剔空候选池导致零吞吐。（同上，#1386 续咬：16 张单全部「健康表红，不派」）
34. 给定熔断/健康表的写方停了，读方应当报「状态过期」并告警，不得按「过期=不拦」静默降级几天。（windsurf-dao#1778；VPS 熔断表 09-18、健康表 09-20 起冻结）
35. 给定同一次事件里一批渠道一起撞容量，解冻时间应当被确定性地错开。（windsurf-dao#1230）
36. 给定某渠道容量 3–4，一轮起 10 个会话，应当按渠道限在途数，撞 429 后冷却，不得每轮原样重投。（windsurf-dao#1145）
37. 给定执行工具（如 pi）遇上游 503，不得在 1 毫秒内静默切到另一家同名模型；换不换路由只由引擎决定并记账。（memory `pi-silent-provider-fallback`）

**通知与收件箱**

38. 给定一条要人拍/报警通知，应当拿到飞书回执 messageId 才算送达；入队不算；没送到下一轮重试。（windsurf-dao#1842）
39. 给定 CI 修复轮、自审返工轮，应当记在独立返工账里，不得吃掉异厂审查的轮次。（windsurf-dao#1755；`contract.mjs:36-40`）
40. 给定 PR `mergeable=CONFLICTING` 且没有任何 check，应当判冲突导致 CI 不触发 → 并目标分支；不得判 check 缺失 → 等人。（windsurf-dao#1755；memory `conflicting-pr-gets-no-ci-runs` 撞 3 次）
41. 给定推送被拒「refusing to allow a GitHub App to … workflow … without workflows permission」，应当判权限类挂起，不得判可重试。（#1725；memory `github-app-cannot-push-workflows`）
42. 给定 PR 合并时已冲突（MERGE_CONFLICT），应当走机械修，不得当瞬时故障退避 5 次。（windsurf-dao#1595）
43. 给定重试一个带幂等键的写动作，必须复用原键。（memory `retry-must-reuse-idempotency-key`：自拟新键刷出两条 62KB 重复评论）

**资源**

44. 给定一个 agent 子进程被内核 OOM 杀掉，应当只死这一个 agent：常驻服务 PID 不变、`system.slice` 无 OOM 事件、其它任务继续。（windsurf-dao#1810；决定 `:108`）
45. 给定 ACP/CLI agent 从 worker 进程里拉起，应当进独立 scope，不得留在 worker 的 cgroup（否则按默认 OOMPolicy=stop，一个 agent OOM 会停掉 worker）。（`acp-runtime.mjs:466`；VPS `dao-fleet-worker` OOMPolicy=stop）
46. 给定运行时 `set-property` 改过的资源上限，漂移检查应当比对生效值（`systemctl show`），不只比对单元文件。（VPS `50-MemoryHigh.conf`，09-16 手工，仓内 2.5G vs 生效 3.5GiB）
47. 给定 3 份测试同时申请 2 个测试槽，第 3 份应当排队而不是失败，并输出排队时长。（windsurf-dao#1748 验收）
48. 给定两份同一测试并发跑，应当各用独占临时目录，不得固定路径互删。（memory `fixed-name-sandbox-dies-under-concurrent-runners`：串行 6 轮全绿、3 份并发全红）
49. 给定「本机不跑全量」这类规矩，每一个调用点都要有闸，不得只改措辞。（#1748 评论；memory `rule-fix-missed-fifth-copy`）
50. 给定放执行槽的活动还没跑完、worker 正在替换，resume/cancel 信号仍须被处理。（PR #1847 `e88ca29ab` 正文）
51. 给定机器忙到准入锁 2 秒拿不到，闸不得把这判成「没查成」卡住任务；锁失败要计数落盘。（#1748；windsurf-dao#1802）
52. 给定判门槛用的量是墙钟耗时，不得拿它当硬闸（负载下两次能差一倍，只报趋势）。（memory `wall-clock-cannot-be-a-gate`）

---

## 9. 没查成 / 不采信

| 事项 | 状态 | 说明 |
|---|---|---|
| 9-22 04:28 mirasim-server 3.5G 峰值以 stop-timeout 停服 | 没查成原始日志 | VPS 日志留存最早只到 09-22 14:29（更早的已轮转），只剩单元注释（`mirasim-server.service:72-73`） |
| mirasim 结构化错误码能否经会话协议帧拿到 | 没查成 | 两台机器 analytics 里 0 命中；ws 错误帧内容没实测。新系统接 mirasim 时要先实测 |
| 82 条 no-reason 失败的真实成因 | 只查成 1 条 | 81 条 ACP 状态文件已被回收；那 1 条是权限请求后被取消，不能推广到全部 |
| 「worker 部署重启：活动随旧进程丢失」这句是谁写的 | 没查成 | 在 git 全历史里搜不到，只在 VPS 收件箱存档里 |
| ACP runner 此刻属于哪个 cgroup | 按代码推断，未实测进程 | 读回时 fleet worker 组里只有 1 个 node 进程（无在途会话）；依据 `acp-runtime.mjs:466` 的 detached spawn |
| 执行槽（3）在生产上的效果 | 没实测 | 账本文件不存在，上线后没有新任务进执行阶段 |
| PSI 历史 | 没有数据 | 旧系统从没记过 PSI；只有第 6.3 节一次空闲读数 |
| 真实 OOM 样本 | 没有 | 三个服务 memory.events 全 0；留存日志无内核 OOM |
| 「等人约占墙钟 57%」 | 不采信 | 出自一次会话的临时工作流输出，仓内无耐久出处 |
| 09-23 夜「mirasim-server MemoryCurrent 3.29G」 | 不采信 | 同上，只在会话临时输出里；第 6.3 节改用有出处的 09-18 观测 |
| 部分夹具是否真机原文 | 已在第 5 节逐条标「测试」 | S29、S31、S32、S43–S49、S52 只在测试里出现 |
| mirasim 错误码与说明的逐条对应 | 部分按字面推断 | 第 3.3 节只把相邻可见的几条写成确定对应 |

