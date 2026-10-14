# fleet-dao 协作约定

<!-- repo-contract:skip progress 创始人引导一条一个文件记在 docs/directives/（pnpm progress directive），docs/PROGRESS.md 不放那一节 -->

这份是目录：一屏读完，细则去下面指到的地方读，用到哪份读哪份。通用规矩在 `agents/shared-rules.md`（同步进每台机器的全局说明），这份只写本仓。

## 仓是什么

创始人的 AI 研发流水线：法国 VPS 上的引擎（Temporal 工作流）按单派各家订阅 CLI 写码、开 PR、合并，主线绿了自动发版；驾驶舱（后端 `packages/api`、前端 `packages/web`）给人看和插手；本机跑指挥官会话。目标看 `docs/goals.md`，为什么这样定看 `docs/design.md`，目录结构看 `README.md`。

词义固定：单＝GitHub issue；主线＝origin/main；法国＝法国 VPS 上的引擎；本机＝创始人的电脑；创始人＝仓的主人；项目＝驾驶舱的顶层（一个项目一个仓）。

## 只有四类事要创始人点头

对外发布、花钱、删数据、改标准。

- 改标准＝改到 `packages/conventions/standard-paths.json` 列的路径；技能脚本、同步工具的代码修 bug 不算。
- 创始人在对话里选定了算同意：`pnpm pr:open --founder-quote "<原话>" --at "<时间>"`，PR「需求」栏下写「人闸：改标准」并贴原话和时间，直接挂自动合并；他没见过的内容才等他。不认 GitHub 账号的批准（本机 gh 登的是创始人账号）。
- `agents/config/claude-permissions.json` 的 `autoMode` 两个数组都要带 `"$defaults"`，少了内置安全规则整段被换掉。
- 为什么这样分：design 第五节「人闸第四类：改标准」。

## 去哪找什么

| 要做的事 | 先读 |
|---|---|
| 改引擎（工作流、活动、派工、定时任务） | `packages/engine/AGENTS.md` |
| 改驾驶舱后端 / 前端 | `packages/api/AGENTS.md` / `packages/web/AGENTS.md`；改界面再读 `docs/design/驾驶舱界面.md` |
| 改表结构、迁移、路由默认值 | `packages/db/AGENTS.md` |
| 改 Store 契约（后端和引擎共用的读写层） | `packages/store/AGENTS.md` |
| 改检查、CI 计划、pnpm 脚本（开单、开 PR、进度） | `packages/conventions/AGENTS.md` |
| 别的包 | 它 `package.json` 的 `description`，再看 design 第四节「仓库结构」 |
| 装机、发版、运维、法国上的东西 | `docs/ops.md`（跟着 `deploy/` 一起改） |
| 拍板记录（一个决定一个文件） | `docs/decisions/README.md` |
| 创始人引导怎么记、怎么办完 | `docs/directives/README.md` |
| 生效中的临时调整 | `docs/PROGRESS.md` |
| 旧系统的坑和接线细节 | `docs/reference/README.md`（旧引擎那份已归档：`docs/archive/old-engine-audit.md`） |
| 账号被封了清痕迹 | 只看 `docs/reclaude.md` |
| 技能、钩子、各家 AI 的全局说明 | `agents/`（同步脚本 `packages/agents-sync`） |

## 进度和单

- 创始人的引导和决定当场 `pnpm progress directive` 记下，接手先 `pnpm progress read`；认领、办完、进度流水的全套见 `docs/directives/README.md`。
- 计划以 GitHub 为准，`pnpm plan` 现读。创始人开的单进当前版本；AI 发现的不急的开小单进未排期，告诉他排第几。
- 需求写在单上，四节：场景、原话、已知的模块、怎么算做完；用 `pnpm issue:new` 开（参数见它报错里的用法，本机做的加 `--local`）。要写方案才写，放 `specs/<编号>-<短名>/`，不改已有的。
- 引擎自己挑单、自己关单，不直写主线；单要写成什么样它才接，见 `packages/engine/AGENTS.md`「常见坑」。

## PR

- `pnpm pr:open` 开 PR，当场挂自动合并（改标准见上）；只看 CI，红了才回来修。谁开谁负责到合并。
- 关单：最后一个 PR 的「需求」栏下另起一行写 `Closes #号`；没有 PR 的用 `pnpm issue:close`。
- 推之前本机只跑改到的测试文件（`npx vitest run <文件>`）加格式和类型检查，其余交给 CI。后端 Node 22 直接跑 TypeScript，相对导入带 `.ts`。
- 改了哪个包的入口、命令、坑，顺手改那个包的 AGENTS.md。

## 最常用的命令

| 命令 | 干什么 |
|---|---|
| `pnpm install` | 装依赖（新工作树先跑） |
| `pnpm dev` | 本机起驾驶舱前端 mock，不要后端 |
| `pnpm start` / `pnpm stop` | 起停本机嵌入式 Postgres（要真库的测试先 start） |
| `npx vitest run <文件>` | 跑改到的测试文件 |
| `pnpm test:changed` | 跑改动影响到的测试（判出要全跑时交给 CI） |
| `pnpm format` / `pnpm typecheck` | biome 格式 / tsc 类型检查 |
| `pnpm check` | 格式 + 类型 + 改到的测试 + 卫生检查 |
| `pnpm pr:open` | 开 PR 并挂自动合并 |
| `pnpm issue:new` / `pnpm issue:close` | 开单 / 没有 PR 的收尾关单 |
| `pnpm progress read` / `pnpm plan` | 看创始人引导 / 看计划 |

全部命令和参数见 `README.md`「常用」。

## 其他

- 主线绿了法国自动发版。先改仓库、合进主线，再落到法国，不在机器上手改。本机只做断链急修、要本机资源的、指挥官本职，其余给法国。
- 已上线的真问题先回退再修；主线必过检查红了立刻修，修复 PR 写清是哪次合并弄坏的。CI 里的检查必须确定、只看检出来的文件，看外部状态的放定时任务、只留言不挡 PR。
- 公开仓：卫生检查只拦真密钥（pre-push 挡）。
