# hooks / Agent 全量审计

本稿记录现行职责和 #2954 撤层边界。当前 agents/hooks 下实有 35 个 .mjs 模块；过程入口按 plugin-catalog 的现行目录登记，库模块不另起过程入口。

结论：原生消息链应成为唯一投递通道。在役宿主的忙时、连续多条与异常恢复验收通过，现撤“读未落盘账猜丢失，再从 hook 补原文”的第二条投递链；仓约定、安全、同步、容量、无人值守、队列与外部工人终态通知仍有独立业务职责。没有单独 hook 登记的库模块不因此成为死代码。

## 事实源与证据边界

- 职责和写存读链来自当前仓库源码、登记目录、调用方与同步脚本。源码证明路径和顺序，不自动证明某次真实宿主执行了它。
- `plugin-catalog.mjs` 当前登记 7 条过程入口；Codex 另有安全、SessionStart、PostToolUse、Stop 4 个用户级事件。Claude 的 `asyncRewake` 能力不能推给所有 vendor。
- #2937 的登记归属、字段校准、重复项与退役墓碑已由 #2945 合入；#2941 的正常 Stop 续轮已由 #2951 合入；真实 Mirasim 共享 Codex hooks 布局由 #2958 修复。旧稿的这些问题不再算开放缺陷。
- #2957 已补迁移闲忙核验：完整列表之外还要求原生 `noRun` 明确信号，未知保持未知。实际安装已由根代理独立核验；本稿不公开任何令牌、网关地址、私人会话内容或原始调试日志。
- 本机真实 installed launcher 的 busy / sequence / resume 三类 v2 探针已通过，范围是 installed launcher → reclaude stream transport、隔离 Claude 配置和本机自有订阅路径。它们没有经过真实 Mirasim cloud 会话入口，不能据此声称 cloud 成功；cloud 成功不另作为撤重复投递的前置。
- 旧 v1 busy / sequence 的 false 原样保留：旧探针错误地要求忙时消息必须存为独立 `type:user` 行，而本机 CLI 实存为 `queued_command` 与原生 system envelope；第一轮工具还碰到 10 秒 timeout 转后台。新探针是另版本、另会话，不修改旧结果。
- 真实 Mirasim cloud 一例已执行但失败：两条 `/v1/messages` 均 `viaRelay:true`、HTTP 429、`errorCode=credit_exhausted_30d`，宿主 `done + incomplete`，fixture 未开始。这证明走到了真实平台模型请求入口，不能证明消息进入模型或模型处理。具体为平台 30 天额度窗口耗尽，现成状态与账本没有重置时间，不推断总余额为零。

## 全量模块职责、写存读链及去留

“原生替代”只表示宿主已有哪种基础能力，不表示它自动实现本仓业务规则。下表覆盖现行模块；已退役投递模块另列，不再参与运行调用。

