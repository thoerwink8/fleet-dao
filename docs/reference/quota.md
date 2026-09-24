# 额度与模型目录手册

> **实现额度读取（额度账）、模型扫描与探活、调度台的选路与并发之前读。** 对应设计 §九「自由组合的派工模型」、§十「额度与账单」、§十六「六层选型目录」「模型扫描」「额度读取」三行、§十七 第 7、8 条。
> 讲清每个渠道的额度怎么读、读不到怎么估、模型发现与探活怎么判、旧六层目录怎么对到新概念、最小数据表、选路流程草稿、各渠道并发的经验值；坑逐条写成测试用例。
> 来源：旧系统审计切片 s2（2026-09-25）。数字是当时的读数，会变。全仓记法见 [README](README.md)。
> 基线：windsurf-dao `b1ebd88d`；ai-gateway-stack `origin/master` `db448771`；MiraQuota 源码（非 git 检出，文件日期 2026-08-27）；`<VPS>` 只读读回（2026-09-24 16:02–17:23Z）。
> 引用记法：`wd:` = windsurf-dao；`ags:` = ai-gateway-stack；`mq:` = MiraQuota 源码；`#N` = windsurf-dao#N；`@xxxxxxxx` = windsurf-dao 的提交。
> 占位：`<账号A>`、`<拼车组织>`、`<独享组织>`、`<端口>`、`<VPS>`、`<回环>`（本机回环地址）。组织编号、邮箱、令牌、IP、主机名一律略去；凭据只写种类不写位置。
> 「坑」只收有提交、issue、判例或现场读回为证的；代码核对出来、还没出过事的，单列在第五节。

---

## 〇、先看这六条

1. **旧系统一池只存「最紧的那个窗口」，所以天生做不出「快清零的先用」。** Claude 订阅与 Mirasim 中转的读数都只记一池一条最紧窗口（wd:scripts/lib/relay-account-usage.mjs:7；wd:scripts/lib/reclaude-account-usage.mjs:8-9）。实读 2026-09-24 17:14Z：中转 5h 窗只用了 0.8%（1140/143528 点）、几小时内就清零，入账的却是 7d 的 55.7%——「快清零还没用完」这条信号在入库那一步就丢了。新系统必须**每池每窗口一行**。
2. **Claude 订阅那条线从没被派工用上，审计时它的读数也断着，没人报警。** 目录自己写着「没有任何一次会话被证实走到了 reclaude 订阅（经 mirasim 起的都走了中继）」（wd:docs/execution-profiles.json:427）。`<VPS>` 上最后一条成功读数是 2026-09-24 12:30:50Z，之后再没有；17:15Z 那一轮写的是「读数探针没跑成（status 1）」。读数失败按设计「不进 faults」（wd:scripts/execution-usage.mjs:101），近 5 小时无人知道。根因没查成：时间上紧跟一次「root 改写了服务用户家目录里的凭据文件」，像旧判例 `root-owned-files-in-service-home`（见 [deploy.md](deploy.md) P01），未证实。
3. **探活结果存了两份，选路只看其中一份。** `~/.dao/leg-expiry.json`（选路读）与 `~/.dao/leg-catalog/alive.json`（只给保鲜检查和派工前补探读）。「模型对不上（model_drift）」「认证失败整池失活（pool_auth）」只写进后者，选路看不见。目录里 `cooldown_until` / `fail_streak` / `window_h` / `last_task_ok_at` 有读方、没有任何写方（wd:scripts/leg-catalog-migrate.mjs:97-99、296-298），对应的两道淘汰闸永远不会响。
4. **「10% 试探」在旧系统里从没真派过。** ε=0.1 只用来往 Jev 的影子候选里塞一条，fleet 仍派排序第一（wd:packages/fleet/src/cli.mjs:363-364；wd:scripts/lib/leg-pick.mjs:2-4）。新系统的试探必须真派、并在派工记录上打标。
5. **并发数大多是「拍的」不是「量的」。** 唯一实测是 2026-09-14 grok-4.6、composer-2.5 各 6 路 6/6；中转的 5 是拍板值，Claude 订阅终端腿的 5 是照抄中转的。机器侧真正撞到的墙：8 个任务同跑 → 负载 14、Mirasim 回环 ws 反复断（→ 降到 5，wd:scripts/lib/dispatcher/gates.mjs:10-17），以及执行阶段 floor(核数/2)=3（#1748）。
6. **「停整个账号池」曾被一条文字误判触发。** 按分钟限流的报错里带了 quota 一词，被判成账号额度用完，一个中转池 28 条腿停 24 小时（@fce41c82，#1681）。之后改成：上游给了恢复时间就照办，没给就 15 分钟起逐级加长到 24 小时（wd:scripts/lib/leg-choice.mjs:939-974）。

---

## 一、每个渠道的额度怎么读

### 1.0 总表

| 渠道 · 账号池 | 怎么读 | 时间窗 · 刷新点 | 旧频率 | 读一次花多少 | 读不到怎么办 |
|---|---|---|---|---|---|
| Claude 订阅（reclaude；`<账号A>` 下两个组织：`<拼车组织>` 类型 team、`<独享组织>` 类型 personal） | 探针命令，读 stream-json 里最后一条 `rate_limit_event`（1.1） | 5h 滚动 + 7d；刷新点 = 事件里的 `resetsAt`（unix 秒） | 每 15 分钟 | ≈ $0.0116 等值/次，扣的是共享额度（≈ $1.1/天） | 用满报错里「约 N 分钟后重置」→ 近似刷新点；再没有就「没查成」，不切号、不当还够 |
| Mirasim 中转账号（云端 relay；一份账号额度被所有中转路由共扣） | 本机回环 ws 发 `getRelay`（1.2） | `5h`、`7d`（账号级）+ `7d_<族>`（只扣该族模型）；刷新点 = 帧里 `resetAt` | 每 10 分钟 | 0（读会话服务内存，不打上游） | MiraQuota 用「固定窗锚点 + 本机账本」推算；旧 dao 判「没查成」 |
| 同一中转账号（MiraQuota 的精确路） | 会话路由端口 `GET /v1/limits`，要会话令牌（1.2） | 同上 | 每 15 秒 | 0 | 退到 relay 帧百分比（0.1% 分辨率） |
| Cursor 订阅（账号级一份上限） | Dashboard 接口 `GetCurrentPeriodUsage` + 逐会话 `GetFilteredUsageEvents`（1.3） | 月账期；刷新点 = `billingCycleEnd` | 每 5 分钟 | 0 次模型调用；1 次请求 + 最多 10 页事件 | 两个计费池拆不开，只能当一份 |
| xAI Grok 订阅 | 没有无头、只读、账号级的接口（1.4） | 周限；刷新日「待补」 | — | — | 只能从失败推：402 / 周限 → 暂停该池 |
| Kimi Code 订阅 | **没查成**：目录没登记来源（1.4） | 没查成 | — | — | 同上 |
| Devin/Windsurf、opencode、commandcode、pqapi | 没有接口，或已退役 | — | — | — | — |
| Jev 判断题 | 自己记账（按 token 算钱） | 按日 | 每次调用 | $0.042/百万 token；日上限 $0.30，单任务 $0.02 | — |

出处：Claude 订阅 ags:deploy/reclaude-org-switch.mjs:78-147、223-233，ags:deploy/systemd/reclaude-org-switch.timer:8，ags:deploy/install-reclaude-org-switch.sh:24-26；中转 wd:scripts/miraquota-contabo-sync.mjs:97-172，wd:host/machine/systemd/miraquota-contabo.timer:13；MiraQuota mq:README.md:219-251，mq:provider-node/miraquota-provider.mjs:30；Cursor wd:scripts/lib/execution-usage.mjs:620-738，wd:host/machine/systemd/dao-execution-usage.timer:5；xAI / Devin wd:docs/execution-profiles.json:176-178、364-366；Jev wd:scripts/lib/judge-client.mjs:23-25。

### 1.1 Claude 订阅（reclaude，两个组织）

**账号结构**
- 需求原文：拼车组织优先；拼车 `$80/5h` 用满后切独享；5h 窗口重置后切回拼车（ags:deploy/reclaude-org-switch.mjs:4-5）。
- 额度是**账号级**的：三台机器（本机、`<VPS>` 两个用户）是同一个 reclaude 账号，一台用满三台都满（:18-20，2026-09-19 实测）。
- 切号是**机器级**设置（写本机 device.json），一切影响这台机器上所有会话（:67-73；ags:deploy/systemd/reclaude-org-switch.service:4-9）。
- 角色闸（用户 2026-09-23 拍板）：人坐镇的主会话什么都能用；指挥官与工人那台只许独享号（`--no-carpool`），永不切回（:160-167）。`<VPS>` 服务用户装的正是这一档，另加 `--probe` 只为读数（ags:deploy/install-reclaude-org-switch.sh:24-29；实读 `systemctl list-timers` 只有服务用户一份定时）。

**读法**
1. `reclaude org list`：制表符分列，带 `*` 的是当前组织，第三列类型 `team` = 拼车、`personal` = 独享，认不出类型记 null、不猜（:37-65）。
2. 探针：`reclaude -p --output-format stream-json --verbose --model haiku --setting-sources project 'Reply with exactly: OK'`，超时 180 秒（:231-233、443）。
   - 必须 stream-json，否则拿不到 `rate_limit_event`。
   - `--model haiku`：事件是账号级的，跟用哪个模型无关，用小模型省钱。
   - `--setting-sources project`：不加载用户级设置，不跑用户的开机钩子。实测单次 $0.028 → $0.0116。
   - 不能用 `--bare`：它只认 API key，经 reclaude 起会认证失败，回一条 `<synthetic>` 占位消息（:223-230）。
3. 解析：取**最后一条**含数字 `utilization` 的事件的 `rate_limit_info.unifiedWindows.five_hour` / `seven_day` → `{utilization: 0–1, resetsAt: unix 秒}`；事件没有、字段缺、JSON 坏 → null = 「没查成」，不是「没用满」（:78-114）。实测两窗在同一条事件里（:95-99 的样例：7d `resetsAt` = 2026-09-26T20:00Z）。
4. 用满信号（2026-09-23 实咬后补）：结构化的 `rate_limit_info.status === 'rejected'`（此时**没有** `unifiedWindows`），或报错正文里「额度已用完 / usage limit reached / rate limit exceeded」；能抠到「约 N 分钟后重置」就换算成 `resetsAt`（:116-147）。
5. 落盘：`~/.reclaude-org-switch-last.json`，schema 1：`at`、`currentOrg`、`orgs[{id, kind, current}]`（不带名字与邮箱）、`reading{org, fiveHour, sevenDay, exhausted, probed, why}`、`action`、`why`；tmp + rename、权限 0600（:394-422、453-456）。切号状态另存 `~/.reclaude-org-switch.json`，只有 `carpoolResetsAt` 与 `switchedAtMs`（:446-450）。
6. windsurf-dao 侧入账：`probed !== true` 不记；两窗取更紧的一条（已用比例大者紧，一样紧取刷新更晚的），单位 percent；打满时没数字的窗口记 utilization=1（wd:scripts/lib/reclaude-account-usage.mjs:45-100）。

