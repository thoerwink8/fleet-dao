# 旧系统审计参考手册

这里的九份手册，提炼自重写 fleet-dao 之前对旧系统（windsurf-dao、ai-gateway-stack、两台 VPS）做的九个审计切片（2026-09-24/25）：旧系统里各部件实际怎么工作、真实的数字和常数、各渠道的真实接口形状、「坑 → 新系统的测试用例」、旧系统里该丢掉的。它们不决定新系统长什么样（那是[设计文档](../design.md)和[实施计划](../plan.md)的事），只给实现的人当参考和测试清单。

## 实现哪一块之前读哪份

| 手册 | 实现哪一块之前读 | 测试用例 |
|---|---|---|
| [adapters.md](adapters.md) | 渠道插头（`packages/adapters`）：Claude Code（经 reclaude）、codex、cursor-agent、Grok 命令行、pi、dsh、Kimi Code、Mirasim ws、ACP——怎么无头起、能读到什么、怎么判真开工 / 真完成、会怎么坏 | 120 条（CC / CX / CU / GK / PI / DS / KM / MS / ACP / GEN） |
| [quota.md](quota.md) | 额度读取与额度账、模型扫描与探活、调度台的选路与并发上限 | 59 条（Q / D / R / C） |
| [engine.md](engine.md) | 引擎（`packages/engine`）：Temporal 工作流与活动、超时与心跳、信号与更新、合并队列、定时任务、版本演进、Temporal 部署 | 57 条（A–H） |
| [errors.md](errors.md) | 错误分类与处置（「下一步该做什么」动作表）、卡住判定、路由熔断、会话资源隔离与准入；含 49 条真实报错样本夹具 | 53 条（第 8 节） |
| [github.md](github.md) | GitHub：两个机器人与发令牌、写入的幂等与回读、PR 与合并队列、事件接收、白名单作者、互动限制续期、issue 进度段原地更新 | 42 条（A–G） |
| [feishu.md](feishu.md) | 飞书（`packages/feishu`）：接口与硬限制、确认卡、三类推送与关注、置顶盘面卡、菜单、回复即追问、端到端自测 | 29 条（T） |
| [data-jev.md](data-jev.md) | 数据库表（`packages/db`）、Jev 判断题服务、驾驶舱各页要的数据（`packages/api`、`packages/web`） | 47 条（A–H） |
| [deploy.md](deploy.md) | `deploy/` 一条命令装机、日常部署、备份与看门狗、新旧系统切换 | 44 条（P01–P44） |
| [old-issues.md](old-issues.md) | 迁移旧单（实施计划 P6）：每张旧开放单的去向；新设计漏掉的 10 条需求（已并入设计 §十七）；9 条该写成测试的坑 | 9 条 |

几个主题横跨多份手册，先读主手册，再看旁证：

- **完成 = 交付**（相对此刻目标分支有领先提交、且有内容差异）：adapters GEN-06，engine D1，github C7，data-jev A8。
- **按进展判停滞**（没有工具在跑、进度指纹 360 秒不变才算）：adapters GEN-05，engine D7，errors 第 8 节第 24 条。
- **熔断吃真流量、断流单列、全红判共用层坏**：adapters CX-06、GK-07、GEN-14，errors 第 8 节第 30–33 条，data-jev C3、C4。
- **三态**（有 / 查过确实没有 / 没查成）：adapters GEN-01，engine §2.2，data-jev §2.1 与 A1，quota Q1。
- **写 GitHub 的幂等与回读**：github §2 与 B1–B5，engine G9，errors 第 8 节第 43 条，data-jev E1。
- **送达只认飞书 `message_id`**：feishu T17，errors 第 8 节第 38 条，data-jev D5。
- **测试不许碰生产**：adapters GEN-08，data-jev G1，deploy P28，quota D11。
- **root 与服务用户**：deploy P01、P02 与 §1.6，github A6。

## 怎么用

- **测试用例**一律写成「给定……，当……，应当……」，后面带出处。实现一块时，把对应手册的用例写成单元、集成或端到端测试，测试名里带上用例编号；编号只在各自手册内唯一，跨手册引用写「手册名 编号」，如 `engine D1`、`errors 第 8 节第 15 条`。每条都来自真实事故（issue、提交、判例、生产读数）；标「说明书约束」的是读说明书或离线探针得到的，不是旧坑；errors 第 5 节标「测试」的样本只在旧测试里出现过，不能当真实样本验收。
- **数字**（超时、频率、上限、并发、分位数）是审计时的读数或旧系统的配置值，当起步值用，实测后调；标「拍」的是当时拍板的值，不是量出来的。
- **「没查成」**的，开发时先真跑一针、实测清楚再写代码，结果写回对应手册（写之前照下面「这些文件里没有什么」的规矩脱敏）。
- **和设计或计划冲突时，以设计和计划为准**，手册里的审计建议留作权衡依据；已知的几处冲突就地标了「注」（Postgres 版本、Node 版本、备份目标、互动限制由谁续）。

## 记法

- **旧仓**：`WD` / `wd:` = windsurf-dao；`AGS` / `ags:` = ai-gateway-stack；`mq:` = MiraQuota 源码（非 git 检出）；`fd:` / `design §N` = fleet-dao `docs/design.md`。各手册开头写了自己的缺省，多数手册里不带仓名的 `文件:行` 指 windsurf-dao。
- **基线**：windsurf-dao `b1ebd88d`；ai-gateway-stack `db44877`（errors 读的是 `33d3ce4`）。行号以这两个提交为准；两个旧仓会转只读存档，行号不会再漂。
- **单号**：`windsurf-dao#N` / `ai-gateway-stack#N`；手册里只写 `#N` 的默认是 windsurf-dao。`#N gM`、「fleet 任务 #N gM」= windsurf-dao#N 那张单的第 M 代 fleet 工作流。提交写短哈希（`@xxxxxxxx`、`windsurf-dao@xxxxxxxx` 同义）。
- **判例**：「判例 `名字`」「memory `名字`」是旧维护者的判例记忆，不公开；追溯以同处引的 issue、提交、文件为准。
- **章节号**：审计稿写于设计补进第十七节「补充需求」之前；手册里指向设计第十七节及以后的章节号已改成现行编号（迁移 = §十八，待讨论 = §十九）。
- **占位**：`<VPS>` = 法国执行机；`<服务用户>` / `<svc>` = 跑引擎、各 CLI 与 mirasim-server 的 Linux 用户（`~` 指它的家目录）；`<账号A/B>`、`<拼车组织>`、`<独享组织>` = 订阅账号与组织；`<owner>` = GitHub 属主；`<回环>` = 本机回环地址；`<端口>`、`<令牌>`、`<slug>` 同理。旧系统的 GitHub App 按角色称「帅位机器人 / 工人机器人 / 审官机器人 / 看守机器人 / 消歧机器人」，新系统的两个机器人按设计称「引擎」「干活的」。

## 这些文件里没有什么

这是公开仓：IP 地址、邮箱、手机号、人名、账号名与组织编号、令牌与密钥（哪怕片段）、密钥文件在机器上的存放路径、提权问题的利用细节，一律没写进来。凭据只写种类和「谁在用、新系统怎么处理」；要找具体落点，在机器上按旧仓 `host/machine/INDEX.md`（旧系统的落点清单）找。旧机上的安全问题只写了新系统遵守的原则（[deploy.md](deploy.md) §1.6）。