| 模块 | 目的与真实入口 | 谁写、存哪里、谁读 | 原生替代及边界 | 处理与依据 |
|---|---|---|---|---|
| `bootstrap.mjs` | 项目 SessionStart 检查已安装 Fleet 副本，旧安装或异常时修复 | 读取用户登记、已安装 hooks、同步标记与受管源码；经 `syncFleet` 更新受管副本，后续入口读 | 宿主只负责触发 SessionStart，不提供本仓原件更新 | 保留。与常规开场上下文不同，不能因共用同步函数就整层删 |
| `background-launch.mjs` | 给 session-start 联网任务和 queue-stop 统计共用真正脱离后台原语 | 读必要环境与已有代理；父入口写 run 状态，worker 原子写独立 done/failed 回执，backgroundState 读回执和本 worker PID；回执不存环境、密钥或命令 | Windows `spawn(detached:true)` 不能提供正确父树生命周期；统一调用既有 WMI / setsid 原语 | 保留。#2965 已合；失败 / 早退 / 超时明确失败，Windows 使用绝对 taskkill 路径且只终止自己创建的子树；`_detach.mjs` 是同步生成依赖，非第二份原件 |
| `background-recovery.mjs` | 只读本会话原生重启任务通知，提示接手未完成代理/命令 | 读本 transcript；兼容 tick 状态仅保留 backgroundRestartKey，不读 seen 原文账；main-thread 调用 | 原生通知保留真实任务编号，本仓补明确接手方式 | 保留；与 Mirasim 血缘无关，同次重启去重，失败明报且写状态失败仍输出恢复提示 |
| `session-id.mjs` | 原生会话号纯校验 | 无文件或进程副作用；background-recovery 与 work-watch 调用 | 宿主协议仍需边界校验 | 保留；仅允许1到128个字母数字下划线连字符 |
| `capacity.mjs` | 派工前核本机资源容量，供 pretool / queue 使用 | 从系统接口只读资源；无独立持久账；调用方读结果 | 原生 Agent 并发不等于本机资源配额 | 保留。读不到明确失败，不能回空值冒充可派 |
| `founder-inbox.mjs` | 只读 Mirasim 血缘、实际 turns 和同家 prompt-log 历史 | 读 record、turns、prompt-log；session-start、progress 与引导认主读取；不写投递账 | turns 收尾才落，缺行不代表未投递；prompt-log 只证明入口收取 | 保留 lineageOf、sentByFounder、ownerPresence 和 readFounderHistory；读取失败明确报告，不比较发收差集 |
| `fresh-main.mjs` | 派工等入口确认远端 main 新旧 | 经 git-run fetch；写 fetch 成功缓存，调用方读；不切开发树 | 原生 git fetch 是基础操作，不替代本仓新旧约束 | 保留。失败不可放宽为“已经最新” |
| `git-run.mjs` | 共用 git 运行与环境 / 网络回退 | 读调用参数与本机环境；返回真实退出结果给 fresh-main / 同步调用方 | git 原生命令仍需可靠调用、错误传播 | 保留。直连 / 备用路径不等于修改业务工作区 |
| `hook-timing.mjs` | 记录 hook 耗时，供性能核验 | 写 Fleet 日志目录的 `hook-timing.jsonl`，约 2MB 轮转 `.1`；摘要读取该日志 | 宿主事件能力不提供本仓分段耗时证据 | 保留。观测失败不阻业务；耗时日志不证明消息已投递 |
| `main-thread.mjs` | PreToolUse 检查主线程是否先答新的人类引导 | 只读原生 transcript；输出 deny / systemMessage；调用 background-recovery 给恢复上下文 | 宿主负责消息投递，本仓负责先回规则 | 保留 settle、回话工具放行、子代理/camelCase/headless 跳过；不读取投递账或补原文 |
| `plugin-catalog.mjs` | 声明过程事件、timeout、asyncRewake 与退役墓碑 | 纯数据；plugin-loader / 同步读取；无单独登记 | 宿主不维护本仓受管目录与历史退役归属 | 保留。退役名字必须进墓碑，不能只删活动项 |
| `plugin-loader.mjs` | 按仓订阅加载 / 校准受管过程登记 | 读订阅、catalog、项目 settings；写精确受管登记与移除；宿主随后读 | 原生 plugin/hook 加载没有本仓精确迁移规则 | 保留。#2945 已修；保留第三方混组和合法 shell / exec 命令形式 |
| `pretool.mjs` | 工具前执行本仓安全、派工、资源与写码边界 | 读工具 JSON、capacity、ledger、主线等；输出 deny / rewrite / context；派工路径写 ledger | 宿主 permissions 是底层授权，不含本仓跨工具业务政策 | 保留。不能因原生 steer 新增就删安全规则 |
| `pretool-agy.mjs` | Antigravity 工具入口翻译 | vendor schema → 公共判断 → 原协议响应；无独立业务账 | 原生事件负责触发，字段并不与 Claude 一致 | 保留。camelCase 等翻译单独核，不复制业务规则 |
| `pretool-codex.mjs` | Codex 工具入口翻译 | 终端 / 工具 schema → 公共判断 → Codex 响应；受管 home 登记由同步维护 | Codex 独立事件与信任配置不能用 Claude 登记替代 | 保留。#2958 对共享 hooks 链接的修复需按真实布局验收 |
| `pretool-gemini.mjs` | Gemini BeforeTool 入口翻译 | 多文件 / 毫秒等字段归一后调用公共判断；无独立账 | 原生 BeforeTool 不替代策略 | 保留。未知协议不能默许通过 |
| `pretool-kimi.mjs` | Kimi 工具入口翻译 | 秒级 timeout / read 路径等归一后调用公共判断；无独立账 | 原生事件不替代策略 | 保留。保持 vendor 差异，不全量套 Claude 字段 |
| `prompt-log.mjs` | UserPromptSubmit 独立原文留痕 | 按日追加本地 `prompt-log` JSONL，按 promptId 去重；诊断 / 血缘读取 | 原生 transcript 已有另一份历史，但本入口可记录宿主收取时点 | 暂留。只证明宿主收取，不能证明模型看到；不额外输出、不阻塞，不把失败写成成功 |
| `proxy-env.mjs` | 给 CLI 注入既有本机回退代理环境 | 读本机 fallback-proxy；幂等追加 `CLAUDE_ENV_FILE`；后续 CLI 子进程读取 | 宿主一般环境继承不负责本机特定回退 | 保留。无需改账号或全局设置；公开文档不抄具体地址 / 端口 |
| `queue-stop.mjs` | 收轮检查可接队列、容量及无人值守限制，安排统计 | 读 queue / capacity / unattended；写本 sid queue 计数、统计 stamp 与 background run 状态 / 回执；Stop / stats 读 | 宿主 Stop 仅给拦截点，不知道本仓排队业务 | 保留。#2965 已修真正脱离、环境传递与 stats 失败重试：成功后 6h 限频，运行中不重起，失败 1min 后可重试 |
| `redact.mjs` | 共享敏感值遮盖 | 纯处理命令行 / JSON 敏感字段；redact-secrets 等读返回值 | 宿主权限不替代公开输出脱敏 | 保留。明确非所有编码和展开形式的完整识别器 |
| `redact-secrets.mjs` | 管道 / 文件脱敏命令入口 | 读输入，调用 redact，只输出处理后文本；不另存原文账 | 原生 CLI 无本仓统一展示接口 | 保留。输入读不到明确报错 |
| `repo-contract.mjs` | 检查并补齐仓库命令和约定入口 | 读 `agents/repo-contract.json` 与仓文件；init 只补缺；写每日提醒 stamp；session-start / 检查读 | 宿主不提供各仓契约 | 保留。不能以宿主有 AGENTS 支持代替命令与文件检查 |
| `secret-shape.mjs` | 安全查看 JSON / env 结构而不打印值 | 只读指定输入，输出字段类型 / 长度等结构；不存原值 | 原生读工具可能直接泄露完整值 | 保留。读取失败显式失败，结构输出不等于密钥内容 |
| `session-start.mjs` | 常规开场约定、临时调整、引导认主、进度 / PR / 工作树与同步 | 读仓与 Fleet 状态，写同步 / session-net / bgcache；recentPrompts 仅列同血缘旧号实际 prompt-log 历史 | SessionStart 提供触发，业务仍由本仓维护 | 保留 60 分钟/每条200/总3000字封顶、当前号排除及来源失败诊断；不推断未投递，不写 seen |
| `shell-edit.mjs` | 解析命令的仓文件写入边界，区分临时文件与实际代码 | 纯命令 / 路径判断，pretool 读取；无独立持久账 | 宿主 shell 授权粒度不足以覆盖本仓边界 | 保留。临时文件仍走 `_tmp/` |
| `stop.mjs` | 正常 Stop 执行无人值守续轮、进展与外部工人收尾 | 读本 sid unattended、同步完成结果、queue；输出 block / 理由；消费本 sid 的 receipts | 原生 Stop block 是续轮原语，业务条件仍需本模块 | 保留。machine / subagent / headless 跳过；不能照搬到无决策控制的 StopFailure |
| `subagent-ledger.mjs` | 记录 Haiku 派工、返工等护栏 | pretool 追加 ledger JSONL；stats 产 policy / stamp；pretool 读 policy | 原生 Agent 存在不包含成本 / 返工分档政策 | 保留。模型档由已有约定决定，本轮不改 |
| `sync-source.mjs` | 从受管 origin/main 准备同步源 | 读专用检出与锁；更新专用 origin-main，脏树先备份再重建；同步 / bootstrap 读 | git 不自动定义正确同步源和锁边界 | 保留。不能拿开发工作树当安装源，不改用户开发树 |
| `unattended.mjs` | 管本 sid 无人值守状态、进展与防空转上限 | 写 session 独立 unattended JSON / progress receipts；on/off/done/needs-you/paused；Stop 消费 | 原生自动继续 / goal 不等于本仓授权与上限 | 保留。无进展 3 次、总轮 200、最长 12h；不借别 sid 状态，不由进展入口自动 on |
| `vendor-pretool.mjs` | 共用 vendor 翻译及公共策略调用 | 工具 payload → 公共 pretool → vendor 响应；无独立账 | 原生事件名称相同不代表字段相同 | 保留。未知 schema 拒绝，不在各入口复制政策 |
| `work-watch.mjs` | Stop 后等 pnpm work run 外部工人终态并叫醒派它的主会话 | 读 work-runs 的 spec / state / result / beatAt；写 watch 锁与独占 reported；stderr + exit 2；session-id 纯校验 | 原生 Agent 完成通知不覆盖脱离的 work-supervisor 进程 | 保留；唯一 asyncRewake 过程钩子，不参与创始人消息投递 |
| `continuation-progress.mjs` | PostToolUse 给无人值守记真实工具进展 | 成功工具结果 → 本 sid progress receipt；Stop 读取 | 原生 PostToolUse 仅提供事件，不决定何为本仓进展 | 保留。不自动开启无人值守；machine / subagent 跳过 |
| `continuation-results.mjs` | 正常收尾同步读取本 dispatcher 的外部工人完成结果 | 读 work-runs spec / state / result；终态 hash 形成消费 key；stop 使用 | 原生 Agent 通知不能替代外部 work-run 文件合同 | 保留。是同步完成读取，不再造消息轮询投递账 |
| `continuation-start.mjs` | Codex SessionStart 给当前 sid 续轮状态 | 仅读本 sid unattended 状态并输出上下文；不改别家的设置 | Codex 原生 SessionStart 提供入口，业务仍需本模块 | 保留。与 Claude session-start 不可全量混用 |