**只能看到当前组织**：探针读的永远是「此刻这台机器挂着的那个组织」。要读另一个组织就得切号，而切号影响整台机器——所以另一个组织的读数只能靠「切走那一刻记下的刷新点」推（:187-206，:377-390）。

**现场（`<VPS>` 只读，2026-09-24T17:15Z）**
- 切号探针的落盘文件：`action: hold`，`reading.probed: true`，`fiveHour: null`，`sevenDay: null`，`why: "读数探针没跑成（status 1）"`。
- 用量账里最后一条成功读数：2026-09-24T12:30:50Z，7d 用 0%，刷新 2026-09-26T20:00Z（pool-quota 缓存读回）；之后没有任何 Claude 订阅的成功读数。中间每一轮具体是什么结果没看到。
- 根因没查成：时间上紧跟服务用户家目录里一份 Claude 凭据文件被改成 root 属主（旧判例：用 root 在服务用户家目录跑东西会留下 root 属主文件）。reclaude 守护日志里「检查本地 Claude 凭据 permission denied」的报错比最后一次成功还早，所以它本身不一定致命。

**给新系统的建议（推论，旧系统没这么做过）**：`rate_limit_event` 本来就出现在每个 Claude Code stream-json 会话里（:7-8）。新系统无头跑 Claude Code，每个真会话都能顺手带回一份读数；只有空闲时才需要探针，能省下每天 ≈ $1.1 等值的探针额度。

### 1.2 Mirasim 中转账号

**读法（旧 dao 的采样器）**
1. 令牌：会话服务写在本机的回环令牌文件，只进 URL，不进返回值、不进日志（wd:scripts/miraquota-contabo-sync.mjs:52-71、97-103）。
2. 连 `ws://<回环>:<端口>/ws?token=…`，依次发 `{type:'clientHello'}`、`{type:'getState'}`、`{type:'getRelay'}`，等 `type:'relay'` 或 `type:'error'` 的帧；开连 8 秒、等帧 6 秒（:101-172）。
3. 帧形（2026-09-06 真机帧，wd:tests/miraquota-contabo.test.js:25-67）：
   `relay.usage = {ok, agent, source:'relay-limits', capturedAt(ISO), status, windows:[{label, usedPercent, remainingPercent, resetAt(ISO), resetAfterSeconds, status:'allowed'|'warning'|'limit_reached', used, budget, modelScoped?}], error}`。
   解析要容忍：`label`/`name`、`resetAt`/`reset_at`、秒/毫秒/ISO 三种时间（wd:scripts/lib/miraquota-contabo.mjs:34-47、104-123）。
4. 帧不对、`usage.ok` 不为真、窗口空 → 「没查成」，不填默认窗口（:54-97）。

**窗口的含义**
- `5h`、`7d` 是**账号级**窗口：所有走中转的路由共扣一份；`7d_<族>`（实见 `7d_claude`、`7d_fable`）只扣模型 id 里含这个族名的路由；组名 = 标签最后一个下划线之后（wd:scripts/lib/relay-account-usage.mjs:3-9、25-31）。
- 实读（`<VPS>` journal，2026-09-24T17:14Z）：`5h 1140/143528 · 7d 285511/512600 · 7d_claude 267666/512600 · 7d_fable 90243/271678`（单位：点）；7d 刷新点 2026-09-29T05:27:56Z。
- **上限会变**：2026-09-06 真机帧是 5h 171852 / 7d 613756 / 7d_fable 325291，2026-09-24 变成 143528 / 512600 / 271678；MiraQuota 另记 2026-08-24（5h 约 42525 → 156800）、2026-08-26（换账号三窗同时变四分之一）两次改档（mq:README.md:263-271、301-305）。
- **上游状态字**：真机帧里出现过 `7d_fable` 用到 99.04%（322156/325291）就 `status:'limit_reached'`，`7d` 到 85% 就 `warning`（wd:tests/miraquota-contabo.test.js:49-57）。
- 什么时候才用中转：服务端 `getConfig.relay` 现值 `mode:auto, threshold:0.95, on5h, on7d, reactive`——自带订阅优先，5h/7d 到 95% 或当场被上游拒才切中转（ags:docs/MIRASIM-CHANNELS.md:74）。`<VPS>` 上会话服务没有本地账号（`agent_accounts=[]`，wd:docs/observations/2026-09-19-mirasim借reclaude代理出网.md:37），所以经它起的会话都走中转。

**MiraQuota 的另一条路（精确读法与降级）**
- 会话路由端口（Claude Code 的 `ANTHROPIC_BASE_URL` 那个回环端口）上的 `GET /v1/limits`，头 `x-api-key: <会话令牌>`；返回 `windows[]{name, used, budget, reset_at, model_scoped}` 与 `suspended` / `unmetered` / `degraded` 三个账号状态位（mq:README.md:232-243；mq:provider-node/miraquota-provider.mjs:191-258）。
- 令牌只存在于 Mirasim 拉起的会话进程环境里；Windows 读不到进程环境，要手工传（mq:provider-node/README.md:24-35）。
- 远端 `relay.mirasim.ai/v1/limits` 要设备私钥签名，不可用；网关账本里的 `anthropic-ratelimit-unified-7d-utilization` 头只在 2026-08-09 之前有，从没有 5h（mq:README.md:245-251）。
- 退路：`ws://<回环>:<端口>/mirachannel/ws` 发 `{type:'host', payload:{type:'getRelay'}}`，只有 0.1% 分辨率的百分比（mq:README.md:224；mq:provider-node/miraquota-provider.mjs:262-317）。
- 频率：15 秒一次、每次超时 2 秒、找不到端口 300 秒后重找、数据 90 秒不更新算过期（mq:Sources/MiraQuota/Limits.swift:50-52、146；mq:provider-node/miraquota-provider.mjs:30、324）。
- 五级降级：精确（/v1/limits）→ 实时（relay 帧）→ 已过期 → 推算（窗口锚点 + 本机账本）→ 本地（从没拿到过锚点，只有滚动支出）（mq:README.md:440-455）。
- 点数折美元只是账单参考：每点美元在 $0.00235–0.00502 之间漂；标定要「支出与增量两侧都挂起」配对；改档后百分比样本作废（mq:README.md:253-299）。**调度不该用美元，用点数和百分比。**

**Mirasim 会话服务自带的「账号额度探针」**：每分钟一条 haiku 请求（带 `x-mirasim-probe` 头），只刷新本地 oauth 账号窗口；云端额度走 relay 账本，是另一条路。`<VPS>` 已关（`MIRASIM_ACCOUNT_USAGE_PROBE=0`）（wd:docs/observations/2026-09-19-mirasim借reclaude代理出网.md:24-27、36-38）。目录里写它「只采 claude/codex/kimi/dsh/antigravity」（wd:docs/execution-profiles.json:178）——理论上是 Kimi 的一条读法，没验证过。

### 1.3 Cursor

- 接口：`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`，body `{}`；头 `Authorization: Bearer <Cursor 登录态里的 accessToken>`、`Content-Type: application/json`、`Connect-Protocol-Version: 1`；禁止重定向、15 秒超时、响应上限 4MB；只放行两个方法名（wd:scripts/lib/execution-usage.mjs:650-665）。
- 返回：`billingCycleStart` / `billingCycleEnd`（毫秒字符串）、`planUsage.{totalSpend, limit, remaining}`（美分）；401/403 记 `cursor_account_auth_required`（:657、673-681）。返回里还有账号展示信息，入账时丢掉（wd:tests/execution-usage.test.js:574）。
- 逐会话：`GetFilteredUsageEvents` body `{teamId:0, startDate, endDate, page, pageSize:100}`，最多 10 页、回看 7 天；`usageEventsDisplay[]{conversationId, timestamp, model, tokenUsage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCents}, chargedCents}`；`conversationId` 就是 ACP 会话号（:684-736）。长得一样的两条事件也是两次调用，不去重；`chargedCents`（实扣）与 `totalCents`（估算）分开记，缺实扣不拿估算填（:702-705、725-727）。
- Cursor 本地 SQLite 里的 token 数是「当前上下文占用」，不是计费计数，不许当花费（:860-864）。
- 两个计费池（2026-08-29 用本账号实证）：Cursor 自家模型池（含 grok-fast，Ultra 套餐内零扣费）与 Other 池（kimi-k3 等第三方，烧美元）；Dashboard 只给一份上限，拆不开（ags:docs/MIRASIM.md:58-62；wd:docs/execution-profiles.json:228、246）。
- 现场（`<VPS>`，2026-09-24T17:18Z）：月账期（`billingCycleStart/End` 相差一个月），上限以美分返回（当时约 $400）、已用过半；逐会话匹配上 153 个、15 个没对上；`gaps: ["cursor_session_window_incomplete"]`。这份上限属于哪个计费池——没查成。

### 1.4 xAI、Kimi 与其它

- **xAI Grok**：没有无头、只读的账号级查询。`grok usage <会话号>` 只报单个会话的本地花费；Grok Build 只有交互界面里的 `/usage`（wd:docs/execution-profiles.json:176-178）。周限，刷新日「待补」（同文件 xai-subscription 的 quotaWindow）。实见：2026-09-19 撞周限（wd:docs/leg-policy.json:5），2026-09-20 真探回 `402 Payment Required: Grok Build usage balance exhausted`（wd:host/machine/systemd/dao-leg-expiry.service:9-11），2026-09-21 复测恢复（wd:docs/leg-policy.json:10）。
- **Kimi Code**：目录里 kimi-subscription 没有额度来源，也没读过任何计费数字（wd:docs/execution-profiles.json 该池 availability.reason）。没查成。
- **Devin/Windsurf**：devin CLI 只有 auth/models 等命令，不报已用与上限（wd:docs/execution-profiles.json:364-366）；池声明 2026-09-20 到期，巡查实读已过期 3.7 天。
- **opencode / commandcode / pqapi**：已弃用或档全停用，无读法。

