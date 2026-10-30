# fleet-dao

创始人一个人加上手里多家 AI 订阅的派工系统。GitHub issue 就是需求：创始人和指挥官对话对题、建单，引擎接着起无头会话动手、验收，做到 PR 合进主线；订阅额度互不闲置，驾驶舱里看得见、管得住。

还在施工，各阶段做到哪看[里程碑](https://github.com/thoerwink8/fleet-dao/milestones)。下面只写每样东西在哪、管什么，不代表都做完了。

## 入口

- **驾驶舱**：域名只在机器配置里（香港 `/etc/fleet-dao/hk.env` 的 `FLEET_DOMAIN`），公开仓不写；健康页在 `/health/`。
- **飞书机器人 fleet-dao**：能做什么见 design 15.4。
- **GitHub issue**：用「需求」模板写一句话就行。

## 两台机器

法国干活、香港当门面。各跑什么、端口、用户、目录、怎么看健康、怎么回滚：[docs/ops.md](docs/ops.md)。

两台上还另跑着一个不归本仓管的私有项目 **self-proxy**（创始人自用的代理，2026-09-28 起）：单元 `self-proxy-*`、目录 `/etc/self-proxy`、`/opt/self-proxy`，香港还有 nginx 站点 `self-proxy` 和 `/srv/self-proxy-sub`；「法国-中转」借用本仓的隧道。端口见 ops 第二节端口表。本仓的装机脚本不装、不删它们，排查时也别动；唯一例外是香港 `/opt/self-proxy/src` 的属主和写权限（root 单元会执行里面的脚本，#2235，ops 第三节香港文件表），`hk.sh` 收成 root:root 并读回，内容不碰。

## 仓库地图

| 目录 | 是什么 |
|---|---|
| `packages/shared` | 各包共用的类型、校验和常量；包与包之间的接口约定在这 |
| `packages/core` | 三段流程用的纯判断：接活的几道关、任务简报、验证结论、提醒谁在处理；不碰网络和库，引擎、后端、网页、`fleet` 命令都调它判 |
| `packages/db` | Postgres 表结构、迁移、查询、渠道目录装载器 |
| `packages/engine` | 引擎：Temporal 工作流、失败分流与熔断、停滞判定 |
| `packages/adapters` | 渠道插头：无头起各家写码助手、读过程记录；各渠道的额度读取 |
| `packages/store` | 后端和引擎共用、不碰 HTTP 的那一层：Store 契约和两套实现（内存、Postgres）、GitHub 作者白名单、对账和进门的判法；只许 api、engine 依赖它，它不许依赖 api、engine |
| `packages/api` | 驾驶舱后端：登录、接口、实时推送、给工作流发信号、fleet 命令接口、收 GitHub 事件 |
| `packages/web` | 驾驶舱前端：看板和后台管理页面；本机假数据模式（`react-router dev --mode mock`）开发和截图用 |
| `packages/github` | 引擎对 GitHub 的读写：推分支、开 PR、等 CI、合并、issue 进度段与关单、对账补漏 |
| `packages/jev` | 流程里用来提速的判断环节（不是独立产品）：三道题的题库、提问接口、TypeSafe 后端，一律只记不拦 |
| `packages/conventions` | design 第七节的约定写成检查：合并闸 merge-gate（引擎任务 PR 等冷验收）、开单脚本、文档指针检查、欠账检查、阶段收口 |
| `packages/hygiene` | 公开仓卫生检查：全仓扫描和推送前的闸，只拦私钥、令牌、密码这类真密钥（账号、邮箱、IP 不拦） |
| `packages/agents-sync` | 同步脚本：把通用段 `agents/shared-rules.md`、`agents/skills/`、`agents/hooks/` 装进这台机器上各家 AI 的全局入口，记下这台同步到哪个提交，另能查漂移、撤旧仓留下的东西 |
| `agents/` | 给各家 AI 装的东西的原件：技能（`skills/`）、钩子（`hooks/`）、权限配置（`config/`），和钉住规矩的测试（`test/rules/`）；由 agents-sync 装出去 |
| `deploy/` | 装机、发版、健康页，和它们的检查 |
| `docs/` | 目标、设计、决定、运维、进度；`docs/reference/` 是旧系统的坑 |
| `specs/` | 方案文档（要写才写）和历史的需求、结果；需求在 GitHub 的单子里（#654） |

## 密钥和本机配置在哪

这是公开仓：私钥、令牌、密码这类真密钥一律不进；账号、组织编号、邮箱、IP 这类标识不算泄漏，不当密钥藏（创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md）。

- **服务器上**：`/etc/fleet-dao/`，不进 git；每个文件放什么见 ops 第三节（用户、目录、库）。
- **加密副本**：私有仓 [fleet-dao-vault](https://github.com/thoerwink8/fleet-dao-vault)，age 加密，一个文件一个 `.age`，仓里有密文、公钥和解密钥匙本身（明文，只靠那个私有仓和 GitHub 账号保护）。它只放**我们自己有、丢了别处再也没有**的东西：两台机器上的配置和密钥、自建 VPS 的订阅地址；别人家的现场凭据不进这里（丢了跟现场要一份就有）。在创始人电脑上跑那个仓里的 `bash refresh.sh` 刷新；怎么解开、机器没了怎么恢复、钥匙丢了怎么换（`bash rekey.sh`），见那个仓 README。
- **创始人电脑上**：`~/.fleet-dao/`，放解密钥匙 `vault-key.txt` 和 age；只有拿着这把钥匙的人解得开。钥匙还要抄一份进创始人的密码管理器。
- 数据库备份不在保险箱里，见 ops 第十一节「备份与恢复」。

## 常用

- 装机：ops 第四节（怎么跑装机脚本）。
- 发版：`deploy/release.sh`，见 ops 第九节（发布应用）。
- 仓根命令（仓合同 `entry`）：`pnpm dev` 在本机起驾驶舱前端的 mock 开发服务（`packages/web` 的 `dev:mock`，前台跑、Ctrl+C 停，不需要后端）；`pnpm start` / `pnpm stop` 起停本机要常驻的东西，目前只有嵌入式 Postgres（`pnpm pg:local start` / `stop`，脱离会话起，要真库的 e2e 先 start）；`pnpm check` 见下。本机不起引擎和驾驶舱后端，它们跑在法国。进度单用 `pnpm progress <note|directive|claim|done|read>`，对外仓引导带 `--meaning`、原文走私有处，补传用 `pnpm progress quotes:flush`（见 [创始人引导](docs/directives/README.md)）；本机会话上报用 `pnpm local-sessions <install|uninstall|status>`。
- 加一台机器：`pnpm machine join <编号> [--name 显示名] --url <法国看板地址> (--ssh <主机别名> | --token-stdin)` 一条命令发通行证、装本机会话上报、试推并试读租约（Windows、macOS 相同）；`pnpm machine issue|list|revoke` 发/列/作废，见 ops 第十三节「加一台机器」。
- 开发：`pnpm install`，Node 和 pnpm 的版本钉在 `package.json`；给 AI 的约定在 [AGENTS.md](AGENTS.md)。
- 跑检查：本机推前只跑改动影响到的测试（`pnpm test:changed`，和 origin/main 比、按 CI 那套判法选包，整个 `agents/test/` 只在它受影响时带、CI 每个 PR 照旧全跑，引擎的会话交活只认它；它判出要全跑时本机不跑、退出码 3，写明全量交给 CI，真要在本机全跑带 `--all`，只跑受影响的包带 `--affected`）和格式、类型；`pnpm check` 默认 = 格式 + 类型 + 改到的测试（同 `pnpm test:changed`，相对 origin/main）+ 卫生检查，四样都跑完再判红，每样报耗时，任何一样没跑成都算红；`pnpm check --all` 才全量 vitest run（本机要 8 分钟以上，和 CI 重复，一般不跑）。只改一个包的入口脚本、包内模块、测试（不在它 `exports`、`bin` 走得到的面上）时只测这个包自己，不连带依赖它的包（`packages/conventions/src/package-surface.ts`）。本机要真 Postgres 的（驾驶舱 e2e）先 `pnpm pg:local start`（Windows 嵌入式库，脱离会话起，见 `packages/web/e2e/README.md`）。CI 一律全套、并行跑，PR 和 main 都一样（`.github/workflows/ci.yml`，见 design 第五节「CI 一律全套」，决定 0101）；本机按改动选只是推前的快反馈。
- 方案索引：`pnpm specs:index` 按各方案主文件头部生成 `specs/README.md`，`pnpm specs:index --check` 核对状态、被取代关系、编号冲突和索引一致。
- 讨论稿（决定 0116、0118）：`pnpm discuss:new -- <短名> --issue <单号> --ask "需求方提了什么"` 按 `agents/skills/discussion-draft/template.md` 在 `specs/<单号>-<短名>/讨论稿.md` 起稿（缺 `--issue` 退出 2、先开单；同单号已有目录只报出来、不新建；短名第一段不能是纯数字；起好稿再跑一次 `pnpm specs:index`），同一份从「讨论中」接着改到「已定」「在做」「做完」，方案就写在稿里，不另起方案文件；`pnpm discuss:check` 查「讨论中」八节齐、「已定」「在做」「做完」的结论节有决定链接和单号，「讨论中」超过 7 天只提醒。仓里的稿由 `agents/test/discussion-draft.test.ts` 在 CI 里按同一检查查，头部状态和 `specs/README.md` 由 `pnpm specs:index` 管。
- 开单：`pnpm issue:new --kind 需求 --domain engine --nature bug --milestone 当前 --title "一句话" --body-file 正文.md`（`--domain` 是 engine、api、mirasim 里一个，`--nature` 是 bug、perf、process 里一个，标签名带「域:」「性质:」，只用来筛；`当前`＝开着的那个 `v<N>` 版本，一周一版、到期自动收口，别写死 `v<N>`；未排期写 `--milestone 未排期`，母单加 `--mother`，子单加 `--parent <母单号>`），缺类别、域、性质、里程碑，或正文里「## 场景」「## 原话」「## 已知的模块」「## 怎么算做完」有一节没写都不开（`--kind 缺陷` 另要写了字的「## 影响」）；整份正文原样进 issue（没有 `--specs`，不再另存需求.md，#654）。开单先走法国的开单服务（决定 0122），连不上、401、503 才退回 gh 直连；法国回 409 同题强命中时打出候选并退出码 1，确实是新的加 `--force`，其实是同一件事加 `--merge-into <号>`。
- fleet MCP：`pnpm mcp:fleet` 起 stdio MCP 服务，让本机会话、Mirasim、帅位会话用同一组工具开单、派单、领活、读账本；怎么登记见 `packages/conventions/AGENTS.md`「fleet MCP」。
- 关单：本机最后一个 PR 在「需求」栏下面另起一行写 `Closes #<号>`，合并时 GitHub 自己关。引擎 PR 正文只保留需求关联，正文与实际 squash 消息均去掉自动关单词，由工作流在合并收尾时关单；冷验收判出「不归我验」的条时写 `Refs #号（分片、关不了它）` 并留单（贴「本机做」），本机或指挥官贴上证据后再关。关单只有两条路（#3740）：有 PR 的按 `Closes #号` 合并时自动关；没有 PR 的用 `pnpm issue:close <号> --note "做成了什么"`，关成「完成」`--note` 必填且非空，没有就不关（退出码 1），子单还开着也不关；读不到 GitHub 报错不关（退出码 2）。`pnpm work done` 只收认领的账、不关单。见 design 第七节「关单要有证据」。
- 欠账：`pnpm debt:check` 只看文件，查活文档里推后的话带着单号（debt.yml 在主线推送和每天跑，只报告、不挡合并，不读 GitHub；不在 PR 上跑）；加 `--live` 另读 GitHub，查挂的单号开没开着（定时任务 debt.yml 用，它再加 `--comment` 留言到单上）。见 design 第七节「欠账不漏」。
- 加新项目：`pnpm project add <owner/仓>` 一条命令做到底（登记、装两个 App、流程标签、仓档案、补齐 PR、真实策略读桥、全绿才开接活、冒烟单），可重复跑；`pnpm project check <owner/仓>` 只查（退出码 0 全绿、1 有没过的、2 没查成）。两个 App 装没装经法国的 `fleet-api project installations <owner/仓> --github-id <仓号>` 读（只读，和驾驶舱导入列表同一份归并；没读全是没查成，不是没装）。见 ops 第九节「加新项目」。
- 计划：`pnpm plan` 从 GitHub 现读版本、先后、母单和子单打印出来，不写文件（#654 起仓里不存快照）；没登录、GitHub 读不到、先后标记认不出都报错、退出码 2。每天一轮 GitHub 对账（`.github/workflows/github-audit.yml`，随时也能 `pnpm github:audit`）查单子和先后有没有断，见 design 第七节「GitHub 对账」。
- 各家 AI 的全局说明、技能和钩子：开发机上由开会话钩子自动同步（同步用的是一份只归它的检出 `~/.fleet-dao/origin-main`，永远停在 `origin/main` 上，本机自己的检出在哪个分支都不影响）；手动跑 `pnpm agents:sync`（`--check` 是预检：不取远端、不切源、不更新目标配置，最后报这台同步到哪个提交、落后主线几个，但封装仍会临时创建并释放源锁 `~/.fleet-dao/origin-main.lock`，整条命令不是零写入；`--offline` 不取远端）；要严格零写入，直接对官方树跑 `node ~/.fleet-dao/origin-main/packages/agents-sync/bin/agents-sync --check --repo ~/.fleet-dao/origin-main`：不经过源准备封装、不碰源锁、不拉远端，所以须另核官方树的提交身份（`git -C ~/.fleet-dao/origin-main rev-parse HEAD` 对 `origin/main`），旧缓存或候选树的结果不能当最新主线；直接查仓里的原文件用 `node packages/agents-sync/bin/agents-sync --check`；`--help` 看全部用法，法国怎么跑见 ops 第五节。同步完想核各家实际读没读到规矩，在 fleet-dao 仓根跑 `pnpm agents:probe [家的 id …]`：真起每家装了的 CLI 问一次（花各家额度，只在手动跑时跑），按它原样抄出的通用段、仓根 AGENTS.md 标题和 `pnpm check` 判，每家一行：过、没读到什么、没装、没查成；退出码全过 0、有没读到的 1、只有没查成的 2（`packages/agents-sync/src/probe.ts`）。
- 无附带维护同步：`pnpm agents:sync --no-maintenance` 仍同步全部目标，只跳过本次本机会话 refresh；直接入口的 `--check`、`--apply` 也支持此参数。不带参数时维护行为不变。
- 无人值守状态按真实会话号隔离：`unattended.mjs` 的命令依次读取 `CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`CODEX_SESSION_ID`；Stop 和 SessionStart 优先使用事件里的 `session_id`，缺失才读同一组环境变量。给出的来源不合法就明确报错，不借另一个会话号。
- 无人值守接续：Claude/Codex 用同步 Stop 把未完成工作送到下一轮，成功 PostToolUse 登记实质进展；后台任务条数不证明完成通知送达。连续三次无进展明确暂停故障；on 只记意图，不代表已安装、信任、执行或通知验证。各入口能力与验法见 [CLI 无人值守接续](docs/design/CLI无人值守接续.md)。
- `pnpm work run <单号>` 登记真实 Claude session / Codex thread，开启无人值守后由同步 Stop 一次性消费本会话终态；Codex 后台完成不主动开新轮。只有 `CODEX_SESSION_ID` 的 root-session 不代替 thread；缺归属及旧 `dispatcher=null` 记录用 `pnpm work runs` 手工读取，续跑不改原归属。

- 本机受管工人的审查退回：`pnpm work return <单号> --body-file <完整意见文件>` 交由退回专用工作流与既有合并闸按同一 PR 串行登记；先核实 PR 级 PREPARE，再写当前头阻合状态和正式 review 回执，未结 PREPARE 跨换头/强推继续阻合；只有核实真实状态与正式回执才报 `registered/blocked`，`queued/unconfirmed` 不代表已阻止合并。`pnpm work feedback <单号> [--wait|--retry]` 读取完整意见、等 Actions 结果或按原请求重试，取消、超时和断线保留本机意图。工人用 `pnpm work ack <单号> --return <编号>` 确认收到；审查方用 `pnpm work resolve <单号> --return <编号> --body-file <核验依据>` 对精确候选 head 解除责任；ack、CI 绿和新 head 都不代替 resolve。交付用 `pnpm work deliver <单号>`，不会擅自解除手工草稿。当前显式退回事务只允许个人仓 owner 发起，工人不能替审查方 resolve；普通组织仓和没有退回协议的本机 PR 保留原判法。

### 真 Temporal 测试准备

首次准备本机真 Temporal 测试运行 `pnpm temporal:install`。它按 `deploy/france.sh` 的固定版本和当前平台（macOS arm64/x64、Linux x64/arm64、Windows x64）从 Temporal 官方发布地址下载，核固定 SHA-256，验证 `--version` 后原子落到 `~/.fleet-dao/test-tools/temporal-cli/`，不改全局 PATH、不碰 SDK 缓存。已准备好的同版本不会重下。下载失败、超时、校验不符或版本不符都不会登记成可用 CLI。

也可以用 `pnpm test:temporal --cli <已安装的CLI绝对路径>` 登记已有 CLI，版本必须与 `deploy/france.sh` 一致；之后 `pnpm test:temporal` 检查登记是否仍可用。登记只写 `~/.fleet-dao/test-tools/`，不下载、不启动服务端。也可直接设 `FLEET_TEST_TEMPORAL_CLI`，显式路径优先，坏路径不会退回登记；CI 必须显式设置。

`pnpm test:temporal-server` 显式下载并核验时间跳跃测试需要的 Java test-server 1.40.0（本次 CI 429 的实际目标版本），缓存到 `~/.cache/fleet-temporal-test-server/`；支持 Linux x64/arm64、macOS x64/arm64、Windows x64，跨平台制品身份已核，执行仍由对应平台 CI/现场验证。版本、官方发布 archive SHA256 和解包 binary SHA256 固定在 `packages/conventions/src/temporal-test-server.ts`，网络准备最多三次、总进程期限90秒，提取期限30秒。命中缓存也核真实 binary；损坏缓存报错且保留，核实后可删除该命令生成的缓存文件再准备。准备不启动服务；业务测试、单跑 evolution 和录重放夹具前先运行此命令，缺失/损坏时测试明确失败，不退回 SDK 下载。每个用例仍单独创建与 teardown 时间跳跃环境，不能用真实 CLI 环境代替。CI 所有测试台都在测试前准备；制品缓存和测试结果缓存均包含这份固定身份。

`pnpm check`、`pnpm test:changed` 选到调用 `createRealEnv` 的文件时先核 CLI；没选到则不做这项准备。直接跑单个测试也会在创建真环境前核验，缺失明确失败，不回退 SDK 隐式下载。`--version` 探测限 5 秒，超时终止该探测进程。随后 SDK 创建只报 `start-or-connect`：SDK 未公开启动和连接的细分状态，日志如实记未知；没有另套超时竞速，环境仍由 SDK 创建并由用例 teardown 清理。

### Windows 上的 Linux 安全测试

`pnpm check`（含 `--all`）和 `pnpm test:changed` 选到安全归档测试时，会将它们交给显式配置的本机 Linux 普通用户；其余测试仍在 Windows 跑。单独验这组测试用 `pnpm test:linux`。不配置或环境不可用会明确失败，不跳过、不自动安装或启动新发行版、不改默认发行版。

将 `FLEET_TEST_LINUX_RUNNER` 设置为本机 JSON 配置文件的绝对路径，配置不进仓。例如已安装 WSL 的配置结构：

```json
{
  "command": "C:/Windows/System32/wsl.exe",
  "args": ["--distribution", "<已配置的发行版>", "--user", "<普通用户>", "--exec", "/usr/bin/env", "-i", "HOME=/home/<用户>", "TMPDIR=/home/<用户>/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "/usr/local/bin/node"],
  "dependencyRoot": "/home/<用户>/fleet-test-dependencies"
}
```

`command` 和 `args` 合起来必须启动 Linux Node（符合仓根 Node 版本要求），检查器在末尾加执行参数，JSON 快照从 stdin 传入；支持已有的其他本机 Linux 启动器。不要将 SSH/VPS 命令当本机 runner。`dependencyRoot` 是该 Linux 中已用 `pnpm install --frozen-lockfile` 安装依赖的仓目录，锁文件、workspace 设置和各包依赖声明须与本次工作树一致。运行时把当前已跟踪和未忽略的新文件复制到独立 Linux 临时目录，包含未提交改动，已删的文件不复活；workspace 依赖链接指向本次快照，第三方依赖复用已安装目录。源码摘要、普通用户、测试清单和 JSON 结果逐项核对后才算通过。Linux 本机和 CI 直接跑原测试。

### 本机私有回环验证资源

`pnpm test:isolated --resource <本机资源JSON绝对路径> -- <完整测试文件...>` 将明确审阅为只用本地服务的一组完整文件交给一次性 Linux 私有网络资源。它沿用本机测试槽、工作树快照与 Linux 结果核验，单独留报告，不替代 `pnpm check` 或 CI，也不改变全局选测。资源摘要过期、未知文件、真实 PG 请求、缺依赖或工具、namespace/关闭证据不符都明确失败。共享 WSL 故障与这条隔离路径的通过分别记账。

资源需先由可信主线安装 root-owned helper，再按[资源说明](packages/conventions/resources/README.md)准备本机 JSON；配置和机器路径不进仓。网络仅有该资源内的回环，server/client/worker 在同一 namespace，业务 Node 与所有服务均普通用户，取消或宿主失联会回收本次进程。不能把依赖外网、共享 TCP PostgreSQL 或未审能力的检查整批送进去，也不能为了通过删除数据库环境变量或改用 PGlite。

实现依据：[Node 的真实路径解析](https://github.com/nodejs/node/blob/main/doc/api/cli.md#--preserve-symlinks)要求防止依赖链接回到旧源码；[WSL 显式发行版和用户参数](https://learn.microsoft.com/windows/wsl/basic-commands)允许使用现有环境而不修改默认设置。Windows 不提供 `/proc/self/fd` 上逐级固定目录句柄的归档语义，不能以普通路径操作替代安全断言。

### 批量开母子单

`pnpm issue:batch --spec <JSON文件>` 一次返回母单号、全部子单号和恢复记录路径。JSON 的 `mother` 和非空 `subs` 列表中每项都要有 `title`、`body`、`kind`（需求/缺陷/杂项）；母单还要有 `domain`、`nature`，子单可逐轴继承母单的有效值；整批写前校验，缺轴或无效值拒开。正文沿用开单四节校验。整批不挂里程碑（未排期）；`local: true` 表示保留「本机做」。

子单自动写 `parent: #母单号` 并挂原生子议题。整批先暂贴「本机做」，挂好全部关系后再撤暂存标签。失败会把本批单关闭为 `not_planned`（保留撤销记录）；创建回包不明时按批次标记分页找回。进程中断或撤销失败时跑 `pnpm issue:batch --recover <恢复记录路径>` 继续清理；未核清或关闭失败会明确报错，不报成功。GitHub 不提供跨单事务，断网时无法保证立即清完，恢复记录会生成在仓根临时目录的 issue-batch 子目录，处理完之前不要删。

母单正文的 `<!-- fleet:mother-manifest -->` / `<!-- /fleet:mother-manifest -->` 之间存 JSON 子单号数组（含已关闭的）。批量创建在成功返回前写全；单独 `pnpm issue:new --mother` 初始化空清单，`--parent` 挂好子单后立即合并清单。每日对账补齐旧母单清单，并据唯一 manifest 自动修复子单正文与原生关系；两份清单争抢同一子单时报告冲突，读不全、坏清单不自动写。修复当轮仍报出不一致，下一轮核对一致才绿。

## 文档各管什么

| 文件 | 管什么 | 什么时候改 |
|---|---|---|
| `README.md` | 门口：是什么、入口、东西在哪 | 入口或目录变了 |
| [docs/goals.md](docs/goals.md) | 要干成什么、守哪些规矩、删什么 | 目标或规矩变了 |
| [docs/design.md](docs/design.md) | 为什么这样定；「已定」表是拍板记录 | 改行为的 PR 同时改它 |
| [docs/ops.md](docs/ops.md) | 两台机器怎么装、怎么发版、怎么看、怎么退 | 跟着 `deploy/` 一起改 |
| [docs/outage-france.md](docs/outage-france.md) | 法国失联速查：关机还是断网、Contabo 重启、重启后核对 | 失联的判断或重启步骤变了 |
| [docs/decisions/](docs/decisions/README.md) | 拍板记录：一个决定一个文件，只增不改；每份头部写状态（生效、被哪份替代、失效），索引在 `docs/decisions/README.md` | 创始人拍板的那一轮，同时改索引 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 生效中的临时调整（创始人引导在 docs/directives/、进度流水在置顶单 #1055，`pnpm progress read`） | 有新的临时调整时 |
| [docs/reference/](docs/reference/README.md) | 旧系统的坑和接线细节 | 做某一块之前先读对应那份 |
| [docs/reclaude.md](docs/reclaude.md) | reclaude 的门口：文档、清理脚本、以及「〈编号〉账号被封了，根据文档清理痕迹」这句提示词 | 入口或提示词变了 |
| [docs/reclaude-in-mirasim.md](docs/reclaude-in-mirasim.md) | Windows/Mac 的 Mirasim 里怎么用 reclaude（启动命令填 reclaude 绝对路径）、自有/平台怎么分、别填错的后果，以及 Linux 与 Fleet 的分工。从 [docs/reclaude.md](docs/reclaude.md) 进 | 装法或 Mirasim 的启动方式变了 |
| [docs/reclaude-self-check.md](docs/reclaude-self-check.md) | 上机前自检和被封号的细则。从 [docs/reclaude.md](docs/reclaude.md) 进 | 清法与判据变了 |
| [AGENTS.md](AGENTS.md) | 给 AI 的本仓约定，只当目录（一屏读完，细则指到包和 docs/） | 本仓规则变了 |
| `packages/<包>/AGENTS.md` | 给 AI 的包说明（engine、api、web、conventions、db、store）：干什么、入口、怎么测、坑、连带改什么 | 改了那个包的入口、命令、坑 |
| [agents/shared-rules.md](agents/shared-rules.md) | 各仓通用的规矩（通用段），同步脚本写进各家 AI 的全局说明 | 改它是改标准；合进主线后开会话钩子自动同步到各台机器 |

## 协作

GitHub 上只用标签和里程碑：每个标签的意思写在[标签页](https://github.com/thoerwink8/fleet-dao/labels)，里程碑就是版本（没挂就是未排期），母单贴「母单」标签、子单用子议题挂在它下面，P0–P6 已关留作历史；怎么用、为什么这样定，见 design 第七节。批量建单的 `mother` 必填 `domain`、`nature`，子单逐轴继承母单有效值；缺失或无效在任何 GitHub 写入前拒绝。查询轴两套，名字带轴：域（`域:engine`、`域:api`、`域:mirasim`）和性质（`性质:bug`、`性质:perf`、`性质:process`）；新开的单和 PR 每轴贴一个，按这两个标签筛。受控入口创建前校验；旧检出、网页或直接 gh 创建的对象由可信主线事件补漏，只认明确声明或唯一来源单，不明就报错，`pnpm github:audit` 持续查漏。开 issue 用上面的 `pnpm issue:new`，做完用 `pnpm issue:close` 关；开 PR 照模板填，只有四栏：做了什么、怎么验证的、还欠什么、需求（本机最终 PR 在「需求」栏下面另起一行写 `Closes #号`；引擎 PR 正文和实际 squash 消息都去掉自动关单词，由受管收尾检查验收责任后关单；有未结验收责任时用 `Refs #号（分片、关不了它）` 留单，按上面的关单约定收尾），并带和开单同一套 `--domain`、`--nature`；PR 不贴类别标签、不挂里程碑（里程碑页只数单子，#654）；能不能合只看 CI 和 merge-gate（见 design 第五节）。

验收责任账只剩只读（决定 0113）：不再写新行，管理命令和关单闸对它的检查都删了；还开着的旧行用 `fleet-api acceptance-handback-once [--apply]` 一次性交回原单（留言、贴「本机做」），之后按单子本身的证据照常关。