`background-launch.mjs` 原件只在 `agents/hooks` 一处；agents-sync 从 `agents/local-sessions/detach.mjs` 同步生成 `_detach.mjs` 运行依赖副本，不是第二份业务原件。#2965 已合，根代理 / 独立审计已核真实已安装后台入口：WMI success 留 done，exit 7 留 failed；包内回归另核受限 PATH 下绝对 taskkill、超时与只结束自己子树。不能把该成功扩成所有外部会话生命周期都已验收。

## 三个 Agent 角色

| 角色 | 目的、约束与输出 | 写存读链 | 原生替代与判断 |
|---|---|---|---|
| `Explore` | `claude-haiku-5-5`、medium、maxTurns 30、omitClaudeMd；查证与只读证据；禁止 Edit / Write / NotebookEdit | `agents/subagents` 原件经 agents-sync 装本机，adapters 转引擎 `--agents`；宿主读定义，主代理读产出 | 保留。原生同名角色不等于此模型 / 权限 / 证据合同 |
| `general-purpose` | `claude-sonnet-5-5`、medium、maxTurns 200；可写代码与交付 | 同一份原件双路安装 / 转换，子代理写工作树与交付，父代理审结果 | 保留。默认开 PR 即汇报；明确交代等 CI 或跟到合并时持续跟进，消除绝对不等 CI 的冲突 |
| `Plan` | `claude-opus-5-5`、high、maxTurns 60；方案与评审；同样禁止直接编辑工具 | 原件经同步 / 转换，宿主读；父代理读计划与风险 | 保留。原生计划模式不自动携带本仓模型 / 角色合同 |