### 1.5 读不到时怎么估

旧系统的做法：
1. **没查成 ≠ 还够**：没快照、窗口过期、快照超 2 小时、没上限、没时钟，一律判 `unscanned` 并写明原因（wd:scripts/lib/pool-quota.mjs:108-177）；选路对 `unscanned` 不淘汰、只注明（wd:scripts/lib/leg-choice.mjs:505、571）。
2. **从失败推**：会话失败分四类——ours（我们自己的）、account（额度/余额/周限/登录）、upstream（限流/满载/5xx/断流）、unknown（wd:scripts/lib/failure-class.mjs:14-23）。account 类暂停**整个池**：上游给了恢复时间照它；没给就 15 分钟 → 1 小时 → 4 小时 → 16 小时 → 封顶 24 小时；该池一次成功即解除；不存状态，每次从执行记录现算（wd:scripts/lib/leg-choice.mjs:939-974）。
3. **Claude 订阅**：用满报错里的「约 N 分钟后重置」换算刷新点；切走时记下拼车的刷新点，切回按它判（ags:deploy/reclaude-org-switch.mjs:142-146、187-206）。
4. **MiraQuota 推算**：窗口是固定窗，测过一次刷新点就能推出之后每个窗口的边界；离线时用「锚点 + 本机账本」推百分比，偏低（不含他人占用）（mq:README.md:453-461）。

新系统（设计 §10「读不到的按实际用量估，撞到限额就记下上限」）的建议：
- 撞限那一刻，把「本窗口内本池的累计用量」记成一条 `learned` 读数（上限的估计值），刷新点取上游给的或按周期锚点推；下个同类窗口按它估剩余。旧系统没做过，没有先例证据。
- 「停整个池」要有数字佐证（接口实查用满，或上游给了恢复时间）；只有文字时只做短暂停（盲设计三臂共识，wd:docs/exams/2026-09-21-judgment-model-where/result.md:24）。
- 没用完的额度到期作废、不能攒（wd:docs/exams/2026-09-21-queue-and-admission/question.md:28）——这正是「快清零的先用」的依据。

### 1.6 坑 → 新系统的测试用例（额度）

> 每条格式：给定……，当……，应当……。出处写在后面。

- **Q1 用满那一刻没有利用率字段**：给定探针非零退出、最后一条 `rate_limit_event` 只有 `{"status":"rejected"}`、stderr 有「5 小时额度已用完，约 20 分钟后重置」，当读数任务解析，应当记该池 5h「已用满」、刷新点 ≈ 读数时刻 + 20 分钟，且不得记成「没查成」；另给定输出里根本没有 `rate_limit_event`，应当判「没查成」，不得当 0%。出处：ags:deploy/reclaude-org-switch.mjs:10-15、116-147、347-356（2026-09-23 实咬：原判据恰在最该切号那一刻弃权）；ags:deploy/reclaude-org-switch.test.mjs:171-224。
- **Q2 切号只认正面证据，失败要回滚**：给定 `org use <目标>` 退出 1、但本机设置已写成目标号，当引擎判定切号结果，应当判失败并切回原号；回滚也失败时如实报「这台现在可能起不了会话」。出处：ags:deploy/reclaude-org-switch.mjs:67-76、235-262（2026-09-22 `<VPS>` 两个用户一起哑掉，手工切回才恢复）。
- **Q3 账号池现算，不写死组织号**：给定 `org list` 里独享组织已被封，只剩拼车组织，当本机角色要求只用独享，应当守在当前组织并报原因，不得按写死的编号硬切。出处：ags:deploy/reclaude-org-switch.mjs:30-33、314-331（2026-09-22 独享号被封后照规矩切过去，`<VPS>` 起不了任何会话）。
- **Q4 切回要看拼车组织的刷新点**：给定切去独享时记下拼车 `resetsAt=T`，在独享组织上探到自己的 `resetsAt=T+4h`，当判切回，应当在 T 之后就切回拼车。出处：ags:deploy/reclaude-org-switch.mjs:187-206（2026-09-21 订正：用独享自己的窗口会在贵的号上白多待近 5 小时）。
- **Q5 探针要便宜、没有副作用**：给定额度探针的命令行，应当是 stream-json + 小模型 + 只加载项目级设置，且不得带 `--bare`。出处：ags:deploy/reclaude-org-switch.mjs:223-233（实测 $0.028 → $0.0116；`--bare` 经 reclaude 认证失败）；ags:deploy/reclaude-org-switch.test.mjs:152-157。
- **Q6 同账号多台机器共用一份额度**：给定多台机器共用一个 reclaude 账号，当任一台读到拼车 5h 用满，应当所有挂该组织的路由同时判满；切号只由一处发起。出处：ags:deploy/reclaude-org-switch.mjs:18-20（2026-09-19 实测）；ags:deploy/systemd/reclaude-org-switch.service:4-9。
- **Q7 每个窗口都要存**：给定中转帧 `5h 1140/143528`（几小时内刷新）与 `7d 285511/512600`，当入库，应当两个窗口各存一行，调度能看到「5h 快清零且几乎没用」；不得只存最紧的 7d。出处：wd:scripts/lib/relay-account-usage.mjs:7、wd:scripts/lib/reclaude-account-usage.mjs:8-9（旧口径只记最紧一条）；`<VPS>` journal 2026-09-24T17:14Z；设计文档第二节「没有快清零的先用」。
- **Q8 模型组窗口只卡对应模型**：给定 `7d_fable` 已 `limit_reached`、`7d` 还有余，当判各中转路由能不能派，应当只有模型 id 含 `fable` 的路由判满，其余照常。出处：wd:scripts/lib/relay-account-usage.mjs:3-9、75-84；真机帧 wd:tests/miraquota-contabo.test.js:49-57；mq:README.md:330-336（不按组过滤会把全机支出挂到零用量窗口上）。
- **Q9 窗口集合不固定**：给定帧里出现从没见过的 `7d_claude`，当入库，应当照样存并按组名匹配，不报错、不丢。出处：2026-09-06 真机帧只有 5h/7d/7d_fable（wd:tests/miraquota-contabo.test.js:42-59），2026-09-24 多出 `7d_claude`（`<VPS>` journal）；mq:docs/ARCHITECTURE.md:58。
- **Q10 上限每次都读**：给定同一窗口前后两次读数的上限不同（171852 → 143528），当算剩余，应当按最新上限算；按百分比积累的历史样本跨改档作废。出处：wd:tests/miraquota-contabo.test.js:46 对照 `<VPS>` journal 2026-09-24；mq:README.md:263-271、301-305（混算曾把满额压低三成、或抬高四倍）。
- **Q11 读数过期不当现值**：给定某池最新读数已超过 30 分钟（旧口径 2 小时），当调度读额度，应当判「没查成」并进对账报警，不得继续当「还够」。出处：wd:scripts/lib/pool-quota.mjs:26-31、160-162（@cc67b630：采集器一停，一周长的窗口会把旧读数一直当现值）；设计文档 §6「每个账号池的额度读数不超过 30 分钟」。
- **Q12 读数任务失败要有人知道**：给定 Claude 订阅读数探针连续失败（退出 1），当每小时对账，应当判红并推提醒；不得因为「不算这次采集的错」而静默。出处：wd:scripts/execution-usage.mjs:101（失败只进 JSON 字段，不进 faults）；`<VPS>` 读回：2026-09-24 12:30:50Z 之后再无成功读数，17:15Z 那轮是「读数探针没跑成（status 1）」，近 5 小时无报警。
- **Q13 取各池最新读数要按池直查**：给定用量账 30 万行以上，当调度取各池最新读数，应当不受报表行数上限影响。出处：@d3f33c0b（#1853/#1861：报表按 maxRows=100000 截断，刚记的中转读数被截在线外，选路报「没有用量快照」）。
- **Q14 选路读额度要快**：给定派工时在工作流里读额度与战绩，应当毫秒级返回，不得同步扫大库。出处：@b798fc88（#1845：一次读 19.7–43.4 秒，同进程 Temporal 查询全排队，疑似 6 小时 59 次 Workflow task not found、76 次查询超时）。
- **Q15 按分钟限流不是账号额度用完**：给定报错「429 Quota exceeded for requests per minute」或「触发限流：每分钟额度已满」，当分类，应当归上游限流、只让这条路由短冷却，不得暂停整个账号池；带 402 / insufficient_quota / billing / 周限 / 余额 的才归账号类。出处：@fce41c82（#1681：一个中转池 28 条腿停 24 小时）；wd:scripts/lib/failure-class.mjs:39-45；同提交的 tests/failure-class.test.js 样本句。
- **Q16 凭文字停池要短，逐级加长**：给定账号类失败但上游没给恢复时间，当连续发生，应当依次停 15 分钟、1 小时、4 小时、16 小时、封顶 24 小时；上游给了恢复时间就照它；一次成功即解除。出处：wd:scripts/lib/leg-choice.mjs:951-960（池一停就等不来那次成功，一次误判 = 死停满 24 小时）；wd:docs/exams/2026-09-21-judgment-model-where/result.md:24。
- **Q17 账号的失败不算到模型头上**：给定 xAI 订阅额度用完、Grok 走 xAI 的会话连败，而同一模型走 Cursor 池正常，当更新战绩，应当只暂停 xAI 池，Grok 在 Cursor 池上的路由战绩不受影响。出处：wd:scripts/lib/failure-class.mjs:10-19（Grok 被记成 23/145，实为 xAI 额度用完）。
- **Q18 没原因的旧失败不进战绩**：给定迁移来的历史失败没有原因字段，当算成功率，应当不进分母、不触发连败冷却。出处：wd:scripts/lib/leg-choice.mjs:923-930（上线当天 Grok 23/61=38% 被排到第 5）。
- **Q19 读数要写进正确的池**：给定 Cursor 池改过 id、一个账号挂两个池，当采样器入账，应当从目录现查「用 cursor-dashboard 读数」的那个池写入，旧 id 走别名，不得写出池为空的行。出处：@7ab10b52（加 `cursorDashboardPoolId()`）；`<VPS>` 读回 pool-quota 缓存：2026-09-24T08:08Z 一行 `accountPoolId=null`、2026-09-22 一行旧 id。
- **Q20 「数据不全」是状态不是故障**：给定 Cursor 会话早于事件回看窗口、或翻页到上限、或事件缺 token，当采样，应当读数照常入库并标不完整，定时任务仍算成功；只有 401/403、HTTP 错才算失败。出处：wd:scripts/lib/execution-usage.mjs:44-50（2026-09-24 每轮都带 `cursor_session_window_incomplete`，单元永远 exit 2，成了背景噪音）；`<VPS>` 读回 cursor-account-sync.json 同码。
- **Q21 会话服务不借 agent 的代理、不跑它自带的额度探针**：给定 Mirasim 会话服务启动，应当环境里带 `MIRASIM_NO_AGENT_EGRESS=1`、`MIRASIM_ACCOUNT_USAGE_PROBE=0`；reclaude 守护日志 30 分钟内出现 `non-cc-client` 应当判红；且这两个开关不许被当成「多余」去掉。出处：wd:docs/observations/2026-09-19-mirasim借reclaude代理出网.md:18-38（每 30–60 秒一条 haiku 400，中转流量依赖 reclaude 守护活着）；@737315de（#1531）；@145e0999（#1682：实验去掉出网开关后 reclaude 设备被解绑）。
- **Q22 新鲜度以读方看到的为准**：给定读数要发布给别处，当判新鲜，应当以「读方读回的最新时刻」为准，不以「本地写成功」为准。出处：wd:docs/observations/2026-09-09-凭据闸把额度采样的git推送掐死.md:8（本地每轮都 amend 成功，远端停在 09-06，相关检查 11/11 全绿）。
- **Q23 一轮跑不完不能被静默杀**：给定一轮采集比超时长，当超时，应当留下「没跑完」记录并告警；看门狗看「上次成功时刻」。出处：wd:docs/observations/2026-09-16-用量Timeout90秒杀掉导出.md:13（90 秒超时，23:29 起采集账没再写完过）；wd:host/machine/systemd/dao-execution-usage.service:25-27（改成 300 秒）。
- **Q24 用量归属认模型族，不认协议名**：给定 grok-4.6 的会话走 `openai-responses` 协议，当入账，应当记在 grok 名下。出处：@5b1cfa8b（#1218）；wd:docs/observations/2026-09-15-用量root副本冻在旧归属.md:13（特权副本冻在旧代码，合入两天后仍把 grok 记成 openai）。
- **Q25 百分比刻度看「已用 + 剩余」**：给定 7d 窗口刚滚动、整帧与历史的百分比都落在 (0,1]，当换算，应当按「已用 + 剩余 = 100 或 1」判刻度，不得把 0.9% 画成 90%。出处：mq:README.md:463-470。
- **Q26 换账号只认用户身份**：给定帧里 relay 令牌尾号约每小时换一次、部分帧不带 `login`，当判「换账号」，应当只认 `login.userId`，缺它的帧不参与判定。出处：mq:README.md:301-321（以尾号判时 48 小时 6445 条样本只剩 11 条可用）。
- **Q27 零用量时 5h 边界在漂**：给定 5h 窗零用量、每次读到的刷新点都是「采集时刻 + 5 小时」，当记锚点或算快清零，应当不把它当锁定的边界。出处：mq:README.md:457-461。
- **Q28 额度是共享的**：给定账号池里还有别人在用，当估剩余，应当以账号级读数为准，不以本机用量推。出处：mq:README.md:536-538（历史 19 次 429 有 2 次发生在本机 5h 支出为 $0 时）。
- **Q29 账本读取不能用单向游标**：给定 Mirasim 网关账本回填 token 时原地改写历史行、Claude 会话 fork/resume 会复制父会话消息，当读用量，应当按 id / requestId 去重、每轮重扫尾部。出处：mq:README.md:398-412、595-598。

