# packages/conventions：约定写成的检查和脚本

协作约定写成代码：仓根大部分 pnpm 命令（开单、开 PR、进度、计划、本机检查）、CI 的计划和汇总判法（CI 一律全套，决定 0101；本机按改动选）、合并闸、文档指针、欠账检查。三态纪律贯穿全包：认不出、读不到一律报出来或升成全跑，不拿「没改什么」「空」冒充没事。各模块的细节约束在文件头注释，这里只留跨文件的不变量。

## 去哪找

| 要找 | 位置 |
|---|---|
| 每个命令一个入口，逻辑在同名模块 | `src/bin/` → `src/`；仓根 `package.json` 的 `check`、`test:changed`、`pr:open`、`issue:new`、`issue:close`、`progress`、`plan`、`intents`、`debt:check`、`github:audit`、`branch:hygiene`、`ci:*`、`flow:stats`、`subagent:stats` 指到这里 |
| `pnpm check` | `check.ts`：biome + `tsc -b` + 改到的测试（`--all` 才全量）+ 卫生检查 + `specs:index --check`，五样跑完再判红；POSIX 每步经 `step-process.ts` 收进程组 |
| Windows 本机执行 | `local-vitest.ts`（`check`、`test:changed`、`test:linux` 共用；需 Linux 语义的测试只转交显式配置的本机 Linux 普通用户，无配置/对不上/跳过明确失败） |
| 只给 CI 用（`.github/workflows/` 调） | `ci-plan.ts`、`ci-box.ts`、`ci-cache.ts`、`ci-verdict.ts`、`main-reuse.ts`、`merge-gate.ts`、`close-on-merge.ts`、`debt-check.ts`、`github-audit.ts`、`version-cut.ts` |
| 查询轴词汇（`--domain`、`--nature`） | 只在 `src/labels.ts` |
| 改标准的路径清单 | `standard-paths.json`（改它本身就是改标准） |
| 测试分台耗时表 | `test-timings.json`，用 `pnpm ci:timings` 刷新，别手改 |
| 方案索引 | `specs-index.ts`：`specs/README.md` 由各方案主文件头的 `- 状态：` / `- 被取代：` 生成，规则写在文件开头 |
| 护栏库存（只报不挡） | `guard-inventory.ts`、`guards.json`；`bin/guard-inventory.ts` 由现有 audit 非阻断步骤写摘要，周一进 #1055。口径及限制见 `specs/3587-建议筛子/第一片落地.md`，细节看文件头 |
| 其它入口（`machine.ts`、`issue-batch.ts`、`work*.ts`、`temporal-test-server.ts`、`test:isolated` 等） | 各自文件头注释 |

## 必须守的不变量