Explore / Plan 未列 tools allowlist，省略 tools 时仍继承 Bash / PowerShell / MCP 等能力；“只读”是职责和禁直接编辑约束，不是 OS 沙箱。本轮无真实越权证据，不顺手删合法检索 / 测试工具；严格只读应另单定义。maxTurns 触顶也不表示任务完成。角色模型、权限或分档不属于 #2954 范围。

## #2954 精确实现边界

实际在役 Mirasim 0.0.545 的忙时单条、连续4条（重复短文/包含关系）及WS重连、精确自有CLI异常后的held恢复均有模型处理链独验。local/cloud共用活动user转送路径，补话hook也不能修平台额度拒绝，因此不再增加“必须cloud成功一次”的门槛；两次cloud429继续保留红。

1. main-thread 只执行原生引导先回规则和后台恢复诊断，不比较投递差集。
2. inbox-watch 已退役，活动目录与项目 Stop 混组中移除，墓碑精确清受管登记；第三方同名/额外参数/shell拼接不动。
3. session-start.recentPrompts 只列实际旧号历史，保留血缘、时间/字数边界和明确来源诊断。
4. inbox-tick、inbox-watch、steer-shown 源码退役；后台恢复迁到 background-recovery，纯校验迁到 session-id。旧用户状态文件不主动删除，旧 tick 状态只复用 backgroundRestartKey，不把 at/seen 当模型已读。
5. prompt-log 独立留痕；安全、容量、同步、Stop、无人值守、队列、进展和外部工人通知保留。不新建消息轮询或第二套可靠投递账。

