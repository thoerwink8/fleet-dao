# fleet-dao

两位创始人加上手里多家 AI 订阅的全流程派工系统。GitHub issue 就是需求：写一句话，AI 从分诊、写方案、写码、测试、审查到合并全包；订阅额度互不闲置，驾驶舱里看得见、管得住。

还在施工，各阶段做到哪看[里程碑](https://github.com/thoerwink8/fleet-dao/milestones)。下面写的是每样东西在哪、管什么，不代表都做完了。

## 入口

- **驾驶舱** <https://fleetdao.dpdns.org>：现在挂的是演示版，数据是假的；正式版随 P2 上线。
- **飞书机器人 fleet-dao**：私聊或在团队群里 @ 它说一句话就记成任务，要你们拍的事也推到这里（design 15.4）。网关代码在主线上，还没上香港。
- **GitHub issue**：用「需求」模板写一句话就行。引擎接上之前（P1），开的 issue 没人自动处理。

## 两台机器

- **法国**（6 核 12G）干活：Temporal、Postgres、引擎、驾驶舱后端、AI 会话；公网只开 ssh。
- **香港**（2 核 2G）当门面：nginx（驾驶舱页面、证书、往法国转接口）、WireGuard；飞书网关以后也放这。
- 端口、用户、目录、看健康、回滚：[docs/ops.md](docs/ops.md)。健康页 <https://fleetdao.dpdns.org/health/>。

## 仓库地图

| 目录 | 是什么 |
|---|---|
| `packages/shared` | 各包共用的类型、校验（zod）和常量；包与包之间的接口约定在这 |
| `packages/db` | Postgres 表结构（Drizzle）、迁移、查询、渠道目录装载器 |
| `packages/engine` | 引擎：失败分流、熔断、停滞判定；Temporal 工作流随 PR #7 进主线 |
| `packages/adapters` | 渠道插头：无头起各家写码助手（Claude Code、cursor-agent、Grok、Mirasim 中转、codex、接口外壳）、读过程记录；各渠道的额度读取 |
| `packages/cli` | `fleet` 命令：AI 会话汇报进度、提问、交活 |
| `packages/api` | 驾驶舱后端（Hono）：飞书登录、接口、实时推送、给工作流发信号、fleet 命令接口、收 GitHub 事件 |
| `packages/github` | GitHub：两个机器人的令牌、会话外推分支、开 PR、等 CI、合并、issue 进度段与关单、对账补漏 |
| `packages/feishu` | 飞书网关（跑在香港） |
| `packages/web` | 驾驶舱前端，随 PR #13 进主线 |
| `packages/jev` | Jev 判断题服务，随 PR #15 进主线 |
| `deploy/` | 装机（`france.sh`、`hk.sh`）、发版（`release.sh`）、「你好」工作流（`hello.sh`）、健康页，和它们的检查 |
| `docs/` | 设计、计划、运维；`docs/reference/` 是旧系统的坑 |
| `specs/` | 需求文档，每个需求一个文件夹（需求、方案、结果） |

## 密钥和本机配置在哪

这是公开仓：密钥、账号、组织编号、邮箱、IP 一律不进。

- **服务器上**：`/etc/fleet-dao/`，不进 git；每个文件放什么见 ops 第三节。
- **加密副本**：私有仓 [fleet-dao-vault](https://github.com/thoerwink8/fleet-dao-vault)，age 加密，一个文件一个 `.age`，仓里只有密文和公钥。要刷新，在创始人电脑上跑那个仓里的 `bash refresh.sh`。
- **创始人电脑上**：`~/.fleet-dao/`，放解密钥匙 `vault-key.txt` 和 age。只有拿着这把钥匙的人解得开副本；它还要抄一份进创始人的密码管理器（plan 第五节）。
- 数据库备份不在保险箱里：每晚法国加密传香港（plan 第二节「备份」，装法随 PR #18 进主线）。

## 常用

- 装机：ops 第四节（`deploy/france.sh`、`deploy/hk.sh`，跑第二遍应当零改动）。
- 发版：`deploy/release.sh`，在法国以 root 跑，见 ops 第九节。
- 开发：Node 22.22 以上、pnpm 11（版本钉在 `package.json`），`pnpm install`；给 AI 的约定在 [AGENTS.md](AGENTS.md)。
- 跑检查：`pnpm check`（格式、类型、测试）。CI 另跑装机脚本的检查 `sudo bash deploy/test/run.sh`。

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

标签只有七个：类别 `需求` `缺陷` `杂项`，AI 分诊时贴、人可以改；特性 `界面`（派工时 GPT 不接）和 `人闸`（碰对外发布、花钱或删数据，合并前等创始人点头）；要人看 `等你拍` `卡住了`，引擎自动贴、自动撕，只是提醒，不挡开工。里程碑 P0–P6 就是 plan.md 的七个阶段，每张 issue、每个 PR 挂一个。开 PR 照模板填，最后一行「文档」写明改了 README、design、ops、plan 的哪份，或「不适用」：改了行为却没改 design，一眼就看得出。为什么这样定，见 design 第七节。
