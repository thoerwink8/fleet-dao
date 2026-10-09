# 各家 AI 的权限怎么同步

一份意图，各家一个翻译：仓里 `agents/config/claude-permissions.json` 写「日常放行什么、禁掉什么、默认怎么问」，`agents-sync` 把它写进每台机器上各家 AI 自己的配置。要一次全生效，在 fleet-dao 检出里跑 `pnpm agents:sync`。

需求和决定记录：`specs/517-各家权限同步/需求.md`（创始人 2026-09-30）；Claude Code 那一家是 #516；为什么放到最宽松、原话、更正和撤回条件见 `docs/decisions/0005-agent-permissions-loosest.md`。

## 一条命令

```
pnpm agents:sync              # 取远端 → 把同步专用的检出切到 origin/main → 同步（规矩、技能、子代理定义、钩子、权限）→ 每家一行报结果
pnpm agents:sync --check      # 只读，不取远端、不写，只报差在哪
pnpm agents:sync --offline    # 网络不通时用：不取远端，按本机上次取到的 origin/main 同步
pnpm agents:sync --seed <目录> # 拿这个 fleet-dao 检出当种子（第一次建、或专用检出坏了要重建时用；
                              # 默认：~/.fleet-dao/synced.json 记的检出，再没有就是脚本所在的检出）
```

- 开发机开新会话时，开会话钩子自己做同样的事（三分钟内同步成功过就跳过），所以平时不用手敲；这条是「现在就要、要看到每家结果」时用。
- 同步用的是一份**只归同步工具的检出** `~/.fleet-dao/origin-main`：永远停在 `origin/main` 的分离头上。本机自己的 fleet-dao 检出在哪个分支、有没有没提交的改动都不影响同步；那边的检出只被当「种子」读（拿它的 origin 地址、本地对象），一个写操作都没有。专用检出里要是被人改了，整份挪到它旁边（`origin-main.bak-<时间>`）再从零建一份——不拿没推的内容去同步，也不删东西。
- **同步完要重开 AI 会话才生效**：已经开着的会话读的是开场时的配置。
- 不满足就明说、不同步：git 跑不起来、取不到远端（`--offline` 才放行）、专用检出建不起来、专用检出的锁被别的同步拿着。退出码 0 都对，1 有没做成的，2 有没查成的。
- 对 AI 说：「跑 `pnpm agents:sync`，把这台的权限同步到最新」。
- Windows 上如果这台的 git 跑不起来（缺 DLL），先把 `D:\Tools\Git\cmd` 放进 PATH 前面。

## 各家怎么写

