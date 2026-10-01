# 0005 各家 AI 的权限：尽量宽松、只放不收，Claude 保持 auto

- 日期：2026-09-30（会话里没记下每句话的具体时刻，按顺序列）
- 谁拍的：创始人。选了「选 1」（先做 Grok、Devin、Kimi、Codex 四家）、要求文档和一条命令一键全生效，最后定「最宽松」。
- 状态：已采纳、已执行（#516、#519、#520 合并，#517 关成完成，本机已同步并核过）。
- 替代：无。承接 `specs/517-各家权限同步/需求.md`；`docs/agents-permissions.md` 是它的说明书。
- 只记他亲口说的：下面「原话」逐字照抄（语音输入的错字不改，「AI 理解」另起一行）；「执行情况」是 AI 报的事实，可以按 PR 号核对。

## 原话

- 「是不是后续我开auto模式，就能搞定很多事情了，不需要再开bybess模式了？」
- 「我希望全局都生效」→ AI 列了 Grok、Devin、Codex 等各家怎么设，他回「3」，后来回「选 1」（先做 Grok、Devin、Kimi、Codex 四家，Gemini 和 Antigravity 等装上能实测再补，pi、dsh 写明做不到）
- 「还需要后续同步到文档和命令也能一键全生效」
- 「快马直接全做」
- 「都跑一遍，然后帮我考虑一下还有什么内容需要也授权,（这里原话有一个 Mirasim 会话分享链接，不进公开仓）   比如ssh」
- 「我建议尽量以宽松的方式去配置，结合我的想法再出方案」
- 「不，我要最宽松，你只能更放松而不是改严，我必须要auto模式，因为我有时候用的是可视化软件mirasim，它用的是cli 但是我无法切换mode」
- 「合并了，你来核一遍」

AI 理解：「auto」指 Claude Code 的自动模式（每个动作由审查员判断）；「bybess」指 bypass（全放开）；「mirasim」是他的图形界面软件，用 CLI 起会话，没法切模式、也没人点确认。「最宽松、只放不收」的意思是：新清单只能比原来放得更开，不许比原来更严。

## 决定

1. Claude Code：`defaultMode` 保持 `auto`（同步工具仍拒收 `bypassPermissions`；机器上自己设成 `bypassPermissions` 的保留、只报不改，见下面「2026-10-01 下午的修正」）；`Bash`、`PowerShell`、各工具和常用 MCP 服务整个放开，另列约 100 个命令前缀（给 Codex 用）；**不设 deny**；早先 9 条拒绝（`grep`、`cat`、`head`、`tail`、`find`、`rg`、`ag`、`ack`、`Select-String`）写进 `retiredDeny`，各机器同步时摘掉。
2. 其他几家照同一份意图翻译：Kimi Code 默认模式 `auto` 加规则块；Codex 用命令前缀规则块；Devin 走 `config.json` 的 `permissions`；Grok 直接读 Claude 那份，不另写；pi、dsh 做不到；Gemini CLI、Antigravity 没装、没实测，待补。
3. `pnpm agents:sync` 一条命令取远端、快进主线、同步、逐家报结果；文档 `docs/agents-permissions.md`。
4. 法国（`--user`）整段不写权限，不变；要不要写另请他拍。
5. 本仓 PreToolUse 钩子（拦读密钥文件、口令值）不属于权限清单，不动、不加严。

## 为什么（前提）

- 他有时用 Mirasim 这类图形界面起 CLI：没法切模式、没有人点确认，凡是要问的都会卡死。所以模式必须是 `auto`，而 `auto` 下「不在 allow 里、又被审查员拦」的命令同样会卡死；放进 allow 才能不经审查员直接跑。
- 这条写的是「他要什么」，不是「这样最安全」：AI 曾建议「ssh、`curl`、`docker`、`kubectl` 不放 allow、交给审查员」，并建议在钩子里加一层删根目录、`curl|sh` 之类的硬底线。他明确否掉（「你只能更放松而不是改严」），所以没有加。第二意见（GPT，经 Mirasim 云端）的四条意见和他的取舍写在会话里，没有收进方案。

## 执行情况（AI 报的事实）

- #516（Claude Code 一家）→ #518（#517 需求）→ #519（Kimi、Codex、Devin 翻译、`pnpm agents:sync`、文档，#517 关成完成）→ #520（放到最宽松：清单、`retiredDeny`、Kimi 改 auto）。
- 本机同步后各家自己的命令核过：`~/.claude/settings.json` 里 `defaultMode = auto`、allow 139 条、deny 0 条；`grok inspect` 读到 131 条、跳过 8 条它不认的（`NotebookEdit` 和 `PowerShell(gh:*)` 这类带括号的写法）；`kimi doctor` 通过；`codex execpolicy check` 对 `git`、`ssh`、`scp`、`kubectl`、`docker`、`sudo`、`rm -rf`、`cat`、`grep` 都放行。
- 同步工具测试 241 条过（含迁移旧拒绝、`retiredDeny`、一键命令的各条失败路径），`tsc`、biome 过。

