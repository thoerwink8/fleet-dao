# Mirasim 自有 / 平台切换与 macOS：调研及修复方案

日期：2026-10-02（北京时间）。状态：调研及建议，尚未实现、未部署。基线：fleet-dao `dfd604f8`；实际封装源码：ai-gateway-stack `d36945db205048e1a00e92e4b370d7722f512abd`。

用户要求：「Mirasim 切换【自有】【平台】，不会生效，【平台】额度走的还是 reclaude；还有个问题就是这个也需要支持 mac，分析并解决，调研完先给方案。」本轮没有切启动命令、切账号或停止用户正在运行的会话。

## 结论

**主因是绕过网关的决定只做一次，却被用于可以反复切换额度来源、复用 Claude 进程的会话。** 自有启动时，封装剥掉 Mirasim 网关参数。之后按钮改成平台，Mirasim 的路由记录变了，但这个进程仍保持被剥过的启动参数，下一回合仍可走 reclaude。已用本机安装的二进制和假子进程复现，不需要调用模型。

还有一个已复现的缺陷：索引缺失、JSON 损坏、没有匹配的会话键，全被封装归为「未标，按自有」。这把「没查成」变成了允许使用 reclaude 的决定。

**不能把所有平台请求都说成误用了 reclaude。** 本机一个标记 cloud 的会话有 6,448 笔流量记录，全部 `viaRelay=true`、`upstreamHost=relay.mirasim.ai`；另一个 Sonnet 平台会话的 1 笔记录同样走中继。新起的 cloud 进程也在隔离实验中保留了网关参数。进程名叫 reclaude 不能单独证明扣了它的额度。用户这次投诉对应的具体会话和服务端账单未逐笔关联，不能声称已锁定那一笔扣费。

macOS 不需要重写一份语言不同的启动器：原 Go 源码已经能编出 Apple Silicon 与 Intel 两种 Mach-O。缺的是正式维护位置、安装产物、平台进程退出处理及 Mac 实机验收。编译成功不表示 Mac 使用验收通过。

## 业务与必须保留的规则

| 要干成什么 | 怎么验 | 出处 |
| --- | --- | --- |
| 同一会话选自有用 reclaude，选平台用 Mirasim 平台 | 两方向切换之后的下一回合按所选来源发请求 | 用户本轮要求 |
| 不打断正在执行的任务 | 当前回合继续；新来源从下一回合开始；其他会话不被重启 | 本仓接入指南的在途保护、通用段的账号切换禁令 |
| 历史与权限交互接着用 | nativeSessionId 延续；工具结果、用户消息各投递一次；权限回调与取消可用 | Mirasim stream-json 调用方式与原封装透传契约 |
| 读取错误不能变成「自有」 | 造坏 JSON、缺文件、歧义映射时，在发请求前明确报错 | AGENTS.md 通用段「底线」 |
| Claude 启动仍经 reclaude | 平台保留 Mirasim 完整注入，并核对最终流量；不通过切 reclaude 账号控制路由 | AGENTS.md 通用段「我的机器与模型」 |
| 其他模型走它们原有接入 | Kimi、DeepSeek 等经 Claude 执行体运行时仍保留 Mirasim 网关参数 | 原 route.go 的非 Claude 模型分支 |
| Mac 与 Windows 使用同一套业务逻辑 | 三种构建目标共用路由、参数、回合状态逻辑；平台差异只在安装与进程收尾 | 用户本轮要求、已验证的跨编译结果 |
| stdout 只用于协议帧 | 日志不混入 Mirasim 读取的 stream-json；日志没有令牌值 | 原 main.go 的透传契约、公开仓卫生规则 |

业务要求不意味着必须沿用「启动时扫描所有索引，找不到就自有」「无条件等待唯一子进程」「非 Windows 清理为空」这些实现方式。

## 证据与断链

