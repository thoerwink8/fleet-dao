# CLI 无人值守接续

无人值守有五个独立环节：CLI 支持 → 钩子登记 → 信任/启用 → Stop 真执行 → 下一轮实际消费完成结果。`on` 只记录本会话意图，不证明后四层已通；读不到必须报「没查成」。状态按真实会话号隔离，机器工人、子代理、无头引擎不拦；off、done、needs-you 保留。

显式 off 写本会话停止记录，优先于队列收轮对账，不允许队列把用户说停的会话再次拉起；重新 on 才清除停止记录。从未开启无人值守、也未明确 off 的会话仍按原队列规则对账。停止记录读失败明说故障，不反过来拉起队列。

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

依据：[Claude hooks](https://code.claude.com/docs/en/hooks) 定义同步 Stop、后台任务字段及 asyncRewake，连续 block 八次上限由工具调用重置；[Codex hooks](https://learn.chatgpt.com/docs/hooks) 定义 Stop block 自动创建提示、信任要求，以及 async 完成在闲置时不能启动新轮。采用各 CLI 的原生同步协议，不扩大次数掩盖断链。
