# packages/conventions：约定写成的检查和脚本

协作约定写成代码：仓根的大部分 pnpm 命令（开单、开 PR、进度、计划、本机检查）、CI 的计划和汇总判法（CI 一律全套，决定 0101；本机按改动选）、合并闸、文档指针、欠账检查。三态纪律贯穿全包：认不出、读不到一律报出来或升成全跑，不拿「没改什么」「空」冒充没事。

## 入口

- `packages/conventions/src/bin/`：每个命令一个入口文件，逻辑在 `packages/conventions/src/` 同名模块里。仓根 `package.json` 的 `check`、`test:changed`、`pr:open`、`issue:new`、`issue:close`、`progress`、`plan`、`intents`、`debt:check`、`github:audit`、`branch:hygiene`、`ci:timings`、`ci:stats`、`flow:stats`、`subagent:stats` 都指到这里。
- `pr-open` 的同步 GitHub 运输用 `pr-arm.ts` 的 `livePrGh`：复用 `github-api.ts` 的仓身份识别，显式传 canonical repo；创建 PR 明确已推送当前分支，避免 Git relay 改写 remote 后让 gh 猜错仓。
- `check.ts`：`pnpm check` = biome 格式 + `tsc -b` + 改到的测试（`--all` 才全量）+ 卫生检查，四样跑完再判红。
- `local-vitest.ts`：Windows 的 `check`（含 `--all`）、`test:changed`、`test:linux` 共用执行入口。四个需要 Linux FD/进程语义的保全测试只能转交显式配置的本机 Linux 普通用户；当前工作树字节快照包含未提交/新文件，删除不复活。Linux 依赖须与当前锁文件和依赖声明一致，workspace 链接重指快照。无配置、摘要/测试清单对不上、报告缺失或跳过都明确失败；CI/Linux 仍直接跑原测试。
- `work.ts` 的派工归属复用入口动态加载的 `unattended.mjs/selectSessionId`；Claude session / Codex thread 接同步 Stop，只有 Codex root-session 不冒充 thread，缺归属仍保留结果供 `pnpm work runs` 读取。续跑不重绑原 spec（包括旧的 null），Codex 后台完成不主动开启新轮。
- `issue-batch.ts`：`pnpm issue:batch --spec <JSON>`，整批校验后建母子单、写 parent 并挂原生关系；失败关闭本批，创建结果不明按唯一标记找回。`--recover <记录>` 清理中断产物，记录生成在仓根临时目录的 issue-batch 子目录。GitHub 无跨单事务，撤销失败必须保留记录并报错。
- 只给 CI 用的（`.github/workflows/` 里调）：`ci-plan.ts`、`ci-box.ts`、`ci-cache.ts`、`ci-verdict.ts`、`main-reuse.ts`、`merge-gate.ts`、`close-on-merge.ts`、`debt-check.ts`、`github-audit.ts`（`--alarm` 红了开同一张「GitHub 对账没过」单，`audit-alarm.ts`）、`version-cut.ts`（版本一周一版、到期自动收口，`github-audit.yml` 的 version-cut 任务每天跑）。
- 查询轴词汇只在 `src/labels.ts`：`pnpm issue:new`、`pnpm pr:open` 显式带 `--domain engine|api|mirasim --nature bug|perf|process`。`src/bin/label-sync.ts` 和 `label-sync.yml` 同步六标签。`issue:batch` 母单必须提供 `domain`、`nature`，子单可逐轴继承母单有效值；整批写入前检查，缺失或无效就拒绝，原子补偿和恢复语义不变。固定流水线报警贴 engine/bug，引导和项目冒烟单贴 engine/process。`query-metadata.yml` 用可信默认分支代码处理创建/编辑/重开事件，只从当前标签、明确正文声明或唯一来源单补轴；写后回读，未知/冲突/读失败报错，不猜、不改排期。`github:audit` 检查两轴约定落地后的新 issue/PR，漏轴和冲突报断裂，PR 标签读失败报没查成。
- `packages/conventions/standard-paths.json`：改标准的路径清单（人闸第四类），**改它本身就是改标准**。
- `src/changelog.ts`（#3110）：完成关单按类别/性质生成版本节，固定交付物、兼容性、验证限制三尾；显式版本锚点幂等替换，临时 AI 运营不当产品条目。引擎每天补齐，里程碑只留链接和排期事实。
- `packages/conventions/test-timings.json`：CI 测试按耗时分台的耗时表，用 `pnpm ci:timings` 从 CI 日志刷新，别手改。

## 测试

