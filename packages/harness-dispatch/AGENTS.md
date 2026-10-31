# packages/harness-dispatch：新内核的派工层

决定 0124 的新内核（母单 #3770，第 3 片 #3775）里把指挥官的 `spawn_worker` 变成跑着的工人、再机械核验交回的那一层。收请求读 `harness-api` 写的事件，排活和领活用 `harness-store` 的调度器，起工人用 `harness-workers`，所有子进程只经 `harness-runner` 的 `runProcess`（`src/command.ts` 的 `runCommand` 是它上面的薄壳）。不依赖旧包。

## 不变量

- 收请求（`intake.ts`）从 `fleet2.projection_checkpoints` 的检查点往后分页读 `worker.spawn.requested`，读页、排活、推检查点在同一个事务里；活的键 `spawn:<事件号>`，同一会话同一 `taskId` 再来也只算一次（命令回执），检查点丢了重读、并发收两遍都不会出第二个工人。队列 `worker` 必须先 `init()` 登记限速，默认同时 1 个。
- 活的截止时刻含排队时间（默认 12 小时）；工人的绝对截止时刻 = 活的截止时刻减核验留的时间，预算比剩下的长就按 `BudgetTooLongError` 终局，不默默截短（A4）。
- 工人令牌每个工人现发（角色 `worker`，会话号 `worker-<runId>`，不写指挥官的流），工人一退出就撤销，核验时已经是撤销的。令牌只进工人的 MCP 配置文件，不进命令行。
- 租约靠 `heartbeat` 续：回 `cancelled` 叫停工人（原因种类 `user-stop`，写进 `killed.detail`）；回 `lost` 也叫停，且不写交回（活已经是别人的）；库连不上超过一个租约时长按 `lost` 算。指挥官的 `worker.stop.requested` 经 `intakeStopRequests` 取消对应的活。
- 交回先机械核验再记账，不让模型判（`verify.ts`）：`git diff --numstat` 对基线（含未跟踪文件）、越界路径（`allowedPaths` / `forbiddenPaths`，不许做里 `路径：xxx` 行也算禁止）、检查命令退出码。四态 `unverified | passed | failed | unknown`：工人没干净交活或越界或检查失败是 `failed`；有探测没跑成是 `unknown`，永远不当 `passed`；没改动、或既没范围又没检查命令是 `unverified`。核验在工人的工作目录里跑，那里的 git 配置和检查命令都是工人写的，所以走无凭据的工人环境、关掉 `core.fsmonitor`、diff 不跑外部程序。
- 每次尝试结束记一条 `handback.recorded` 进指挥官的流 `session:<号>`（`runId`、`attempt`、`final`、`outcome`、`verdict`、`reasons`、证据：工人退出码/叫停原因/停在哪一步、diff 统计、越界路径、检查退出码和输出末尾、工人自己交的话），整条递归过脱敏器（H1），再 `completeJob`。工人自己交的话只当参考，不参与判定。
- 只有确定没副作用的失败才退避重试（`retryJob`）：进程没起来、起步无进展、影子自检没过、工作环境没建成；记一条 `final: false` 的交回。别的（超时、被叫停、退出码非 0）记终局交回就停。
- 调度器直接收成 `dead` 的活（排队时过了截止、领到 `max_attempts` 的毒活）不经 `processJob`：领活时经 `claimJobs` 的 `onDead` 在同一个事务里记终局交回（`outcome: dead`、`verdict: unknown`、原因取 `lastError`），收件箱不少一件；记不进去整次领取回滚。
- 崩溃后重领不盲重派：重领时若已有终局交回，只补 `completeJob`；若上一次的 `worker:<runId>` 流有 `worker.spawned` 却没有对应交回，说明派工器在中途死了、工人做到哪不知道，记 `unknown` 的终局交回就停。
- 影子自检的真实探测（`shadow-probes.ts`，接 `harness-workers` 的 `ShadowProbes`）：影子工人和会话用户同一个用户，家目录里的推送凭据（`.git-credentials`、`gh` 的 `hosts.yml`、`.netrc`、`.ssh/id_*`）和全局 git 凭据助手工人都拿得到，有一样就没过；出网规则看 `fleet2-shadow-firewall.service` 在跑且出网关的口连得上；outbox 装了任何真实处理器就没过。查不了一律 `unknown`。
- 影子派工（#3808）：`shadow-driver.ts` 给冻结批次里没派过的单往 `shadow-<批次>` 会话流写派工请求，带 `shadow`（批次、仓、单号、基线）；回执和请求在同一个事务里写，同一张单只出一条。指挥官的 `spawn_worker` 入参只有六项，带不进 `shadow`。`shadow-workspace.ts` 从本机裸镜像 `<镜像根>/<仓>.git` 以 `clone --shared --no-checkout` 加 `checkout --detach` 建到基线（自带 .git：工人以会话用户跑时写不了镜像，#3814），没带 `shadow` 的请求不建；镜像不在就从 GitHub 匿名 https 建（先建到临时名再改名）、缺基线提交就拉各分支，不带令牌所以只认公开仓（#3811）；给了 sandbox 就把建好的目录交给会话用户，cleanup 按回执删。终局交回记完后经 `Workspace.collect` 抓补丁写 `shadow_runs`：索引拷一份到内核自己的临时目录（`GIT_INDEX_FILE`），对象库也换成那里的（`GIT_OBJECT_DIRECTORY`；`add -N` 也写空 blob），工人的对象库只当备用库读，不往工人的 .git 里写任何东西。补丁只存库里，不建分支、不推。内核以 fleet 读会话用户的目录，核验和抓补丁的 git 都带 `safe.directory=*`。
- 新内核进程（#3811，`kernel.ts`，入口 `src/bin/kernel.ts`）：一个进程里起接口层（只听回环、影子模式）和派工器，按节拍对还没收完的批次跑影子驱动、领活、`sweepCompare` 评分、`shadowSilence` 静默报警（打 `{"alert":"shadow-silent",…}`）；每一步出错只记错，不挡别的步、不退出。outbox 一个真实处理器都不装。读 GitHub 只经 `github-read.ts`：只发 GET 和 GraphQL 查询，令牌只在内核进程里。配置全从环境变量来，见入口文件开头；法国上 `FLEET2_SANDBOX=scope`（`scope-sandbox.ts`：经 `sudo -n fleet-agent-scope` 的 adopt / remove / stop，协议照抄旧 `adapters/src/tree-cleanup.ts`，每次先问能力、删时带 adopt 回执的身份）、执行体前缀 `deploy/france/fleet2-worker.sh`（经 `fleet-agent-scope run fleet2-<编号> --slice fleet2-shadow` 以会话用户起 reclaude）。
- 提示词（`prompt.ts`）：指示类字段在块外，`context` 只出现在带随机标记的资料块里，块尾标记伪造不了（SEC1）。

## 没做的

- 重启后上一代遗留的工人进程由 `harness-runner` 的孤儿清扫处理，这里不管。
- 工作环境怎么建（克隆、worktree、基线）由部署传进来的 `prepareWorkspace` 决定；`.gitignore` 掉的文件和仓外写入看不到，范围外写要靠影子用户的文件权限兜。

## 测试

- `npx vitest run packages/harness-dispatch`：PGlite 跑 `fleet2` 真迁移；`test/fake-worker.mjs` 按 `FAKE_MODE` / `FAKE_WRITE` 改临时 git 仓里的文件并留下提示词和令牌；核验用真 git。
- 对应旧坑 A（时限和叫停原因）、H1、SEC1、S/O（重复、重启、租约）。真 reclaude、真 MCP 服务的联调在法国真机，见 #3775。