| 家 | 写到哪 | 怎么写 | 状态 |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` 的 `permissions`、`autoMode` 和 `env` 里的子代理默认模型 | `defaultMode`（覆盖，**机器上自己设成 `bypassPermissions` 的除外**：那种保留、只报一行）、`allow`/`deny`/`additionalDirectories`（补缺、不删自己加的）；`autoMode` 的 `environment`、`allow`（并集、不删自己加的，见下面一节）；`env.CLAUDE_CODE_SUBAGENT_MODEL`（覆盖、`env` 里别的变量不碰，见「子代理默认模型」一节） | 已合并（#516）、本机实测；`autoMode` 2026-10-01 加（同 PR 带进主线）；保留机器上的 bypass 2026-10-01 下午加；子代理默认模型 2026-10-04 加（#785） |
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
- 翻译后同一条既放行又拒绝、源文件不合规矩（含 `defaultMode` 写 `bypassPermissions`）：装了的各家都报没查成 / 没做成，一个都不写。注意这条只管**源文件**：机器上自己设成 `bypassPermissions` 的照旧保留（见下面「`defaultMode` 与机器上的 `bypassPermissions`」一节）。

## `defaultMode` 与机器上的 `bypassPermissions`

两件容易混的事，分开说（创始人 2026-10-01 下午拍）：

- **仓里的源文件不许写 `bypassPermissions`**：写了照旧拒收，报没查成 / 没做成，一台机器都不写。理由：这份清单会装到**法国那台无人值守的引擎**上，仓里写 bypass 等于把「不用问」推给每一台别人盯不到的机器。仓里默认仍是 `auto`。
- **机器上自己设成 `bypassPermissions` 的：保留，只报不改**。他原话：「我一般都是开启 `bypassPermissions` 模式的，如果按照我的用法，其实我不希望拦，或者 `auto` 拦小部分，`bypassPermissions` 都不拦」。所以同步工具遇到这种机器：
  - `defaultMode` **不覆盖**（仓里写 `auto` 也不动它），不当漂移、不算缺失，退出码不受影响；
  - 报告里那一行会多一句「这台自己设成 bypassPermissions，保留、没改」，`--check` 和 `--apply` 都报（别的那几项该补照补）；
  - 这不是放行：`allow`、`deny`、`autoMode` 照旧按并集合并，别的机器一个都不受影响。

也就是说 `defaultMode` 平常「归仓里管、每次覆盖」有个例外：**机器自己已经选了 `bypassPermissions` 的，这台归这台自己管**。想让它回到 `auto`，在那台机器上把 `permissions.defaultMode` 改成 `auto` 再同步（同步工具不会替你改回来）。注意 `bypassPermissions` 下的会话整个不问了，这是那台自己的选择，不是仓里推的规矩。

## `autoMode`：给分类器看的那一段

`permissions` 管的是「哪些工具调用不用问」，`autoMode` 管的是**另一个东西**：`defaultMode: auto` 之下，每条工具调用还要过一遍 auto 模式的分类器，它默认拦掉不可逆的、破坏性的、以及指向你这套环境之外的调用。分类器会拦下不认识的日常动作（2026-10-01 就拦过一次：#509 那份正文被当成「用户没明确要的覆盖」）。`autoMode` 就是跟它说清楚「自己人是谁、什么算外面、哪些日常动作是例外」的地方，写的是自然语言整句，分类器当规则读，不是工具名或正则。

装到哪：`~/.claude/settings.json` 的 `autoMode`，跟 `permissions` 是同一份文件、两段。**只认用户级**——项目里的 `.claude/settings.json` 和 `.claude/settings.local.json` 里的 `autoMode` 分类器不读（文档写明是防着仓里替自己开后门），所以仓里这份清单必须靠同步工具落到每台机器的家目录，写进仓里不管用。`--user`（法国装机）整段不写。

仓里 `agents/config/claude-permissions.json` 的 `autoMode` 只写两档，同步工具按并集合并进机器上那一档（机器上自己加的、本脚本没管的两档都不动）：

| 档 | 是什么 | 仓里现在写了什么 |
|---|---|---|
| `environment` | 什么是「自己人」：分类器拿它判断「外面」是哪儿 | 和工作仓同一个 GitHub 主人的仓算自己的；这个范围之外（别人的仓、公开的粘贴站和代码托管、外部服务、域名、云存储）算外面 |
| `allow` | 内置软拦规则的例外：日常动作写这里 | 改自己仓里单子和 PR 的标题、正文、标签、评论、子单关系；从私有仓 `fleet-dao-vault` 取我们自己的凭证（自建 VPS 订阅、两台机器的配置和密钥），写进本仓 `.env`、拿它做只读查询；另加一条说明这些不等于别的也放行（推、删、发布、强推照旧按各自的规矩判） |

为什么不写别的：`soft_deny`、`hard_deny` 是收紧，不推给所有机器；`classifyAllShell` 改了之后每条 shell 命令都过分类器、费时，是每台自己愿不愿意的事。这三样同步工具一个不碰，机器上原有的照旧生效。

### 「取凭证走保险箱」这条放行的是什么、不放行什么

2026-10-01 下午加的一条日常（创始人拍的），原文写在清单里：

> 取凭证走保险箱是日常：从私有仓 `fleet-dao-vault` 的 `workstation/vps-subscription/`（创始人自建 VPS 的订阅地址与节点）、`france/` 和 `hk/`（两台机器上的配置与密钥的加密副本）取当前任务要用的凭证、写进本仓的 `.env`、用它做只读查询，都直接做，不用问。保险箱只放「我们自己有、丢了别处再也没有」的东西；别人家的现场凭据（现场服务器的 root、数据库账号这类）不算——那种丢了跟现场要一份就有。登一次就能回来的（各家 AI 的登录态、普通订阅）也不在那儿。**不含**「去翻会话记录、日志、别的会话的文件找凭证」——那是在到处翻找凭证，照旧拦。

分清楚：

- **放行的是正规取法**：知道凭证在 `fleet-dao-vault` 里（`workstation/vps-subscription/` 和 `france/`、`hk/`），去取当前任务要用的那几样，落到本仓的 `.env`，拿它做只读查询。这是一条**确定的取法**，分类器认得出，写进 `allow` 就不用每次都问。
- **不放行的是到处翻找**：把会话记录、日志、别人的会话文件、整个家目录翻一遍去找凭证——那不是在取凭证，是在找哪儿有凭证，照旧拦。所以这条明文写着「不含」，不是把「找凭证」这件事整个放开。
- **保险箱里放什么**（创始人 2026-10-01 下午收窄、当晚再收窄一次）：判准一条——**这东西是不是「我们自己有、丢了别处再也没有」**。放：自建 VPS 的订阅地址与节点、`france/`、`hk/` 里的服务器密钥和配置。不放：**别人家的现场凭据**（现场服务器的 root、数据库账号——丢了跟现场要一份就有，当晚那句「韶关 3 号楼这一种根本就不需要存进我们的保险箱里」就是把这类撤掉）、Google 账号、各家 AI 的登录态、普通订阅这些登一次就回来的。私有仓的 `workstation/README.md` 和 `workstation/vps-subscription/README.md` 写了同一套判准。
- **别假设备用**：有些机器挂了 fleet-dao 但**没有**那个私有仓（没登 `gh`，或就是不给它）。那些机器照旧要能干活：要用的凭证由创始人或现场给，不许因为拿不到就去翻会话记录。
- 这条不改变别的：拿到的凭证往外发、推、删、发布、强推照旧按各自的规矩判。

### `"$defaults"`：少一个就把内置规则整段换掉

两个数组**都必须带字面量 `"$defaults"`**，它在数组里的位置决定内置的那批规则插在哪。文档里那段 Danger 写得很清楚：哪一档的数组没带 `"$defaults"`，那一档的内置规则就**整段**被换掉——软拦那一类丢掉的是强推、`curl | bash`、生产发布、绕过 auto 模式这些，硬拦那一类丢掉的是防外传那条。所以：

- 仓里的源文件少了 `"$defaults"`（或只有 `"$defaults"`、没有自己的规则）：同步工具**拒收**，报没查成 / 没做成，一台机器都不写。不替它补上——补上了源文件本身还是错的，下一个人照它改、拦住和放开的东西就在他手里悄悄变了。
- 机器上那一档在、却没带 `"$defaults"`（谁改的不知道，可能是人自己动了、也可能是别处装的）：报漂移，**整份不动**，要人看。这是没有源文件也认得出的漂移，`--check` 单独会报出来。
- `additionalDirectories`、`permissions` 那几档不受影响：文档说四档各算各的，只写 `environment` 不动另外三档。

### 和 `permissions.allow` 怎么配合

两层闸、两套写法，别混：

1. **`permissions.allow` 在前**：命中的工具调用直接放行、不进分类器。但 auto 模式会**暂时撤掉**那些「能跑任意代码」的宽规则（`Bash`、`PowerShell`、`Bash(node:*)`、`Bash(python:*)` 这类），把它们交给分类器；窄规则（`Bash(gh:*)`、`Bash(git:*)`）照旧直接放。所以清单里那条 `Bash(gh:*)` 在 auto 模式下仍然有效，而写一条宽规则指望它绕开分类器是行不通的。
2. **`autoMode` 在后**：分类器按 `environment` 判「这是不是外面」、按 `soft_deny` / `hard_deny` 判危险、按 `allow` 放行例外。`deny` 和 `ask` 排在分类器之前，谁也覆盖不了。
3. 所以一条命令被拦，先看是哪一层拦的：说 `Denied by auto mode classifier` 是第二层，要动的是 `autoMode`；说「权限被拒」是第一层，要动的是 `permissions`。

改这一段是改标准（这份清单在 `packages/conventions/standard-paths.json` 里）：PR 正文「还欠什么」写「人闸：改标准」，创始人同意才合。合进主线后各台开会话时自动同步，机器上重开会话才生效。

## 子代理默认模型

`~/.claude/settings.json` 的 `env.CLAUDE_CODE_SUBAGENT_MODEL`。决定 0034（`docs/decisions/0034-subagent-by-cost-effectiveness.md`，创始人 2026-10-09 授权）：子代理按性价比分 Haiku 5.5、Sonnet 5.5、Opus 5.5 三档，永不用 Fable（沿用 0017）；**默认值只许 Opus 或 Sonnet**，Haiku 5.5 只在派活时逐个显式选，不当忘了写模型时的兜底（兜底落到 Haiku，写代码的活就悄悄跑在小模型上了）。光靠派的时候记得写 `model` 不够：没写的子代理会跟主会话同一个模型，而创始人本机的主会话可能是他自己选的 Fable。所以把「默认子代理模型」钉进设置，由同步工具写到每台机器。

- **是什么**：Claude Code 的默认子代理模型只有环境变量这一种设法（`settings.json` 里没有同名的键），写在 `~/.claude/settings.json` 的 `env` 里、开会话时生效。仓里 `agents/config/claude-permissions.json` 写的是 `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5-5" }`，即 Sonnet 5.5（决定 0034 的默认档；原先是 Opus 5.5，Opus 仍允许当默认，Haiku 不行）。
- **管得到哪些子代理**：先后是 调用时写的 `model` > 子代理定义里写的模型（写 `inherit` 就跟主会话）> 这个变量 > 主会话（官方文档 model-config、sub-agents 两页，和本机 Claude Code 2.1.285 的程序一致）。所以它只兜住**两头都没写**的那些：

  | 子代理 | 定义里写的模型 | 派的时候没写 `model`，用的是 |
  |---|---|---|
  | general-purpose（不写类型默认就是它）、workflow 里起的、队友、自己定义又没写模型的 | 没写 | **这个变量：Sonnet 5.5** |
  | Plan、`fork` 这类 | `inherit` | 主会话（主会话是 Fable 就是 Fable） |
  | Explore | `inherit`，主会话比 Opus 高一档时最高只到 Opus | 主会话，最高 Opus |
  | claude-code-guide | `haiku` | Haiku |
  | statusline-setup | `sonnet` | Sonnet |

  所以**派子代理照旧一律写明模型**：按决定 0034、0035 的档位，Sonnet、Opus 写 `model: "sonnet"` 或 `"opus"`；Haiku 5.5 写 `subagent_type: "haiku55"`、不传 `model`（别名 `haiku` 在本机指向 Haiku 4.5；`haiku55` 是 `~/.claude/agents/haiku55.md` 里 `model: claude-haiku-5-5` 的自定义子代理，原件在仓里 `agents/subagents/haiku55.md`，随 `pnpm agents:sync` 装到每台机器，#1393）。Agent 工具的 `model` 只收别名，所以交代里要子代理汇报首行写自己的模型 id、对不上就升档重派；细则在指挥官技能 `references/子代理选模型.md`。主会话在 Fable 上时照旧别用 `fork`。这个变量是忘了写时的兜底，不是替代。
