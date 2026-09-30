# 各家 AI 的权限怎么同步

一份意图，各家一个翻译：仓里 `agents/config/claude-permissions.json` 写「日常放行什么、禁掉什么、默认怎么问」，`agents-sync` 把它写进每台机器上各家 AI 自己的配置。要一次全生效，在 fleet-dao 检出里跑 `pnpm agents:sync`。

需求和决定记录：`specs/517-各家权限同步/需求.md`（创始人 2026-09-30）；Claude Code 那一家是 #516。

## 一条命令

```
pnpm agents:sync              # 取远端 → 把检出快进到主线 → 同步（规矩、技能、钩子、权限）→ 每家一行报结果
pnpm agents:sync --check      # 只读，不取远端、不写，只报差在哪
pnpm agents:sync --offline    # 网络不通时用：不取远端，按检出里现有的主线同步
pnpm agents:sync --repo <目录> # 指定 fleet-dao 检出（默认：~/.fleet-dao/synced.json 记的，再没有就是脚本所在的检出）
```

- 开发机开新会话时，开会话钩子自己做同样的事（三分钟内同步成功过就跳过），所以平时不用手敲；这条是「现在就要、要看到每家结果」时用。
- **同步完要重开 AI 会话才生效**：已经开着的会话读的是开场时的配置。
- 不满足就明说、不同步：git 跑不起来、取不到远端（`--offline` 才放行）、检出不在 main 上、`AGENTS.md` 或 `agents/` 有没提交的改动、main 和 origin/main 分叉。退出码 0 都对，1 有前置不满足或有没做成，2 有没查成。
- 对 AI 说：「跑 `pnpm agents:sync`，把这台的权限同步到最新」。
- Windows 上如果这台的 git 跑不起来（缺 DLL），先把 `D:\Tools\Git\cmd` 放进 PATH 前面。

## 各家怎么写