---

## 二、模型发现、榜单巡查、探活

### 2.1 三件事一张表

| | 探活（wd:scripts/leg-expiry.mjs） | 榜单巡查（wd:scripts/catalog-patrol.mjs） | 新模型发现（wd:scripts/model-discovery.mjs） |
|---|---|---|---|
| 做什么 | 每个池挑一条路由，起最小真会话问「只回一行：OK」 | 在役档的模型 id 对上游清单：下架 / 同族新版本 / 上游有而榜单没有；池到期日 | 渠道名册对已登记档：新型号 / 别名变化 / 下线 → 代码归类 +（可选）判官 → 新档提案推群 |
| 数据源 | 真会话 | 目录 sources：CLI `cursor-agent models`、`grok models`、`devin models list --format json`；HTTP `/v1/models`；models.dev 价目 | Mirasim 回环 ws `getModelRoster{agent}`（每个执行体一格）+ 同上的 CLI |
| 频率 | 每 6 小时 `:02` 起（随机延迟 ≤180 秒），每池 1 条、45 秒上限；派工前若该路由上次探通早于 3 小时，补探 1 条（60 秒预算） | 与探活同一个定时任务的第二步 | 同一个定时任务的第三步；判官每轮最多 20 题 |
| 产出 | `~/.dao/leg-expiry.json`（选路读）+ `~/.dao/leg-catalog/alive.json`（保鲜检查读） | `~/.dao/catalog-patrol.json`；新 id 追加进 alive.json 的 `pending_legs` | `~/.dao/model-discovery/`：proposals/、archive/、notify.json、judge-memo.json、last-scan.json |
| 花费 | 每池每 6 小时一次最小会话，吃各自额度；金额没记（没查成） | 0 次模型调用；CLI 20 秒超时 | 名册 0；判官单任务 $0.02、每日 $0.30 封顶 |
| 退出码 | 定时模式下只有「一条都没探成 / 全是没查成」才非零 | 定时模式恒 0；崩了落 error 退 2 | 同左 |

出处：wd:host/machine/systemd/dao-leg-expiry.timer:17-20；wd:host/machine/systemd/dao-leg-expiry.service:13-41、65-67；wd:scripts/lib/leg-catalog-alive.mjs:31-34；wd:packages/fleet/src/dispatch-fresh.mjs:13-16、34-99；wd:scripts/leg-expiry.mjs:76-91；wd:scripts/catalog-patrol.mjs:541-558；wd:scripts/model-discovery.mjs:14-24；wd:scripts/lib/model-discovery.mjs:36-39；wd:docs/execution-profiles.json 的 sources（cursor-models、grok-models、devin-models 的 refreshCommand）。

### 2.2 探活怎么判（值得原样带走的规则）

1. **判定顺序固定**：没查成（快照没读到 / 只有预览 / 帧形不对）→ 认证失败（401/403 按词边界匹配，只看错误与等待原因，不看回答正文）→ 等交互（waiting_user 或有未答项）→ 超时且无输出 = 没查成（不记成交互式）→ 其它错误 = 失败 → 回答含 OK = 通，否则「答上来了但内容不符」= 失败（wd:scripts/leg-expiry.mjs:47-51、151-184）。
2. **失败时「最后可用时刻」冻结在上一次成功**，不是发现失败的那一刻（:354-362）。
3. **订阅维度从路由推导**：池可用 ⇔ 至少一条路由探通；不另造「订阅探针」（:15-20、375-384）。
4. **每条路由一个独立工作目录**（:104-111）。
5. **回显模型核对**：两边都剥掉 `/` 前的渠道前缀和 `[参数]` 后缀再比；对不上记 `model_drift`，**不把路由改指到新型号**；认证失败按池整批失活（wd:scripts/lib/leg-catalog-alive.mjs:23-30、169-241；决策 wd:docs/decisions/2026-09-22-leg-catalog-three-layers.md:74）。ACP 类执行方式不报模型（实读 Cursor 路由都是 `no-echo`），对它们只能信名册。
6. **选路怎么用**：36 小时内探不通 → 淘汰；过期的失败只注明「待重探」；没探过既不算可用、也不算不可用（wd:scripts/lib/leg-choice.mjs:55-85）。
7. **保鲜阈值 7 小时** = 6 小时周期 + 随机延迟 + 一轮 15 分钟，向上取整；等于周期会在每轮开头误报（wd:scripts/lib/leg-catalog-alive.mjs:10-15）。
8. **每池轮着探**：每池只探「上次探通最旧」的那条（wd:scripts/leg-expiry.mjs:212-257）。代价是一个池挂 N 条路由时，每条要 N×6 小时才轮到一次。

新模型考试的先例：给 grok-4.7 上线做的是「点名问答一针 69.4 秒 + 读→改→提交端到端一针 136.7 秒、产物独立核对三项」（wd:docs/leg-policy.json:12）；kimi k3 立档也是真会话在临时 git 树里读、写、提交（wd:docs/execution-profiles.json kimi-subscription 的 availability.reason）。设计 §16 的「新模型考试」可直接以此为模板。

### 2.3 榜单巡查

- 在役口径 = 执行目录里 `enabled===true` 的档（wd:scripts/catalog-patrol.mjs:1-4、47-53）。
- 四态：unlisted（下架）/ newer（同族更高版本，给建议 id）/ ok / unchecked；源报错、快照过期、要登录、没登记源一律 unchecked 并带原因，不拿陈旧清单去比（:89-113、294-322）。
- 版本线：`<线名>-v?<数字.数字>(-后缀)`，线名与后缀都相同才比（:38、59-87）。
- 到期：读池的 `lifecycle.declaredUntil`；已弃用 = retired、没有在役档 = idle，都不报警；没写到期日 = unknown，点名但不红（:150-190、467-486）。
- 连续 3 天 0 条可查 → 红（:611-633）。
- 上游有、榜单没有的 id 只进候选，不进排序（:9、722-733）。

### 2.4 新模型发现

- **分工**：代码管数字、硬约束和最终放行；判官只答限定选项的题，答案过了代码校验才进提案。判官只能把「接替」降成「待命」、把候选判成变体或旧版，**不能把「待命」升成「接替」**（wd:scripts/lib/model-discovery.mjs:4-6）。
- **同族更高版本直接接替旧档**，能力继承并标 `inherited:<旧档>`；全新型号只登记待命（停用状态）。旧档靠服务端默认模型、在暂停中、或名册里用户没勾，接替一律降成待命（:7-10）。
- **每个模型走它自己的执行方式**：新型号的族必须是这个执行方式 × 渠道上已登记档跑过的族（:17-19）。
- **空名册、帧形不对、命令非零 = 没查成**，不当「全部下线」（:13、133-181）。
- 名册帧：`{type:'modelRoster', agent, entries:[{id, label, contextWindow, enabled, defaultOn}]}`，`enabled` = 桌面端「模型管理」页上勾没勾（:128-159）。
- 会话服务单线程，起 codex 会话时 ws 会堵几十秒 → 每个执行体单独等 20 秒、按顺序问（wd:scripts/model-discovery.mjs:131-135）。
- 推群账：拿到飞书 messageId 才算报过，没送到下轮重试（:266-283）。