- **同步工具怎么写**：只写 `env` 里这一项、每次覆盖（同 `defaultMode`：机器上改成别的，哪怕也是 Opus 或 Sonnet，也报漂移、改回仓里的；要换先改仓里）；`env` 里别的变量（代理这些）一个不碰；机器上的 `env` 不是对象就整份不动、报没做成。`--user`（法国装机）跟权限一起整段不写。
- **源文件拒收**（报没查成 / 没做成，一台机器都不写，不替它补上）：没写 `env` 或这一项；值不是 Opus 或 Sonnet（只认 `opus`、`sonnet` 或 `claude-opus-…`、`claude-sonnet-…` 这样的 id，可带 `[1m]`；Fable、Mythos、Haiku（含 `claude-haiku-5-5`：派活时能显式用，不能当默认）、`inherit`、`best`、`opusplan` 都不认）；`env` 里多写了同步工具没登记的变量（`env` 会推给每一台机器，要加新变量，先在 `packages/agents-sync/src/permissions.ts` 的 `ENV_KEYS` 里登记它的校验）。
- **钉住它的测试**：`agents/test/rules/subagent-model.rules.test.ts`（默认值改成 Fable、Haiku（含 5.5）、`inherit` 或删掉都红；自己判、不借同步工具的校验，那边哪天被放宽了这条照样红）；同步工具这边的用例在 `packages/agents-sync/test/permissions.test.ts`。
- **看过、没用的几个设置**：
  - `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`：调用写的 `model` 和定义里写的模型都不算了，一律用这个变量（`fork` 除外），能把上面表里 Plan、claude-code-guide 那几条路也堵上；代价是派活写 `opus`、`haiku` 也会被改成 Sonnet、workflow 里写的模型全被忽略，和决定 0034 的三档冲突，不加。
  - `availableModels`（白名单，哪个设置文件里都认）、`deniedModels`（黑名单，只认系统级的托管设置）：连主会话一起管，会把创始人本机主对话里自己选 Fable 也禁掉，和决定 0017 第 4 条冲突，本机不能用。VPS、WSL 上主会话也不许用 Fable（第 3 条），那边可以用托管设置里的 `deniedModels`，要动部署，这次没做。
