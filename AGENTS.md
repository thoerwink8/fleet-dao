# fleet-dao 协作约定

<!-- repo-contract:skip progress 创始人引导记在置顶进度单（pnpm progress directive），docs/PROGRESS.md 不放那一节 -->

通用规矩在 `agents/shared-rules.md`（同步进每台机器的全局说明），这份只写本仓。词义固定：单＝GitHub issue；主线＝origin/main；法国＝法国 VPS 上的引擎；本机＝创始人的电脑；创始人＝仓的主人；项目＝驾驶舱的顶层（一个项目一个仓）。

目标看 `docs/goals.md`，设计看 `docs/design.md`；改驾驶舱界面先读 `docs/design/驾驶舱界面.md`；账号被封了清痕迹只看 `docs/reclaude.md`。

## 进度和单
- 进度记在置顶单 #1055：`pnpm progress note "一句话"`；创始人的引导和决定当场 `pnpm progress directive "原话" --at "时间"`，办完 `pnpm progress done <评论号>`，无主的先 `pnpm progress claim <评论号>`；接手先 `pnpm progress read`。
- 计划以 GitHub 为准，`pnpm plan` 现读。创始人开的单进当前版本；AI 发现的不急的开小单进未排期，告诉他排第几。
- 需求写在单上，四节：场景、原话、已知的模块、怎么算做完；用 `pnpm issue:new` 开（参数见它报错里的用法，本机做的加 `--local`）。要写方案才写，放 `specs/<编号>-<短名>/`，不改已有的。
- 引擎自己挑单，进队条件见 `docs/design.md` 第九节。要它接：四节齐、范围写死、验收条写成 diff 里看得见的、不贴「本机做」「待补」「要人拍」。引擎不直写主线，它的单它自己关。

## PR
- `pnpm pr:open` 开 PR，当场挂自动合并（改标准的除外）；只看 CI，红了才回来修。关单：最后一个 PR 的「需求」栏下另起一行写 `Closes #号`，没有 PR 的用 `pnpm issue:close`。谁开谁负责到合并。
- 推之前本机只跑改到的测试文件（`npx vitest run <文件>`）加格式和类型检查，其余交给 CI。后端 Node 22 直接跑 TypeScript，相对导入带 `.ts`。

## 改标准
改到 `packages/conventions/standard-paths.json` 列的路径就是改标准；技能脚本、同步工具的代码修 bug 不算。创始人在对话里选定了算同意：`pnpm pr:open --founder-quote "<原话>" --at "<时间>"`，PR「需求」栏下面写「人闸：改标准」并贴他的原话和时间，直接挂自动合并；他没见过的内容才等他。不认 GitHub 账号的批准（本机 gh 登的是创始人账号）。`agents/config/claude-permissions.json` 的 `autoMode` 两个数组都要带 `"$defaults"`，少了内置安全规则整段被换掉。

## 其他
- 主线绿了法国自动发版。先改仓库、合进主线，再落到法国，不在机器上手改。本机只做断链急修、要本机资源的、指挥官本职，其余给法国。
- 已上线的真问题先回退再修；主线必过检查红了立刻修，修复 PR 写清是哪次合并弄坏的。CI 里的检查必须确定、只看检出来的文件，看外部状态的放定时任务、只留言不挡 PR。
- 公开仓：卫生检查只拦真密钥（pre-push 挡）。
