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
| `packages/mirasim-reclaude` | Mirasim 的回合选路启动器（Go 写的，在 `launcher/`）和安全迁移入口（`pnpm mirasim:migrate`：旧接入空闲后才更新，可检查、可回滚，不重启整个 Mirasim） |
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
- 仓根命令（仓合同 `entry`）：`pnpm dev` 在本机起驾驶舱前端的 mock 开发服务（`packages/web` 的 `dev:mock`，前台跑、Ctrl+C 停，不需要后端）；`pnpm start` / `pnpm stop` 起停本机要常驻的东西，目前只有嵌入式 Postgres（`pnpm pg:local start` / `stop`，脱离会话起，要真库的 e2e 先 start）；`pnpm check` 见下。本机不起引擎和驾驶舱后端，它们跑在法国。进度单用 `pnpm progress <note|directive|claim|done|read>`，本机会话上报用 `pnpm local-sessions <install|uninstall|status>`。
- 开发：`pnpm install`，Node 和 pnpm 的版本钉在 `package.json`；给 AI 的约定在 [AGENTS.md](AGENTS.md)。
- 跑检查：本机推前只跑改动影响到的测试（`pnpm test:changed`，和 origin/main 比、按 CI 那套判法选包，整个 `agents/test/` 只在它受影响时带、CI 每个 PR 照旧全跑，引擎的会话交活只认它；它判出要全跑时本机不跑、退出码 3，写明全量交给 CI，真要在本机全跑带 `--all`，只跑受影响的包带 `--affected`）和格式、类型；`pnpm check` 默认 = 格式 + 类型 + 改到的测试（同 `pnpm test:changed`，相对 origin/main）+ 卫生检查，四样都跑完再判红，每样报耗时，任何一样没跑成都算红；`pnpm check --all` 才全量 vitest run（本机要 8 分钟以上，和 CI 重复，一般不跑）。只改一个包的入口脚本、包内模块、测试（不在它 `exports`、`bin` 走得到的面上）时只测这个包自己，不连带依赖它的包（`packages/conventions/src/package-surface.ts`）。本机要真 Postgres 的（驾驶舱 e2e）先 `pnpm pg:local start`（Windows 嵌入式库，脱离会话起，见 `packages/web/e2e/README.md`）。CI 一律全套、并行跑，PR 和 main 都一样（`.github/workflows/ci.yml`，见 design 第五节「CI 一律全套」，决定 0101）；本机按改动选只是推前的快反馈。
- 开单：`pnpm issue:new --kind 需求 --domain engine --nature bug --milestone 当前 --title "一句话" --body-file 正文.md`（`--domain` 是 engine、api、mirasim 里一个，`--nature` 是 bug、perf、process 里一个，标签名带「域:」「性质:」，只用来筛；`当前`＝开着的那个 `v<N>` 版本，一周一版、到期自动收口，别写死 `v<N>`；未排期写 `--milestone 未排期`，母单加 `--mother`，子单加 `--parent <母单号>`），缺类别、域、性质、里程碑，或正文里「## 场景」「## 原话」「## 已知的模块」「## 怎么算做完」有一节没写都不开；整份正文原样进 issue（没有 `--specs`，不再另存需求.md，#654）。
- 关单：最后一个 PR 在「需求」栏下面另起一行写 `Closes #<号>`，合并时 GitHub 自己关。没有 PR 的收尾用 `pnpm issue:close <号>`：关成「完成」要有证据（合并了的 PR 提到它、或下面的子单都关了、或 `--note "做成了什么"`），没有就不关（退出码 1），子单还开着也不关；读不到 GitHub 报错不关（退出码 2）。见 design 第七节「关单要有证据」。
- 欠账：`pnpm debt:check` 只看文件，查活文档里推后的话带着单号（debt.yml 在主线推送和每天跑，只报告、不挡合并，不读 GitHub；不在 PR 上跑）；加 `--live` 另读 GitHub，查挂的单号开没开着（定时任务 debt.yml 用，它再加 `--comment` 留言到单上）。见 design 第七节「欠账不漏」。
- 加新项目：`pnpm project add <owner/仓>` 一条命令做到底（登记、装两个 App、流程标签、仓档案、补齐 PR、全绿才开接活、冒烟单），可重复跑；`pnpm project check <owner/仓>` 只查（退出码 0 全绿、1 有没过的、2 没查成）。见 ops 第九节「加新项目」。
- 计划：`pnpm plan` 从 GitHub 现读版本、先后、母单和子单打印出来，不写文件（#654 起仓里不存快照）；没登录、GitHub 读不到、先后标记认不出都报错、退出码 2。每天一轮 GitHub 对账（`.github/workflows/github-audit.yml`，随时也能 `pnpm github:audit`）查单子和先后有没有断，见 design 第七节「GitHub 对账」。
- 各家 AI 的全局说明、技能和钩子：开发机上由开会话钩子自动同步（同步用的是一份只归它的检出 `~/.fleet-dao/origin-main`，永远停在 `origin/main` 上，本机自己的检出在哪个分支都不影响）；手动跑 `pnpm agents:sync`（`--check` 只读，最后报这台同步到哪个提交、落后主线几个；`--offline` 不取远端），直接查仓里的原文件用 `node packages/agents-sync/bin/agents-sync --check`；`--help` 看全部用法，法国怎么跑见 ops 第五节。
- 无人值守状态按真实会话号隔离：`unattended.mjs` 的命令依次读取 `CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`CODEX_SESSION_ID`；Stop 和 SessionStart 优先使用事件里的 `session_id`，缺失才读同一组环境变量。给出的来源不合法就明确报错，不借另一个会话号。

### 批量开母子单

`pnpm issue:batch --spec <JSON文件>` 一次返回母单号、全部子单号和恢复记录路径。JSON 的 `mother` 和非空 `subs` 列表中每项都要有 `title`、`body`、`kind`（需求/缺陷/杂项）；正文沿用开单四节校验。整批不挂里程碑（未排期）；`local: true` 表示保留「本机做」。

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
| [docs/reclaude-in-mirasim.md](docs/reclaude-in-mirasim.md) | Windows/Mac 的 Mirasim 自有/平台切换、旧安装自动迁移、检查/撤回，以及 Linux 与 Fleet 的分工。从 [docs/reclaude.md](docs/reclaude.md) 进 | 装法或启动器变了 |
| [docs/reclaude-self-check.md](docs/reclaude-self-check.md) | 上机前自检和被封号的细则。从 [docs/reclaude.md](docs/reclaude.md) 进 | 清法与判据变了 |
| [AGENTS.md](AGENTS.md) | 给 AI 的本仓约定，只当目录（一屏读完，细则指到包和 docs/） | 本仓规则变了 |
| `packages/<包>/AGENTS.md` | 给 AI 的包说明（engine、api、web、conventions、db、store）：干什么、入口、怎么测、坑、连带改什么 | 改了那个包的入口、命令、坑 |
| [agents/shared-rules.md](agents/shared-rules.md) | 各仓通用的规矩（通用段），同步脚本写进各家 AI 的全局说明 | 改它是改标准；合进主线后开会话钩子自动同步到各台机器 |

## 协作

GitHub 上只用标签和里程碑：每个标签的意思写在[标签页](https://github.com/thoerwink8/fleet-dao/labels)，里程碑就是版本（没挂就是未排期），母单贴「母单」标签、子单用子议题挂在它下面，P0–P6 已关留作历史；怎么用、为什么这样定，见 design 第七节。查询轴两套，名字带轴：域（`域:engine`、`域:api`、`域:mirasim`）和性质（`性质:bug`、`性质:perf`、`性质:process`）；新开的单和人开的 PR 每轴贴一个，按这两个标签筛。开 issue 用上面的 `pnpm issue:new`，做完用 `pnpm issue:close` 关；开 PR 照模板填，只有四栏：做了什么、怎么验证的、还欠什么、需求（要在合并时关单，「需求」栏下面另起一行写 `Closes #号`），并带和开单同一套 `--domain`、`--nature`；PR 不贴类别标签、不挂里程碑（里程碑页只数单子，#654）；能不能合只看 CI 和 merge-gate（见 design 第五节）。