### 2.5 现场读回（`<VPS>`，2026-09-24 16:02–16:07Z 那一轮）

- **探活**（`~/.dao/leg-expiry.json`，16:07:43Z 更新）：通的有 codex 三条、opus-5.5 中转、kimi 两条、Cursor 三条（有的是上一轮）；`grok-4.7@xai-native` 失败「答上来了但内容不符（空）」；`grok-mirasim-native`（4.6）没查成「超时且无输出」；`devin-acp-deepseek` 没查成「Requested concrete model ID is absent from the ACP model catalog」——自 2026-09-20 起每轮都是这句。
- 同一文件里有 30 条 2026-09-19T16:32Z 的记录写着「测试环境结构性够不着真执行体……单元测试注入」——测试写进了生产观测文件。
- `alive.json` 的 `pending_legs` 已堆到 250 条，没有读方处置。
- **巡查**（`~/.dao/catalog-patrol.json`）：查了 6 条、源 3/4；6 条中转路由全是「unchecked 快照过期」（中转名册源在仓里只有 2026-09-09 的快照、没有自动刷新命令）；`cursor-acp-grok-4.6`、`cursor-acp-grok-4.7` 判「下架」，但同一小时探活两条都答通；`devin-acp-deepseek` 判下架（对的）；到期：多数池 unknown，windsurf-devin 已过期 3.7 天。
- **新模型发现**（`last-scan.json`）：8/8 格扫成；判官 0 问、复用备忘 34 次；提案 接替 2、待命 24；本轮无新推送；`cursor-native` 一格列出 240 个未登记写法。
- **`devin-acp-deepseek` 这条腿**：模型已从上游目录消失、池已到期、巡查已判下架，探活却一直记「没查成」（不淘汰），它仍在执行者偏好表末位（wd:docs/leg-policy.json:47）。

### 2.6 坑 → 新系统的测试用例（发现、巡查、探活）

- **D1 定时任务「显示开着」不等于会跑**：给定一个周期任务，当看门狗巡检，应当按「上次成功时刻」判活，「下一次触发」为空即红。出处：ags:deploy/systemd/reclaude-org-switch.timer:5-7（2026-09-19：单调时钟定时器算不出下次触发，看着开着不再跑）；wd:host/machine/systemd/miraquota-contabo.timer:8-10（2026-09-05 同类死态无声停了半天）。
- **D2 探活要自己定时跑，选路要读它**：给定某路由刚探出 402，当 36 小时内派工，应当不选它；池到期前 7 天应当提醒。出处：@83efd0c3（#1618：探针此前只有人手敲；2026-09-18 用户才发现 devin/opencode/commandcode 快过期；2026-09-20 真探出 402 的 grok 仍排第一，每次先在坏路由上白栽一次）；wd:host/machine/systemd/dao-leg-expiry.service:5-11。
- **D3 每条探活独立工作目录**：给定家目录里有无关进程，当探活起会话，应当不被租约闸挡成「没查成」。出处：wd:scripts/leg-expiry.mjs:104-111（2026-09-20 全路由重探，grok/luna/sol 三条被挡）。
- **D4 探活要核对实际走的计费通道**：给定一条声称「订阅直连」的路由，当探活答上来了，应当同时读回服务端记录的实际通道（本地 / 中转），和声明不符判失败。出处：@911ad8e6（#1575：探针没指定通道、服务端实走中转，被误判为订阅直连；上线当天领队位挂 3 次，服务端 422 拒跑）。
- **D5 点名的模型要回读核对**：给定请求里点名 `deepseek-flash`，当服务端静默把它变成 null、用了全局默认模型，应当探活读回实际模型并判不符。出处：ags:docs/MIRASIM-CHANNELS.md:78-86（2026-09-20 反例：点名后快照 model=null，落回已退役网关，403）。
- **D6 界面标签不是模型 id**：给定界面上显示 `v4.1-flash`、`k3`，当登记或起会话，应当把标签记作别名，发出去用真 id `deepseek-flash`、`kimi-k3`。出处：ags:docs/MIRASIM-CHANNELS.md:58、72（点标签服务端不认）。
- **D7 一台会话服务同一时刻只有一个 pi 模型**：给定两条 pi 路由各指不同模型、都靠服务端默认，当同时启用，应当拒绝；发现任务对这种「接替」只提待命。出处：ags:docs/MIRASIM-CHANNELS.md:85；wd:scripts/lib/model-discovery.mjs:9-10。
- **D8 巡查 0 条可查 = 没查成**：给定一轮巡查 0 条在役路由能对上游清单，当出结论，应当报「没查成」、连续 3 天判红，不得报「无差异」；巡查的在役口径必须与派工同源。出处：wd:scripts/catalog-patrol.mjs:1-4（#1395 终审：输入是已过时的旧路由表，13 条旧「在役腿」全部 unchecked，起因那条根本不在范围）、467-478、611-633。
- **D9 列表写法与启动写法不同会误报下架**：给定 Cursor 路由启动 id 带 `[context=…,reasoning_effort=…,fast=…]`、上游列表是另一种写法，当巡查比对，应当用同一套归一规则，且「下架」只在探活也失败时成立。出处：`<VPS>` 读回（2026-09-24T16:07Z 两条 Cursor Grok 路由判下架；grok-4.6 那条 16:02Z 刚探通，grok-4.7 那条当天 04:56Z 探通）；ags:docs/MIRASIM-CHANNELS.md:100（4.6 与 4.7 的 ACP 目录拼法不同）。
- **D10 「模型不在上游目录」要判失败**：给定起会话报「Requested concrete model ID is absent from the ACP model catalog」，当探活判定，应当判该路由失败、淘汰并通知，不得归「没查成」。出处：`<VPS>` 读回（`devin-acp-deepseek` 自 2026-09-20 起每轮都是这句，4 天多仍在偏好表里）；wd:scripts/leg-expiry.mjs:201-206（起会话抛错时非认证一律记没查成）。
- **D11 测试不许写生产观测**：给定跑完整套测试，当检查生产库与服务用户家目录，应当没有新增行。出处：`<VPS>` 读回 `~/.dao/leg-expiry.json` 的 30 条「单元测试注入」记录（2026-09-19T16:32Z）；判例 memory「加默认记账后测试污染真 ~/.dao」。
- **D12 发现的候选要折叠、要有人处置**：给定一个清单一轮列出 240 个未登记写法，当生成候选，应当把同线同版本的变体折叠，只把真新型号进候选；候选超过 N 天没处置要进提醒。出处：`<VPS>` 读回（pending_legs 250 条无读方；`cursor-native` 一格 240 条）。
- **D13 每个在役渠道都要有能自动刷新的清单源**：给定某渠道只有一份仓内旧快照，当巡查，应当在驾驶舱标「列不到」并报出来，不得让在役路由长期「快照过期、没查」。出处：`<VPS>` 读回（6 条中转路由 unchecked）；wd:docs/execution-profiles.json sources 里 `mirasim-model-roster` 没有 refreshCommand。
- **D14 会话服务单线程，读名册要逐个等**：给定要问多个执行体的名册，当某执行体正在起 codex 会话，应当每个执行体单独计时、按顺序问，不因一个堵住全体判没查成。出处：wd:scripts/model-discovery.mjs:131-135。
- **D15 保鲜阈值要大于周期**：给定探活 6 小时一轮、带随机延迟，当设过期阈值，应当 = 周期 + 抖动 + 一轮耗时（旧 7 小时）。出处：wd:scripts/lib/leg-catalog-alive.mjs:10-15。

---

## 三、六层目录与选路：带走什么，新系统的最小数据表

### 3.1 旧六层怎么对到新概念

| 旧（wd:docs/leg-catalog.json、wd:docs/execution-profiles.json） | 新（设计 §9） | 带走 | 丢掉 | 依据 |
|---|---|---|---|---|
| 族 `family{family_id, vendor, stage_allow[]}` | 族 | id、厂商、人写的白话专长（旧 `_family_strengths`，wd:docs/leg-policy.json:57-63） | `stage_allow`（族 × 阶段白名单、缺省拒绝） | 新设计自由组合，全局禁令只两条（设计 §三 #9） |
| 腿 `leg{leg_id, family_id, rank{stage}, stage_narrow[], speed, retired_at}` | 模型 | 归一后的 id、族、退役时间、别名（界面标签 ↔ id） | `rank`（挪到「阶段 × 路由」的顺序）、`stage_narrow`（Fable 只当领队 → 现在是禁令） | leg-catalog-three-layers.md:9-10、34-35；D6 |
| 渠道 `channel{channel_id, billing, auth}` | 渠道 | id、计费方式（套餐内 / 按量）、额度来源 `{kind, why}` | `auth` 原文 | 设计 §三 #21；wd:scripts/lib/execution-catalog.mjs:31-37、129-135 |
| 宿主 `host{host_id, can_write, can_resume, interactive}` | 执行方式 | 能写、能续、无头可用（interactive 取反，由探活写回）、会不会回报模型 | — | wd:scripts/lib/leg-catalog.mjs:103-108 |
| 池 `pool{pool_id, channel_id, window_h, cooldown_until, fail_streak}` + 旧池事实 `{sharedWith, reservePolicy, quotaSource, lifecycle}` | 账号池 | 渠道、共用关系、只给哪些阶段用（收着用）、额度来源、到期日、并发上限 + 依据 | `window_h` / `cooldown_until` / `fail_streak`（没有写方，改成从读数与会话记录现算）、`paid:null + _todo` | 第五节断链 1；wd:scripts/lib/execution-catalog.mjs:114-148 |
| 路由 `route{route_id = <腿>@<渠道>, host, pool, stages[], alive, expected_model_id, last_probe_*}` | 路由 | 渠道 + 账号池 + 模型 + 执行方式、发出去的精确 id、期望回显、模型怎么定（点名 / 服务端默认 / 执行方式自选）、人工开关 | `<腿>@<渠道>` 这种 id（会撞）、`stages`（挪到阶段顺序表）、手填 `alive`（改为最新探活现算） | leg-catalog-three-layers.md:36（kimi k3 两个执行方式撞 id）；wd:scripts/lib/execution-catalog.mjs:19-26 |
| 约束 `distinct_family: [execute, review]` | — | 不带（设计改成「第二意见」） | 硬闸 | 设计 §16「审查闸改成第二意见」 |
| 偏好 `leg-policy{prefer, deprioritize, paused{until}, tiers}` | 阶段 × 路由顺序 + 人工暂停 | `prefer` → 顺序；`paused.until` 到点自动恢复 | `tiers`（强 / 标准 / 经济档）、`deprioritize +1000` | wd:scripts/lib/leg-choice.mjs:284-298、300-321 |

