# CLI 无人值守接续

无人值守有五个独立环节：CLI 支持 → 钩子登记 → 信任/启用 → Stop 真执行 → 下一轮实际消费完成结果。`on` 只记录本会话意图，不证明后四层已通；读不到必须报「没查成」。状态按真实会话号隔离，机器工人、子代理、无头引擎不拦；off、done、needs-you 保留。

显式 off 写本会话停止记录，优先于队列收轮对账，不允许队列把用户说停的会话再次拉起；重新 on 才清除停止记录。从未开启无人值守、也未明确 off 的会话仍按原队列规则对账。停止记录读失败明说故障，不反过来拉起队列。

Codex 原生子代理没有 `FLEET_WORKER` 时，也不能凭继承的旧用户引导开启无人值守。命令入口在任何状态读写前，以当前 `CODEX_THREAD_ID` / `CODEX_SESSION_ID` 定位当前 `CODEX_HOME`（缺省为 `~/.codex`）下唯一精确文件名结尾的 rollout，仅读第一条 `session_meta`。环境号、事件号和 metadata.id 必须一致；`source.subagent.thread_spawn` 的父号与顶层父号必须一致，才认派生会话；已知 `cli` / `vscode` 来源且无父号才准交互路径。子代理拒绝 on 及代改父状态，开场/Stop/PostToolUse 不读父窗口，不追加进展或注入父历史。来源缺失、冲突、新格式或读失败明确 unknown，不借其他会话/home 兜底；Claude 既有会话号路径和 worker/反方拒开保持。

来源读取仅遍历 `sessions/年/月/日` 四层、最多4096目录项，允许受配 `CODEX_HOME/sessions` 根链接到共享正式来源，核其realpath与目录身份读取前后稳定；后代日期目录/rollout文件链接与重复来源仍拒绝。首记录最多1MiB，逐字节在第一个换行停止，不预读后续对话记录。每次本地IO之间检查1秒预算；这不是可中止内核文件IO的硬超时。越界、半行和关闭失败均未知，不保存原始metadata、正文、路径或异常。该结构来自本机当前三份脱敏首记录，根首行约23KiB；它是当前实现证据，不是官方稳定schema保证。来源判定只用于无人值守准入，不能证明hook属于根的新回合、宿主收到续轮或模型消费结果。若宿主对子事件只暴露父号、继承父环境且不提供agent_id，仍缺可证子身份，不能声称本修复已解决该协议边界；安装后自然续轮验收责任仍按 #3247 保留。

| 入口 | 能力与登记 | 完成结果 |
| --- | --- | --- |
| Claude 原生 | 订阅项目的 process 组：同步 Stop、PostToolUse；SessionStart 读回状态；项目/用户 hooks 不得禁用 | 未完成时 Stop 返回 block + reason 续轮；用 TaskOutput 收任务结果。脱离聊天的工人由已有 asyncRewake 叫醒，Stop 也直接读终态并一次性注入续轮 |
| Claude 经 Mirasim | 仍依赖 Claude CLI 的项目钩子；加载器安装、Mirasim 指向的家目录和项目路径需读回 | 同上；网关切断/会话被停止不能靠「后台任务还在」证明叫醒，不能把 Mirasim 界面开关当作验证 |
| Codex 原生 | 用户 hooks.json 登记 SessionStart、PostToolUse、Stop；config.toml 对每条命令的当前哈希逐项信任，保留人关闭的设置 | 同步 Stop 的 block + reason 创建下一轮提示；原生后台任务用等待工具收结果；工人 result.json 按 dispatcher 归属直接注入一次 |
| Codex 经 Mirasim | 同步覆盖默认 `~/.codex` 和已存在的 `~/.mirasim/agent-homes/codex-relay`，每个入口独立登记四事件并在相邻 config.toml 逐项信任；不追任意 CODEX_HOME、不创建未安装入口、拒绝链接越界 | 同上。保留第三方钩子和用户关闭设置；Codex async 钩子完成不会启动新轮，不能登记 Claude asyncRewake 冒充支持 |
| Grok、Devin | 借读 Claude 用户配置不证明支持相同 Stop/唤醒语义；本仓未验证接续能力 | 不登记未经支持的接续事件；不能声称无人值守已接通 |
| Gemini、Antigravity、Kimi、pi、dsh | 现有安全工具钩子/扩展不证明可创建新轮；本仓未验证接续能力 | 不登记未经支持的接续事件；没有 Claude/Codex 真实会话来源时 on 明确失败 |