- `npx vitest run packages/conventions/test/<文件>`。读仓里文件的检查都经 `packages/conventions/src/repo.ts` 的 `RepoView`，测试换成内存假仓（`test/helpers.ts` 的 `memRepo`）。
- `packages/conventions/test/doc-pointers.test.ts` 对全仓的活文档跑指针检查：design、ops、README、仓根和各包的 AGENTS.md、`docs/design/` 下的模块文件。

## 常见坑

- `plan-reader.ts` 给 `pnpm plan` 装配只读传输，`audit-client.ts` 给 `pnpm github:audit` 显式复用同一读取传输：gh 明确配置 socket 时经 `gh api --include --method GET`，不搬令牌；没有配置仍走原生 HTTP。数字仓号分页先经当前仓元信息核对 id 和 full_name，不能信 Link 自报身份。配置或进程真失败必须报没读成，不能静默换身份、匿名或直连；audit 的本机 socket 写入限定在对账需要的 issue、留言、里程碑、母子关系，JSON 经 stdin 发送，逐字段核真实回执；创建、更新、关闭失败或回执不符都报没查成。Actions 的 token 身份及其他 GitHub 读写入口保持原路径，不在 401 后切传输。
- `ci-policy-bridge.ts` 是 Actions 零安装的真实 HTTPS reader，只相对引用 shared 的纯协议文件。可信标准 App slug 查数字 Bot，逐 PR `fleet-ci-policy-source/pr/<号>` 选当前头最新可信 source；来源缺失 force，坏来源/读失败明确没查成，私有即时 force 不跟历史公开 URL。发表前重读 head/mode。不得加 caller mode、策略快照或旧 off fallback。
- `pnpm project check` 的第六步真 HTTP 读桥，caller 按生成模板精确识别；show 缺 mode/数字仓号等字段不猜。缺 source 报红，check 不写，add 才经受保护 `fleet-api project refresh-policy-source` 补齐；没有 PR 必须明说尚未验真实事件全链。

- `mother-manifest.ts` 严格读写母单正文 JSON 清单；`family-manifest.ts` 全量读含已关闭子单后按唯一清单修复正文与原生关系，多母认领先报冲突、不写。入口 `bin/github-audit.ts` 显式给 family reader/writer；原对账接口仍可只读。批量写清单失败走整批补偿；`issue:new --parent` 的清单失败须明说子单已开已挂，不能建议重开。
- 空母单只对批量创建标记报错，不按创建时间报警；目录母单允许空清单。parent 孤儿、字段与原生关系冲突和 manifest 差异仍须报告。
- `pnpm project check|add` 第二步（`project.ts` 的 `probeApps`）读装没装只经 `fleet-api project installations`（#2977，法国用两个机器人的 metadata:read 安装令牌，和导入列表同一份归并），不读本机 gh 的 `user/installations`；`parseInstallFacts` 逐字段严格认。「没查成」（非 0、ssh 超时、非 JSON、缺字段、`reason` 非空、仓号仓名对不上）是 unchecked、退出码 2，不当成没装、不退回本机 gh 猜、不补装；读全了明确不含才是「没装」（red），add 才走本机 gh 的单仓 PUT 补装。
- `pnpm project add` 第八步冒烟单（#2995）：有没有这张固定标题只信 issues 列表直接列全的结果，和 `createIssue` 回执单号的直接读取（GET）。搜索索引的空不算没有、也不算没开成；列单或直读失败是没查成（退出码 2），不去补开第二张；回执单号或标题对不上是明确失败，同样不补开。

