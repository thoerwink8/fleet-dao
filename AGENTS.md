# fleet-dao 协作约定

所有仓通用的规矩在 `agents/shared-rules.md`。同步脚本（`packages/agents-sync`）把它写进每台机器上各家 AI 的全局说明。没有全局说明的工具（Cursor CLI、zcode）先读它。这份只写本仓的规矩。

<!-- repo-contract:skip entry 本机不起引擎和驾驶舱：它们跑在法国、按 docs/ops.md 发布；本仓的命令入口是 pnpm plan、pnpm pr:open、pnpm progress:* 这一套 -->
<!-- repo-contract:skip progress 创始人引导记在进度单 #1055（决定 0014），docs/PROGRESS.md 不许有那一节（agents/test/progress-structure.test.ts 钉着） -->

写法：一句话只说一件事。一个词只有一个意思：单＝GitHub issue；主线＝origin/main；法国＝法国 VPS 上的引擎；本机＝创始人的电脑；创始人＝仓的主人；项目＝驾驶舱的顶层，一个项目就是一个仓。

## 本仓（fleet-dao）

### 目标和流程
- 要干成什么看 `docs/goals.md`，设计看 `docs/design.md`，流程照 `specs/509-需求梳理/流程重做方案.md`（决定 0010）。可以无人值守推进。
- 改驾驶舱界面先读 `docs/design/驾驶舱界面.md`，`lint-design` 测试守着。
- 账号被封了清痕迹只看 `docs/reclaude.md`（创始人说「〈编号〉账号被封了，根据文档清理痕迹」）。

### 进度
- 进度记在 GitHub 置顶单 #1055：`pnpm progress:note "一句话"`。创始人的引导和决定当场 `pnpm progress:directive "原话" --at "时间"`，办完 `pnpm progress:done <评论号>`，无主的先 `pnpm progress:claim <评论号>` 认领；接手先 `pnpm progress:read`。

### 引擎怎么接活
- 引擎自己挑单（#1335）：进队条件、老单整理、排队、限速写在 `docs/design.md` 第九节，代码管着。要它接：四节齐、范围写死、验收条写成 diff 里看得见的（#1150）、不贴「本机做」「待补」「要人拍」。
- 引擎不直写主线，它的单它自己关；它开的 PR 不写 `Closes`（写了会被当成叫停）。在 fleet 流程里干活用 `fleet` 命令汇报、提问、交活（`fleet --help`）。
- 主线绿了法国自动发版（头的 CI 绿、满 1 小时、没有发版在走或卡住，决定 0088），驾驶舱按钮照常能点；发完开关恢复到发版前。

### 计划和单
- 计划以 GitHub 为准，`pnpm plan` 现读，仓里不存副本。里程碑＝版本，没挂＝未排期。母单贴「母单」标签，子单用子议题挂在母单下。
- 不加优先级标签：版本里母单和单独的单排在里程碑说明的 `<!-- fleet:order -->` 标记之间，子单在母单页面排。创始人开的单进当前版本（受版本预算约束）；AI 发现的不急的开小单进未排期，告诉他排第几。
- 需求写在单上，四节：场景、原话、已知的模块、怎么算做完；做成了什么写在 PR 里。方案要写才写，放 `specs/<编号>-<短名>/方案.md`；不改 specs/ 里已有的需求和结果。
- 开单用 `pnpm issue:new`，带 `--kind` 和 `--milestone`（版本全名、`v<N>` 或 `未排期`）；母单 `--mother`，子单 `--parent <母单号>`，本机做的开单时就加 `--local`（事后补贴不管用，母单不贴）。见到缺类别或里程碑的当场补。引擎对账的巡检单、演练的假单除外。
- 会话里的临时垫片（不在仓里的巡查、队列、页面生成）挂在替代它的单上，单号写在两边；替代的那一层上线就删。

### PR
- 开 PR 用 `pnpm pr:open`，当场挂自动合并（改标准的除外）。所有 PR 只看 CI（决定 0023），全绿由 GitHub 合；不轮询、不手动合、不 `--watch`，红了才回来修，冲突了并主线。
- 合并闸 `merge-gate` 只判引擎分支有没有通过的 `cold-verify`，细则和各项目「强制 CI」开关见 `docs/design.md` 第五节、第九节；别往闸里加别的，`merge-gate-inputs.test.ts` 会拦。
- 关单：最后一个 PR 在「需求」栏下另起一行写 `Closes #<号>`。没有 PR 的收尾用 `pnpm issue:close <号>`，带证据（合并的 PR 提到它、子单都关了，或 `--note "做成了什么"`），不直接用 gh。
- 谁开的 PR 谁负责到合并：「做完」＝合进去且单关了，或交接给指挥官写清卡在哪。一个 PR 最多 3 轮，超了交接。

### 改标准（人闸第四类）
- 改到 `packages/conventions/standard-paths.json` 列的路径就是改标准；技能脚本、同步工具的代码修 bug 不算。
- 这种 PR 正文「还欠什么」写「人闸：改标准」。创始人在对话里选定了算同意：正文贴原话和时间，直接挂自动合并；他没见过的内容才等他。不认 GitHub 账号的批准（本机 gh 登的是创始人账号）。
- `agents/config/claude-permissions.json` 管 `autoMode`，同步进 `~/.claude/settings.json`；两个数组都要带 `"$defaults"`，少了那一类内置规则（强推、`curl | bash`、生产发布、防外传）整段被换掉，同步工具会拒收。

### 本机和法国怎么分活
- 和创始人对话的会话就是指挥官：记决定、派活、开 PR、报进度照 `commander` 技能做；子代理三个角色的定义只在 `agents/subagents/`（决定 0087）。
- 本机只做三类：断链急修（含法国坏了修不了自己）；要本机资源的（本机配置和同步、浏览器登录态、创始人的账号和设备、指挥官的工具）；指挥官本职。其余都给法国。
- 先改仓库、合进主线，再由自动发布（或 france.sh）落到法国，不在机器上手改；法国环境文件该是什么写在 `deploy/france/desired-config.json`。
- 通用段、`agents/` 下的技能和钩子合进主线后，开会话钩子自己同步到各台机器；要现在同步或看结果跑 `pnpm agents:sync`（`--check` 只读）。法国跟着自动发布同步（`docs/ops.md` 第九节）。

### 推之前怎么检查
- 本机只点名跑改到的和新加的测试文件（`npx vitest run <文件…>`，一次一条），再跑格式和类型检查；不跑 `pnpm test:changed`、整包或全量 `pnpm check`，其余交给 CI。卫生检查交给推前钩子。
- 后端用 Node 22 直接跑 TypeScript，相对导入带 `.ts` 后缀。

### 坏了怎么修
- 已上线的真问题先回退再修。主线必过检查红了立刻修，修复 PR 写清是哪次合并弄坏的。CI 里的检查必须确定、只看检出来的文件；看外部状态的放定时任务，只留言不挡 PR（#299）。

### 卫生和公开仓
- 公开仓：账号、组织编号、邮箱、IP 不算泄漏。卫生检查（`packages/hygiene`）只拦私钥、令牌、密码这类真密钥：pre-push 挡，引擎推分支、开单和 PR 前自己扫，CI 的 hygiene job 只报不挡。它只管 fleet-dao（认仓在 `packages/github/src/hygiene-scope.ts`，认不出报错）；真该放行的写进白名单并写理由。

### Jev
- Jev 是流程里答选择题的小模型（`packages/jev`：错误分流、停滞预判、issue 归类，只记不拦），见 `docs/design.md` 第十一节、`judge-or-code` 技能。