- 改它是改标准（同上：这份清单在 `packages/conventions/standard-paths.json` 里）。合进主线后各台开会话时自动同步，**重开会话才生效**；查这台装没装上：`pnpm agents:sync --check` 里 `~/.claude/settings.json#permissions` 那一行会写「env.CLAUDE_CODE_SUBAGENT_MODEL 是 claude-sonnet-5-5」。

## 托管块和「不删你自己加的」

- Kimi、Codex 的托管块用两行注释圈起来（`# >>> fleet-dao 权限` … `# <<< fleet-dao 权限`）：块里整块由同步脚本写，手改的下次会被覆盖；块外的内容一个字不碰（Codex 以后自己追加的规则、你自己写的规则都留着）。两行标记缺一行、重复、颠倒，或文件里有多行字符串读不准：不动，报没做成，要人看。
- Claude、Devin：`allow`/`deny` 按并集合并，机器上自己加的不删；只有仓里 `retired` 里写明的才摘。同一条落在相反的两边（仓里要 `deny`、机器上放在 `allow`）：报漂移，整份不动。
- 每次改之前把原文件备份到 `~/.fleet-dao/backups/<时间>/`；撤回就把备份拷回原位。
- Kimi 里先匹配的生效：你自己在块外写的规则排在块前面就优先；排在块后面，我们的拒绝先命中。