### 3.2 硬过滤（淘汰码）——值得带走的清单

淘汰的候选**留在列表里、带原因码**，不许静默消失（用户明确要求，wd:scripts/lib/leg-choice.mjs:25-27、610-638）。旧顺序与新对应：

| 旧淘汰码 | 含义 | 新系统 | 出处 |
|---|---|---|---|
| `disabled` / `availability-*` | 档未启用 / 可用性不是 available | 路由、池、渠道任一未启用 | leg-choice.mjs:532-533 |
| `paused` | 人工暂停，`until` 到了自动恢复 | 同，放路由上 | :284-298、535 |
| `excluded-by-caller` / `family-excluded` | 调用方排除 / 同族排除 | 只留「单个任务指定路由」 | :536-537 |
| `pool-exhausted` | 池的读数已用满（所有阶段） | 任一适用窗口用满或上游状态字说满 | :541 |
| `pool-reserved` | 池只给点名的角色用 | 池只给点名的阶段用 | :193-198、542 |
| `pool-vetoed` | 判断题否决这个池（只能加淘汰） | 删（设计 §16 删 Jev 选路） | :543 |
| `role-missing` / `capability-missing` | 目录角色或能力没验证 | 阶段要写 → 执行方式能写且无头 | :544-547；leg-catalog.mjs:103-108 |
| `probe-failed` | 36 小时内探不通 | 同；外加认证失败、模型对不上 | :551、55-85 |
| `account-paused` | 账号类失败，暂停到 retry-at 或逐级时长 | 同，现算 | :553-558、939-974 |
| `route-dead` / `stage-not-allowed` / `host-unfit` | 目录路由没活 / 阶段不允许 / 宿主不够 | 路由最新探活 + 禁令 + 执行方式能力 | :352-371 |
| `pool-cooldown` / `pool-fail-streak`（≥2） | 池冷却 / 池连败 | **不带**：字段没有写方，永远不响 | :372-381；第五节 |
| `tier-too-weak` | 档位弱于任务要求 | 不带 | :531 |

另两条：GPT 写码在排序里成本 ×3（:97-101，#1726/#1735 的二道保险）；执行与审查不同族在生成候选时就淘汰（:26-27）。新设计里分别变成「禁令 GPT × UI」与「第二意见」，后者不再是硬闸。

### 3.3 排序与微调——值得带走的常数

旧排序键（字典序，前面的压过后面的；wd:scripts/lib/leg-choice.mjs:592-609）：角色命中强度 → 能力验证强度 → 连败冷却 → 成功率保底线 → 在途满没满 → 档位 → **人拍的偏好** → 成本（订阅 → 按量 → 未知；GPT 写码 ×3）→ 近 7 天成功率 → 近 30 天质量 → id。

值得带走的常数：
- 成功率只看近 7 天真实结局（故障期的失败不该永远压着恢复了的路由）（:45-46）。
- 连续失败 3 次 → 冷却 6 小时，**只后置不淘汰**（全员冷却时仍要有路由可用），到点自动回到原位，下一次真跑就是那次试探（:47-50、132-145）。
- 保底线：样本满 10、成功率低于 0.5 → 排到正常路由后面，不淘汰（:51-53、597-599）。
- 只有「上游」与「没写原因」的失败算路由的账；我们自己的、账号的、旧占位符都不算（:900-930；wd:scripts/lib/failure-class.mjs:14-23）。
- 质量分：近 30 天、样本 < 5 视为未知、按中性 0.5 参与，只后置不淘汰（wd:scripts/lib/leg-quality.mjs:5-8、57-63）；决策文档另写「n<5 的不得压过 rank 更高且 n≥5 的」（leg-catalog-three-layers.md:56）。
- 调序建议只重排已在偏好表里、样本够的腿，表外的腿分再高也不插进来（wd:scripts/lib/leg-quality.mjs:105-123；wd:scripts/leg-policy-tune.mjs:1-15）。
- 可复现：候选打乱与探索用带 seed 的伪随机（mulberry32 + Fisher–Yates），seed 记进结果（wd:scripts/lib/leg-choice.mjs:437-458、652-689）。

旧系统**没有**的：「快清零的先用」、「额度够不够收尾」、真正派出去的试探。这三样新系统要从零做（第 3.6 节）。

### 3.4 旧系统里该丢掉的

- **两份偏好 / 目录 / 腿表并存**：`docs/model-routing.json`（腿节，并发上限还在这读）、`docs/execution-profiles.json`（选路真相源）、`docs/leg-catalog.json`（旁路生成）、`docs/leg-policy.json`（人拍偏好）四份文件描述同一件事；巡查就曾拿过时的那份当输入（D8）。新系统一张表一件事。
- **Jev 选路**（设计 §16 已定删）：旧版只在影子里跑、从没换过人（wd:packages/fleet/src/cli.mjs:363-364）。
- **档位（tiers）与判断题出的难度档**：新设计没有这层。
- **用 git 仓当额度账本**（MiraQuota 多机页的 `machine/<机器>` 分支 force-push）：新系统直接写 Postgres。
- **探活结果存两份**（leg-expiry.json 与 alive.json）：新系统一张探活表。

### 3.5 新系统最小数据表（Postgres）

角色简称：**创始人**（驾驶舱后台）、**帅位**（定时起的 AI 帅位会话）、**工人**（引擎工人 / Temporal 活动）、**读数任务**（每种额度来源一个 Temporal 定时）、**探活任务**、**发现任务**、**调度器**（引擎里的选路）、**对账**（每小时对账）。

配置和人工开关的每次改动写进全局「操作记录」表（不在本手册范围，见设计 §三 #5），支持一键撤回。

#### 配置类（人或帅位改）

**1. `channels` 渠道**
- 字段：`id`（PK，如 `claude-sub`、`mirasim-cloud`、`cursor`、`xai`、`kimi`、`api-<厂>`）、`name`、`billing`（`subscription` 套餐内 / `metered` 按量）、`monthly_fee_usd`（订阅月费，驾驶舱填、不进 git）、`metered_cap_usd_month`（按量月上限；按量且为空 = 该渠道路由一律不派）、`quota_source`（`claude-stream` / `claude-probe` / `mirasim-relay` / `cursor-dashboard` / `none`）、`quota_source_why`（`none` 时必填）、`enabled`。
- 谁写：创始人；帅位只能把 `enabled` 改成 false 并推通知。谁读：调度器、读数任务、驾驶舱「渠道与账号」「账单」。

**2. `account_pools` 账号池**
- 字段：`id`（PK）、`channel_id`、`label`（如 `<账号A>·拼车组织`）、`local_ref`（机器本地配置里的键名，不存凭据本身）、`org_kind`（`carpool` / `solo` / null，Claude 订阅由读数任务从 `org list` 现写）、`shares_with`（text[]：扣同一份额度的其他池）、`max_concurrent`（null = 保守 3）、`max_concurrent_basis`（必填：拍 / 量 + 日期 + 出处）、`declared_until`（订阅到期日）、`reserve_for_stages`（text[]，空 = 不限）、`enabled`。
- 谁写：创始人；读数任务只写 `org_kind`。谁读：调度器（并发队列、收着用、到期提醒）、驾驶舱。
- 说明：Mirasim 中转应建**一个**账号池（5h/7d 本来就是账号级），不要像旧系统那样按族拆三个再补 `sharedWith`（wd:scripts/lib/quota-alarm.mjs:3-10）；模型组窗口靠读数上的 `applies_to` 区分。Cursor 也是一个池（上限拆不开）。Claude 订阅两个组织各一个池。

**3. `families` 族**
- 字段：`id`（PK）、`vendor`、`strengths`（人写的白话专长）。
- 谁写：创始人。谁读：驾驶舱、分诊与规划的提示词、禁令。

**4. `models` 模型**
- 字段：`id`（PK，归一后的键：去 `claude-` 前缀、`5-1` → `5.1`、去 `[参数]`、去渠道前缀）、`family_id`、`display_name`、`aliases`（text[]：界面标签与历史写法）、`context_window`、`retired_at`。
- 谁写：创始人；发现任务只提案，经人点头才写。谁读：调度器、探活（回显归一比对）、发现任务、驾驶舱「模型目录」。

**5. `executors` 执行方式**
- 字段：`id`（PK：`claude-code` / `codex` / `cursor-agent` / `grok-cli` / `kimi-cli` / `api-shell`）、`can_write`、`can_resume`、`headless_ok`、`reports_model`（ACP 类为 false）、`progress_format`、`verified_at`。
- 谁写：创始人登记；能力由探活与考试写回。谁读：调度器（写码阶段要 `can_write ∧ headless_ok`）、驾驶舱。

**6. `routes` 路由**
- 字段：`id`（PK，代理键，如 `opus-5.5@claude-sub-solo/claude-code`，**必须含执行方式与池**）、`pool_id`、`model_id`、`executor_id`、`launch_model_id`（真正发出去的精确写法，含 `[参数]`）、`model_selection`（`pinned` / `server-default` / `agent-default`）、`expected_echo`、`enabled`、`paused_until` + `pause_reason`（人工暂停，到点自动恢复）。唯一约束：(`pool_id`, `model_id`, `executor_id`, `launch_model_id`)。
- 谁写：创始人、帅位；发现任务只提案。谁读：调度器、探活、驾驶舱。

**7. `stage_types` 阶段类型**
- 字段：`id`（PK：分诊、规划、写码、UI、测试、审查、调研、判断）、`needs_write`、`needs_headless`、`description`。
- 谁写：创始人。谁读：调度器。

**8. `stage_routes` 每个阶段的有序路由（人排序）**
- 字段：`stage_type_id`、`route_id`（联合 PK）、`position`、`enabled`、`pinned`（创始人钉住：帅位与自动微调都不动）、`updated_by`、`updated_at`。
- 谁写：创始人（驾驶舱拖拽）、帅位（只改没钉住的行）。谁读：调度器、驾驶舱「调度台」。

