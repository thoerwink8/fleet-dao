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

执行证据（#3247）：既有 Stop、SessionStart、PostToolUse 和开关命令将白名单回执写入本机无人值守目录的 `.receipts/`。每次 on 使用独立 generation，旧窗口和晚到事件仍归原窗口；缺 generation 的历史身份未知，不用时间猜。按会话指纹分文件，只追加、不轮转覆盖，每份上限 2MiB、单行 2KiB；读写同以4096行为上限，拒绝继续追加后保留可读历史。跨会话最多128份日志，新文件准入在独立单次目录锁内核对，单次遍历最多258个目录项；满额不新增、不删除历史，已有日志仍可追加。满额、坏行、半行、锁未释放、目录/文件链接或非普通文件明确未知，不拿空当没有执行。写入只抢一次锁、不等待；写后关闭或解锁失败也报未知，日志句柄未能确认关闭时保留锁供读回报错，不改变钩子原决策；POSIX 新目录/文件权限为700/600，Windows权限沿宿主ACL，不把chmod当访问控制保证。回执只存时间、事件、阶段、白名单原因和身份/结果指纹，不存正文、工具参数、环境值、成果原文或原始异常。

`pnpm exec node agents/hooks/unattended.mjs status --receipts` 只读当前会话、当前窗口证据；没有证据或读失败退出1并写unknown。它不检查宿主内存中的已加载清单，静态登记/信任仍须另读，on也不代表安装验证。prepared只表示准备输出，emitted只表示stdout写回调成功，不表示宿主收到。Codex按真实session、generation和Stop turn_id与不同新turn_id关联实际工具事件；子代理钩子共用parent session_id，缺agent_id不能证明根，所以只记来源未证的新回合事件。Claude这两个事件未提供可用共同turn_id时明确未知。子代理、缺身份、同轮工具、其他会话或窗口均不能凑成根接续；结果去重的deliveredResults仍只表示已准备投递，不是消费证明。本版本没有可证的模型ack，根续轮和结果消费保留unknown，不说模型理解或验收完成。隔离回归不代替安装后自然收轮的现场核验；网关切断、Interrupt或进程退出也不由Stop保证恢复。

依据：[Claude hooks](https://code.claude.com/docs/en/hooks) 定义同步 Stop、后台任务字段及 asyncRewake，连续 block 八次上限由工具调用重置；[Codex hooks](https://learn.chatgpt.com/docs/hooks) 定义 Stop block 自动创建提示、信任要求，以及 async 完成在闲置时不能启动新轮。采用各 CLI 的原生同步协议，不扩大次数掩盖断链。

Codex 宿主的钩子进程可能没有终端 CODEX_THREAD_ID / CODEX_SESSION_ID。专用登记入口（continuation-start、continuation-progress-codex、stop-codex）明确家族后，只用本次事件 session_id 选来源；存在环境号时仍要求一致。直接 on 不借事件号或其他会话兜底，Claude 共有入口不因存在 CODEX_HOME 就切换家族。可信 agent_id 在共用 SessionStart 的快慢实现及内部无人值守提示全链透传；子代理开场不读创始人队列。prompt-log 不把子提示记成创始人历史，work-watch 不读父派工、不claim reported、不请求rewake；两者不新增 Codex 登记。

来源读取在目录遍历、文件打开前、fd打开后和首行读完后核对后代目录与文件的非链接类型、realpath 包含关系及 dev/ino，目录换链接、文件换代均明确未知。Node 当前接口不提供本次路径遍历的原子 openat 合同；这些前后身份核验不声称能抵御本地恶意攻击者的 ABA 替换，也不作为根续轮或结果消费证明。