## 要注意的两点

- **原则：尽量宽松、只放不收**（创始人 2026-09-30）。他有时用 Mirasim 这类图形界面起 CLI，没法切模式、也没人点确认，凡是要问的都会卡死。所以 Claude **仓里**保持 `defaultMode: auto`，`Bash`、`PowerShell`、各工具和常用 MCP 服务整个放开，`deny` 是空的，早先那 9 条拒绝（`grep`、`cat`、`head`、`tail`、`find`、`rg`、`ag`、`ack`、`Select-String`）在 `retiredDeny` 里，各机器同步时摘掉。以后要收紧，先找创始人。
- **仓里的 `auto` 和机器自己的 `bypassPermissions` 不冲突**（创始人 2026-10-01 下午）：仓里仍不许写 `bypassPermissions`（会推给无人值守的机器），但机器上自己设成 `bypassPermissions` 的**保留、只报不改**（上面「`defaultMode` 与机器上的 `bypassPermissions`」一节）。他自己那台开着 bypass，同步不会把它改回 `auto`。
- **Kimi 的默认模式用 `auto`（不打断、自动判断）**，不用 `yolo`（日常自动、危险的仍问）：`yolo` 遇到要问的会在没人点的界面里卡住。
- **本仓的 PreToolUse 钩子不受影响**：它拦「读到密钥文件、口令值」「打印进程命令行不打码」，不属于权限清单，照旧生效。
- **打印进程命令行时要把密钥打码**（2026-10-02 加，创始人拍的）：进程的整条命令行是公开的（Linux 的
  `/proc/<pid>/cmdline`、Windows 的 `Win32_Process.CommandLine`），口令当参数交给别的进程之后就躺在那里——`ps -ef`、
  `wmic process`、`Get-CimInstance Win32_Process` 这类「看现在有哪些进程」的平常命令会把它们整段打出来（2026-10-02 就是这么漏的：
  lark-mcp 那行的 `-s <secret>`）。要跑就接一条管道过 redactor（`~/.fleet-dao/hooks/redact-secrets.mjs`，随钩子一起装）：

  ```
  ps -ef | node "$HOME/.fleet-dao/hooks/redact-secrets.mjs"
  Get-CimInstance Win32_Process | Select-Object CommandLine | node "$HOME/.fleet-dao/hooks/redact-secrets.mjs"
  ```

  不接的会被钩子拦下（只列进程名和 pid 的 `ps -A`、`ps -eo pid,comm`、`tasklist`、`Get-Process` 照样放行）。
  打码的是 `-s` / `--secret` / `--token` / `--password` 这几类参数的值、名字带 secret / token / password 的 JSON 字段；
  拿不准就遮。这是安全网、不是保险箱：变量展开出来的、编码过的照样漏（说明写在 `agents/hooks/redact.mjs` 开头）。