| 家 | 写到哪 | 怎么写 | 状态 |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` 的 `permissions` | `defaultMode`（覆盖）、`allow`/`deny`/`additionalDirectories`（补缺、不删自己加的） | 已合并（#516）、本机实测 |
| Grok | 不另写 | 它直接读 `~/.claude/settings.json` 的 `permissions`（含 `defaultMode`），随 Claude 那份生效；它不认的工具（`NotebookEdit`、`PowerShell(…)`）开会话时跳过并警告，不影响别的 | 本机实测：`grok inspect --json` 的 `permissions` 里读到 34 条、跳过 9 条（依据 `~/.grok/docs/user-guide/22-permissions-and-safety.md` 第 3 节） |
| Kimi Code | `~/.kimi-code/config.toml` | 最前面一行 `default_permission_mode = "auto"`；文件末尾一块托管块，里面是 `[[permission.rules]]`（先匹配的生效，所以拒绝排在放行前面；现在没有拒绝） | 本机装了：`kimi doctor` 认这份配置 |
| Codex | `~/.codex/rules/default.rules` | 一块托管块，里面是 `prefix_rule(pattern=["git"], decision="allow")` / `decision="forbidden"` | 本机装了：`codex execpolicy check` 核过匹配结果 |
| Devin CLI | Windows `%APPDATA%\devin\config.json`、Linux `~/.config/devin/config.json` 的 `permissions` | `allow`/`deny` 里写 `Exec(git)`、`Read(**)`、`Write(**)`、`grep`；补缺、不删自己加的；不同步默认模式（文档没说清 config.json 里有没有这个键） | 依据是官方文档，本机没装、没实测 |
| Gemini CLI | 还没接 | 规则要写在 `~/.gemini/policies/*.toml`，`--yolo` 写不进配置 | 本机没装，装上核过再接 |
| Antigravity（agy） | 还没接 | 写法只来自博客；官方 issue #548：无头模式会忽略 `allow` | 装上实测后再接 |
| pi | 做不到 | 它没有审批功能，默认全放行，只能靠扩展 | — |
| dsh | 做不到 | 只有 ask / never 两档，不能按命令写规则 | — |

装了但没接的几家，`--check` / `--apply` 会逐家一行说为什么，不假装装了。

## 翻译规则（Claude 的写法 → 各家）

- `Bash(git:*)` / `PowerShell(git:*)`（命令名后面只有 `:*`）：Kimi → `Bash(git *)`；Codex → `["git"]`；Devin → `Exec(git)`。带空格、通配在中间的写法翻不了。
- 整个 shell 放开（`Bash`、`PowerShell` 不带括号）：Kimi → `Bash`；Devin → `exec`；Codex 的规则没有「所有命令」的写法，靠清单里逐个列出的命令前缀（约 100 个）近似。
- 整个 MCP 服务（`mcp__服务名`）：Kimi、Devin → `mcp__服务名__*`；Codex 没有对应。
- `Read`、`Grep`、`Glob`、`Write`、`Edit` 这类工具名：Kimi 照抄；Devin 翻成 `Read(**)`、`Write(**)`、`grep`、`glob`；Codex 的规则只管命令，没有对应。
- `WebFetch`、`WebSearch`、`Agent`、`Workflow`、`NotebookEdit`：各家都没有对应写法，不同步，报告里数出「有几条没同步」。
- 翻译后同一条既放行又拒绝、源文件不合规矩（含 `defaultMode` 写 `bypassPermissions`）：装了的各家都报没查成 / 没做成，一个都不写。

## 托管块和「不删你自己加的」

- Kimi、Codex 的托管块用两行注释圈起来（`# >>> fleet-dao 权限` … `# <<< fleet-dao 权限`）：块里整块由同步脚本写，手改的下次会被覆盖；块外的内容一个字不碰（Codex 以后自己追加的规则、你自己写的规则都留着）。两行标记缺一行、重复、颠倒，或文件里有多行字符串读不准：不动，报没做成，要人看。
- Claude、Devin：`allow`/`deny` 按并集合并，机器上自己加的不删；只有仓里 `retired` 里写明的才摘。同一条落在相反的两边（仓里要 `deny`、机器上放在 `allow`）：报漂移，整份不动。
- 每次改之前把原文件备份到 `~/.fleet-dao/backups/<时间>/`；撤回就把备份拷回原位。
- Kimi 里先匹配的生效：你自己在块外写的规则排在块前面就优先；排在块后面，我们的拒绝先命中。

## 要注意的两点

- **原则：尽量宽松、只放不收**（创始人 2026-09-30）。他有时用 Mirasim 这类图形界面起 CLI，没法切模式、也没人点确认，凡是要问的都会卡死。所以 Claude 保持 `defaultMode: auto`（同步工具仍拒收 `bypassPermissions`），`Bash`、`PowerShell`、各工具和常用 MCP 服务整个放开，`deny` 是空的，早先那 9 条拒绝（`grep`、`cat`、`head`、`tail`、`find`、`rg`、`ag`、`ack`、`Select-String`）在 `retiredDeny` 里，各机器同步时摘掉。以后要收紧，先找创始人。
- **Kimi 的默认模式用 `auto`（不打断、自动判断）**，不用 `yolo`（日常自动、危险的仍问）：`yolo` 遇到要问的会在没人点的界面里卡住。
- **本仓的 PreToolUse 钩子不受影响**：它拦「读到密钥文件、口令值」，不属于权限清单，照旧生效。
- **Codex 的 `allow` 是「不问、不进沙箱直接跑」**：`git`、`node`、`python`、`pnpm` 这类前缀放行后，带任何参数都不再问，和 Claude 里 `Bash(python:*)` 一样宽；只按前缀匹配、没有通配符，`git` 不会匹配 `gitk`（本机核过）。

## 怎么加、怎么撤一条

1. 改 `agents/config/claude-permissions.json`：加就加进 `allow` / `deny`；撤就从里面删掉、写进 `retired`（两边都摘）或 `retiredDeny`（只从 deny 里摘，放宽时把旧拒绝撤了、同一条又放进 allow 用它），各机器下一次同步才会摘掉。
2. 这份文件在 `packages/conventions/standard-paths.json` 里，改它是「改标准」：PR 正文写「人闸：改标准」，创始人同意才合。
3. 合进主线后，各开发机开会话时自动同步，或者手动 `pnpm agents:sync`。

## 法国

`--user`（法国装机）整段不写权限：`defaultMode: auto` 会让那个用户的会话少一道确认，法国的会话放不放开由引擎起会话时的参数定（引擎带 `--setting-sources project`，本来也不读用户级设置）。要不要给法国写，另请创始人拍。

## 代码在哪

- `packages/agents-sync/src/permissions.ts`：Claude 的合并逻辑，也给 Devin 用（`judge`、`merged`、`checkJson`、`applyJson`）。
- `packages/agents-sync/src/permissions-vendors.ts`：翻译和 Kimi、Codex 的托管块。
- `packages/agents-sync/src/targets.ts`：每家写到哪（`PERMISSIONS_TARGET`、`KIMI_PERMISSIONS` 等）和做不到的几家的理由（`PERMISSION_GAPS`）。
- `packages/agents-sync/src/sync-now.ts`：一键命令。
- 测试：`packages/agents-sync/test/permissions*.test.ts`、`sync-now.test.ts`，每条读不懂、写不成的路径都有故意造出失败的用例。