同步 Stop 不凭 background_tasks 或 session_crons 非空就放行。它把未完成工作交给下一轮，提示用 CLI 的阻塞等待工具收结果，避免模型 sleep 或轮询。工人终态从本机运行记录读，dispatcher 必须匹配本会话；旧 watcher 的 reported 只表示曾发通知，不能代替模型已消费，故同步续轮独立去重。记录读失败明确报错。

防空转仍是连续三次、总共 200 次、最长 12 小时，均不放宽。只有成功 PostToolUse 的新写入、验证、提交或工人结果才算进展，重复相同动作不重置；有进展时可持续跨过多个三轮周期。三次无进展后写 paused 和接续故障，不保持 on 假装正常收尾；错误提示保留未完成状态。检查链路后才重新 on。

隔离回归实际启动 Stop/PostToolUse 脚本，分别按 Claude/Codex 事件协议走六轮写文件、续轮、后台结果消费、重复防护、done/off/needs-you/机器工人放行。它证明仓内协议，不能代替安装后在当前 CLI 的信任清单读回和最小真实续轮探针；真实会话不得被探针打断。

执行证据（#3247、#3299）：既有 Stop、SessionStart、PostToolUse 和开关命令将白名单回执写入本机无人值守目录的 `.receipts/`。每次真实on仍使用独立generation，缺generation明确未知，不补造代次或为了观测重新on。现存v1 `<session指纹>.jsonl`、诊断池和锁原位保留，位置、内容和哈希不变；每份原2MiB、4096行、单行2KiB合同继续用于旧reader/writer。合法完整且恰好4096行仍可读当前窗口历史，另报`capacity: exhausted`、`code: LIMIT`；超限、坏行、半行、锁、链接或非普通文件返回未知。旧历史故障和LIMIT不能因v2可读被改成成功，缺事件不证明没有执行。

未来事件写可替换的v2 `<session指纹>.latest-v2`，每份小于64KiB，不承诺永久逐条历史。根状态保留每类最新事件、最近Stop尝试（entered/prepared/emitted/fault/final分列）、一个最近emitted待关联请求及一组最近关联原证据。prepared不替换旧pending，只有同尝试的emitted可更新；窗口在写前、提交前、提交后均从真实业务状态重读核对。totalBlocks只作原有顺序fence，不更改其业务值；同floor不同attempt无法证明顺序便拒写ORDER_UNKNOWN，旧窗口/低floor/旧尝试和emitted后的迟到prepared不能覆盖。attempt随机指纹仅为身份，不用UUID或时间猜顺序。关联只能在同请求下提升已有证据，普通工具或缺turn不降级；已知替换次数单列，实际漏失量与coverage恒unknown。

current与排他next暂存共用原 `.admission.lock`，仅尝试一次，不等待、重试或清理未知残留。所有v1、锁、v2和替换峰值统一预算：`N_v1 + 2*N_v2 <= 128`，每个v1（含仅锁）预留未来2MiB，每个v2预留两份64KiB，峰值目录项 `2*N_v1 + 2*N_v2 + 1 <= 258`，字节总额不超原256MiB。旧writer先持准入锁时新writer拒绝；v2存在后旧writer新桶因未知后缀安全拒绝，已有v1仍可在原上限内追加，其未来峰值已预留。next遗留、读/写/close/fsync/rename/unlock故障明确未知；正常换generation若恰好发生在next写出与提交之间，也会留下next并持续BUSY，不能据此宣称自动恢复全部观测故障，须保留证据另行处置；未确认关闭的锁不删除，互斥只覆盖遵守共享锁的合作writer，核验时可见的current/next/锁身份变化拒绝；rename后复核current身份，不符明确IO。路径rename不是CAS，末次核验后不遵守锁的外部进程仍可替换路径，不能保证阻止覆盖、回滚或抵御任意恶意换树（包括ABA）。Windows和Linux进程级替换验证不等于跨平台掉电崩溃安全。POSIX目录/文件权限700/600，Windows沿宿主ACL。回执不存正文、工具参数、环境值、成果原文或原始异常。off/过期删除窗口后无法再证明live generation，观测返回WINDOW_UNKNOWN，不阻挡原业务。