- **Codex 的 `allow` 是「不问、不进沙箱直接跑」**：`git`、`node`、`python`、`pnpm` 这类前缀放行后，带任何参数都不再问，和 Claude 里 `Bash(python:*)` 一样宽；只按前缀匹配、没有通配符，`git` 不会匹配 `gitk`（本机核过）。

## 生效的条件（做了什么、什么时候才算生效）

同步工具「写进去了」不等于「AI 那边用上了」，逐条对：

1. **仓里的清单合进主线**（#516、#519、#520 已合）。没合进主线，`pnpm agents:sync` 同步的还是旧的。
2. **这台机器同步过**：开新会话时钩子自动同步，或者手动跑 `pnpm agents:sync`（要 `node`、`git` 能用；Windows 上 git 缺 DLL 时先把 `D:\Tools\Git\cmd` 放进 PATH 前面）。同步完 `pnpm agents:sync --check` 应该零漂移、零缺失。
3. **重开 AI 会话**：已开着的会话读的是开场时的配置。
4. **那一家真的读这份文件**：Claude Code 读 `~/.claude/settings.json`（`permissions` 和 `autoMode` 同一份，`autoMode` 只认用户级、项目级不读）；Grok 借道读同一份；Kimi、Codex 读各自的文件（都在本机用各家自己的命令核过：`kimi doctor`、`codex execpolicy check`、`grok inspect --json`）。Devin 没装、没实测；Gemini CLI、Antigravity 没接。
5. **`autoMode` 那一刻生效还看得到**：同步完可以跑 `claude auto-mode config`（打印分类器实际用的那几档规则）核一遍，`claude auto-mode defaults` 看内置的。仓里写的是自然语言，判断在分类器那边，本机没法逐条断言「这条一定拦、那条一定放」。
6. **图形界面（Mirasim）**：它起 CLI 时读不读用户级设置、有没有自己带模式参数，**没实测**。在里面开新会话让 AI 跑一条 `ssh` 试，被拦就把报错给 AI 查。
7. **法国不生效**：`--user` 整段不写，法国的会话放不放开由引擎起会话的参数定。
8. **机器上自己设成 `bypassPermissions` 的那台**：同步不会改它，但要不要真的用 bypass 是那台的事——同步工具只保证「不改回来」，不保证「一定生效」（模式还是得在那台的会话里真正开着）。

