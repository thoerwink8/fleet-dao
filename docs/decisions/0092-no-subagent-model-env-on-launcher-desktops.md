# 0092 装了 mirasim-reclaude 启动器的桌面机，同步不再往 ~/.claude/settings.json 写子代理默认模型（部分取代 0034 第 6 条）

- 索引状态：生效
- 被取代：0119（第 6 条）
- 日期：2026-10-14 15:20（北京时间）
- 谁拍的：创始人在对话里选方案 A（原话在下面）。改标准，引入它的 PR 合并即生效。
- 状态：采纳。
- 后续：决定 0112 退役了启动器，本条依然有效，判据 `isLauncherCommand` 扩到 `reclaude`、`reclaude.exe`（下面「哪类机器」按这个读；迁移器 `isManagedLaunch` 已随包删除）。
- 取代：决定 0034 第 6 条里「设置里写子代理默认模型（`CLAUDE_CODE_SUBAGENT_MODEL`），由同步工具写到每台机器」那一半——装了启动器的桌面机除外。默认值只许 Opus 或 Sonnet、源文件照旧写这一项、别的机器照旧写，都不变。
- 关联：`packages/agents-sync/src/permissions.ts`（`launcherDesktop`、`DROP_WHY`）、`packages/agents-sync/src/mirasim-launch.ts`（`isLauncherCommand`，和迁移器 `packages/mirasim-reclaude/src/migrate.ts` 的 `isManagedLaunch` 各一份，`packages/agents-sync/test/mirasim-launch.test.ts` 钉两份一致；同步工具是开会话必经的零安装一步，不 import 别的包的文件）、`agents/config/claude-permissions.json`、`docs/reclaude-in-mirasim.md` 第 1 节和 3.2 排查、`docs/agents-permissions.md`「子代理默认模型」。

## 原话

```
2026-10-14 15:20（北京时间），创始人在对话里选：A

方案 A：装了启动器的桌面机，同步工具不再往 ~/.claude/settings.json 写 CLAUDE_CODE_SUBAGENT_MODEL，子代理默认模型改由 Mirasim 设置里的子代理模型管。这样 Mirasim 就不会误判，跟随全局就按全局档位走。
```

## 背景

Mirasim（读 0.0.498 的 `server.cjs` 查到）判一个 CLI 是不是被拦截：读 `~/.claude/settings.json`，三件同时成立就判 claude 为 `via=intercept`——

1. `env` 里有任一「改模型的键」：`CLAUDE_CODE_SUBAGENT_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`；
2. `env` 里有指向回环的 `HTTPS_PROXY` 加 `NODE_EXTRA_CA_CERTS`（reclaude 写的）；
3. Mirasim 设了 claude 的启动命令（mirasim-reclaude 启动器）。

判成 intercept 后，没单独选额度来源（跟随全局）的会话不会被注入平台网关。启动器看到没有网关，只能走自有：界面显示「平台」，实际经 reclaude 花自有额度。

本机端到端核过：带着 `CLAUDE_CODE_SUBAGENT_MODEL` 时，跟随全局的会话启动器日志 `gateway=none`、账本没有 relay；临时删掉这个键，同一路径变成 `gateway=kept`、`viaRelay=true`。

第 1 条里的 `CLAUDE_CODE_SUBAGENT_MODEL` 正是同步工具按 0034 第 6 条写进每台机器的。

## 决定

1. **哪类机器**：不是 Linux，且 `~/.mirasim/setting.json` 的 `agentLaunch.claude.command` 的文件名是 `mirasim-reclaude`、`mirasim-reclaude.exe`、`reclaude-mirasim`、`reclaude-mirasim.exe` 之一（和迁移器同一个判据 `isManagedLaunch`）。
2. **这类机器上**：同步工具不写 `env.CLAUDE_CODE_SUBAGENT_MODEL`；已经在的，**不论值是什么都删**（Mirasim 只看有没有这个键，任何值都会触发误判），删时报一行人话说明删了什么、为什么。`--check` 见到键还在报漂移。
3. **子代理默认模型在这类机器上改由 Mirasim 设置里的子代理模型管。** 三个角色 `Explore`、`general-purpose`、`Plan` 的定义钉了完整型号（0087），本来就不靠这个变量；它只兜住没写类型、自定义又没写模型的子代理。
4. **别的机器不变**：没装启动器的桌面机、Linux、法国照旧写，每次覆盖。
5. **读不成按不是这类机器处理**：`~/.mirasim/setting.json` 读不了、不是 JSON、启动命令不是字符串，照写这个键，报告里说「没查成」，不报错、不中断同步。没有这个文件、没设启动命令就是没装，不多说。
6. （已被决定 0119 取代：`env` 里钉死模型别名的键同步一律算漂移、先备份再删，见 `0119-no-model-pins-in-settings-env.md`。原文：）**只管这一个键**：`env` 里别的改模型的键不是同步工具写的，不碰（3.2 排查里写了手动删）；`permissions`、`autoMode` 不动，两个数组带 `"$defaults"` 的规矩照旧。

## 没做的

- 没让同步工具删别的改模型的键：那些是人自己写的，删了可能改掉他想要的行为；排查一节写清症状和手动修法。
- 没改 Mirasim 本身的判据：那是 Mirasim 的代码，不在本仓。
