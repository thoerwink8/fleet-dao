# fleet-dao

两位创始人加上手里多家 AI 订阅的全流程派工系统。GitHub issue 就是需求：写一句话，AI 从分诊、写方案、写码、测试、审查到合并全包；订阅额度互不闲置，驾驶舱里看得见、管得住。

还在施工，各阶段做到哪看[里程碑](https://github.com/thoerwink8/fleet-dao/milestones)。下面只写每样东西在哪、管什么，不代表都做完了。

## 入口

- **驾驶舱**：域名只在机器配置里（香港 `/etc/fleet-dao/hk.env` 的 `FLEET_DOMAIN`），公开仓不写；健康页在 `/health/`。
- **飞书机器人 fleet-dao**：能做什么见 design 15.4。
- **GitHub issue**：用「需求」模板写一句话就行。

## 两台机器

法国干活、香港当门面。各跑什么、端口、用户、目录、怎么看健康、怎么回滚：[docs/ops.md](docs/ops.md)。

## 仓库地图

| 目录 | 是什么 |
|---|---|
| `packages/shared` | 各包共用的类型、校验和常量；包与包之间的接口约定在这 |
| `packages/db` | Postgres 表结构、迁移、查询、渠道目录装载器 |
| `packages/engine` | 引擎：Temporal 工作流、失败分流与熔断、停滞判定 |
| `packages/adapters` | 渠道插头：无头起各家写码助手、读过程记录；各渠道的额度读取 |
| `packages/cli` | `fleet` 命令：AI 会话汇报进度、提问、交活 |
| `packages/api` | 驾驶舱后端：登录、接口、实时推送、给工作流发信号、fleet 命令接口、收 GitHub 事件 |
| `packages/web` | 驾驶舱前端：看板和后台管理页面 |
| `packages/github` | 引擎对 GitHub 的读写：推分支、开 PR、等 CI、合并、issue 进度段与关单、对账补漏 |
| `packages/jev` | Jev 判断题服务：题库、提问接口、从只记不拦转到真拦 |
| `packages/feishu` | 飞书网关（跑在香港） |
| `packages/conventions` | design 第七节的约定写成检查：PR 必填栏（CI 的 pr-fields）、开单脚本、文档指针检查 |
| `deploy/` | 装机、发版、健康页，和它们的检查 |
| `docs/` | 设计、计划、运维；`docs/reference/` 是旧系统的坑 |
| `specs/` | 需求文档，每个需求一个文件夹（需求、方案、结果） |

## 密钥和本机配置在哪

这是公开仓：密钥、账号、组织编号、邮箱、IP 一律不进。

- **服务器上**：`/etc/fleet-dao/`，不进 git；每个文件放什么见 ops 第三节（用户、目录、库）。
- **加密副本**：私有仓 [fleet-dao-vault](https://github.com/thoerwink8/fleet-dao-vault)，age 加密，一个文件一个 `.age`，仓里只有密文和公钥。在创始人电脑上跑那个仓里的 `bash refresh.sh` 刷新；怎么解开、机器没了怎么恢复，见那个仓 README 的「解开一个文件」和「法国整机没了怎么恢复」两节。
- **创始人电脑上**：`~/.fleet-dao/`，放解密钥匙 `vault-key.txt` 和 age；只有拿着这把钥匙的人解得开。钥匙还要抄一份进创始人的密码管理器（plan 第五节）。
- 数据库备份不在保险箱里，见 plan 第二节「备份」。

## 常用

- 装机：ops 第四节（怎么跑装机脚本）。
- 发版：`deploy/release.sh`，见 ops 第九节（发布应用）。
- 开发：`pnpm install`，Node 和 pnpm 的版本钉在 `package.json`；给 AI 的约定在 [AGENTS.md](AGENTS.md)。
- 跑检查：`pnpm check`（文档里的路径、章节指针也在里面查）；CI 跑哪些见 `.github/workflows/`。
- 开单：`pnpm issue:new --kind 需求 --milestone P1 --title "一句话" --body-file 正文.md`，缺类别或里程碑不开；加 `--specs 短名` 顺带建需求文档骨架。

## 文档各管什么

| 文件 | 管什么 | 什么时候改 |
|---|---|---|
| `README.md` | 门口：是什么、入口、东西在哪 | 入口或目录变了 |
| [docs/design.md](docs/design.md) | 为什么这样定；「已定」表是拍板记录 | 改行为的 PR 同时改它 |
| [docs/ops.md](docs/ops.md) | 两台机器怎么装、怎么发版、怎么看、怎么退 | 跟着 `deploy/` 一起改 |
| [docs/plan.md](docs/plan.md) | 各阶段的验收标准（进度看里程碑） | 验收标准变了 |
| [docs/reference/](docs/reference/README.md) | 旧系统的坑和接线细节 | 做某一块之前先读对应那份 |
| [AGENTS.md](AGENTS.md) | 给 AI 的一页约定：偏好、人闸、底线 | 规则变了 |

## 协作

GitHub 上只用标签和里程碑：每个标签的意思写在[标签页](https://github.com/thoerwink8/fleet-dao/labels)，里程碑就是 plan 的 P0–P6；怎么用、为什么这样定，见 design 第七节。开 issue 用上面的 `pnpm issue:new`；开 PR 照模板填，贴一个类别标签、挂一个里程碑、写明「对应计划」和「specs」，缺一样 CI 的 pr-fields 就红；最后一栏「文档」写改了哪份文档，或「不适用」。