**9. `bans` 禁令**
- 字段：`id`、`family_id`（可空）、`model_id`（可空）、`stage_type_id`（可空 = 全部阶段）、`reason`。种子两条：（gpt 族，UI 阶段）、（fable 模型，全部阶段）。
- 谁写：创始人（改规则 = 人闸）。谁读：调度器；驾驶舱拖拽时当场拒绝。

#### 事实类（机器写，以追加为主）

**10. `quota_readings` 额度读数（额度账的唯一写入口）**
- 字段：`id`、`pool_id`、`window`（`5h` / `7d` / `7d_claude` / `month` / `week`…）、`applies_to`（`account` 或 `model:<组名>`）、`used`、`limit_value`、`unit`（`percent` / `points` / `usd`）、`resets_at`、`upstream_status`（`allowed` / `warning` / `limit_reached` / `rejected` / null）、`kind`（`measured` 实读 / `learned` 撞限推出 / `estimated` 用量估算）、`source`（`claude-stream` / `claude-probe` / `mirasim-relay` / `cursor-dashboard` / `session-sum`）、`observed_at`、`source_event_id`（唯一，重记同一次读数不涨账）、`run_id`。
- 视图 `quota_latest`：每个（池, 窗口）取最新一条。
- 谁写：读数任务；工人在会话收尾时从 CLI 流里被动抽出的读数；撞限时写 `learned`。谁读：调度器（过滤与快清零）、驾驶舱「额度」、对账（每池 ≤30 分钟）、飞书置顶盘面卡。

**11. `sessions` 会话（花了多少 + 战绩原料）**
- 字段：`id`、`task_id`、`subtask_id`、`stage_type_id`、`route_id`、`pool_id`（**NOT NULL**）、`model_reported`、`started_at`、`ended_at`、`state`（running / done / failed / stopped）、`failure_class`（ours / account / upstream / unknown）、`failure_code`、`retry_at`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`cost_actual_usd`、`cost_estimated_usd`、`points`、`duration_ms`、`usage_complete`、`explored`（这次是试探）。
- 谁写：工人（起会话写 running；收尾写结局与用量；迟到的计费回填另补，如 Cursor 事件、Mirasim 账本）。谁读：调度器（在途数、池暂停、连败）、战绩视图、驾驶舱「账单」、对账。
- 说明：执行与进度切片若另有会话表，这些字段并进去即可，不必两张。

**12. `probes` 探活与考试**
- 字段：`id`、`route_id`、`at`、`kind`（`liveness` 探活 / `exam` 考试）、`outcome`（ok / failed / auth / interactive / model_drift / unscanned）、`echoed_model`、`actual_channel`（服务端回报的实际通道）、`latency_ms`、`why`。
- 谁写：探活任务、派工前补探、新模型考试。谁读：调度器（36 小时内 failed / auth / model_drift 淘汰）、对账（在役路由 7 小时没探通 = 红）、驾驶舱「模型目录」。

**13. `model_candidates` 新模型候选**
- 字段：`id`、`channel_id`、`executor_id`、`listed_id`、`label`、`first_seen_at`、`last_seen_at`、`relation`（successor / standby / variant / older / none）、`supersedes_route_id`、`status`（open / exam_scheduled / accepted / rejected / gone）、`exam_probe_id`、`notified_at`。
- 谁写：发现任务；考试结果由工人写。谁读：驾驶舱「模型目录」、闲置调度（设计 §三 #11「考新模型」）。

**14. `dispatch_decisions` 派工原因**
- 字段：`id`、`subtask_id`、`stage_type_id`、`at`、`chosen_route_id`、`chosen_position`、`explored`、`seed`、`candidates`（jsonb：每条路由的顺序、淘汰码或 null、微调记录）、`reason`（一句话）。
- 谁写：调度器。谁读：驾驶舱（每一步用哪条路由、为什么）、战绩（区分试探样本）。

#### 派生（视图或物化视图，不单独写）

**15. `route_stats` 战绩**：按（路由, 阶段, 7 天 / 30 天）算 `n`、`done`、`failed_counted`（upstream + unknown）、`excluded`（ours + account）、`success_rate`、`fail_streak`、`last_failed_at`、`quality_mean`、`quality_n`、`p50_duration_ms`。来源 `sessions` + 质量分（审查与验证切片出）。读：调度器、驾驶舱「战绩」。
**16. `pool_state` 池状态**：`in_flight`（running 会话数）、`paused_until`（账号类失败现算：有 retry_at 照它，否则 15 分钟 × 4^(n−1) 封顶 24 小时）、各窗口剩余比例与离刷新多久。读：调度器、驾驶舱、飞书盘面卡。

### 3.6 选路流程草稿

```
选路(子任务, 阶段):
  列表 = stage_routes[阶段]（按 position）；单个任务指定了路由就只用那一条
  逐条判淘汰码（先到先得，淘汰的留在 candidates 里）：
    banned        命中禁令
    disabled      路由 / 池 / 渠道未启用，或人工暂停未到期
    exec-unfit    阶段要写而执行方式不能写，或不能无头
    probe-failed  36 小时内最新探活为 failed / auth / model_drift
    pool-paused   pool_state.paused_until 未到
    quota-out     任一适用窗口（applies_to 为 account 或匹配本模型的组）上游状态字说满，或 used ≥ limit（读数须新鲜）
    quota-short   适用窗口剩余 < 该阶段在该池上的 p80 用量（没有样本就不判）            ← 新
    metered-cap   按量渠道本月已花 ≥ 月上限，或没设月上限                              ← 新（设计 §三 #21）
    reserved      池只给点名的阶段用，本阶段不在其中
  不淘汰但要排队：in_flight ≥ max_concurrent → 标「等空位」
  读数不新鲜（>30 分钟）：不淘汰，标「额度没查成」，并由对账报警
  存活为空：有「等空位」的就排队；否则挂起并报警（驾驶舱写明在等什么）

  微调（只动没钉住的行，每次最多挪一位，挪动写进 candidates）：
    快清零上移   某适用窗口离刷新 ≤ 窗口长度 × 20%，剩余 ≥ 50%，读数新鲜          ← 新，起步值待数据校准
    战绩后置     7 天计数样本 ≥ 10 且成功率 < 0.5；或连败 ≥ 3 且最后一次失败在 6 小时内
    样本少不动   样本 < 5

  试探：以 0.1 的概率从存活的非首位里挑一条（优先 7 天 0 样本的），真派出去，explored = true
  写 dispatch_decisions（一句话原因）
```

待创始人拍的两处：快清零是「上移一位」还是「提到没钉住行的最前」；读数没查成的池是照常可派（旧做法）还是只在其他路由都不可用时才派。

注：第二处设计 §九（2026-09-25 版）已定——额度没读成（或读数过期）的账号池不挡，但排在读到了的后面，派工原因里写明「额度未知」；读失败本身按设计第十节报警。上面草稿里「读数不新鲜：不淘汰，标『额度没查成』」一行按此实现。

### 3.7 坑 → 新系统的测试用例（目录与选路）

- **R1 状态不许成化石**：给定某路由的冷却 / 暂停记录超过有效期没人更新，当选路，应当忽略它（或判没查成），不得一直把路由压在末位；冷却与暂停从最近的真实会话现算并带到期时刻。出处：@475b9b4b（#1666：熔断表两天半没人写，「试探中」的 Grok 永远排末位、永远轮不到那次试探）；wd:scripts/lib/leg-choice.mjs:16-23。
- **R2 去掉一个状态会放出它压着的默认值**：给定改动选路逻辑，当合并前，应当对每个阶段读回首选路由并与改动前比对，首选变了要人确认。出处：@546cba1f（#1668）；wd:docs/leg-policy.json:11（去掉化石表后审查的自动推荐变成 Grok，而它近 7 天真实成功率只有 23/145）。
- **R3 没排序时不许按 id 字典序**：给定某阶段的路由都没排顺序，当选路，应当拒绝派工并提示人排，不得按 id 字典序取第一。出处：wd:docs/leg-policy.json:5（此前同分按 id 字典序，Cursor 天生第一，2026-09-20 重派 #1560 自动选到它，与拍板相反）。
- **R4 同模型不同执行方式是两条路由**：给定 kimi-k3 经 pi 与经 kimi-cli 两种跑法，当登记，应当生成两条 id 不同的路由，不得撞号。出处：wd:docs/decisions/2026-09-22-leg-catalog-three-layers.md:36（迁移时 `kimi-k3@<渠道>` 撞 id，只好把一条改挂别的渠道）。
- **R5 路由挂的池必须是它实际扣费的池**：给定一条走中转的 Claude 路由，当登记或探活，应当挂在中转池上，探活读回的实际通道与池不符判错。出处：@7ab10b52（Opus 中转腿挂在 Claude 订阅池上「收着用」，与实际中转渠道对不上；中转 Anthropic 池挂着名却零条腿）。
- **R6 退役不是暂停**：给定一个模型能力已被取代（Fable 不如 Opus 5.5），当处理，应当写禁令或退役，不得用「暂停，删掉即恢复」表示。出处：@7ab10b52；wd:docs/leg-policy.json:70。
- **R7 共用一个窗口的只报一次**：给定三条路由共用一个中转账号窗口、用到 80%，当推提醒，应当只推一条，每个刷新周期只推一次，只有拿到飞书 messageId 才算推过。出处：@aa323a6a；wd:scripts/lib/quota-alarm.mjs:3-17。

---

## 四、各渠道的并发经验值

### 4.1 渠道级（会话级上限）

