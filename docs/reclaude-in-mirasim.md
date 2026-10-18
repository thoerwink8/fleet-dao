# Mirasim 自有 / 平台接入与旧安装迁移

Windows 和 macOS 的接入由本仓 `packages/mirasim-reclaude` 维护。旧 `reclaude-mirasim.exe` 的一次启动判路已被替代，装机和升级不再依赖退役的 ai-gateway-stack。批准范围见 [决定 0012](decisions/0012-mirasim-routing-and-migration.md)，验证状态看 [进度](PROGRESS.md)。

## 0. 判据：什么样才算接上了

新启动器在空闲后的新回合发出前读取当前会话路由。明确 `local` 使用 reclaude 自有额度；`cloud` 保留 Mirasim 的网关注入，使用平台中继。切换发生在当前回合结束、权限、控制请求与后台任务处理完以后，只重建该会话的执行进程，通过 `--resume` 保留原生会话。运行中以及尚有未决任务时收到的用户引导，完整、按序送给当前执行体，不等待回合结束、不重选路、不重启；执行体异常退出明确报错，不自动重放引导。SDK 恢复仍先完成初始化和控制状态重放，再发用户消息；透传成功只证明 CLI 收到，模型何时处理由 CLI 的消息边界决定。

送达回执：Mirasim 给可引导的会话带 `--replay-user-messages`，Claude Code 真正读进一条用户消息时回显同内容、`isReplay=true` 的 user 帧。Mirasim 显示的「已引导」只表示写进了管道，不等于送到，所以启动器给每条转出去的用户消息记账、见回显销账：没销账的不算空闲，不重选路、不重启执行体（免得 CLI 队列里的消息随旧进程丢掉），后续消息照常交给当前执行体；空闲时（主回合已结束，哪怕后台任务还在跑）转出去 60 秒既没回显也没任何输出，判卡住，给 Mirasim 回一个报错 result，让它当场显示「没送到、请重发」，不无声挂着；10 分钟仍没回显的不再挡路由，只记日志。没带这个参数的会话不记账，行为照旧。

回显对上是哪一条，不按子串，一次回显最多销一条：转出的 user 帧和回显都带 `uuid` 就只按 `uuid` 相等对（`uuid` 不同即使正文一样也不是同一条）；否则按正文精确相等，两边都只有 text（字符串或全是 text 块），各自只去首尾空白后逐字相等，同正文多条时销最早一条，回显多了前后缀、只是包含都不算。带图片等非 text 块或正文为空、又没有 `uuid` 的消息无法判定是哪一条，仍保留未确认责任（日志 `event=user-identity-unknown retained=true`），保护当前执行体直到原有 10 分钟过期边界；空闲时转出且始终没有任何输出，仍按原有 60 秒规则明确报错。不用空正文或不匹配回显销账，也不自动重放；这类消息是否送到，启动器判断不了，不能据此判它已被消费并提前换进程。启动器不假定 CLI 一定回显 `uuid`，转出的帧没带就只走正文规则。

两种来源要分别看证据：

- 自有：启动器记录 `route=local`，Claude 实际经 reclaude 发请求；Mirasim 账本可能没有这笔用量，不能拿账本空白当成功。
- 平台：下一回合的计费模型请求在 `~/.mirasim/traffic/<Mirasim 会话 ID>/index-*.ndjson` 中为 `viaRelay=true`，实际上游是平台中继。进程名叫 reclaude、日志写 `cloud` 都不能单独证明额度来源。
- 读路由失败、ID 映射歧义、未知路由值、平台网关注入缺失时明确失败，不回落到另一份额度。

`--fleet-doctor` 只核 reclaude 目标程序，不启动模型、不验证账号或扣费。

## 1. 原理：为什么需要会话启动器