旧实现的问题是返回hook输出前便写已见账，且turns当前轮未落盘，不能用缺行或旧at证明丢失/处理。现从必经入口去除这条推断与重注入链。

StopFailure 不能直接挂普通 stop：官方定义它为 API 错误结束，且没有 decision control。普通 stop 的 block / 进展消费 / 完成消费不能原样搬过去，否则会记“接续”但宿主不续。若真实失败用例需要，另做失败诊断 / 未完成状态，不消费 completion，也不假设 asyncRewake 在该组合上有效。跨宿主 teardown 的后台工作生命周期另验。

低优先项不扩大本单：session-start 的 plainRun 在本基线仍只有定义无调用，后续清理归 #2937；纯 node 过程入口可另片评估 exec 减 shell；bootstrap / session-start 合并要先有重复耗时证据；prompt-log 日文件去重成本尚未证明是主阻塞。

## 本机原生 schema 与 installed 探针

Claude CLI 2.1.302 本轮忙时输入的真实保存形式：

- `attachment.type=queued_command`，有 `prompt`、`source_uuid`、`delivery_id`、`timestamp`。v2 逐条核 `source_uuid == input.uuid` 且 `prompt === 完整输入`，每 UUID 恰一次且顺序严格递增；相同 short / longer 包含 short / 再次相同 short 分别以不同 UUID 核对，不以子串计数。
- `api-request-blob.message.role=system` 保存原生 mid-turn 封装中的完整原文；后续 `api-request.tail` 引用 blob hash，`assistant.requestRef` 引用 request.id，且请求时间早于精确回答时间。独立核这条模型请求链，不把回答文本冒充入站证据。
- 实机首条 assistant tool_use 有 `user_message_uuid` / `user_message_uuids`，本轮 folded 回答没有；类型定义支持该字段不代表每条实际 frame 都有，不据缺失推断丢送。
- 每例在看到本次 fixture 的 busy-start 后才发 steer；fixture 6 秒，真实 Bash timeout 至少 30 秒且前台，工具结果必须包含完成标记、无转后台文本。
- busy 用新 nonce 精确反转；sequence 输出完整三个原文数据与 fresh nonce 反转；resume 两个真实进程同 sid，核历史 seed 原文与旧新双 nonce 精确反转。strict 输出格式与语义分别记，strict=false 从不改绿。
- 三例均核真实已安装 release 路径 / migration sourceHash / binaryHash / `--fleet-version`，不是临时 probe.exe。原 6 配置前后 hash 不变，隔离复制凭据 finally 清理。安全 schema 只含自造测试结构 / UUID 与时间；受限原始日志不进入公开稿。

