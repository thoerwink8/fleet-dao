# packages/conventions：约定写成的检查和脚本

协作约定写成代码：仓根的大部分 pnpm 命令（开单、开 PR、进度、计划、本机检查）、CI 的计划和汇总判法（CI 一律全套，决定 0101；本机按改动选）、合并闸、文档指针、欠账检查。三态纪律贯穿全包：认不出、读不到一律报出来或升成全跑，不拿「没改什么」「空」冒充没事。

## 入口

- `packages/conventions/src/bin/`：每个命令一个入口文件，逻辑在 `packages/conventions/src/` 同名模块里。仓根 `package.json` 的 `check`、`test:changed`、`pr:open`、`issue:new`、`issue:close`、`progress`、`plan`、`intents`、`debt:check`、`github:audit`、`branch:hygiene`、`ci:timings`、`ci:stats`、`flow:stats`、`subagent:stats` 都指到这里。
- `check.ts`：`pnpm check` = biome 格式 + `tsc -b` + 改到的测试（`--all` 才全量）+ 卫生检查，四样跑完再判红。
- `issue-batch.ts`：`pnpm issue:batch --spec <JSON>`，整批校验后建母子单、写 parent 并挂原生关系；失败关闭本批，创建结果不明按唯一标记找回。`--recover <记录>` 清理中断产物，记录在 `_tmp/issue-batch/`。GitHub 无跨单事务，撤销失败必须保留记录并报错。
- 只给 CI 用的（`.github/workflows/` 里调）：`ci-plan.ts`、`ci-box.ts`、`ci-cache.ts`、`ci-verdict.ts`、`main-reuse.ts`、`merge-gate.ts`、`close-on-merge.ts`、`debt-check.ts`、`github-audit.ts`（`--alarm` 红了开同一张「GitHub 对账没过」单，`audit-alarm.ts`）、`version-cut.ts`（版本一周一版、到期自动收口，`github-audit.yml` 的 version-cut 任务每天跑）。
- `packages/conventions/standard-paths.json`：改标准的路径清单（人闸第四类），**改它本身就是改标准**。
- `packages/conventions/test-timings.json`：CI 测试按耗时分台的耗时表，用 `pnpm ci:timings` 从 CI 日志刷新，别手改。

## 测试

- `npx vitest run packages/conventions/test/<文件>`。读仓里文件的检查都经 `packages/conventions/src/repo.ts` 的 `RepoView`，测试换成内存假仓（`test/helpers.ts` 的 `memRepo`）。
- `packages/conventions/test/doc-pointers.test.ts` 对全仓的活文档跑指针检查：design、ops、README、仓根和各包的 AGENTS.md、`docs/design/` 下的模块文件。

## 常见坑

- 测试读包外文件（别的包的源码、`docs/ops.md`、`AGENTS.md`、`deploy/` 脚本）要登记进 `packages/conventions/src/ci-plan.ts` 的 `PATH_RULES` / `TEST_READS`；`test/ci-plan.test.ts` 扫所有测试文件，漏记一条就红。
- CI 一律全套（决定 0101）：`ci.yml` 的 changes 只用 `ciFullPlan()`，不按改动选；只有两种跳过——PR 上测试台输入完全相同（`ci-cache.ts`）、主线同树复用 PR 的结果（`main-reuse.ts`，e2e 也复用）。别再往 CI 里加按路径少跑的规则：漏的东西到主线才红。汇总（`ciVerdict`）见到不是全套的 plan 就红。
- `ci-plan.ts` 的 `planCi` 现在只给本机：`test:changed`、推前预检按改动选先跑哪些，改了判法本机跟着变。
- 只改一个包「对外面」以外的文件只测这个包自己（`packages/conventions/src/package-surface.ts`）；认不出面就当整个包都是面。
- 文档指针检查误报了就收窄 `packages/conventions/src/doc-pointers.ts` 的规则，不往文档里加豁免；章节别光写「第 X 节」，写明是 design 还是 ops 的。
- CI 里的检查必须确定、只看检出来的文件；看外部状态（GitHub）的放定时任务，只留言不挡 PR。
- CI 由这几块组成（减法，2026-10-16）：`ci.yml` 的 `lint`（biome、tsc、文档指针、技能测试、deps、release_smoke 并行，加卫生检查——CI 里只在 lint 的这一步跑一处，文件树和 PR 历史两遍；本机 `pnpm check` 和 pre-push 钩子另有一份，是推之前的快反馈）、`test`、`web`、`e2e`（合并闸和发版闸，两种屏宽全套，不含隔离集）、`deploy`，PR 和主线都全跑，汇总 job `check` 的 needs 就是这几个。只报不挡或随时间变的挪去定时：`debt.yml`（欠账报告）和 `e2e-quarantine.yml`（隔离集 E2E）每天跑一次、可手动触发，都不再跟 push；`e2e-flaky.yml` 仍跟主线 ci 跑完统计偶发；`ci-rerun.yml` 在主线 ci 第一次运行（run_attempt=1）红了时重跑失败的 job 一次（#2747，`test/ci-rerun.test.ts` 钉着只认 ci、只重跑一次）。

## 改它时要连带改

- 加改 pnpm 命令：仓根 `package.json` + `README.md`「常用」；常用的那几条还要改仓根 `AGENTS.md` 的命令表。
- 改 CI：`packages/conventions/src/ci-plan.ts` 和 `.github/workflows/ci.yml` 要对得上（汇总 job 逐个核对该跑的跑了）。
- 改 `docs/ops.md` 里生成的表（端口、用户、目录、单元、密钥）：`node packages/conventions/src/bin/ops-tables.ts --write` 重新生成，`--check` 核对。
- 改开单、关单、PR 栏目的规矩：同步 design 第七节和 `README.md`「常用」。
