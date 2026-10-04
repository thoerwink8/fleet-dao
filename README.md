# fleet-dao

两位创始人加上手里多家 AI 订阅的全流程派工系统。GitHub issue 就是需求：写一句话，AI 从分诊、写方案、写码、测试、审查到合并全包；订阅额度互不闲置，驾驶舱里看得见、管得住。

还在施工，各阶段做到哪看[里程碑](https://github.com/thoerwink8/fleet-dao/milestones)。下面只写每样东西在哪、管什么，不代表都做完了。

## 入口

- **驾驶舱**：域名只在机器配置里（香港 `/etc/fleet-dao/hk.env` 的 `FLEET_DOMAIN`），公开仓不写；健康页在 `/health/`。
- **演示版**：驾驶舱域名下的 `/demo/`（路径是配置，见 ops 第九节「演示版」）：假数据、不用登录、换了一套名字；游客能看什么在驾驶舱的「演示版」页定。
- **飞书机器人 fleet-dao**：能做什么见 design 15.4。
- **GitHub issue**：用「需求」模板写一句话就行。

## 两台机器

法国干活、香港当门面。各跑什么、端口、用户、目录、怎么看健康、怎么回滚：[docs/ops.md](docs/ops.md)。

两台上还另跑着一个不归本仓管的私有项目 **self-proxy**（创始人自用的代理，2026-09-28 起）：单元 `self-proxy-*`、目录 `/etc/self-proxy`、`/opt/self-proxy`，香港还有 nginx 站点 `self-proxy` 和 `/srv/self-proxy-sub`；「法国-中转」借用本仓的隧道。端口见 ops 第二节端口表。本仓的装机脚本不装、不查、不删它们，排查时也别动。

## 仓库地图

| 目录 | 是什么 |
|---|---|
| `packages/shared` | 各包共用的类型、校验和常量；包与包之间的接口约定在这 |
| `packages/db` | Postgres 表结构、迁移、查询、渠道目录装载器 |
| `packages/engine` | 引擎：Temporal 工作流、失败分流与熔断、停滞判定 |
| `packages/adapters` | 渠道插头：无头起各家写码助手、读过程记录；各渠道的额度读取 |
| `packages/cli` | `fleet` 命令：AI 会话汇报进度、提问、交活 |
| `packages/api` | 驾驶舱后端：登录、接口、实时推送、给工作流发信号、fleet 命令接口、收 GitHub 事件 |
| `packages/web` | 驾驶舱前端：看板和后台管理页面；同一份代码另打一个演示版（`build:demo`） |
| `packages/github` | 引擎对 GitHub 的读写：推分支、开 PR、等 CI、合并、issue 进度段与关单、对账补漏 |
| `packages/jev` | Jev 判断题服务：题库、提问接口、从只记不拦转到真拦 |
| `packages/feishu` | 飞书网关（跑在香港） |
| `packages/conventions` | design 第七节的约定写成检查：合并闸 merge-gate（先审后合路径等第二意见、引擎任务 PR 等冷验收）、开单脚本、文档指针检查、欠账检查、阶段收口 |
| `packages/agents-sync` | 同步脚本：把 `AGENTS.md` 上半段、`agents/skills/`、`agents/hooks/` 装进这台机器上各家 AI 的全局入口，记下这台同步到哪个提交，另能查漂移、撤旧仓留下的东西 |
| `deploy/` | 装机、发版、健康页，和它们的检查 |
| `docs/` | 设计、计划、运维；`docs/reference/` 是旧系统的坑 |
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
- 开发：`pnpm install`，Node 和 pnpm 的版本钉在 `package.json`；给 AI 的约定在 [AGENTS.md](AGENTS.md)。
- 跑检查：本机推前只跑改动影响到的测试（`pnpm test:changed`，和 origin/main 比、按 CI 那套判法选包，引擎的会话交活只认它；它判出要全跑时本机不跑、退出码 3，打出改到的包各自单跑的命令 `pnpm exec vitest run packages/<包>/`，真要在本机全跑带 `--all`）和格式、类型；`pnpm check` 是全量（格式、类型、全部测试、卫生检查；文档里的路径、章节指针也在里面查），本机一般不跑。CI 按改动跑受影响的部分、并行跑，main 上全量（`.github/workflows/ci.yml`，见 design 第五节「CI 按改动跑」）；想先看一个分支 CI 会跑什么：`node packages/conventions/src/bin/ci-plan.ts`。
- 开单：`pnpm issue:new --kind 需求 --milestone v1 --title "一句话" --body-file 正文.md`（未排期写 `--milestone 未排期`，母单加 `--mother`），缺类别、里程碑，或正文里没写「## 怎么算做完」都不开；整份正文原样进 issue（没有 `--specs`，不再另存需求.md，#654）。
- 关单：最后一个 PR 在「需求」栏下面另起一行写 `Closes #<号>`，合并时 GitHub 自己关。没有 PR 的收尾用 `pnpm issue:close <号>`：关成「完成」要有证据（合并了的 PR 提到它、或下面的子单都关了、或 `--note "做成了什么"`），没有就不关（退出码 1），子单还开着也不关；读不到 GitHub 报错不关（退出码 2）。见 design 第七节「关单要有证据」。
- 欠账：`pnpm debt:check` 只看文件，查活文档里推后的话带着单号（debt.yml 在主线推送和每天跑，只报告、不挡合并，不读 GitHub；不在 PR 上跑）；加 `--live` 另读 GitHub，查挂的单号开没开着（定时任务 debt.yml 用，它再加 `--comment` 留言到单上）。见 design 第七节「欠账不漏」。
- 计划：`pnpm plan` 从 GitHub 现读版本、先后、母单和子单打印出来，不写文件（#654 起仓里不存快照）；没登录、GitHub 读不到、先后标记认不出都报错、退出码 2。每天一轮 GitHub 对账（`.github/workflows/github-audit.yml`，随时也能 `pnpm github:audit`）查单子和先后有没有断，见 design 第七节「GitHub 对账」。
- 各家 AI 的全局说明、技能和钩子：开发机上由开会话钩子自动同步（同步用的是一份只归它的检出 `~/.fleet-dao/origin-main`，永远停在 `origin/main` 上，本机自己的检出在哪个分支都不影响）；手动跑 `pnpm agents:sync`（`--check` 只读，最后报这台同步到哪个提交、落后主线几个；`--offline` 不取远端），直接查仓里的原文件用 `node packages/agents-sync/bin/agents-sync --check`；`--help` 看全部用法，法国怎么跑见 ops 第五节。

## 文档各管什么

| 文件 | 管什么 | 什么时候改 |
|---|---|---|
| `README.md` | 门口：是什么、入口、东西在哪 | 入口或目录变了 |
| [docs/design.md](docs/design.md) | 为什么这样定；「已定」表是拍板记录 | 改行为的 PR 同时改它 |
| [docs/ops.md](docs/ops.md) | 两台机器怎么装、怎么发版、怎么看、怎么退 | 跟着 `deploy/` 一起改 |
| `docs/decisions/` | 拍板记录：一个决定一个文件，只增不改，被推翻标「已被 xx 替代」（design 第三节的决定表拆过来，#139） | 创始人拍板的那一轮 |
| [docs/reference/](docs/reference/README.md) | 旧系统的坑和接线细节 | 做某一块之前先读对应那份 |
| [docs/reclaude-in-mirasim.md](docs/reclaude-in-mirasim.md) | Windows/Mac 的 Mirasim 自有/平台切换、旧安装自动迁移、检查/撤回，以及 Linux 与 Fleet 的分工 | 装法或启动器变了 |
| [docs/reclaude-self-check.md](docs/reclaude-self-check.md) | 装了 reclaude 的机器上机前 / 换机后怎么自检：清旧账号 id、按点名的组织编号摘被封号的邮箱、四步查有没有在产生上报 | 清法与判据变了 |
| [AGENTS.md](AGENTS.md) | 给 AI 的一页约定：上半段各仓通用（同步脚本写进各家 AI 的全局说明），下半段只管本仓 | 规则变了；改上半段要各台机器重跑同步脚本 |

## 协作

GitHub 上只用标签和里程碑：每个标签的意思写在[标签页](https://github.com/thoerwink8/fleet-dao/labels)，里程碑就是版本（没挂就是未排期），母单贴「母单」标签、子单用子议题挂在它下面，P0–P6 已关留作历史；怎么用、为什么这样定，见 design 第七节。开 issue 用上面的 `pnpm issue:new`，做完用 `pnpm issue:close` 关；开 PR 照模板填，只有四栏：做了什么、怎么验证的、还欠什么、需求（要在合并时关单，「需求」栏下面另起一行写 `Closes #号`）；PR 不贴类别标签、不挂里程碑（里程碑页只数单子，#654）；能不能合只看 CI 和 merge-gate（见 design 第五节）。