这三例只证明当前 installed launcher 的本地 stream transport。若要声称真实 cloud 成功，仍须新会话WS入口、同sid忙时原文、模型处理与真实viaRelay账本同时成立；当前没有此成功证据。accepted、steerTaken、prompt-log、CLI replay 各自只是中间证据，单独均不能代表模型已处理。

真实 cloud 本轮只新建一个独立工作区会话，没有重发、切账号、改 route 总开关或充值；两次平台模型请求都因 `credit_exhausted_30d` 被拒，没有成功模型调用。初版 cloud 探针把 record.createdAt 误当数值而拒认归属，后续只读核回 ISO 时间 / 精确 workdir / 同 sid，修正解析但未再发针，旧红保留。本次 `.claude.json` hash 变化，其他五个观察文件不变；精确 after 副本未找到，且该文件后来再次变化，不能归因同期写者，不能套用本地三例“原配置不变”的结论。原始证据留本机受限目录，公开仅留结构与结论。

## 在役宿主真实恢复证据

在役 0.0.545 与已安装 launcher→reclaude→Claude 路径，连续4条与WS重连的23项独验通过；重复短文和包含关系按不同UUID核完整正文、顺序及模型请求链，不以子串ACK作证。

异常恢复 v7e 单次实测27831ms：仅终止经句柄与血缘核实的自有CLI叶子，19项守卫通过；前置2744ms、最终guard到终止38ms，保持4000/500ms上限。一次原生 resumeQueue(discard:false)，精确actualHeldRef的两条一致outbox.dispatched回执去重一次，绑定新task；同native SID完整169行严格解析，恢复正文canonical SHA256→requestRef→唯一严格答案，fresh绑定task自然done且队列空。raw manifest SHA256为 0ce7b6b778930ccdfbe1fe5d4a122a3d9ed33a1660ecf4556ea97999bbfea479，76文件hash由根和独审重核；不以事后snapshot补造dispatch。仅证明本轮恢复正文的canonical链，历史opaque bodies未全解析。

5个关键配置hash不变，.claude.json运行期缓存/档案字段变化，账号身份稳定；不能称全部配置未变。旧红探针保留：v7d在resume后197ms误认旧task终态提前退出，后来产品自然恢复不能补绿旧轮；v7e只修等待新绑定task的验收状态机，不放宽身份/时间护栏。受限原始日志与授权封存不上传公开仓。0.0.553仍只限制品与局部回放，未实机验收。

## 0.0.553 证据与不能推导的结论

最初现场在役产物实际为 0.0.545；闲置 app/state 中的其他版本号不等于正在运行版本。核查时官方 stable 是 0.0.547、预发布是 0.0.553；只下载校验并定点解包，没有安装、升级或重启 Mirasim。