| 渠道 · 执行方式 | 数值 | 拍还是量 | 日期 | 依据摘要 | 出处 |
|---|---|---|---|---|---|
| Mirasim 中转（所有中转路由） | 5 | **拍**（当日未测） | 2026-09-08 | 用户拍板 | wd:docs/decisions/2026-09-08-channel-caps.json:8；wd:docs/decisions/2026-09-08-channel-concurrency-two-planes.md:66；wd:docs/model-routing.json:649 |
| Mirasim 中转 luna / sol 实测 | 没查成 | — | 2026-09-14 | luna 读会话中途大面积失败；sol 全倒在连不上回环 ws（基础设施故障，非容量） | @27ffcc97（#1274 正文） |
| Mirasim 中转过载的样子 | — | 量 | 2026-09-09 | 审官长流打在中转上 `relay-ticket: mint error` 中止 | two-planes.md:105-107（#1169） |
| xAI Grok 原生（grok-4.6） | 不限 | 量（短会话） | 2026-09-14 | 同起 6 个 6/6，6 路全程出字、5/6 产出 4100–6900 字；十几分钟的审查会话没测 | wd:docs/model-routing.json:765-767；@27ffcc97 |
| Cursor 原生 ACP（composer-2.5） | 不限 | 量 | 2026-09-14 | 同起 6 个 6/6、产出 3800–5500 字、零容量拒绝；旧「上限 1」作废 | wd:docs/model-routing.json:841-843 |
| Cursor 经网关代理（已退役） | 2 | 量 | 2026-09-08 | 4 并发整批挂起；3 条时 agent 进程崩（退出码 1）；「ACP 常驻单代理」 | two-planes.md:68 |
| grokpool（xAI 经网关，已退役） | 不限 | 拍 + 长流 ≥8 | 2026-09-08 | 「工人无限做没出过问题」 | two-planes.md:67 |
| windsurf（经网关，已退役） | 6 | 拍 | 2026-09-08 | 长流 8 全绿只是 HTTP 代理，不是真实会话证明 | two-planes.md:65 |
| pqapi codex（已停用） | 2 | 拍（原依据「CLI 3-4」已撤回） | 09-08 / 09-09 | 「3-4」其实是网关里只剩一条可用账号 | two-planes.md:64、92-112 |
| commandcode | 0 / 到期 | — | 2026-09-08 | 不作溢流 | two-planes.md:71 |
| Claude 订阅（reclaude 终端腿） | 5 | **照抄中转的拍板值** | — | 依据栏写的是「mirasim 中继 = 5（拍的不是量的）」 | wd:docs/model-routing.json:647-649、701-703 |
| Kimi 原生 | 没查成 | — | — | — | — |
| 待填的默认 | 3 | 规则 | 2026-09-08 | 取当时「Codex 3-4」的下界（该观察后来撤回），不放开也不拦死 | wd:scripts/lib/channel-concurrency.mjs:56-69 |
| 网关机（已退役） | 总长流 12–14 条 | 量 | 2026-09-08 | 触发 90% CPU 保护、整机 503 | two-planes.md:36-46 |

两个口径别混：请求级（一次性短 HTTP）≠ 长流探针 ≠ 真实 agent 长会话；**最终判据只认真实派工的会话死因**（two-planes.md:48-55）。

### 4.2 机器级（6 核 12G）

| 项 | 数值 | 拍还是量 | 出处 |
|---|---|---|---|
| 派单器同时在途任务 | 5（8 条同跑时负载 14、Mirasim 回环 ws 反复断、控制面探针闪红；5 条时负载 3~5） | 量，2026-09-23 拍板 | wd:scripts/lib/dispatcher/gates.mjs:10-17；@a3358069（#1767） |
| 同时处于执行阶段的任务 | floor(核数 / 2) = 3 | 规则，2026-09-22 | wd:packages/fleet/src/machine-slots.mjs:1-4、22-27（#1748） |
| 全机同时跑测试 | 2 份 | 规则 | wd:docs/release-policy.json:43；@e88ca29a |
| Temporal 活动并发 | max(4, 核数 × 2) = 12；隔离决定建议先降到 6 作垫片 | 规则 | wd:packages/fleet/src/cli.mjs:793-799；wd:docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:76、85 |
| 单个 agent 内存 | `MemoryHigh` 1.2–1.6G / `MemoryMax` 2–2.5G（三臂区间，未上线） | 拍 | 同上决定:64 |
| 会话服务 | `MemoryHigh` 3.5G 被回填撞到；一个 agent 被 OOM 曾连带停掉整个会话服务 | 量 | wd:docs/observations/2026-09-18-上报mirasim-回填不收敛与codex不重试.md:20；@443cda61（#1810） |

### 4.3 新系统起步建议（建议，不是出处）

- 每个账号池一条队列，`max_concurrent` 起步：Mirasim 中转 5（沿用拍板值，打上「拍」）；Cursor、xAI 各 3（量过 6/6 但只是短会话）；Claude 订阅两个组织、Kimi 各 3（从没量过）。全部标 `max_concurrent_basis`，实测后改。
- 总量由机器准入兜底：看内存与压力，不看整机 CPU 百分比（设计 §四）；旧系统的实测墙是「8 个任务同跑」。
- 上限的依据只认 `sessions` 里的结构化失败统计，每次改数写依据。

### 4.4 坑 → 新系统的测试用例（并发）

- **C1 并发按账号池计，不按启动器计**：给定走同一个启动器、但落在不同供应商的路由（xAI、Cursor、中转），当算在途，应当各算各的池；不得把它们合成一个渠道再取最小值。出处：@27ffcc97（#1274：composer 凭印象填的「1」把整个 mirasim 渠道压成并发 1）；wd:scripts/lib/channel-concurrency.mjs:96-104（2026-09-15：整块盘面一次只能派一张）。
- **C2 在途数的分子要有真实来源**：给定两条在跑会话都在池 P、`max_concurrent=2`，当再起第三条，应当排队；会话记录缺池 id 时应当拒绝写入（NOT NULL），不得静默按 0 计。出处：@610c6f7f（#1266：会话名单没带模型，渠道在途数恒为 0，闸永远判不出满，且长得跟「渠道都很空闲」一模一样）。
- **C3 没测过的不许继承别人的「不限」**：给定池 A 已验证不限、池 B 没填，当算 B 的上限，应当用保守值 3。出处：@27ffcc97（#1274：gpt-5.6-sol 因同渠道的 grok / composer 标了不限而被放行）；wd:scripts/lib/channel-concurrency.mjs:309-310。
- **C4 容量依据不许来自文字回声或短探针**：给定 issue / PR 正文里出现「429」「at capacity」，当统计容量，应当只数会话记录里的结构化失败。出处：two-planes.md:92-112（09-09 撤回：态势快照里的 429 全是正文回声，熔断表等零条真 429；「3-4」其实是账号可用性）。
- **C5 已取消、只在收尾的工作流不占名额**：给定一个任务已取消、还在收尾，当算在途，应当不计入。出处：@69bbffc4（#1822：收尾挂 20 多分钟，占着 5 个名额之一）。
- **C6 准入看机器压力**：给定 8 个任务同跑、负载飙升、Mirasim 回环连接反复断，当再来新任务，应当排队不放行。出处：wd:scripts/lib/dispatcher/gates.mjs:10-17（@a3358069，#1767）。
- **C7 一个会话 OOM 不许带走别人**：给定一个会话被内核 OOM 杀掉，当检查，应当其他会话与引擎照常。出处：@443cda61（#1810：默认策略下一个 agent 被 OOM 就停掉整个会话服务，2026-09-22 连带死过一次）。
- **C8 换执行方式要重测上限**：给定 Cursor 从网关代理改成原生 ACP，当沿用旧上限，应当标「待重测」；旧值作废要留记录。出处：two-planes.md:68（经网关 2）对照 wd:docs/model-routing.json:843（原生 6/6，「旧上限 1 作废」）。

---

## 五、代码核对出的断链与风险（没见事故记录，不算「坑」，但新系统要避开）

1. **探活结论选路看不到一半**：选路读原始目录的 `alive`（按启用状态初始化）与 `~/.dao/leg-expiry.json`（wd:scripts/lib/leg-choice.mjs:847-864）；`model_drift`、`pool_auth` 只写进 `alive.json`（wd:scripts/lib/leg-catalog-alive.mjs:179-241），而 `withAlive` 合成视图只被保鲜检查用（:418；全仓 grep 无其他调用）。探活的 `judgeProbe` 不比回显，回显对不上仍记「通」（wd:scripts/leg-expiry.mjs:178-179）。→ 新系统一张探活表，选路与对账读同一份。
2. **有读方没写方的字段**：池的 `window_h` / `cooldown_until` / `fail_streak`、路由的 `last_task_ok_at` 只在迁移时置空（wd:scripts/leg-catalog-migrate.mjs:97-99、296-298），全仓没有写入；选路却拿 `cooldown_until`、`fail_streak ≥ 2` 做淘汰（wd:scripts/lib/leg-choice.mjs:372-381）。→ 新系统每个运行时字段登记写方，没写方的字段不许进过滤条件。
3. **试探只在影子里**：`shortlist` 的 ε 探索只换进交给 Jev 的候选，Jev 结论只记账不换人（wd:packages/fleet/src/cli.mjs:335-365；wd:scripts/lib/leg-pick.mjs:2-4）。
4. **上游状态字没人读**：中转帧的 `status: limit_reached` 旧代码不取（wd:scripts/lib/miraquota-contabo.mjs:104-123 只要 used/budget），池判「用满」只比 `spent ≥ limit`（wd:scripts/lib/pool-quota.mjs:169）；真机帧里出现过 99.04% 就 limit_reached（wd:tests/miraquota-contabo.test.js:54-57）。→ 新系统以上游状态字为准。
5. **Claude 订阅在目录里没有可派的路由**：`opus-5.5` 只有中转一条，订阅那边只有已退役的 `fable-5.1@reclaude`（alive=false）（wd:docs/leg-catalog.json routes）——派工不可能走到订阅，与设计第二节「派工从不走 Claude 订阅那条线」一致。
6. **每池轮流探活，单条路由很久才探一次**：一个池挂 3 条路由，每条要 18 小时才轮到；保鲜检查用池级时间兜住不报红（wd:scripts/lib/leg-catalog-alive.mjs:402-431），所以单条路由坏了也可能长时间不被发现。实读：Cursor 池的 grok-4.7 路由上次探通 04:56Z，而池级 16:02Z。

---

## 六、没查成

- Kimi Code 的额度怎么读（目录没登记；Mirasim 自带账号探针号称支持 kimi，但 `<VPS>` 上关着、也没账号）。
- xAI 周限的刷新日（目录写「待补」）。
- Cursor Dashboard 那份 $400 上限属于哪个计费池（自家模型池还是 Other 池）。
- 探活每次花多少钱（旧系统没记）。
- codex 自带订阅的限流字段（两个仓都 grep 不到任何读取代码）。
- `<VPS>` 上 Claude 订阅读数探针失败的根因（与凭据文件变成 root 属主时间吻合，未证实）。
- Claude 订阅真实会话并发、Mirasim 中转真实长会话并发（从没量过）。
- Mirasim 账本回填不收敛（#1333）、codex 失败不重试 `attempts=1`（#1342）现在是否已由上游修好（审计时没用 gh 查状态）。