本机 Mirasim 为 `0.0.393`。实际命令是 `~/.local/bin/reclaude-mirasim.exe`，不是用户口述次序的 mirasim-reclaude.exe。`go version -m` 读到构建源码版本 `d36945db`，与存档仓 `origin/master` 一致。fleet-dao 只有 [接入指南](reclaude-in-mirasim.md)，代码仍在已退役的 ai-gateway-stack：[main.go](https://github.com/thoerwink8/ai-gateway-stack/blob/d36945db205048e1a00e92e4b370d7722f512abd/deploy/reclaude-mirasim/main.go)、[route.go](https://github.com/thoerwink8/ai-gateway-stack/blob/d36945db205048e1a00e92e4b370d7722f512abd/deploy/reclaude-mirasim/route.go)。

| 环节 | 实际行为 | 断点 |
| --- | --- | --- |
| 写方：Mirasim `setSessionRoute` | 修改会话的 routeOverrides，持久化 routes，通知会话列表及终端重选路 | 聊天进程没有在这里直接重启 |
| 存放处：plugin-index | `routes["claude:<Mirasim ID>"]` 为 local/cloud；本机本轮共 320 条：cloud 291、local 29 | 命令行使用 native ID；不能当同一 ID 直接匹配 |
| 读方：封装 `shouldStrip` | main.go 启动时读一次，按结果重写 args/env，然后一直透传 stdin/stdout | 自有已绕开 Mirasim 网关；网关内动态选路触及不到它 |
| 读方的失败分支 | 索引读不到、坏 JSON 被跳过；最后空值默认为自有 | 没查成被当成可用的路由决定 |
| 报警方：启动日志及测试 | 每次启动记一条判法；没有逐回合实际来源记录 | 现有测试默认「缺索引应为空、未标应自有」，且不测一个进程内切换 |

Mirasim 安装包后端 `resources/server.cjs` 的 `RCn` 为聊天进程组装 `--input-format stream-json`；复用签名 `QCn` 包括工作目录、模型、effort、额外参数与环境，没有独立的 route 字段。`setSessionRoute` 会更新原生网关的选路状态，但现有封装剥掉参数后，请求不再经过那个网关。

### 隔离实验

目标设置为本地假程序，不启动真实 reclaude、不调用付费模型。运行的封装是本机实际安装的二进制。

| 用例 | 实际结果 |
| --- | --- |
| local 启动，随后把 routes 改为 cloud，再发送下一条 stdin | 子进程 PID 不变；启动 settings 与进程 env 中网关地址仍被剥掉 |
| 重新启动一个 cloud 进程 | Mirasim 注入的网关地址与认证字段仍在 |
| 索引坏 JSON | 记成「route 未标」，剥网关，仍启动子进程 |
| 索引目录里没有索引文件 | 同上 |
| 索引可读，但找不到该会话键 | 同上 |

原 Go 测试 `go test -count=1 -v .` 的 11 个顶层测试全通过；这证明现有测试看不见此次切换问题，不能拿它们通过宣称接入正常。诊断脚本与纯假数据结果放在本调研工作树 `_tmp/`，没有加入源代码。

### 同根范围

此次修复应一起覆盖 Windows、macOS，以及已有 Linux 路径；新会话、resume、fork、continue；多工作目录索引；路由缺失与读取失败的区别；settings 文件读写失败；同一原生 ID 可能匹配多个 Mirasim 会话时的歧义。本机目前未发现重复 native ID，不能把它说成本次已触发原因。

还发现指南关于 reclaude 的配置形态已过时：本机用户 settings 是 HTTP(S)_PROXY、CA 和 NO_PROXY，已不是文档描述的 BASE_URL/OAuth。换成原版 Claude 或只改进程 env，都不自动等于隔离了 reclaude 的用户 settings。落地时要一并更新指南。

## 建议方案

**建议把这一接入迁入 fleet-dao 正式维护，改成在回合边界重新确认来源，来源变化时仅重建该会话的执行进程。** 不增加外部服务，也不增加脱离会话单独运行的后台监控。

1. **路由只认 Mirasim 的当前选择。** 明确 local 才允许剥掉网关注入并使用 reclaude。明确 cloud 完整保留 Mirasim 的网关地址、认证与必要参数。有效索引中确实没有指定路由时，保留 Mirasim 的默认路径，不再自己把它解释成自有；索引读失败、身份映射不唯一或格式不认识，则报明确错误。限定当前工作目录的索引并核对 Mirasim ID/native ID，不能遍历多个索引取第一个就当准。
2. **把切换放在下一回合发出前。** 聊天流按协议的 result 识别当前回合结束，在下一个 user 帧转发之前重新读来源。变了就先结束旧的空闲子进程，用新来源的 args/env 恢复同一个 nativeSessionId，再交给它下一条输入。当前回合不改来源；旧子进程尚未退出、新进程握手不成，都不能继续发送或换另一份额度兜底。一次性调用仍只需在启动时确认。
3. **保留原始注入，正确恢复协议。** 必须保存未剥过的 args/env，切回平台时从它们重建，不能用上一次剥过的结果。重起需要重新完成 SDK 初始化、权限钩子与控制消息握手，处理 request ID 对应关系；已经执行的用户消息、工具结果不得重放。只有历史已保存且 native ID 已确认才恢复。若 Mirasim 网关或令牌已失效，明确退回给调用方重建，不能复用旧地址继续尝试别的额度来源。
4. **保持平台的现有启动契约，验最终流量。** 此方案继续由 reclaude 拉起真实 Claude；平台完全保留 Mirasim 注入，最终请求走 Mirasim 网关与平台中继。这样不用改变「Claude 一律经 reclaude 起」的规矩。需要在 Windows 与 Mac 的集成验收里确认平台 host/ledger、两条额度来源、取消与权限交互；不能仅以启动日志的 cloud 字样作为验收。平台直起原版 Claude 是比较方案，涉及用户级代理、CA、凭据和启动规矩的例外，不能简单换 exe 并声称解决。
5. **Mac 正式交付。** 共用 Go 核心；产物为 windows/amd64、darwin/arm64、darwin/amd64。安装选对架构、设置执行权限、保存绝对启动路径，GUI 启动不依赖终端 PATH；目标 Mac 不必装 Go。Windows 保留整树 Job 清理；Mac/Linux 专门处理信号、退出与子进程回收，在取消、退出 Mirasim、异常退出时测试。安装时检测在途回合、等待空闲，不重启整台 Mirasim。
6. **诊断能看见错。** 启动/回合切换日志只记录会话 ID、路由来源、目标程序、版本与失败原因，不记录凭据，不占用 stdout。离线 doctor 明确报告「读失败」「未指定」「local」「cloud」，不把程序存在或二进制可编译当成整条接入已验证。

这不是给旧的 shouldStrip 再加一个兜底 if，也不是单加文件 watcher。要修的是「一份会变化的会话选择，如何在下一次真实请求前进入执行进程」；watcher 只能辅助，回合发送处才是必须经过的落点。

## 对照、代价与删层选择

查询日期均为 2026-10-02。来源独立于本仓的旧实现。

| 来源中的标准做法 | 对本方案的约束 |
| --- | --- |
| [Claude Code settings 的优先级](https://code.claude.com/docs/en/settings)：命令行 settings 可覆盖用户及项目配置 | 保留 Mirasim 注入，并逐项核对它与用户代理设置的组合；不修改所有会话共用的用户配置 |
| [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)：支持 stream-json 输入和按 ID resume | 在协议回合边界重新启动与恢复；单独验证 SDK 初始化、权限、历史与重复投递 |
| [reclaude 的安装说明](https://docs.reclaude.ai/en/cli/install)：支持 Apple Silicon/Intel Mac，并提供对应二进制 | 不要求用户切平台或更换供应商；补封装的两个 Darwin 产物与安装路径 |
| [Go 的信号行为](https://pkg.go.dev/os/signal)：Unix 信号与子进程继承需要明确处理 | 旧的 signal.Ignore(os.Interrupt) 加空 job_other 不能代替 Mac 退出测试 |

| 方案 | 代价与风险 | 判断 |
| --- | --- | --- |
| 在真实回合边界接入来源变化（建议） | 需要管理子进程恢复、SDK 控制消息与请求 ID；要三平台测试；切换需要一次进程重建等待 | 能满足用户继续用同一按钮切换、下一回合生效 |
| 只修索引与 ID，继续一次性启动，每次切换要求人手动重启 | 工作较少；每次切换增加人工动作、容易忘记，旧进程问题仍在 | 可作为短期人工办法，不能算此需求做完 |
| 删掉整个封装，全部回到 Mirasim 原生网关 | 少一层；目前自有经 Mirasim 转发会遇到已记录的 reclaude non_cc_client；需上游提供兼容接入或原生生命周期扩展 | 当前缺所需上游能力，不能满足自有走 reclaude；不伪装客户端、不改闭源安装包 |

## 验收与尚未验证

最重要的验收是两方向的真实请求归属，而不是 exe 名字：自有 → 平台、平台 → 自有、回合运行中切换后下一回合生效；同一会话历史保留，其他会话不动。

实施时必须先用假进程造出此次失败，再覆盖：坏/缺索引；不认识的路由；工作目录冲突、两套 ID、fork/resume；临时 settings 读写失败；平台网关/令牌失效；快速连点；后台续发；SDK 初始化、工具权限回复、取消与 EOF；子进程异常退出和整树收尾。失败时发出请求的数量应为 0，不静默换另一额度来源。

本轮已验证：安装二进制与源码版本相符；5 类离线启动/切换实验；原 Go 的 11 个顶层测试；未修改源码的 Darwin 两架构编译与 Mach-O 头。**未验证：修复后的任何运行行为、Mac 实机启动/切换/退出、投诉那笔请求的服务端额度归属。** 不将本轮可编译的旧 Mac 二进制作为修复版分发。

## 不同模型复核的实际状态

按 discuss 尝试了 5 次不同模型复核，**没有拿到有效独立结论**：第一轮 reclaude 同步配置失败后换 DeepSeek，未在预算内完成；第二轮 DeepSeek 返回 `no upstream available`；第三轮 Kimi 超时；第四轮 Grok 经 Mirasim 超时；第五次改走本机 Grok 命令行仍退出失败。没有把超时、失败或未结束的文本算成审过，也不声称模型间已达成一致。

因此，以上是有源码和隔离实验支撑的建议草案；实施前仍需证明回合重起、SDK 控制消息与权限恢复这部分设计可行，不能把本轮方案或旧源码的测试通过当成修复完成。本轮到交付调研与建议为止，没有开启实现或发布。