| 对象 | 完整性或范围 |
|---|---|
| 0.0.553 payload | SHA256 `a92e0b025ace067f6957aead965f983f69d2ad22129e3824cd5761236d92d842` |
| 0.0.553 server | SHA256 `24b90bfbe1cb607a6d9305a128788792cd4fd7e9d2050ebf3cbd2a72f3aa4fea` |
| 0.0.553 tracker class | 字符区间 564828..565898；SHA256 `8e25daabeb900426fb17159a2ae5a10a6751a32071addf55c12b2ac42e34913b` |
| 0.0.547 server | SHA256 `7ed3a5487fbfb68f51b55901daf09270fccc746d8a4f2ac13799b1c253206088` |
| REA 整包分析 | 30 秒 timeout，只取得 partial inventory；不是整包语义完成。Evidence `ev_7f239542d2b72e00ab7799a4f434cf2624c54275afdaccc15b5fa64c7a2c251b` |
| 定点 tracker 回放 | 只提取 class，在无 fs / network / process 的 VM 回放；未执行 bundle bootstrap |

547 / 553 该局部回放一致：当前 assistant 不清 owed；result 后下一 assistant 可在没有 user replay 时清 owed；longer replay 包含 short 时可能清 short；两份相同文本一次 replay 仅清一份。该证据支持 accepted / taken 不能证明模型处理，不能推断新版整体消息链均坏，也不能声称已真人端到端实测 553。

旧临时 launcher 探针曾以随机反转证明模型处理，但字面 ACK 多空格，strict=false 保留 false；它不是实际安装验收。当前 v2 真 installed 探针补足了本地 launcher 的实证，仍不能替代 cloud 路由入口。

## 验收状态与待补

| 项目 | 状态与边界 |
|---|---|
| 现行模块 / 三角色职责审计 | 当前 35 个模块逐项覆盖；退役投递模块不计入 |
| 精确登记与退役墓碑 | #2945 已合，不能重复列未修 |
| Claude 正常 Stop 同 session 自动续轮 | 已有真实 2.1.302 隔离 phase1 → phase2 → done 证据；不扩成所有失败 / vendor 组合均通过 |
| Codex 共享 hooks 布局 | #2958 已合；真实安装 readback 以根代理证据为准 |
| Windows 背景生命周期 | #2965 已合；真实安装 WMI success / exit7 回执已核，生成 _detach 依赖已说明 |
| installed 本地 stream busy / sequence / resume | v2 三例全通过；旧 v1 两例 false 保留 |
| 真实 Mirasim cloud 忙时 steer / 计费来源 | 已执行但红：两次真实模型请求 viaRelay:true / HTTP429 / credit_exhausted_30d，fixture 未启动；无 retryAt，不声称cloud成功，也不再增加撤层门槛 |
| 图文帧、权限 / control 未结束、主线程死亡后的完成交付 | 不以本轮三个文本探针代替，按实际需求另列验收，不作已通过承诺 |
| #2954 代码撤除 | 本实现撤重复投递三模块；相关业务回归和完整CI通过后交付，不因此关闭全量审计母项 #2937 |

## 公开参考

- [Claude hooks](https://code.claude.com/docs/en/hooks)：事件 / exec / Stop / StopFailure / async 生命周期；现行文档不保证本机所有旧版本都有同样能力。
- [Claude subagents](https://code.claude.com/docs/en/sub-agents)：tools 省略时继承，disallowedTools 只移除所列工具；不把职责指令叫 OS 沙箱。
- [Mirasim reference](https://mirasim.ai/docs/reference)：原生 watch、queue steer 等入口；cloud 使用平台额度、local 使用自有账号，不自动互相 fallback；没有承诺 accepted 就等于模型处理。
- [Claude mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)：API 允许把忙时终端用户输入作为 mid-turn system 消息；该通用说明不独自证明本机 CLI 行为，CLI 结论以前述真实 schema 为据。

公开稿只保留测试结构、结论、哈希和公开资料。受限凭据、私网 / 网关 URL、个人聊天与原始运行日志均不随审计稿提交。