## 还没定、还没验证的

- **Mirasim 里到底生效没有**：它起 CLI 时读不读 `~/.claude/settings.json` 没实测。他在 Mirasim 里开新会话、让 AI 跑一条 `ssh` 试，确认不被拦；被拦就把报错给 AI，再查它怎么起 CLI（有没有自己带模式参数）。
- Codex 没法写「所有命令」：`cmd /c`、`powershell -c` 这两个外壳前缀不在清单里，会走 Codex 自己的默认询问；要放开就把这两个前缀加进清单（改标准）。
- Devin 依据官方文档，本机没装、没实测；Gemini CLI、Antigravity 没装，装上后核过写法再接。
- 「换成 `bypassPermissions`」始终不同步：他要的是 auto，不是 bypass。
  - **2026-10-01 下午修正**：默认仍是 `auto`，但机器上自己设的 `bypassPermissions` 保留、只报不改；仓里的源文件仍拒收它。见下面「2026-10-01 下午的修正」。

## 2026-10-01 下午的修正（创始人拍）

- 原话：「我一般都是开启 `bypassPermissions` 模式的，如果按照我的用法，其实我不希望拦，或者 `auto` 拦小部分，`bypassPermissions` 都不拦，你觉得怎么做」。AI 给的推荐：仓里默认仍写 `auto`；同步时不再把机器上已有的 `bypassPermissions` 改回 `auto`（保留、只报一行）；`autoMode.allow` 加一条「从保险箱取凭证是日常」。他回：「**1,2 都照做**」。
- 落到哪：`packages/agents-sync/src/permissions.ts`（机器上自己设的 `bypassPermissions` 保留，源文件写 bypass 仍拒收）；`agents/config/claude-permissions.json` 的 `autoMode.allow` 加「取凭证走保险箱」；`docs/agents-permissions.md` 跟着改。
- 没变的：仓里默认仍是 `auto`，仓里的源文件**仍不许写** `bypassPermissions`——那份会装到法国那台无人值守的引擎上，放行它等于把「不用问」推给每一台别人盯不到的机器。
- 这条不改上面的「撤回条件」：要收紧仍先找创始人。

## 2026-10-01 晚上再收窄：保险箱只放「我们自己的」（创始人拍）

- 原话：「韶关 3 号楼这一种根本就不需要存进我们的保险箱里。就是没有必要的东西，其实不应该存在保险箱里。」
- AI 理解：下午那条判准写的是「丢了以后除了创始人脑子里别处还有没有」，但把**别人家的现场凭据**（现场服务器 root、数据库账号）也算进了「放」那一栏——这跟判准本身矛盾：那种丢了跟现场要一份就有，**别处明明有**。收窄成「**我们自己有、丢了别处再也没有**」才算资产。
- 落到哪：`agents/config/claude-permissions.json` 的 `autoMode.allow` 那条删掉 `workstation/sites/`、写明「别人家的现场凭据不算」；`docs/agents-permissions.md` 跟着改；私有仓 `fleet-dao-vault` 删掉 `workstation/sites/`（commit `48f7deb`）。
- 现场凭据以后怎么拿：由创始人或现场给（当面，或别的正规途径），**不进保险箱**。

## 撤回条件

- 只有创始人能决定收紧：改 `agents/config/claude-permissions.json`（要撤的写进 `retired` 或 `retiredDeny`），PR 写「人闸：改标准」，他同意才合；各机器下一次同步才会摘掉。备份在各机 `~/.fleet-dao/backups/<时间>/`，手动撤回就把备份拷回原位。
- 出现「AI 在没人盯的图形界面里做了不可逆的事」（删数据、改了生产），先回退、再由创始人重新拍这条；本条不因为「可能出事」自动收紧。

## AI 先前说错、这里更正的

- 「Kimi 的 `auto` 是什么都不问、更接近 bypass，不许同步」：错。Kimi 文档写的是「不打断、自动判断」，和 Claude 的 `auto` 更接近；同步用 `auto`，`yolo`（该问才问）在没人点的界面会卡住。
- 调研员给的 Kimi 写法 `[permissions] allow/deny` 是网页摘要凭空来的；真实写法是顶层 `default_permission_mode` 加 `[[permission.rules]]`（先匹配的生效），已按官方页面核过。
- 「Grok 的 Agent、Workflow 也会被跳过」：错。本机实测它只跳过 `NotebookEdit` 和带括号的 `PowerShell(…)`。
- 「Grok、Devin 这台没装」：Grok 装了，Devin 没装。
- 「ssh、`curl` 别放 allow、交给审查员」：在 Mirasim 这类没人点确认的场景下不成立（审查员一拦就卡死），已按他的要求改成放开。