- 测试读包外文件（别的包的源码、`docs/ops.md`、`AGENTS.md`、`deploy/` 脚本）要登记进 `packages/conventions/src/ci-plan.ts` 的 `PATH_RULES` / `TEST_READS`；`test/ci-plan.test.ts` 扫所有测试文件，漏记一条就红。
- CI 一律全套（决定 0101）：`ci.yml` 的 changes 只用 `ciFullPlan()`，不按改动选；只有两种跳过——PR 上测试台输入完全相同（`ci-cache.ts`）、主线同树复用 PR 的结果（`main-reuse.ts`，e2e 也复用）。别再往 CI 里加按路径少跑的规则：漏的东西到主线才红。汇总（`ciVerdict`）见到不是全套的 plan 就红。
- `ci-plan.ts` 的 `planCi` 现在只给本机：`test:changed`、推前预检按改动选先跑哪些，改了判法本机跟着变。
- `test:changed` 判需全跑时先认非空 `FLEET_RUN_ID`，再认 CI：引擎会话显式 `--affected` 生效，写码 CLI 注入的 `CI=true/1` 不覆盖它；无引擎标记的专用 CI、引擎默认和显式 `--all` 仍全跑。
- `src/test-slots.ts` 拿到本机测试槽就打印 `SLOT_ACQUIRED_LINE`（没排队也打印），引擎据此把等槽和实际执行分开计时。默认持槽上限 45 分钟，要盖住引擎 30 分钟测试执行预算和收尾，避免测试还活着时被回收、同机并发超过容量；普通 `test:changed` 和引擎测试共用这组槽。
- 只改一个包「对外面」以外的文件只测这个包自己（`packages/conventions/src/package-surface.ts`）；认不出面就当整个包都是面。
- 文档指针检查误报了就收窄 `packages/conventions/src/doc-pointers.ts` 的规则，不往文档里加豁免；章节别光写「第 X 节」，写明是 design 还是 ops 的。
- CI 里的检查必须确定、只看检出来的文件；看外部状态（GitHub）的放定时任务，只留言不挡 PR。
- 合并闸的策略 reader 只在核准仓身份、PR 号和精确 head 后返回结构化 closed；初算和发表前都跳过这种终态，不覆写已合旧头。换头、串仓、策略变化或读取失败仍报错。GitHub 的读取与写状态是分开的 API，最终读取后仍有非原子窗口。
- CI 由这几块组成（减法，2026-10-16）：`ci.yml` 的 `lint`（biome、tsc、文档指针、技能测试、deps、release_smoke 并行，加卫生检查——CI 里只在 lint 的这一步跑一处，文件树和 PR 历史两遍；本机 `pnpm check` 和 pre-push 钩子另有一份，是推之前的快反馈）、`test`、`web`、`e2e`（合并闸和发版闸，两种屏宽全套，不含隔离集）、`deploy`，PR 和主线都全跑，汇总 job `check` 的 needs 就是这几个。只报不挡或随时间变的挪去定时：`debt.yml`（欠账报告）和 `e2e-quarantine.yml`（隔离集 E2E）每天跑一次、可手动触发，都不再跟 push；`e2e-flaky.yml` 仍跟主线 ci 跑完统计偶发；`ci-rerun.yml` 在主线 ci 第一次运行（run_attempt=1）红了时重跑失败的 job 一次（#2747，`test/ci-rerun.test.ts` 钉着只认 ci、只重跑一次）。

## 改它时要连带改

- 加改 pnpm 命令：仓根 `package.json` + `README.md`「常用」；常用的那几条还要改仓根 `AGENTS.md` 的命令表。
- 改 CI：`packages/conventions/src/ci-plan.ts` 和 `.github/workflows/ci.yml` 要对得上（汇总 job 逐个核对该跑的跑了）。
- 改 `docs/ops.md` 里生成的表（端口、用户、目录、单元、密钥）：`node packages/conventions/src/bin/ops-tables.ts --write` 重新生成，`--check` 核对。
- 改开单、关单、PR 栏目的规矩：同步 design 第七节和 `README.md`「常用」。

- `issue:close` 和 `close-on-merge` 收尾都现读数据库最终验收责任；`--note`、Bot 评论不能替代结清。Actions 从可信 engine App 的精确 PR/head policy-source 找只读口，本机复用已安装的 local-sessions 地址。没读成明确退出 2、不关单。

- 对外仓引导（#3109）由 repo-kind 按 INIT_CWD 判，原话只从 prompt-log/stdin 进私有待传目录和 quote 管理链，公开文件、开单及收件箱迁移回写只用 meaning；缺 meaning 先拒绝。同编号回执精确确认才删待传，后台失败留明确提醒。协议在 shared 的 private-quotes.ts 零依赖叶子，conventions 相对导入保持同步检出零安装可用。

- 本机显式退回协议在 `managed-feedback.ts`，GitHub事务装配在 `managed-feedback-github.ts`，work入口在 `managed-work.ts`；只接受可信 Actions Bot 的 COMMENTED 明确协议，普通评论、法国正式 CR、coldVerify 和验收责任账互相独立。普通重算由 `merge-gate.yml` 执行，退回事务由 `managed-feedback.yml` 执行；两份工作流的写者必须共用 `merge-gate-${{ github.repository }}-pr-${{ matrix.pr }}` 精确 PR concurrency group，保持 `queue: max`、`cancel-in-progress: false`。批量入口只由 plan 列出 PR、交给 matrix 逐 PR 写，不能另开 all 写者或让本机直接写状态。排队不算阻合，ack不算resolve，读取失败保留未知责任。
