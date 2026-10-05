# Mirasim 自有 / 平台接入与旧安装迁移

Windows 和 macOS 的接入由本仓 `packages/mirasim-reclaude` 维护。旧 `reclaude-mirasim.exe` 的一次启动判路已被替代，装机和升级不再依赖退役的 ai-gateway-stack。批准范围见 [决定 0012](decisions/0012-mirasim-routing-and-migration.md)，验证状态看 [进度](PROGRESS.md)。

## 0. 判据：什么样才算接上了

新启动器在下一条用户输入发出前读取当前会话路由。明确 `local` 使用 reclaude 自有额度；`cloud` 保留 Mirasim 的网关注入，使用平台中继。切换发生在当前回合结束、权限与后台任务处理完以后，只重建该会话的执行进程，通过 `--resume` 保留原生会话。

两种来源要分别看证据：

- 自有：启动器记录 `route=local`，Claude 实际经 reclaude 发请求；Mirasim 账本可能没有这笔用量，不能拿账本空白当成功。
- 平台：下一回合的计费模型请求在 `~/.mirasim/traffic/<Mirasim 会话 ID>/index-*.ndjson` 中为 `viaRelay=true`，实际上游是平台中继。进程名叫 reclaude、日志写 `cloud` 都不能单独证明额度来源。
- 读路由失败、ID 映射歧义、未知路由值、平台网关注入缺失时明确失败，不回落到另一份额度。

`--fleet-doctor` 只核 reclaude 目标程序，不启动模型、不验证账号或扣费。

## 1. 原理：为什么需要会话启动器

Mirasim 用 `--settings <文件或 JSON>` 把本地网关地址和认证字段交给 Claude。旧封装只在启动时剥掉自有会话的注入，复用进程时没有重新选路，切回平台后仍可能使用自有额度。

新版保存原始 args/env；明确自有才在安全副本中剥掉 Mirasim 回环网关的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`。切回平台从原始参数恢复，重新完成 SDK 初始化与控制状态恢复；已经执行的用户消息和工具结果不重放。用户级 reclaude 配置保持由 reclaude 管理，不假定它一直是某一种代理或认证形态。

Claude 两种来源都经 reclaude 拉起。有效索引没有该会话 override 时保留 Mirasim 默认网关；索引缺失和坏 JSON 不能被当成「没有 override」。

## 2. 做法：三种桌面产物

Go 核心共用，GitHub Actions 在 Windows、Intel Mac、Apple Silicon Mac 和 Linux 上分别运行协议/生命周期测试并构建本机产物。Windows 用 Job 回收子孙；Mac/Linux 用会话监管进程和进程组回收。监管进程随会话结束退出，不是新的常驻服务。

安装保存绝对路径；查找 reclaude 的顺序为程序同目录、用户 `~/.local/bin`、Windows 安装目录、PATH，也可指定 `RECLAUDE_MIRASIM_TARGET`。Mac GUI 不需要靠终端先改 PATH；reclaude 仍须已安装并登录。

## 3. 装 / 查 / 撤

已有旧封装的桌面机：正常开新 AI 会话时，同步钩子取得主线后，`agents-sync --apply` 会自动安排迁移。忙时隐藏后台任务等空闲，不终止在途回合；再次同步不重复安排。没有 Mirasim、自定义启动命令、Linux 均跳过自动桌面迁移。

也可以在 fleet-dao 检出里主动执行一条命令：

```bash
pnpm agents:sync                   # 取得最新主线并自动安排旧封装迁移
pnpm mirasim:migrate               # 当前检出的迁移器：等空闲、迁移、回读确认
pnpm mirasim:migrate --check       # 只读，未迁移/未确认退出 75
pnpm mirasim:migrate --rollback    # 等空闲，恢复迁移前的命令与参数
```

Node 须为 22.22 或以上。目标机器无需安装 Go：有 Go 时从本仓编译；没有时用已登录的 `gh` 下载主线成功工作流中与源码匹配的构建，核对 manifest、架构、SHA-256 和版本。构建不存在、下载/校验失败或目标 reclaude 不可用都明确报错，不把旧文件或自报版本当作新版。

迁移通过 Mirasim 的本地认证 WS `setAgentLaunch` 更新，从 `listClis` 返回的 `clis[].launch` 回读启动命令/参数，再核磁盘配置；`getConfig` 只返回功能设置，不含启动命令，不能拿它的缺字段当默认 claude。默认使用连续空闲确认：此 API 会重建 Claude driver，所以首次迁移等待所有在途 Claude 回合结束。Mirasim 未运行则后台等待它启动；最长等 6 小时，到期明确记 `expired`，后续同步可以重新安排。

状态保存在 `~/.fleet-dao/mirasim-reclaude/`：

- `migration.json`：迁移前命令/参数、源码和二进制校验，不复制账号或令牌。
- `worker.json`：后台 PID、等待/完成/失败状态；Windows 的失败详情另见 `worker.err`。
- `releases/<源码 hash>/`：新版产物。旧封装和历史版本保留，撤回不删除会话或账号数据。

主动撤回后，同一源码版本不会被自动同步重新装回；后续新版本或显式 `pnpm mirasim:migrate` 可以再次迁移。

直接用 `node packages/mirasim-reclaude/bin/migrate` 也能运行，专用同步检出无需安装 `node_modules`。`--no-wait` 只尝试当前空闲状态，没完成退出 75；错误退出 1，不能把等待当迁移成功。

## 4. 服务器（Linux）与 Fleet

法国维持两个明确入口：自有 Claude 直接由 reclaude 起，无头 Mirasim 固定 `cloud`。账号池、渠道切换与额度耗尽后的任务接续由 Fleet/Temporal 控制；不默认安装桌面混合来源启动器。自动迁移入口在 Linux 明确跳过。

Fleet 接收 Mirasim 的平台成功结果前核账本：至少有计费模型请求的 2xx，成功模型调用全部为 `viaRelay=true`。成功直连/混合来源拒绝平台成功入账；坏行、缺来源字段或读失败返回「没查成」。本地 `messages/count_tokens` 与 `v1/models` 辅助请求不能证明模型成功，也不误判成串账。

该修改没有发布法国配置、开启引擎或改变账号切换规则。

## 5. 已知边界

切换不改变正在运行的回合，下一回合才应用；自有起的进程里没有平台网关时当场切平台做不到，启动器退回该消息并明说原因和办法（日志 `event=refuse-switch`），不杀会话、不悄悄仍走自有；第一次从旧安装迁移仍要等所有 Claude 回合空闲。平台令牌/网关失效后由调用方重新建立接入，不用自有额度兜底。

测试 runner 上的 Mac 协议与进程树验证不等于用户 Mac 的 GUI 接入或服务端账单验收。实际完成程度始终以 [归档页](archive/progress-2026-10-02.md) 里 2026-10-02 那几节的证据和之后的 PR 为准。

诊断日志在 Windows `%LOCALAPPDATA%\reclaude-mirasim\launch.log`、Mac `~/Library/Caches/reclaude-mirasim/launch.log`、Linux `~/.cache/reclaude-mirasim/launch.log`，只记录版本、会话 ID、来源、generation 与失败原因，不记录认证字段，不占 stdout。
