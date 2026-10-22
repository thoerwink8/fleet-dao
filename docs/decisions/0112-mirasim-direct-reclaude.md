# 0112 Mirasim 的 claude 启动命令直接填 reclaude，退役 Go 启动器、迁移器和对账（部分取代 0012）

- 索引状态：生效
- 日期：2026-10-22（北京时间）
- 谁拍的：创始人在对话里说的（原话见下）。改标准（`agents/config/claude-permissions.json`、`packages/agents-sync` 的判据），按决定 0097 自己落、事后报。
- 状态：采纳。
- 取代：0012 里「桌面 Windows / macOS 用本仓启动器重新选路、旧安装随同步自动迁移」那部分（第 1、2 条的桌面实现，以及 `packages/mirasim-reclaude` 里的 Go 启动器、迁移器 `pnpm mirasim:migrate`、对账 `pnpm mirasim:audit`、reclaude 预热测速 `pnpm mirasim:health`）。0012 里法国 Linux 直接 reclaude、无头 Mirasim 固定 cloud 那条不变。
- 关联：决定 0092 依然有效，判据 `isLauncherCommand` 扩到 `reclaude`、`reclaude.exe`（旧启动器的名字也留着，还没换的机器仍在用）；`packages/agents-sync/src/mirasim-launch.ts`；`docs/reclaude-in-mirasim.md`。

## 原话

```
我觉得很简单做法，我在另一台机器试了下，mirasim的claude code cli的启动方式改成reclaude，就正常了；说明完全可以退役？所以你把钩子 + 包装器全删掉，是不是可以简化
```

## 实测（2026-10-22，本机 Mirasim 0.0.576）

把全局 claude 启动命令设成 `C:\Users\Administrator\.local\bin\reclaude.exe`（经 `ui-cli call setAgentLaunch`），跑了三个真实回合：

- **自有（route=local）**：进程链 `Mirasim.exe → reclaude.exe → claude.exe`，Mirasim 没往进程里注入网关，计费记录里没有这条会话（自有会话不进 Mirasim 账本）。
- **同一会话切到平台（route=cloud）**：Mirasim 自己重起进程（新的 reclaude pid），账本 `POST /v1/messages viaRelay=True status=200`。
- **新会话跟随全局**：账本 `viaRelay=True status=200`。
- **Mirasim 探版本**：`listClis` 里 claude 一行 `installed:true, path=…\reclaude.exe, version="2.1.307 (Claude Code)"`；`reclaude --version` 的 stdout 只有这一行。
- **Mirasim 的单会话启动覆盖**（`setSessionLaunch` / plugin-index 的 `launches`）只用于终端窗格（`openTui`），不影响 SDK 回合。

旧启动器自己的日志 `%LOCALAPPDATA%\reclaude-mirasim\launch.log` 的统计：自 10-18 起记 gateway 词以来，24 次 local 启动全是 `gateway=none`（Mirasim 本来就不给自有会话注入网关），`gateway=stripped` 0 次；全部 660 次启动 `generation=1`，从没在进程内重建过（切路由一直是 Mirasim 自己重起进程）。就是说启动器的核心工作——剥网关、进程内切路由——在 Mirasim 0.0.576 上已是空转。

## 决定

1. **退役**：整个 `packages/mirasim-reclaude` 删掉（Go 启动器、迁移器、对账、单会话覆盖检查、reclaude-health 预热/测速/更新、worker/锁、bin、测试），连同它的 CI 工作流、`pnpm mirasim:migrate|health|audit`、自测里的 Go 路径、conventions 的边界名单和耗时表项。不写新的迁移器和对账。
2. **怎么用**：Mirasim 设置 → Agents → Claude 的启动命令填 reclaude 的绝对路径。自有 / 平台按会话选，由 Mirasim 自己做。步骤和注意事项在 `docs/reclaude-in-mirasim.md`。
3. **`agents-sync` 不再管 Mirasim**：开会话同步里调迁移、漂移提示、reclaude 后台预热的代码和测试全删，包依赖一并去掉。只留 0092 的判据，名单加 `reclaude`、`reclaude.exe`：Mirasim 设了任何 claude 启动命令、env 里又有改模型的键，就会判 claude 被拦截、不给跟随全局的会话注入平台网关；填 reclaude 和填旧启动器是同一种情况。
4. **还在用旧启动器的机器**：照文档手改启动命令即可，旧的 Go 文件留在原处不再维护。

## 取舍（失去的东西）

- **cloud 缺网关时的拒发兜底没了**：旧启动器在「Mirasim 说 cloud 却没给网关」时拒绝发请求（日志里 3 次，最近一次 10-12）。去掉后这种回合会走 reclaude 自有额度，不会多花新钱，只是界面显示「平台」而实际是自有。
- **Windows Job 回收子孙进程没了**：旧启动器用 Job 对象在会话结束时回收子进程；直接用 reclaude 后靠 reclaude 和 Mirasim 自己收。
- **自动迁移和漂移提醒没了**：启动命令被改回裸 claude（Mirasim 升级、人在界面清掉）不再有人提醒，也没有 `--rollback`；改成人手改启动命令代替。对账命令没了，查额度走向直接看 Mirasim 账本（`~/.mirasim/traffic/<会话>/index-*.ndjson` 的 `viaRelay`）。
- 这些都是在 Mirasim 0.0.576 上实测够用才删的；以后 Mirasim 改了注入网关的行为，再按那时的实测重新定。

## 没做的

- 没改 Mirasim 本身，也没动任何机器上的 `~/.mirasim` 设置：本机的启动命令是指挥官另行切的。
- 没动 `~/.fleet-dao/mirasim-reclaude/` 下旧状态文件（迁移记录、releases、日志）：删了找不回的东西不替人删，机器上可自行清理。