Mirasim 给会话注入平台网关时，把本地网关地址和认证字段写进 `--settings <文件或 JSON>` 的 env 块；启动器也认进程环境里的网关，以防别的版本这么传。启动器两处都看：会话没单独选路由（跟随全局档位）时，有回环网关加令牌就是平台、原样保留，没有就走自有。旧封装只在启动时剥掉自有会话的注入，复用进程时没有重新选路，切回平台后仍可能使用自有额度。

新版保存原始 args/env；明确自有才在安全副本中剥掉 Mirasim 回环网关的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`。切回平台从原始参数恢复，重新完成 SDK 初始化与控制状态恢复；已经执行的用户消息和工具结果不重放。用户级 reclaude 配置保持由 reclaude 管理，不假定它一直是某一种代理或认证形态。

Claude 两种来源都经 reclaude 拉起。有效索引没有该会话 override 时保留 Mirasim 默认网关；索引缺失和坏 JSON 不能被当成「没有 override」。

Mirasim 自己也会决定给不给网关（读 0.0.498 的 `server.cjs` 查到）：`~/.claude/settings.json` 的 env 里有任一改模型的键（`CLAUDE_CODE_SUBAGENT_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`），又有 reclaude 写的指向回环的 `HTTPS_PROXY` 加 `NODE_EXTRA_CA_CERTS`，又设了 claude 启动命令，它就判 claude 被拦截（`via=intercept`），不给跟随全局的会话注入平台网关；启动器拿不到网关只能走自有，界面显示「平台」实际花自有额度。所以装了启动器的机器上同步工具不写子代理默认模型键、已有的删掉，子代理默认模型改在 Mirasim 设置里管（[决定 0092](decisions/0092-no-subagent-model-env-on-launcher-desktops.md)）。

## 2. 做法：三种桌面产物

Go 核心共用，GitHub Actions 在 Windows、Intel Mac、Apple Silicon Mac 和 Linux 上分别运行协议/生命周期测试并构建本机产物。Windows 用 Job 回收子孙；Mac/Linux 用会话监管进程和进程组回收。监管进程随会话结束退出，不是新的常驻服务。

安装保存绝对路径；查找 reclaude 的顺序为程序同目录、用户 `~/.local/bin`、Windows 安装目录、PATH，也可指定 `RECLAUDE_MIRASIM_TARGET`。Mac GUI 不需要靠终端先改 PATH；reclaude 仍须已安装并登录。

## 3. 装 / 查 / 撤

已有旧封装的桌面机：正常开新 AI 会话时，同步钩子取得主线后，`agents-sync --apply` 会自动安排迁移。忙时隐藏后台任务等空闲，不终止在途回合；再次同步不重复安排。没有 Mirasim、自定义启动命令、Linux 均跳过自动桌面迁移。

也可以在 fleet-dao 检出里主动执行一条命令：

```bash
pnpm agents:sync                   # 取得最新主线并自动安排旧封装迁移
pnpm mirasim:migrate               # 当前检出的迁移器：等空闲、迁移、回读确认
pnpm mirasim:migrate --check       # 只读：已是当前新版 0；被改回裸 claude 75；从没装过 75；另列单会话启动命令覆盖，有会话覆盖成裸 claude 也 75
pnpm mirasim:migrate --rollback    # 等空闲，恢复迁移前的命令与参数
pnpm mirasim:audit [--days N]      # 只读对账，见 3.2
```

Node 须为 22.22 或以上。目标机器无需安装 Go：有 Go 时从本仓编译；没有时用已登录的 `gh` 下载主线成功工作流中与源码匹配的构建，核对 manifest、架构、SHA-256 和版本。构建不存在、下载/校验失败或目标 reclaude 不可用都明确报错，不把旧文件或自报版本当作新版。

迁移通过 Mirasim 的本地认证 WS `setAgentLaunch` 更新，从 `listClis` 返回的 `clis[].launch` 回读启动命令/参数，再核磁盘配置；`getConfig` 只返回功能设置，不含启动命令，不能拿它的缺字段当默认 claude。默认使用连续空闲确认：此 API 会重建 Claude driver，所以首次迁移等待所有在途 Claude 回合结束。Mirasim 未运行则后台等待它启动；最长等 6 小时，到期明确记 `expired`，后续同步可以重新安排。

磁盘 `running`/`queued` 始终等待；坏记录或缺 `record.json` 不直接忽略。只有每个已连接实例的完整全局 `listSessions`（不带筛选或条数限制，关联请求号且 `hasMore:false`）均无该会话、所有 Claude 条目明确已结束，再由各实例的 `subscribe` 基线明确返回 `outbox` 的 `baseline:true,noRun:true,items:[]`，才认作历史残留。`noRun` 是原生同时查过内存与 IO 运行态后的明确结果；仅没有 snapshot 回包不算。原生列表不完整、字段损坏、仍有 snapshot、连接失败或超时均继续等待；不删挪历史文件。补核失败后用新连接重查，避免迟到基线被认作下一轮结果。连续两次确认空闲后重新读取当前源码版本进行准备；准备后源码再变仍拒绝切换。

状态保存在 `~/.fleet-dao/mirasim-reclaude/`：

- `migration.json`：迁移前命令/参数、源码和二进制校验，不复制账号或令牌。
- `worker.json`：后台 PID、等待/完成/失败状态；等待时另有 `idleState`（`busy`/`unknown`）、具体 `detail` 和 `checkedAt` 核对时间。Windows 的失败详情另见 `worker.err`。
- `releases/<源码 hash>/`：新版产物。旧封装和历史版本保留，撤回不删除会话或账号数据。

主动撤回后，同一源码版本不会被自动同步重新装回；后续新版本或显式 `pnpm mirasim:migrate` 可以再次迁移。

启动命令是 Mirasim 设置里的一个字段，人在界面改、Mirasim 升级、升级失败提示都可能把它改掉。开会话同步会核一次：迁移记录是 `migrated`、当前命令却是裸 `claude`/`claude.exe`/空，就判为被改掉了（drift）。**只发现、不自动装回**，不改 Mirasim 设置：`migrate --auto` 打一行「Mirasim 的 claude 启动命令被改回了裸 claude（不经 reclaude，会话全走平台额度）。要恢复：pnpm mirasim:migrate；确定不用：pnpm mirasim:migrate --rollback；排查看 docs/reclaude-in-mirasim.md「排查」一节」并退出 76，`agents-sync` 把它写成一条 `✗` 漂移，开会话钩子带进会话上下文。改成别的自定义命令不算被改掉；主动撤回过（`restored`）静默跳过。

直接用 `node packages/mirasim-reclaude/bin/migrate` 也能运行，专用同步检出无需安装 `node_modules`。`--no-wait` 只尝试当前空闲状态，没完成退出 75；错误退出 1，不能把等待当迁移成功。

### 3.1 预热、测速记录与 reclaude 更新

桌面机（非 Linux、装了 reclaude）每次开会话同步，`agents-sync --apply` 会后台脱离起一个 `packages/mirasim-reclaude/bin/health --sync`，不等它、失败只写日志、不让同步失败：

- 预热：每次都跑 `reclaude daemon --detach`（幂等），让 daemon 在 Mirasim 用之前已经热好。
- 测速：距上次满 6 小时才跑 `reclaude config gateway test`，连同 `reclaude status` 里正在用的 `gateway_url` 和 `gateway_healthy`，追加一行 JSON（`at`、`platform`、`current`、`healthy`、`results[]`）到 `~/.fleet-dao/mirasim-reclaude/gateway-test.jsonl`，超 1MB 截掉旧的一半。线路始终是 reclaude 的 auto 模式，这里不设线路。
- 更新：同样每 6 小时 `reclaude update --check`，结果记在 `reclaude-update.json`。有新版时，只有 Mirasim 没有在途 Claude 回合（沿用迁移的空闲判断，读 `~/.mirasim/sessions/claude/*/record.json`）才跑 `reclaude update`，更新不压在 Mirasim 启动路径上；有在途回合或判不了空闲只记「有新版待装」，下一轮再试。
- 所有子进程带超时（测速 15 秒、update 5 分钟、其余 10 秒）；超时、起不来、输出认不出都记「没查成」，不当正常。只调 reclaude 命令，不读 reclaude 的设备密钥目录。
- 节流时间在 `health-state.json`，运行日志在 `health.log`（同目录，同样超 1MB 截半）。

看现状：

```bash
pnpm mirasim:health          # 只读汇总：daemon、当前线路及最近测速、各线路最近 5 次中位数、reclaude 版本和有无新版、上次检查时间
pnpm mirasim:health --run    # 现在就预热、测速、检查更新（空闲才装）再汇总
```

### 3.2 排查：额度走错了怎么查、怎么修

另一台机器上贴这一句：

```text
Mirasim 额度可能走错了，根据文档排查
```

听到这句就只照这一节做，在那台机器的 fleet-dao 仓根目录跑，不另写一套。三条命令都只读，可以随便跑；要改设置的修法只用下表里那一条，跑之前先确认没有在途回合要紧（迁移器自己会等空闲，不打断回合）。

症状：说好走自有却扣了平台额度，或说好走平台却没有平台账；开会话上下文里有「启动命令被改回了裸 claude」；reclaude 慢或连不上。

1. `pnpm mirasim:migrate --check`：启动命令现状。
2. `pnpm mirasim:audit`（默认近 3 天，`--days N` 改）：先打启动命令现状，再每条近期有回合的会话一行：会话 ID 前 8 位、最近回合时间、Mirasim 设的路由、启动器每次拉起的 `route/gateway` 及次数、账本里 `/v1/messages` 的平台中继和直连计数。只打这些，不打请求内容、提示词、令牌。
3. `pnpm mirasim:health`：reclaude 自己的状况（daemon、线路测速、版本），见 3.1。

| 看到 | 意思 | 在那台机器上怎么修 |
|---|---|---|
| `--check` 退出 0「已经是当前新版」 | 启动命令没问题 | 不用修，接着看 audit |
| `--check` 退出 75「被改回了裸 claude」，或 audit 顶行同样说 | 装过新版启动器，后来启动命令被改掉，所有会话绕过 reclaude 走平台 | 要恢复：`pnpm mirasim:migrate`；确定不用：`pnpm mirasim:migrate --rollback` |
| `--check` 退出 75「还没装过新版启动器」 | 从没装过（裸 claude 或旧封装） | `pnpm mirasim:migrate` |
| `--check` 退出 75「装的是旧版启动器」 | 新版没装上 | `pnpm mirasim:migrate` |
| audit 标红 (c) 有回合但启动器没有拉起记录 | 启动器被绕过；通常和上面「被改回裸 claude」同时出现 | 同「被改回裸 claude」那一行 |
| audit 标红 (b) 启动器选了自有，账本里却有平台中继账 | 剥网关没生效，自有会话扣了平台额度 | 先 `pnpm mirasim:migrate` 装到当前版本再看；仍红就把 audit 那几行和 `launch.log` 里对应会话的 `event=launch`/`event=reject` 行贴到单上，不在机器上手改 |
| 额度来源显示平台（跟随全局），audit 里 launch 行 `route=default gateway=none`、账本无 relay | `~/.claude/settings.json` 的 env 里有改模型的键（`CLAUDE_CODE_SUBAGENT_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`），Mirasim 判 claude 被拦截、不注入平台网关（见第 1 节） | `pnpm agents:sync`（新版同步会删 `CLAUDE_CODE_SUBAGENT_MODEL`）；别的改模型的键同步不碰，手动从 env 里删掉；重开会话生效 |
| audit 标红 (a) 启动器选了平台，回合里却没有平台中继账 | 平台会话没走平台（或回合根本没发出请求） | 看那条会话在 Mirasim 里是不是报错的回合；不是就同 (b) 贴单 |
| 退出 2「没查成」 | 日志、路由索引、会话或账本读不到或有坏行 | 按报出的文件修读权限或等写完再跑；没查成不等于没事 |
| `mirasim:health` 线路不健康、daemon 没起 | reclaude 自己的问题，额度来源没错 | `pnpm mirasim:health --run`；网络坏了看下面 |

audit 的判断：启动器日志里 `gateway=kept` 按平台、`gateway=stripped` 按自有；旧版启动器没有这个词时按 `route=cloud`/`route=local`。早于日志最早一行的回合不判 (c)（日志满 1MB 会清空重写）。有标红退出 1。

网络坏了怎么办：

- 只是某个会话：在 Mirasim 里把这个会话切到「平台」，下一回合生效。
- 整台临时不走 reclaude：`pnpm mirasim:migrate --rollback`，好了再 `pnpm mirasim:migrate`。注意它恢复的是迁移前那条命令；迁移前若是旧封装 `reclaude-mirasim`，仍经 reclaude，这种机器只能逐会话切「平台」。
- 不要在 Mirasim 设置里删启动命令：删了没人知道，开会话同步会一直报「被改回了裸 claude」。

## 4. 服务器（Linux）与 Fleet

法国维持两个明确入口：自有 Claude 直接由 reclaude 起，无头 Mirasim 固定 `cloud`。账号池、渠道切换与额度耗尽后的任务接续由 Fleet/Temporal 控制；不默认安装桌面混合来源启动器。自动迁移入口在 Linux 明确跳过。

Fleet 接收 Mirasim 的平台成功结果前核账本：至少有计费模型请求的 2xx，成功模型调用全部为 `viaRelay=true`。成功直连/混合来源拒绝平台成功入账；坏行、缺来源字段或读失败返回「没查成」。本地 `messages/count_tokens` 与 `v1/models` 辅助请求不能证明模型成功，也不误判成串账。

该修改没有发布法国配置、开启引擎或改变账号切换规则。

## 5. 已知边界

切换不改变正在运行的回合，下一回合才应用；自有起的进程里没有平台网关时当场切平台做不到，启动器退回该消息并明说原因和办法（日志 `event=refuse-switch`），不杀会话、不悄悄仍走自有；第一次从旧安装迁移仍要等所有 Claude 回合空闲。平台令牌/网关失效后由调用方重新建立接入，不用自有额度兜底。

测试 runner 上的 Mac 协议与进程树验证不等于用户 Mac 的 GUI 接入或服务端账单验收。实际完成程度始终以 PR 和单子评论里的证据为准（2026-10-02 那几节的旧进度原文在 git 历史里）。

诊断日志在 Windows `%LOCALAPPDATA%\reclaude-mirasim\launch.log`、Mac `~/Library/Caches/reclaude-mirasim/launch.log`、Linux `~/.cache/reclaude-mirasim/launch.log`，只记录版本、会话 ID、来源、generation 与失败原因，不记录认证字段，不占 stdout。`event=launch` 行带 `gateway=kept|stripped|none`（保留平台网关 / 剥掉走自有 / 参数里本来没有），只记这个词，不记网关地址和令牌。

- 不带会话参数的调用（如 Mirasim 的用量探测 `get_usage`）没有用户可选的路由，按 Mirasim 的注入原样交出（`route=gateway`）。
- Mirasim 回收空闲进程发停止信号：优雅停掉执行体、退出 0，记 `event=stopped`。
- 每条用户消息转给执行体记 `event=user-forward path=turn|active idle=… len=… unacked=…`（`turn`＝空闲时开新回合，`active`＝运行中或有未决任务时直接透传），回显到了记 `event=user-ack ms=…`（对不上任何一条记 `event=user-ack-unmatched`），判卡住记 `event=user-stalled`，10 分钟没回执记 `event=user-unacked-expired`，执行体退出、被停、换掉时还有没销账的记 `event=user-unacked reason=exit|stopped|switch n=…`。只记长度和毫秒数，不记内容。查「已引导却没收到」：Mirasim 那一刻发了消息而日志里没有 `user-forward`，是 Mirasim 没发出来；有 `user-forward` 没 `user-ack`，是 CLI 没读进。测试用 `RECLAUDE_MIRASIM_DELIVERY_STALL_MS` 缩短卡住判定。
- 切路由只在实际结果变了（保留网关↔剥掉）才重建执行进程；default(保留)↔cloud、default(无网关)↔local 不重启。
- 索引说 `local`、Mirasim 却注入了带令牌的回环网关（这个进程第一次选路时）：隔 300ms 重读索引最多 3 次，仍矛盾按索引执行并记 `event=route-conflict`。Mirasim「这一回合由空间/远程作者付」的判定只在它内存里，落盘的 `turnPayers` 是调用发生后才记的账，启动器回合开始前读不到，所以这种回合仍按索引走。
- 读索引和 `record.json`：Windows 上用放开删除共享的句柄、读完立刻关；这只是必要条件，旧 rename 语义的 Windows 上启动器读文件那一瞬间 Mirasim 的覆盖仍会失败（Mirasim 失败即丢弃这次写入），窗口很短；撞上共享冲突或读到半截 JSON 隔 50ms 重读最多 3 次。先直接读本会话的 `record.json`，对不上才扫全部，无关会话的坏记录不挡新会话。多个索引时按 Mirasim 的命名（服务端工作区根目录路径的 base64url）和索引 `keys` 里的登记找会话所属索引。

## 6. Mirasim 提示「Claude Code 升级失败」

现象：设置里 `cli.claude.minVersion` 比 reclaude 背后那份 claude 新，Mirasim 想升级，提示写「claude runs from …\mirasim-reclaude.exe, pinned by the launch command in Settings → Agents → Claude, and that copy is still 〈版本〉」（#1669，Windows、Mirasim v0.0.454）。

结论：Mirasim 按启动命令找 claude，不按 PATH。下面是读 Mirasim 服务端 0.0.425 的 `server.cjs` 查到的，提示原文和截图一致：

- 找哪份：设置里填了启动命令（迁移后就是本启动器），就用它；没填才按 PATH 找 `claude`。
- 探版本：跑「启动命令 `--version`」，取 stdout 第一行里的版本号，限时 5 秒（升级后最后复核一次 45 秒）。
- 升级：启动命令被钉住时，不跑 npm，只试两步：先跑「启动命令 `update`」，再跑 Claude 官方安装脚本（Windows 是 `irm https://claude.ai/install.ps1 | iex`）。之后再探一次启动命令的版本，没变就报上面那条失败。
- 官方安装脚本另装一份 claude，reclaude 不用它，所以这一步动不了版本。

启动器的做法：`--version` 和 `update` 都原样交给 reclaude，不截、不改（`launcher/main.go`，测试 `TestMirasimVersionProbeAndSelfUpdateReachReclaudeUnchanged`）。

- Mirasim 看到的版本，就是 reclaude 背后那份 claude 的真实版本。
- Mirasim 的「升级」，实际跑的就是 `reclaude update`。

怎么升级：走 reclaude 自己的升级命令 `reclaude update`。reclaude 跑哪份 claude 由 reclaude 定：配置目录里 `claude.path` 写的那份，或 reclaude 自带的 CLI。自带的 CLI 手换会被 reclaude 覆盖回去（[adapters 参考](reference/adapters.md) CC-13）。

- reclaude 还没发到 `minVersion` 那一版时，`reclaude update` 后版本不变，Mirasim 照样报这条失败。这时只能等 reclaude 出新版。
- 不要照提示清掉启动命令：清了就不经 reclaude，自有额度没有了。
- 不要拿装了另一份 claude 冒充升级成功。