本机核过的结果（2026-09-30，同步后）：`~/.claude/settings.json` 里 `defaultMode = auto`、allow 139 条、deny 0 条；`grok inspect` 读到 131 条、跳过 8 条它不认的（`NotebookEdit` 和带括号的 `PowerShell(…)`）；`kimi doctor` 通过、默认模式 `auto`；`codex execpolicy check` 对 `git`、`ssh`、`scp`、`kubectl`、`docker`、`sudo`、`rm -rf`、`cat`、`grep` 都放行，`cmd /c`、`powershell -c` 没命中（Codex 只按命令前缀匹配、没有「所有命令」的写法，这两个外壳前缀要放开得加进清单）。

## 怎么加、怎么撤一条

1. 改 `agents/config/claude-permissions.json`：加就加进 `allow` / `deny`；撤就从里面删掉、写进 `retired`（两边都摘）或 `retiredDeny`（只从 deny 里摘，放宽时把旧拒绝撤了、同一条又放进 allow 用它），各机器下一次同步才会摘掉。
   `autoMode` 的 `environment` / `allow` 直接改那两条数组，**`"$defaults"` 别动**（见上面那一节）；只写「日常」，推送、删除、发布、强推这些不写进去（「取凭证走保险箱」是取法的日常，写进去了，「到处翻找凭证」不写）。撤一条就从数组里删掉——`autoMode` 没有 `retired` 那一套：它按并集合并，机器上原来装过的条目不会自动摘掉，要摘得在机器上手动删（这类条目不多，且多半是各台自己加的）。
2. 这份文件在 `packages/conventions/standard-paths.json` 里，改它是「改标准」：PR 正文「还欠什么」写「人闸：改标准」，创始人同意才合。
3. 合进主线后，各开发机开会话时自动同步，或者手动 `pnpm agents:sync`。

## 法国

`--user`（法国装机）整段不写权限：`defaultMode: auto` 会让那个用户的会话少一道确认，法国的会话放不放开由引擎起会话时的参数定（引擎带 `--setting-sources project`，本来也不读用户级设置）。要不要给法国写，另请创始人拍。

## 代码在哪

- `packages/agents-sync/src/permissions.ts`：Claude 的合并逻辑（`permissions`、`autoMode` 两段和 `env` 里的子代理默认模型：`ENV_KEYS`、`OPUS_OR_SONNET`），也给 Devin 用（`judge`、`merged`、`checkJson`、`applyJson`；Devin 那边不写 `autoMode`、`env`）。
- `packages/agents-sync/src/permissions-vendors.ts`：翻译和 Kimi、Codex 的托管块。
- `packages/agents-sync/src/targets.ts`：每家写到哪（`PERMISSIONS_TARGET`、`KIMI_PERMISSIONS` 等）和做不到的几家的理由（`PERMISSION_GAPS`）。
- `packages/agents-sync/src/sync-now.ts`：一键命令。
- `agents/hooks/redact.mjs`、`agents/hooks/redact-secrets.mjs`：把命令输出里的密钥值换成 `***`（上面「打印进程命令行」那条），装上以后就用
  `~/.fleet-dao/hooks/` 下的那份。
- 测试：`packages/agents-sync/test/permissions*.test.ts`、`sync-now.test.ts`，每条读不懂、写不成的路径都有故意造出失败的用例；
  钩子拦的规矩（含打印进程命令行那一条）在 `agents/test/rules/pretool.rules.test.ts`，改了拦什么那里会红；
  子代理默认模型只许 Opus 或 Sonnet、三档和升级规则钉在 `agents/test/rules/subagent-model.rules.test.ts`。
