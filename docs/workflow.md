# 本仓怎么协作（细则）

仓根 `AGENTS.md` 只当目录，这里是它指过来的细则：进度和单、PR、改标准、发版和底线。通用规矩在 `agents/shared-rules.md`；目标看 `docs/goals.md`。

词义固定：单＝GitHub issue；主线＝origin/main；法国＝法国 VPS 上的引擎；本机＝创始人的电脑；创始人＝仓的主人；项目＝驾驶舱的顶层（一个项目一个仓）。

## 进度和单

- 创始人的引导和决定当场 `pnpm progress directive` 记下，接手先 `pnpm progress read`；认领、办完、进度流水的全套见 `docs/directives/README.md`。
- 计划以 GitHub 为准，`pnpm plan` 现读。创始人开的单进当前版本；AI 发现的不急的开小单进未排期，告诉他排第几。
- 需求写在单上，四节：场景、原话、已知的模块、怎么算做完；用 `pnpm issue:new` 开（参数见它报错里的用法，本机做的加 `--local`）。一个队列（GitHub 单）、一本账、两种执行者，默认开单给法国，开完顺手戳法国立刻接；只有讨论中的、急修、要本机资源的、改标准的四类才贴 `--local` 留本机（决定 0096）。要写方案才写，放 `specs/<编号>-<短名>/`，不改已有的。
- 引擎自己挑单、自己关单，不直写主线；单要写成什么样它才接，见 `packages/engine/AGENTS.md`。

## PR

- `pnpm pr:open` 开 PR，当场挂自动合并（改标准见下）；只看 CI，红了才回来修。谁开谁负责到合并。
- 关单：最后一个 PR 的「需求」栏下另起一行写 `Closes #号`；没有 PR 的用 `pnpm issue:close`。
- 推之前本机只跑改到的测试文件（`npx vitest run <文件>`）加格式和类型检查，其余交给 CI。后端 Node 22 直接跑 TypeScript，相对导入带 `.ts`。
- 改了哪个包的入口、命令、坑，顺手改那个包的 `AGENTS.md`。全部 pnpm 命令见 `README.md`。

## 改标准

- 四类人闸：对外发布、花钱、删数据、改标准。改标准＝改到 `packages/conventions/standard-paths.json` 列的路径；技能脚本、同步工具的代码修 bug 不算。为什么这样分见 design 第五节「人闸第四类：改标准」。
- 创始人在对话里选定了算同意：`pnpm pr:open --founder-quote "<原话>" --at "<时间>"`，PR「需求」栏下写「人闸：改标准」并贴原话和时间，直接挂自动合并；他没见过的内容才等他。不认 GitHub 账号的批准（本机 gh 登的是创始人账号）。
- `agents/config/claude-permissions.json` 的 `autoMode` 两个数组都要带 `"$defaults"`，少了内置安全规则整段被换掉。

## 发版和底线

- 主线绿了法国自动发版。先改仓库、合进主线，再落到法国，不在机器上手改。本机只做断链急修、要本机资源的、指挥官本职，其余给法国。
- 已上线的真问题先回退再修；主线必过检查红了立刻修，修复 PR 写清是哪次合并弄坏的。CI 里的检查必须确定、只看检出来的文件，看外部状态的放定时任务、只留言不挡 PR。
- 公开仓：卫生检查只拦真密钥（pre-push 挡）。