`pnpm exec node agents/hooks/unattended.mjs status --receipts` 只读当前会话、当前窗口证据，分列旧历史和 `latestState`；没有证据或读失败退出1并写unknown。合法v1满额历史仍带LIMIT、退出1，即使latestState可读也不把后续覆盖说成完整。新状态明示 `retention: replaceable_latest_state`、可证替换次数和未知漏失；根续轮与消费恒unknown。它不检查宿主内存中的已加载清单，静态登记/信任仍须另读，on也不代表安装验证。prepared只表示准备输出，emitted只表示stdout写回调成功，不表示宿主收到。Codex按真实session、generation和Stop turn_id与不同新turn_id关联实际工具事件；子代理钩子共用parent session_id，缺agent_id不能证明根，所以只记来源未证的新回合事件。Claude这两个事件未提供可用共同turn_id时明确未知。子代理、缺身份、同轮工具、其他会话或窗口均不能凑成根接续；结果去重的deliveredResults仍只表示已准备投递，不是消费证明。本版本没有可证的模型ack，不说模型理解或验收完成。隔离回归不代替安装后自然新窗口核验；没有适用自然样本则保留#3299/#3247现场责任，不制造真实事件。网关切断、Interrupt或进程退出也不由Stop保证恢复。

依据：[Claude hooks](https://code.claude.com/docs/en/hooks) 定义同步 Stop、后台任务字段及 asyncRewake，连续 block 八次上限由工具调用重置；[Codex hooks](https://learn.chatgpt.com/docs/hooks) 定义 Stop block 自动创建提示、信任要求，以及 async 完成在闲置时不能启动新轮。采用各 CLI 的原生同步协议，不扩大次数掩盖断链。

Codex 宿主的钩子进程可能没有终端 CODEX_THREAD_ID / CODEX_SESSION_ID。专用登记入口（continuation-start、continuation-progress-codex、stop-codex）明确家族后，只用本次事件 session_id 选来源；存在环境号时仍要求一致。直接 on 不借事件号或其他会话兜底，Claude 共有入口不因存在 CODEX_HOME 就切换家族。可信 agent_id 在共用 SessionStart 的快慢实现及内部无人值守提示全链透传；子代理开场不读创始人队列。prompt-log 不把子提示记成创始人历史，work-watch 不读父派工、不claim reported、不请求rewake；两者不新增 Codex 登记。

非根容量隔离（#3293、#3299）：入口把既有authority的allowed/machine/unknown传给回执层，不重新推断身份。allowed在v2内严格核session/generation；machine/unknown共用一份可替换v2诊断，保留最新一条、实际authority及事件session/agent/generation指纹。没有判定的catch上下文默认unknown。根/诊断格式不能互认，诊断不追加旧v1池，也不修改父快照或业务状态。池名只是存储键，不替换事件身份，不能作为根执行、下一轮或消费证据。

池使用64个零作保留存储键，它不是任何已知固定session字符串的SHA-256，不提供可构造的合法session原像。根写入若恰好得到该键明确CONFLICT。旧 `<零键>.jsonl`只读保留，新 `<零键>.latest-v2`若已有空文件、根格式或不兼容内容则拒绝，不接管。新池同样占两份64KiB原槽位并受共享总预算、普通文件、链接、锁和关闭失败保护。容量不足或故障只报未知，不改变原钩子决策；不腾旧历史、不恢复v1追加、不重新on或补generation。

有界状态取舍依据：[OpenTelemetry日志SDK](https://opentelemetry.io/docs/specs/otel/logs/sdk/)的有界队列与可观测丢弃、[OpenTelemetry错误处理](https://opentelemetry.io/docs/specs/otel/error-handling/)的遥测故障不破坏业务、[Perfetto缓冲模型](https://perfetto.dev/docs/concepts/buffers)对停止记录和覆盖旧记录的显式区分。这里选择保留不可变v1及有限最新事实，不承诺完整审计历史；可证明替换与无法量化的漏失分开。

来源读取在目录遍历、文件打开前、fd打开后和首行读完后核对后代目录与文件的非链接类型、realpath 包含关系及 dev/ino，目录换链接、文件换代均明确未知。Node 当前接口不提供本次路径遍历的原子 openat 合同；这些前后身份核验不声称能抵御本地恶意攻击者的 ABA 替换，也不作为根续轮或结果消费证明。