- 读不到就如实报：GitHub、Temporal、读桥的读写失败是「没查成」（退出码 2 / unchecked），不当成没有、没装、已通过，不静默换身份、匿名或直连，不退回别的传输猜。
- CI 一律全套（决定 0101）：`ci.yml` 的 changes 只用 `ciFullPlan()`，不按改动选；只有两种跳过——PR 上测试台输入完全相同（`ci-cache.ts`）、主线同树复用 PR 的结果（`main-reuse.ts`）。不要往 CI 里加按路径少跑的规则（漏的东西到主线才红）；汇总 `ciVerdict` 见到不是全套的 plan 就红。`planCi` 只给本机（`test:changed`、推前预检）。
- CI 里的检查必须确定、只看检出来的文件；看外部状态（GitHub）的放定时任务，只留言不挡 PR。只报不挡的（`debt.yml`、`e2e-quarantine.yml`）每天跑，不跟 push。
- 改 CI：`ci-plan.ts` 与 `.github/workflows/ci.yml` 要对得上（汇总 job 逐个核对该跑的跑了）。
- 测试读包外文件（别的包源码、`docs/ops.md`、`AGENTS.md`、`deploy/` 脚本）要登记进 `ci-plan.ts` 的 `PATH_RULES` / `TEST_READS`；`test/ci-plan.test.ts` 扫所有测试文件，漏记就红。
- `test-split.ts` 的 `HEAVY_TESTS`（#3597，接 #3469）：重型 / 不确定测试名单，只此一处，每条写理由和真实超时记录（`#单号` 或 `run 运行号`，没有记录不许进，被邻居拖超时的受害者不收）。名单里的文件不进必过的 test 台（`assignTests` 排除，`testsProblem` 拦），改在 `ci.yml` 独立的 `heavy` job 串行（`--no-file-parallelism`）、可重试（`--retry=2`）地跑，每个 PR 和主线推送都跑；它不在 `check` 的 needs 里（`NON_BLOCKING_JOBS`），红了只让这个 job 红，不挡合并、不自动开单。发版要它绿：`release-train-lib.mjs` 的 `preflightCi` 读被发提交上的 `heavy`，红了、没跑、还在跑都不发。`NEVER_HEAVY`（`replay.test.ts`、`task-workflow.test.ts`）永远不许进名单。不靠加超时、删断言、跳用例解决。`needsPg` 只把明确列出的真实竞争测试放进 pg 台，不悄悄降成 PGlite。
- 测试槽 `src/test-slots.ts` 拿到槽就打印 `SLOT_ACQUIRED_LINE`（没排队也打印），引擎据此把等槽和执行分开计时；默认持槽上限 45 分钟，要盖住引擎 30 分钟测试预算加收尾。`test:changed` 判需全跑时先认非空 `FLEET_RUN_ID`（引擎会话显式 `--affected` 生效，写码 CLI 注入的 `CI=true` 不覆盖它）。
- 只改一个包「对外面」以外的文件只测这个包自己（`package-surface.ts`）；认不出面就当整个包都是面。
- 文档指针检查误报了就收窄 `doc-pointers.ts` 的规则，不往文档里加豁免；章节别光写「第 X 节」，写明是 design 还是 ops 的。
- 合并闸：策略 reader 只在核准仓身份、PR 号和精确 head 后返回结构化 closed，不覆写已合旧头；`runMergeGate` 写模式退出码只表达是否算成并发表（0/2），不重复 required status 的裁决；`merge-gate.yml` 与 `managed-feedback.yml` 的写者必须共用 `merge-gate-${{ github.repository }}-pr-${{ matrix.pr }}` concurrency group，保持 `queue: max`、`cancel-in-progress: false`（`test/ci-plan.test.ts` 钉着）；批量入口只由 plan 列 PR、matrix 逐 PR 写。
- `issue:close` 和 `close-on-merge` 不再读验收责任（#3630，决定 0113 第二片），只看受管工作的关单检查。`close-on-merge-gh.ts` 对写请求不重放，限流重试有 30 秒整轮预算。
- 新 PR 的需求行完成用 `Closes #号`，分片用 `Refs #号（分片、关不了它）`；手写正文的裸 Refs 在任何推送或 GitHub 写入前拒绝。`pr-open` 同步 GitHub 运输用 `pr-arm.ts` 的 `livePrGh`，显式传 canonical repo。
- 查询轴：`issue:new`、`pr:open` 显式带 `--domain engine|api|mirasim --nature bug|perf|process`；`issue:batch` 母单必须提供两轴，子单可逐轴继承，整批写入前检查；`query-metadata.yml` 不猜、不改排期。
- 母子单：`mother-manifest.ts` 严格读写正文 JSON 清单，批量写失败整批补偿；`issue:new --parent` 清单失败须明说子单已开已挂，不能建议重开。空母单只对批量创建标记报错。
- 通行证只在内存和子进程环境变量，所有输出先 `redact`（`machine.ts`）；对外仓引导里原话只进私有待传目录，公开文件和单只用 meaning。
- `pnpm project check|add`：装没装只信 `fleet-api project installations`（逐字段严格认，「没查成」退出码 2，不当没装）；冒烟单有没有只信列表直接列全和回执单号直读，搜索索引的空不算没有，回执对不上不补开第二张。`ci-policy-bridge.ts` 不得加 caller mode、策略快照或旧 off fallback，没收到响应头的网络失败重读一次，收到响应的不重读。
- 本机显式退回协议（`managed-feedback*.ts`、`managed-work.ts`）：只接受可信 Actions Bot 的 COMMENTED 明确协议；工人退出码成功但交付没核上时只退避复核不再起 CLI；issue 已关闭、伪造本分支 PR、待审查都不算交付；返工用 `pnpm work rework <单号>`，同一代次只起一个工人；不手写 state/result，不杀进程。

## 测试

- `npx vitest run packages/conventions/test/<文件>`。读仓里文件的检查都经 `src/repo.ts` 的 `RepoView`，测试换成内存假仓（`test/helpers.ts` 的 `memRepo`）。
- `test/doc-pointers.test.ts` 对全仓活文档（design、ops、README、仓根和各包 AGENTS.md、`docs/design/`）跑指针检查。
- 字符数上限：`test/agents-md-size.test.ts`（engine 10,000，conventions 与 api 各 8,000）。

## 改它时要连带改

- 加改 pnpm 命令：仓根 `package.json` + `README.md`「常用」；常用的还要改仓根 `AGENTS.md` 命令表。
- 改 `docs/ops.md` 里生成的表：`node packages/conventions/src/bin/ops-tables.ts --write`，`--check` 核对。
- 加改 `specs/` 下的方案：主文件标题下写 `- 状态：在做 | 做完 | 被取代 | 未复核`（被取代另加 `- 被取代：specs/<目录>`），跑 `pnpm specs:index` 一起提交。
- 改开单、关单、PR 栏目的规矩：同步 design 第七节和 `README.md`「常用」。
