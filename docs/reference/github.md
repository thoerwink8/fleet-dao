# GitHub 集成手册（机器人身份 · 写入网关 · PR 与合并 · 事件）

> **实现 GitHub 相关的部分之前读：两个机器人与发令牌、写 issue / PR 的幂等与回读、开 PR / 读检查 / 合并队列、事件接收、白名单作者、互动限制续期、issue 进度段原地更新。** 对应设计 §三 第 1、3、4、5 条，§六「自己的合并队列」，§七，§十三「高响应」，§十四「安全」。
> 来源：旧系统审计切片 s5（2026-09-24）。参考 windsurf-dao 仓（旧）。全仓记法见 [README](README.md)。
> 出处写法：`文件:行` 一律指 windsurf-dao 仓内路径；`windsurf-dao#N` 是旧仓 issue/PR；「判例 memory `名字`」是旧维护者的判例记忆（不公开）；「实测」是审计时只读命令的输出摘录。
> 称呼：旧系统的五个 GitHub App 按角色称「帅位机器人 / 工人机器人 / 审官机器人 / 看守机器人 / 消歧机器人」；新系统的两个机器人按设计称「引擎」与「干活的」。登录名一律写成 `<slug>` 形式。
> 占位：`<账号A>` = 两个旧仓与 fleet-dao 所在的个人账号；`<VPS>`、`<服务用户>`、`<AppID>`、`<bot用户ID>` 同理。本文不含任何密钥、令牌、编号、邮箱、IP。

---

## 0. 先看这 8 条

1. **两个机器人现在的 GitHub 权限一模一样**。实测（令牌缓存里 GitHub 回写的 permissions 字段，2026-09-24）：帅位机器人与工人机器人都是 `contents:write / pull_requests:write / issues:write / checks:read / metadata:read`。windsurf-dao#573 登记过「worker 的 pull_requests 要降回 read，否则权限隔离是装饰」（`scripts/lib/gh.mjs:69-73`），至今没做；而且按官方文档，合并 PR 只要 `Contents: write`，降了也拦不住工人合并。结论：「谁能合并」在 GitHub 权限层面分不开，只能靠代码约定 + 每小时对账（§6 C22）。能做的收紧是：工人不需要 `Issues: write`，摘掉后「issue 只经网关写」在 GitHub 层就成立。
2. **两个机器人都没有 `Workflows` 和 `Administration`**。后果有二：(a) 主线一改 `.github/workflows/`，所有在途分支「并主线再推」都会被 GitHub 拒——旧系统实咬过（PR #1833 正文：PR #1768 改了 check.yml 之后，早于它起的分支并 master 再推都撞上），这和设计 §6.4「主线一变，在途分支自动同步」正面冲突；(b) 互动限制的读、写分别要 `Administration: read / write`，「引擎自动续期」现在做不到。两件都是权限变更，要创始人拍（§1.3）。
3. **fleet-dao 仓的现状（实测 `GET /repos/<账号A>/fleet-dao` 等）**：公开；属个人账号（owner.type=User）→ GitHub 自带的合并队列用不了（官方：只给组织所有的仓）；默认分支是 **`main`**；main 未设任何保护（审计时；之后已开规则集，见 §5.1 末尾的注）；`allow_auto_merge=false`、`delete_branch_on_merge=false`、squash 标题默认 `COMMIT_OR_PR_TITLE`；互动限制 `collaborators_only`、`origin=repository`、到期 `2027-03-24T16:35:51Z`。
4. **事件桥要重新长出签名校验与对账**。旧事件桥用 `gh webhook forward`（本机不开端口，所以刻意不做签名校验，`scripts/lib/gh-events.mjs:5-10` 写明「改回 HTTP 端点必须把签名校验加回来」），2026-09-19 已随旧链路退役；fleet 现在靠派单器每 10 分钟轮询一次（`host/machine/systemd/dao-dispatcher.timer:20`）。设计把收件口放到 Cloudflare，等于重新开了一个谁都能 POST 的口：必须验 `X-Hub-Signature-256`、10 秒内回 2xx；GitHub 不自动重投失败投递（官方），所以要有投递日志对账 + 轮询兜底 + 自造样本判活。
5. **作者白名单会变成唯一的门**。旧系统真正挡住陌生人的，是「只有人能贴 `triage/accepted`」（`docs/labels.json:33`、`scripts/lib/dispatcher/queue.mjs:102`）。设计 §16 删了进门标签，白名单就是唯一的门。旧 fleet 只把 issue 标题+正文喂给会话（`packages/fleet/src/activities.mjs:937-944`），碰巧挡住了陌生人评论，却让创始人写在评论里的拍板永远到不了执行体（windsurf-dao#1675）。新系统要读评论，就必须同时按作者过滤；机器人开的单还要能追到「是哪位创始人让开的」，否则等于放开「AI 自己编活」。
6. **机器人提交没挂到机器人账号上**（审计时新发现，有提交为证）。旧代码用 App ID 拼 bot 的 noreply 邮箱（`scripts/lib/gh.mjs:93`、`:446-471`）；实测 bot 用户 ID ≠ App ID，2026-09-24 master 上一笔工人机器人的提交（windsurf-dao `11fd9ba9`）在 GitHub 上 `author` 为 null。新系统用 bot 用户 ID 拼邮箱，并回读 `commits/{sha}.author.login` 验证。
7. **网关的幂等账是每台机器一份的本地文件**（`scripts/lib/issue-gateway.mjs:6`、`:151-172`），换机不拷，正文里的幂等标记也只写不查（`extractIdempotencyMarker` 在网关里没有调用点）。Temporal 的活动重试是「至少一次」，工人一多、一换机就会重复写。账要进 Postgres，并在「写了但回执没收到」时按标记回查远端。
8. **旧代码到处写死 master**：`packages/fleet/src/cli.mjs:206`、`packages/fleet/src/contract.mjs:33`、`:56`、`scripts/lib/push-gate.mjs:30`、`scripts/apply-branch-protection.mjs:67`、`:106`、`scripts/gh-as.mjs:33`。fleet-dao 默认分支是 main。搬代码时一律改成读仓库的 `default_branch`，并配一条「引擎代码里不许出现字面量 master」的测试（§6 G1）。

---

## 1. 两个机器人身份

### 1.1 旧系统怎么做

**五个 App，新设计只留两个**

| 身份 | 旧用途 | 权限 | 新设计 |
|---|---|---|---|
| 帅位机器人 | 帅：开单/评论/关单/贴标、合并 PR | 实测：contents:write、pull_requests:write、issues:write、checks:read、metadata:read | 留这个角色（新：「引擎」机器人） |
| 工人机器人 | 工人：推分支、开 PR | 实测：同上，一字不差 | 留这个角色（新：「干活的」机器人） |
| 审官机器人 | 审官 approve（为绕开 windsurf-dao#444「同账号不能批准自己 PR」而建，见 windsurf-dao#573 正文） | 实测：contents:read、pull_requests:write、issues:read、checks:read | 退（第二意见在引擎内，不需要 GitHub 审批） |
| 看守机器人 | 事故观察 | 规格：issues/pull_requests 写，contents/checks 读（`NEW-MACHINE.md:81`） | 退 |
| 消歧机器人 | 贴「已消歧」授权标 | 规格：只 issues:write（`scripts/lib/gh.mjs:127-138`） | 退（进门标签已删） |

实测来源：令牌缓存里 GitHub 回写的 `permissions` 字段（只读这一字段与到期时间，没读令牌本身，没有换发新令牌）。

**发令牌（`scripts/lib/gh.mjs`）——这套做法值得原样搬**

1. 凭据：每个角色一份 JSON（appId、installationId、slug）+ 一份私钥 PEM，放机器本地、不进 git。缺文件报 `not_installed`「这台机器没装」，json 缺字段报 `bad_config`「配置错了」，两者处置不同（`:153-194`；windsurf-dao#573 ①登记为「已经踩过」）。
2. JWT：Node 内建 crypto 签 RS256，`iat = 现在-60 秒`（抗时钟漂移），`exp = 现在+540 秒`（GitHub 硬限 10 分钟）（`:141-143`、`:213-227`）。
3. 换令牌：`POST /app/installations/{installation_id}/access_tokens`，要求 201 且带 token/expires_at（`:256-279`）。
4. 缓存：每个角色一个令牌缓存文件（0600），剩余 ≤10 分钟就重换——令牌 1 小时硬过期，长任务跑一半会 401（`:15`、`:141`、`:196-211`、`:280-290`）。
5. 自检：`gh-as.mjs <role> --whoami` 调 `GET /installation/repositories`，并与期望权限逐项比对；读不到算「没查成」，不算「0 条差异」（`:371-420`）。
6. 官方补充（审计时核对「Generating an installation access token」页）：换令牌时可带 `repositories`/`repository_ids` 与 `permissions` 把令牌收窄到单仓、单权限；令牌 1 小时过期；GitHub 已预告安装令牌不再固定 40 字符，别按长度判断。

**提交身份**：每棵工作树写 worktree 级 `user.name=<slug>[bot]`、`user.email` 用 `<AppID>+<slug>[bot]` 拼 GitHub 的 noreply 邮箱，写完回读（`scripts/lib/gh.mjs:446-471`；windsurf-dao#573 ③：「只改一半比不改更容易误判」）。邮箱前缀用错了，见 §0 第 6 条与 §6 A4。

**凭据隔离**（windsurf-dao#792 的结论原话：「最终承重的是唯一网关和凭据隔离，不能把『多写一遍提醒』当成完成」）：
- 自动化单元一律 `UnsetEnvironment=GH_TOKEN GITHUB_TOKEN`；不推远端的单元用 `GH_CONFIG_DIR=/var/empty` 挡住个人登录（`scripts/lib/issue-gateway-check.mjs:332-345`）。
- 会话里不许跑 gh：GitHub 事实由活动取回塞进提示词，提交身份由系统设（`packages/fleet/src/activities.mjs:884`、`:985`，g7/g9 实咬：会话跑 gh 会卡在权限提问）。
- 推送时才按次取工人机器人的令牌注入 git 进程环境（`packages/fleet/src/cli.mjs:746-750`）。

**装在哪（只写种类，不写位置）**
- 私钥与安装号：放跑服务那个用户的本地配置里，**不放 root 家目录**（`NEW-MACHINE.md:60`）。私钥「只此一份，丢了要回 GitHub 重新生成」（`NEW-MACHINE.md:58`）；属「手动带、不进 git」的一类（`host/machine/INDEX.md:70`）。
- GitHub 侧：五个 App 都归 `<账号A>`，按「选定仓库」安装：帅位机器人装 6 个仓（`NEW-MACHINE.md:83` 以「与 marshal 同范围」旁证；网关允许列表 `scripts/lib/issue-gateway.mjs:21-30` 正是这 6 个），消歧机器人只装 1 个仓（`NEW-MACHINE.md:98`）。**旧 App 装没装到 fleet-dao：没查成**（验法：用各 App 的 JWT 调 `GET /repos/<账号A>/fleet-dao/installation`，404 = 没装）。新系统已新建两个 App（实施计划 P1，已装到 fleet-dao 与 fleet-dao-canary），不和旧的共用私钥。

**建 App 时的操作坑**（写进装机手册，测不了）：建 App 只能由账号所有者在网页完成，没有 API（`NEW-MACHINE.md:91`）；Webhook「Active」默认勾着、勾着就必填 URL（`NEW-MACHINE.md:85`，新系统反而要填 Cloudflare 收件口和密钥）；直接跳安装页 URL 会被误导性的「This App has changed since you last viewed it」拒绝，必须从 App 设置页点 Install 进去（`NEW-MACHINE.md:113` 起）。

### 1.2 新系统权限矩阵（建议）

| 能力 | 接口 | 所需权限（官方文档） | 干活的（旧工人 App） | 引擎（旧帅位 App） |
|---|---|---|---|---|
| 推任务分支 | git push | Contents: write；推送里碰 `.github/workflows/` 另需 Workflows: write | ✓ | — |
| 开 PR、改 PR 标题正文 | `POST/PATCH /repos/{o}/{r}/pulls…` | Pull requests: write | ✓ | ✓（合并前改标题） |
| 草稿转正式 | GraphQL `markPullRequestReadyForReview` | Pull requests: write（旧 fleet 以帅位机器人实跑：`activities.mjs:1324`） | — | ✓ |
| 读 PR、mergeable | `GET /pulls/{n}` | Pull requests: read | ✓ | ✓ |
| 读检查 | `GET /commits/{ref}/check-runs`；`GET /commits/{ref}/status` | Checks: read（旧系统以帅位机器人实跑：`scripts/lib/ci-check-runs.mjs:26-30`）；Commit statuses: read（官方：公开仓可免权限读） | ✓ | ✓ |
| 服务端同步主线 | `PUT /pulls/{n}/update-branch` | Pull requests: write，且 App 还要有 head 仓的 Contents: write（官方原文） | 可选 | — |
| 合并 | `PUT /pulls/{n}/merge` | **Contents: write**（官方原文；所以工人技术上也能合） | 约定不做 | ✓ |
| 删分支 | `DELETE /git/refs/heads/…` | Contents: write（审计时未单独核文档） | ✓ | ✓ |
| issue 建/评/改正文/关 | `/issues…` | Issues: write | **✗ 建议摘掉** | ✓ |
| 判协作者 | `GET /collaborators/{user}` | Metadata: read（官方原文，204 是 / 404 不是） | ✓ | ✓ |
| 互动限制读/写 | `GET/PUT /interaction-limits` | Administration: read / write（官方原文） | ✗ | **待拍** |
| 读完整分支保护 | `GET /branches/{b}/protection` | Administration: read；旧检查器注明四个 App 读都是 403（`scripts/lib/branch-protection-check.mjs:21-23`） | ✗ | 待拍 |
| App 投递日志与重投 | App webhook 的 deliveries 接口 | App JWT（不是安装令牌） | — | ✓（webhook 挂它身上） |

### 1.3 要创始人拍的（改权限，属人闸）

- **Q1 主线改了 CI 配置时，在途分支怎么同步**：A 给「干活的」加 Workflows: write（全自动；代价是 AI 写的 CI 改动也能推上去，要配「碰 `.github/workflows/` 必须人点头」的硬闸）；B 不给，引擎识别到就停下、推飞书、人手推（旧 windsurf-dao#1725 的 bundle 垫片；窗口期所有在途分支一起停）；C 先实测「rebase 同步」或 `update-branch` 接口会不会同样被拒再定（审计时没查成，不许凭推断定）。
- **Q2 互动限制谁来续**：A 给「引擎」加 Administration（最省事，但这把钥匙能改保护、删仓）；B 另建一个只有 Administration 的小 App（最小权限，但违背「只两个机器人」）；C 不自动续，引擎按设置时记下的到期时间提前 30 天提醒，人手点一次（半年一次）。注意：连「读到期时间」也要 Administration: read。
- **注**：设计 §十四（2026-09-25 版）已写明「引擎」才能合并、改 issue、续互动限制、推 CI 配置改动，「干活的」只能推分支、开 PR——相当于 Q2 选 A、Q1 由「引擎」推 CI 配置改动。以设计为准；上面两问留作权衡依据（给「引擎」Administration 的风险、CI 配置改动要不要人点头）。

---

## 2. issue 网关：幂等与审计

对象：`scripts/issue-gateway.mjs`（CLI）与 `scripts/lib/issue-gateway.mjs`（库）。设计 §16 定为「留思路」。

### 2.1 契约
- 只收业务动作：create / comment / comment-upsert / close / reopen / edit-labels / edit-title / edit-body / milestone（库 `:18`；CLI `:21-31`）。
- 身份固定为帅位机器人：请求里出现 identity/token/cmd/shell/role 等字段即拒（库 `:31-34`、`:185-188`）；CLI 见 `--identity/--token/--role/--cmd` 即拒（CLI `:83-85`）；`gh-as` 对 `issue <写动词>` 一律拒并指向网关（`scripts/gh-as.mjs:165-169`、`scripts/lib/gh.mjs:25-37`）。
- 必带 host（发起方）与幂等键（1–200 个可见字符）（库 `:197-203`）。
- 仓白名单：默认 6 仓 + 环境变量 + 飞书群映射，不在名单就拒（库 `:21-30`、`:60-73`、`:688-692`）；名单少一个仓 = 交卷被拒、看起来像派出去了（库 `:26-27`，windsurf-dao#1024）。
- 凭据缺失 fail-loud，绝不退回个人 gh（库 `:317-324`、`:636-639`）。

### 2.2 幂等
- 账键 = sha256(动作\n仓\n幂等键) 前 32 位（`:151-156`）；账文件 `~/.dao/issue-gateway/idempotency/<键>.json`，0600（`:158-172`）。
- 命中已成功的账 → 直接返回原结果、标 `replay:true`，不再写 GitHub（`:694-703`；测试 `tests/issue-gateway.test.js:251`）。
- comment-upsert 例外：它本身「有则改、无则发」，同键第二次必须真去改（`:695-697`）。
- GitHub 上已经落了对象（有 number）就必须记账，哪怕回读失败——否则重放会再建一张（`:709-710`，注释：「本次真实验收 closedBy 字段踩过」）；记账失败则返回失败并附已落地 URL，交人按 URL 处置（`:711-720`）。
- 正文尾部嵌 `<!-- dao-idempotency:<键> -->`（`:80-90`）；edit-body 先去掉旧标记只留一个（`:606-608`）。标记只写不查（见 §0 第 7 条）。

### 2.3 回读自证（「拿到 URL 不等于成功」，`:1-5`）

| 动作 | 回读什么才算成 | 出处 |
|---|---|---|
| create | issue 作者是帅位机器人 | `:344-374` |
| comment | `GET` 这条评论 → 作者 | `:376-410` |
| close / reopen | state 必须 CLOSED / OPEN；回读缺 state 算没查成 | `:412-462` |
| edit-labels | 加的都在、删的都不在 | `:499-526` |
| edit-title / edit-body | 回读等于新值；正文比较前 CRLF→LF、去尾空白 | `:583-619`、`:594-598` |
| milestone | 回读里程碑号相等 | `:464-497` |
| comment-upsert | 回执正文含标记且作者是帅位机器人 | `:540-581` |

作者判定兼容机器人 login 的三种写法：REST `<slug>[bot]`、gh CLI `app/<slug>`、GraphQL `<slug>`（`:19-20`、`:92-113`；审计时 GraphQL 实测 `author.login` 是不带 `[bot]` 的写法）。

### 2.4 审计
- 每次调用（含被拒）追加一行 JSON 到 `~/.dao/issue-gateway/audit/audit.ndjson`：ts、host、action、idempotency_key、repo、bot、ok、stage、error、url、number、replay、author（`:174-179`、`:640-678`）。
- 失败阶段分得开：reject_input / forbidden_field / missing_idempotency / allowlist / creds_missing / gh_write / incomplete_receipt / gh_readback / author_mismatch / body_too_long / idempotency_store / audit。
- 审计写失败而对象已落地 → 返回失败（stage=audit）并附 URL，不许报成功（`:662-676`；测试 `tests/issue-gateway.test.js:431`）。
- 返回值里 ok/stage/error 压过附加字段，防止失败被盖回成功（`:145-149`，windsurf-dao#1015 审查意见）。

### 2.5 旧实现的缺口（新系统要补）
1. **账在本机文件**，换机不拷、多工人不共享 → Postgres 写入意图表（幂等键唯一约束）：先记「pending」→ 调 GitHub → 回填 number/url；重试遇 pending，先列最近由机器人建的 issue/评论、按标记回查，找到就补账，找不到才写。
2. **回执靠解析 CLI 输出里的 URL**：windsurf-dao#1211 就是 `/pull/` 形状没认出 → 判失败 → 不记账 → 重试连发三条（`:115-121`）。新系统直接读 REST 返回体的 number/id（官方最佳实践原文「Do not manually parse URLs」）。fleet 开 PR 也在从输出 URL 末段取号（`packages/fleet/src/activities.mjs:1112`），一并改。
3. **没有「提出人」**：审计只有 host（哪个宿主），没有哪位创始人要写的。设计 §3 第 5 条要求「记下提出人」→ 审计加 `requested_by`（驾驶舱 Access 身份 / 飞书用户）与工作流 ID。
4. **comment-upsert 只翻第一页 100 条评论找标记**（`:545`），评论过百会找不到、再发一条（潜在缺陷，未见事故）。新系统的进度改写在正文（§5.4），真要写评论就分页。
5. **幂等键由调用方手拼**：同一轮先后给 issue 和 PR 贴同一组标签，键若相同，后一次被当重放吞掉（`packages/fleet/src/cli.mjs:584-589` 注释记录的失效形态）。新系统由引擎统一生成：工作流 ID + 活动名 + 目标 + 轮次 + 内容摘要。

### 2.6 去留
- **搬**：固定身份、调用方不能选身份/传令牌、必带幂等键、回读自证、结构化审计、三态（成功/失败/没查成）、正文不走命令行参数、65536 字符上限预检。
- **丢**：gh CLI 外壳（§7）、写死在代码里的仓名单常量、「待拍板」标签的依据检查（windsurf-dao#1389，旧规则）、开单前 Jev 查重影子期（`scripts/issue-gateway.mjs:92-107`；新设计不许 AI 自己开单）。

---

## 3. PR：开、读检查、合并、收尾（旧 fleet 的做法）

### 3.1 开 PR（`packages/fleet/src/activities.mjs` 的 execute）
- 分支名 `dao/issue-<单号>-g<代>`（`:28`）。
- 推前三件事：先把远端分支头快进进工作树（别人在工人提交之上推进过；分叉就不动）（`:465-482`、`:1029-1032`）；判交付——相对**此刻**目标分支要有领先提交且有内容差异（`:282-297`、`:1064-1070`）；对齐提交前缀，但已在远端的提交不许 amend（`:1078-1083`）。
- 推送用工人机器人的令牌；失败分两类：App 无 workflows 权限 → `PERMISSION_DENIED` 要人，其余可重试（`:315-328`、`:1085-1086`）。
- 按分支找开着的 PR，base 不对就拒；没有就以工人机器人开草稿 PR（`:1087-1113`）。
- 合并前由帅位机器人把标题换成白话、正文写各轮记录（squash 提交标题取自 PR 标题）；这一步失败不挡合并（`:885-906`、`:1321-1323`）。

### 3.2 读检查（verify）
- 每 15 秒一次 `gh pr view --json headRefOid,baseRefName,statusCheckRollup,mergeable`，最长 20 分钟（`:1129-1191`）。
- 同名检查只留最新一条：rerun、以及 pull_request 与任务分支 push 双触发都会出两条（`:339-353`，PR #1760）。
- 契约：每个必过检查恰好一条、COMPLETED、SUCCESS；FAILURE/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE 判红；别的结论算没查成（`packages/fleet/src/contract.mjs:99-121`）。
- mergeable=CONFLICTING：活动自己并目标分支——干净就推、交回新头；有冲突就把文件清单交回返工；不 force push、不猜着解（`activities.mjs:493-570`、`:1151-1167`；windsurf-dao#1755）。
- 头被推进过、但工人提交仍是祖先：认领新头，审查重来（`:1134-1139`、`:1169-1174`）。
- 本机快马 `pr-land` 的读法：GraphQL 汇总读不到时退到 REST check-runs + status，两条都读不到算没查成（`scripts/lib/pr-land.mjs:22-48`）；零条检查不当绿（`:6-8`、`:79`）。

### 3.3 合并（integrate）
- 合前核对：PR 是 OPEN、头 = 审过的头、base = 契约目标分支、mergeable≠CONFLICTING（UNKNOWN 照常试）（`activities.mjs:1313-1320`）。
- `pr ready` 后 `pr merge --squash --match-head-commit <头>`，都用帅位机器人（`:1324-1325`）；`pr-land` 走 REST `PUT /pulls/{n}/merge`，带 `merge_method=squash` 与 `sha`（`scripts/pr-land.mjs:110-116`）。
- 失败不看报错文案，重读 mergeable：只有 CONFLICTING 才判 `MERGE_CONFLICT`（不可重试），其余 `SERVICE_UNAVAILABLE`（可重试）（`:1326-1334`；`contract.mjs:143-144`）。
- 合后回读，交付判定要求 merged、sourceHead=审过的头、mergeCommit 是 SHA、base 对（`:1335-1345`；`contract.mjs:123-134`）。
- 旧仓分支保护：required=["check"]、strict=false、enforce_admins=false（`scripts/lib/branch-protection-check.mjs:29-31`）。strict=false 的代价写在 CI 配置里：「各自绿、合起来红」只有每日定时兜底，个人账号用不了 merge queue（`.github/workflows/check.yml:20-21`）。

### 3.4 关单与收尾
- 关单走网关 close，幂等键 `<任务ID>-close`，关完回读 state（`packages/fleet/src/cli.mjs:676-719`）；关单失败判可重试，因为网关幂等（`activities.mjs:1351-1359`）。
- 挡 GitHub 原生关单词：`close/fix/resolve… #N` 会在合并瞬间由 GitHub 自己关单，绕过关单逻辑（`scripts/lib/close-keyword-guard.mjs:1-7`；`scripts/lib/pr-land.mjs:65-69`）。
- 取消的任务：脏树先存档再强收，并按分支精确匹配关掉这一代 PR，否则下一代派不出去（`activities.mjs:189-219`、`:1360-1415`；PR #1827）。

---

## 4. 事件桥

### 4.1 旧：`gh webhook forward`（windsurf-dao#956 → `scripts/gh-event-bridge.mjs` + `scripts/lib/gh-events.mjs`）
- 为什么做：审官判定落地、PR 合并要关单、工人交卷要起审官，三件都是「有人做了个动作」，却要等 20 分钟轮询（windsurf-dao#903「三票落了 20 分钟无人处置」）（`gh-event-bridge.mjs:2-7`）。
- 怎么做：`gh webhook forward --events=pull_request,pull_request_review` 在仓上建一个投到 webhook-forwarder 的 hook，本机经出站 wss 拉回；本机不监听端口，所以没有签名校验这一层（`gh-events.mjs:5-10`、`:36`；`gh-event-bridge.mjs:8-14`、`:386`）。它依赖个人 gh 登录，App 令牌用不了（`scripts/lib/issue-gateway-check.mjs:332-333`）。
- 只叫醒不判断：收到事件就 `systemctl start --no-block` 已有单元，判据仍在原脚本里（一把尺只在一处）；同一单元 60 秒冷却，冷却期来的事件期末补一发（`gh-events.mjs:25-26`、`:41-42`、`:128-138`；`gh-event-bridge.mjs:91-107`、`:221-243`）。
- 判活：每 10 分钟朝自家 hook 打一次 ping，「最近收到过自造样本」才判绿；心跳停、ping 迟到超过两个周期+5 分钟、一小时断线 ≥6 次、叫不动单元都判红（`gh-events.mjs:140-161`、`:335-422`）。
- hook 归属：只删能证明是自家的失效 hook；宽扫曾误伤别人的活 hook；EOF 后 5 秒一次重连 17709 次把通道卡死几十小时，改成 5 秒起跳、封顶 5 分钟的退避（`gh-events.mjs:28-33`、`:166-168`、`:212-231`）。
- 结局：2026-09-19 随旧链路退役，单元停+禁（`scripts/bootstrap-server.mjs:66`、`:75`；`docs/decisions/2026-09-19-transition-to-fleet.md:17`）；fleet 现在靠派单器每 10 分钟一轮（`host/machine/systemd/dao-dispatcher.timer:20`）。

### 4.2 新：Cloudflare 收件口必须满足（设计 §4「GitHub 事件接收」、§13）
1. 用 App 级 webhook（每个 App 一个 URL + 一把密钥），挂在「引擎」机器人上。订阅按需：`issues`、`issue_comment`、`pull_request`，外加 CI 完成的叫醒（`check_suite`/`check_run` 要 Checks: read，两个机器人已有；`workflow_run` 要 Actions: read，两个都没有——事件与权限的对应审计时没逐条核）。
2. 按**原始请求体**算 HMAC-SHA256，与 `X-Hub-Signature-256` 常量时间比对；不对就拒并留日志（windsurf-dao#956 验收「伪造签名必须被拒且留日志」）。
3. 10 秒内回 2xx，否则 GitHub 判投递失败（官方）；转不到 VPS 就回 5xx，让 GitHub 留下「失败」记录，别回 2xx 然后丢掉。
4. GitHub 不自动重投；3 天内可重投；重投时 `X-GitHub-Delivery` 不变（官方）→ 用它去重；每小时用 App JWT 拉投递日志，对不上的重投并报警。
5. 事件只当「叫醒」：给对应工作流发信号，引擎重读 GitHub 真值再决策；轮询兜底保留（windsurf-dao#956 验收：「故意让 webhook 失效，轮询必须在一个周期内接住」）。
6. 判活靠自造样本：设计 §6 的 6 小时巡检单本来就会产生事件——把「巡检单的事件多久内到达」列进判活，外加「投递日志里最近失败数」。不以「没报错」判绿。
7. `sender` 可能是占位的 ghost 用户（官方：check_run/check_suite 等可能没有真实触发人），判作者用内容对象的 `user`（§5.3）。

---

## 5. 新系统四项能力：接口与权限

### 5.1 合并队列（引擎自排）

为什么自己排：GitHub 合并队列只给「组织所有的公开仓 / 用 GHEC 的组织私有仓」（官方「Managing a merge queue」），fleet-dao 属个人账号（实测）。旧仓因此只能 strict=false + 每日定时兜底（`check.yml:20-21`）。

同一仓同时只合一个：

| 步 | 做什么 | 接口 / 权限 | 对应坑（§6） |
|---|---|---|---|
| 1 | 取队首 PR，读 head、base、草稿否、mergeable；null/UNKNOWN 单独重读、等 GitHub 算完 | `GET /pulls/{n}`；Pull requests: read | C10 |
| 2 | 主线在上次测试后动过 → 同步主线到 PR 分支：本地 merge/rebase + push，或 `PUT /pulls/{n}/update-branch` 带 `expected_head_sha`（202 异步，422 = 头变了） | Contents: write（+ Pull requests: write）；同步带进 workflow 改动还要 Workflows: write | C1 C4 C5 C6 |
| 3 | 等**新头**上的 CI：由 push 事件在新 SHA 上跑，不去 rerun 旧的 pull_request 运行；读 check-runs（+ status）；零条 = 等，同名取最新 | Checks: read；Commit statuses: read（公开仓可免） | C2 C9 C17 C18 |
| 4 | 红：同一 SHA 重跑一次确认，仍红退回原会话；绿：检查有没有没消费的追加要求 | — | C12 C19 |
| 5 | 草稿转正式；`PUT /pulls/{n}/merge`：`merge_method=squash`、`sha=新头`、**显式 `commit_title`**（fleet-dao 的 squash 默认 `COMMIT_OR_PR_TITLE`，单提交 PR 会用提交标题而不是 PR 标题） | Contents: write；405 不能合（重读状态再分类）、409 头变了（回第 1 步）、422 校验失败或刷太快 | C8 C11 |
| 6 | 回读 merged / merge_commit_sha；删分支（fleet-dao 没开合并后自动删）；回写 issue 进度；记账 | Pull requests: read；Contents: write；Issues: write | C13 C22 |

建议给 main 装的保护（一次性，要 Administration，创始人装）：必过检查 = CI 那一项的名字；**strict=true**（队列本来就串行，代价小，GitHub 侧兜住「在最新主线上测过」）；禁止强推与删除；不要求审批（第二意见在引擎内，windsurf-dao#444 那个理由已不存在）。装之前先确认必过检查在 pull_request 与任务分支 push 上都会出现（C20）。能否用规则集把「合并」限定给「引擎」一个 App：没查成。

注（2026-09-25）：实施计划 P1 这一项已完成——两个新机器人已装到 fleet-dao 与 fleet-dao-canary，两个仓的主线规则集已开：只有「引擎」机器人和仓主能直推，其余走 PR 且 `check` 要绿（[plan.md](../plan.md) 第五节）。strict、禁止强推等细项以仓上的规则集为准。

### 5.2 互动限制自动续期

- 现状（实测）：`collaborators_only`，`origin=repository`，到期 `2027-03-24T16:35:51Z`（仓创建时设的 6 个月）。
- 接口（官方「REST API endpoints for repository interactions」）：
  - `GET /repos/{o}/{r}/interaction-limits` —— Administration: read；没有限制时回空。
  - `PUT` 同路径，body `{"limit":"collaborators_only","expiry":"six_months"}` —— Administration: write。`expiry` 可选 one_day / three_days / one_week / one_month / six_months，**不写默认 one_day**。账户级限制存在时回 409，只能改账户级。
- 覆盖面（官方）：限制评论、开 issue、开 PR、表情、编辑已有评论、改 issue/PR 标题；「只限协作者」= 对仓没有写权限的人受限。
- 机器人：两个都没有 Administration（实测）→ 见 §1.3 Q2。
- 续期逻辑（建议）：每天一次（Temporal 定时）：GET → 剩余不足 30 天 → PUT（显式 six_months）→ 回读 `expires_at ≥ 现在 + 170 天` → 记 Postgres「上次成功时间、到期时间」；GET/PUT 失败、403、409 都报警（没查成 ≠ 没事）；看门狗盯「上次成功」是否新鲜。选 §1.3 Q2 的 C 时，只保留「提前 30 天提醒」这一半。
- 没查成：App 机器人自己的评论、开 PR 受不受这项限制（按「没有写权限的人受限」推断不受；装上后发一条评论实测一次）。

### 5.3 白名单作者过滤

- 旧门在哪：只有人能贴 `triage/accepted`（`docs/labels.json:33`；`scripts/lib/dispatcher/queue.mjs:102`），公开仓里陌生人开的单永远派不出去。设计删了这道门，白名单成了唯一的门；互动限制一旦过期（或续期失败），陌生人就能评论。所以白名单必须在代码里强制执行，不能依赖互动限制。
- 身份从哪来：webhook 负载里内容对象的 `user`（issue.user / comment.user / pull_request.user / review.user），编辑事件再看 `sender`；`sender` 可能是 ghost（官方）。
- 机器人 login 有三种写法：REST `<slug>[bot]`（type=Bot）、gh CLI `app/<slug>`、GraphQL `<slug>`（`scripts/lib/issue-gateway.mjs:19-20`、`:92-113`；`scripts/lib/cause-slug-check.mjs:37`；审计时 GraphQL 实测）→ 按 type=Bot + 数字 ID 认，不按字符串认。
- 协作者：`GET /repos/{o}/{r}/collaborators/{user}`（Metadata: read；204 是、404 不是；官方）带短时缓存；创始人名单放 Postgres 配置。`author_association` 对机器人给什么值：没查成，别拿它判机器人。
- 规则（建议）：
  1. 开工：issue 作者是创始人或协作者；或作者是「引擎」机器人 **且** Postgres 操作记录里有对应的创始人操作（驾驶舱/飞书开的单）。否则不开工——防「AI 自己编活」（设计 §3 第 11 条）。
  2. 喂给会话的评论只收白名单作者的；其余只记录。
  3. 正文被白名单外的人编辑（sender 不在名单）→ 用最后一个可信版本，报警。
  4. 自家机器人改正文、发评论产生的事件不再触发工作流（防自激，见 §5.4）。
  5. 来自 fork 的 PR 不进引擎。
- 所需权限：Issues: read、Pull requests: read、Metadata: read（两个机器人都有）。

### 5.4 issue 正文原地更新进度

- 接口：`PATCH /repos/{o}/{r}/issues/{n}`，Issues: write（旧帅位机器人有；旧 edit-body 已在生产用过：PR #1732。官方页审计时抓取被截断，这一节原文没抓到）。写前 `GET`。官方只给**读**的条件请求（ETag / 304，且 304 不占主配额），写入没有「版本不对就拒」的乐观锁——按「没有」设计。
- 做法（建议）：
  1. 正文分两段：人写的（原话、AI 理解）+ 引擎段，用 `<!-- fleet:progress:start -->…<!-- fleet:progress:end -->` 包住，只替换引擎段。
  2. 写前重读最新正文，用最新的人写段拼新正文；新旧引擎段相同就不写（省内容创建配额）。
  3. 写后回读：引擎段 = 新值、人写段与写前一致；不一致 = 撞上了人手编辑 → 把人手版本放回并报警。比较前 CRLF→LF、去尾空白（`scripts/lib/issue-gateway.mjs:594-598`）。
  4. 正文上限 65536 字符，发前检查（windsurf-dao#1363）；走 HTTP 请求体，不走命令行参数。
  5. 节流：同一 issue 只在步骤变化时写，并合并高频更新；全局写请求串行、间隔 ≥1 秒；遇 secondary rate limit 按 retry-after 或 ≥60 秒指数退避（官方：内容创建 ≤80 次/分、≤500 次/时；PATCH 每次记 5 点）。PATCH 是否算「内容创建」没查成，按算设计。
  6. 子任务与 PR 用编号渲染，**不写 Closes/Fixes/Resolves**（C13）。
  7. 一致性检查分三态：已发布的引擎段与 Postgres 真值对不上 = 红；读不到 = 没查成（旧 T44 视图评论就是这么判的：`scripts/lib/stage-board.mjs:1-7`）。
- 自激：引擎改正文会产生 `issues.edited`（sender=「引擎」机器人），必须被 §5.3 第 4 条挡住。

---

## 6. 踩过的坑 → 新系统的测试用例

> 只收有 issue、判例或提交为证的。标「审计时新发现」的，是审计时只读核查挖出的、旧系统没人报过但有提交/输出为证的。

### A 身份与凭据

- **A1 AI 用个人身份写了 GitHub**
  新系统的测试用例：给定服务进程与会话环境里只有机器人凭据，当引擎代创始人开单/评论/合并，应当回读作者为指定机器人，作者不符或读不到判失败；进程环境里不存在 GH_TOKEN/GITHUB_TOKEN 与个人 gh 登录；任何路径都不退回个人凭据（包括「机器人在某仓没推送权就改用仓主凭据合并」这类旁路）。
  出处：windsurf-dao#792（#790 事故：裸 `gh issue create` 记到个人账号名下）；`scripts/lib/issue-gateway.mjs:344-364`；`scripts/lib/pr-land.mjs:86-94`（旧快马对网关仓用仓主凭据合并的旁路）。
- **A2 凭据没装被报成配置错**
  测试用例：给定某机器缺某角色私钥，当调用该角色，应当报「这台机器没装」并失败，不回退到别的身份；json 缺字段才报「配置错了」。
  出处：windsurf-dao#573 ①（登记为已踩过）；`scripts/lib/gh.mjs:153-194`。
- **A3 服务器没有个人登录，裸读 CI 恒失败还触发昂贵兜底**
  测试用例：给定服务器没有个人 gh 登录，当引擎查某个 SHA 的 CI，应当用机器人令牌查；查不成判「没查成」，不触发全量本地测试之类的兜底。
  出处：PR #1825（服务器 5 分钟自检每天白跑 36 次全量测试）；`scripts/lib/ci-check-runs.mjs:10-12`。
- **A4 机器人提交没关联到机器人账号**（审计时新发现）
  测试用例：给定引擎以「干活的」机器人身份提交并推送，当回读 `GET /repos/{o}/{r}/commits/{sha}`，应当 `author.login == "<slug>[bot]"`；提交邮箱前缀用 bot 用户 ID（启动时 `GET /users/<slug>[bot]` 取），不用 App ID。
  出处：实测提交 11fd9ba9（2026-09-24，master）`author` 为 null；实测 bot 用户 ID ≠ App ID；`scripts/lib/gh.mjs:93`、`:446-471`。
- **A5 推送依赖个人登录，挡掉个人登录就推不动**
  测试用例：给定机器上没有个人 gh 登录（或被空目录挡住），当引擎推任务分支，应当仍用机器人令牌推成功（每次推送显式带凭据，不依赖机器上的凭据助手配置）。
  出处：`docs/observations/2026-09-09-凭据闸把额度采样的git推送掐死.md:8`（额度采样单元自 2026-09-06 起每 10 分钟推送失败）；`scripts/lib/issue-gateway-check.mjs:345`；`packages/fleet/src/cli.mjs:746-750`。
- **A6 root 在服务用户家目录里留文件**
  测试用例：给定装机脚本以 root 身份执行，当它放置凭据、克隆仓、跑测试，应当落在服务用户家目录且属主是服务用户；装机自检扫出 root 属主文件即红。
  出处：判例 memory `root-owned-files-in-service-home`（撞 2 次：132 个、376 个 root 属主文件，三种不相像的失败）；`NEW-MACHINE.md:60`。
- **A7 「仓不存在」其实是「没装/没权限」**
  测试用例：给定机器人没装到目标仓，当引擎访问该仓得到 404，应当报「App 未装到该仓或无权限」，不报「仓库不存在」或「认证失败」。
  出处：判例 memory `github-not-found-vs-auth`（GitHub 对不存在与无权限统一回 Not Found，2026-08-10 被误导成认证问题）。
- **A8 改设置回 200 但没生效**
  测试用例：给定用 API 改仓库设置（自动合并开关、互动限制、分支保护），当接口回 200，应当回读该字段本身确认生效，不生效报红。
  出处：判例 memory `private-repo-free-plan-no-automerge`（PR #616：`allow_auto_merge` PATCH 回 200 字段不动；windsurf-dao#625）。

### B 网关写入

- **B1 回执没认出 → 不记账 → 重试重复发**
  测试用例：给定评论已在 GitHub 落地但回执形状没认出（如 PR 评论的 `/pull/` 链接）或回执丢失，当同一请求重试，应当先按幂等键与正文标记回查远端，找到就补账返回原结果，不得再发一条。
  出处：windsurf-dao#1211（交卷评论连发三条，修复 PR #1212）；`scripts/lib/issue-gateway.mjs:115-121`、`:709-720`（注释「closedBy 字段踩过」）。
- **B2 重试时换了幂等键**
  测试用例：给定一次写入回执丢失，当人或程序重试，应当只能复用原请求（原幂等键）重放；换键重发要被拦下或至少先回查远端是否已有同内容。
  出处：判例 memory `retry-must-reuse-idempotency-key`（2026-09-17 在 windsurf-dao#1174 刷出两条 62KB 重复评论，且删不掉）。
- **B3 大正文走命令行参数撞 E2BIG**
  测试用例：给定 200KB 正文，当写评论，应当成功（不经命令行参数传递）；给定超过 65536 字符的正文，应当在发出前拒绝并报实际字符数。
  出处：windsurf-dao#1363（132399 字节 E2BIG，修复 PR #1548）；`scripts/lib/issue-gateway.mjs:276-292`。
- **B4 幂等键粒度太粗，合法的第二次写被当重放吞掉**
  测试用例：给定同一轮先给 issue、再给 PR 写同一组改动，当两次写入，应当两次都落地（键含目标、轮次、内容）；给定真重放，应当只落一次。
  出处：`packages/fleet/src/cli.mjs:584-589`（注释记录的失效形态）。
- **B5 从 URL 文本里抠编号**
  测试用例：给定 GitHub 返回的对象，当取 issue/PR/评论编号，应当读返回体的 number/id 字段；构造一个 URL 形状陌生的回执，结果仍正确。
  出处：windsurf-dao#1211；`packages/fleet/src/activities.mjs:1112`；官方 REST 最佳实践「Do not manually parse URLs」。

### C PR、CI 与合并

- **C1 冲突的 PR 不起 CI**
  测试用例：给定 PR 与主线冲突（mergeable=CONFLICTING），当引擎等 CI，应当判成「需要同步主线」并自动同步（干净就推，冲突把文件清单交回会话），不得判「CI 缺失」交人；任务分支的 push 事件也要触发 CI，冲突态也有信号。
  出处：windsurf-dao#1755（一夜三张 #1739/#1747/#1749）；判例 memory `conflicting-pr-gets-no-ci-runs`（撞 3 次）、`ci-silent-when-pr-conflicts`（PR #490、#613）；`packages/fleet/src/contract.mjs:99-110`；`.github/workflows/check.yml:25-29`（PR #1768 的垫片）。
- **C2 rerun 复用旧的合并提交**
  测试用例：给定修法已合进主线而 PR 没动，当合并队列要「在最新主线上重测」，应当先产生新的头提交（同步主线后推送）触发新运行，不得调用 rerun。
  出处：判例 memory `rerun-reuses-stale-merge-commit`（PR #1774 红，修法 PR #1783 合进后 rerun 两次仍红，关开 PR 才绿）。
- **C3 任务自己改了 CI 配置，App 推不上去却被当成可重试**
  测试用例：给定任务的改动碰了 `.github/workflows/` 且机器人没有 Workflows 权限，当推送被拒（`refusing to allow a GitHub App to create or update workflow`），应当一次判「权限不足、要人」，不按可重试退避。
  出处：windsurf-dao#1725（白烧 6 次、约 112 分钟才交人），修复 PR #1833；`packages/fleet/src/activities.mjs:315-328`。
- **C4 主线改了 CI 配置，所有在途分支同步后都推不上去**
  测试用例：给定主线新合入了 workflow 改动而机器人没有 Workflows 权限，当引擎给在途分支同步主线，应当在推送前识别出「同步带进了 `.github/workflows/`」，按 §1.3 Q1 已拍的路走（有权限就推、没有就停下叫人），不得让所有在途分支同时在推送上反复失败。
  出处：PR #1833 正文「#1768 改过 check.yml 之后，早于它起的分支并 master 再推都会撞上」；提交 7c07c1da3（PR #1768 改 check.yml）。
- **C5 系统 amend 改写已发布的提交**
  测试用例：给定分支头提交已在远端（别人在工人提交上推进过），当系统要改提交信息，应当不 amend/rebase；判不出是否已发布就按已发布处理。
  出处：PR #1765（windsurf-dao#1734 g1，2026-09-23 02:40：并进的 merge 提交被改写成新 SHA，之后每轮推送 non-fast-forward）；判例 memory `system-amend-rewrites-published-commit`；`activities.mjs:483-492`、`:1078-1083`。
- **C6 远端分支头被推进，下一轮推送被拒**
  测试用例：给定远端任务分支在工人提交之上被推进过，当下一轮会话开工，应当先快进到远端头；分叉就不动并报出来，不覆盖。
  出处：PR #1760、#1763（2026-09-22 一夜三张 + 次日凌晨 non-fast-forward）；`activities.mjs:465-482`、`:1029-1032`。
- **C7 「HEAD 变了」被当成交了活**
  测试用例：给定执行者零产出、而工作树被快进到新主线（HEAD 变了），当判交付，应当判「空交付」——要求相对此刻目标分支领先提交数 >0 且对合并基有内容差异；系统也不许 amend 不属于本任务的提交。
  出处：判例 memory `completed-is-not-delivered`（windsurf-dao#1560 → PR #1571 一路全绿、活一个字没做）；`activities.mjs:282-297`、`:1064-1070`。
- **C8 判绿之后又推了新提交**
  测试用例：给定第二意见与 CI 针对提交 A 通过、之后又推了 B，当合并，应当拒绝（结论必须绑在当前头上）；合并请求带 `sha=当前头`，头变了 GitHub 回 409，按「重新排队」处理。
  出处：判例 memory `review-green-must-match-head`（PR #497 差点误合）；`contract.mjs:74`；`activities.mjs:1316`、`:1325`；官方合并接口 `sha` 参数（409）。
- **C9 零条检查、同名多条检查**
  测试用例：给定头提交上还没有任何检查，应当判「等」而不是绿；给定同名检查因 rerun 或 push/pull_request 双触发出现两条，应当取最新一条，不判「有歧义」。
  出处：`scripts/lib/pr-land.mjs:6-8`、`:79`；PR #1760（「8 条在途全躺收件箱的三个真因」之一）；`activities.mjs:339-353`。
- **C10 mergeable 读成 UNKNOWN**
  测试用例：给定列表或多字段查询给出 mergeable=UNKNOWN，当判能不能合，应当单张重查；仍 UNKNOWN 就等，既不当冲突也不当可合。
  出处：windsurf-dao#1017（`tests/mergeable-resolve.test.js:1-3`：列表与多字段查询里恒为 UNKNOWN）；windsurf-dao#1595 第 2 条。
- **C11 合并失败靠报错文案猜原因**
  测试用例：给定合并接口失败，当分类，应当重读 mergeable：只有 CONFLICTING 判必然失败（不重试、交回会话同步），其余可重试；构造「分支保护的 not mergeable」与 409 两种文案，都不得被判成冲突。
  出处：windsurf-dao#1595（冲突被当瞬时故障重试 5 次）；`activities.mjs:1318-1334`。
- **C12 追加要求与合并赛跑**
  测试用例：给定 PR 已进合并队列、创始人刚追加要求或点了「改一下」，当队列走到合并前最后一步，应当看到没消费的追加信号并暂停合并；若已合并，把追加转成新子任务，不丢。
  出处：判例 memory `auto-merge-races-marshal-followup`（PR #596：追加后 69 秒判绿、2 分钟后合并，两条追加落空）。
- **C13 GitHub 关单词绕过关单逻辑**
  测试用例：给定引擎生成的 PR 正文，当合并，应当不含 `Closes/Fixes/Resolves #N`（写「属于需求 #N」），合并前再扫一次；需求单被 GitHub 自动关掉要报警并按规则重开。
  出处：PR #1853 正文带 `Closes #1838` 被 GitHub 合并时自动关单、绕过关单脚本，修复 PR #1866；`scripts/lib/close-keyword-guard.mjs:1-7`；`scripts/lib/pr-land.mjs:65-69`。
- **C14 取消的任务 PR 一直挂着**
  测试用例：给定任务被取消，当收尾，应当关掉这一代 PR（按分支精确匹配），脏树先存档，下一代能从最新主线重开。
  出处：PR #1827（2026-09-24 一夜手工关 4 张才解开）；`activities.mjs:189-219`。
- **C15 两个并行任务新建了同一个文件**
  测试用例：给定两个子任务的方案里都要新建同一路径，当调度，应当不让它们同时跑（排队或同一会话连做）；运行中检测到就报警。
  出处：`scripts/lib/competing-prs.mjs:3-6`（2026-09-06 PR #884/#886 各建同一文件，一个 PR 基本作废）。
- **C16 机器人读 GraphQL 检查汇总被拒**
  测试用例：给定机器人读 `statusCheckRollup` 被拒（`Resource not accessible by integration`），当读 CI，应当退到 REST check-runs；两条都读不到判「没查成」，不当零条检查。
  出处：`scripts/lib/pr-land.mjs:26-47`、`scripts/pr-land.mjs:9-10`（2026-09-24 在网关仓实测）。
- **C17 刚推送就读到上一次的红**
  测试用例：给定推送后不久读到红，当判红，应当对同一 SHA 再确认一轮；仍红才退回。
  出处：`scripts/pr-land.mjs:99-107`（PR #1872、#1874 两次靠人手重跑才合上）。
- **C18 偶发红被当成代码坏了**
  测试用例：给定合并队列重测红，当判定，应当对同一 SHA 的 push 运行重跑一次；转绿记「偶发」不退回，仍红才退回原会话，复核不了叫人。
  出处：`scripts/master-sentinel.mjs:13-16`（2026-09-24 fleet 集成测试 180 秒超时，重跑就绿）。
- **C19 选项的值被当成 PR 号**
  测试用例：给定命令漏写 PR 号、只带 `--max-min 20`，当解析，应当报用法错误，不得把 20 当 PR 号（否则报出别的 PR 的 MERGED）。
  出处：`scripts/lib/pr-land.mjs:96-101`（2026-09-24 实咬：报成「MERGED」了一张早已合并的 PR）。
- **C20 分支保护装到 CI 不在 PR 上跑的仓，永久锁死**
  测试用例：给定要给某仓装「必过检查」，当一键装，应当先确认该检查会在 pull_request（与任务分支 push）上出现且当前为绿，否则拒装。
  出处：windsurf-dao#999；`scripts/apply-branch-protection.mjs:5-7`（miraquota-win 的 CI 只 on.push）。
- **C21 机器人自己合、没有审查证据**
  测试用例：给定已合并的 PR，当每小时对账，应当每一张都能在 Postgres 找到合并队列记录（CI 所在的头、第二意见或风险档免审理由）；合并人不是「引擎」机器人 或找不到记录即报警。
  出处：windsurf-dao#1093（2026-09-06 夜 5 张 PR 作者与合并人同为帅位机器人、reviews=0）；`scripts/lib/marshal-selfmerge-check.mjs:1-7`。
- **C22 工人身份合并了 PR**（由 §0 第 1 条引出，防的是 C21 那类旁路）
  测试用例：给定一个 PR 的 mergedBy 是「干活的」机器人，当对账，应当报红。
  出处：官方合并接口只要 Contents: write（旧工人机器人实测有）；windsurf-dao#573「权限隔离是装饰」的登记。

### D 事件

- **D1 通道断了、进程还活着，自检全绿**
  测试用例：给定收件口或转发链路断了但进程都活着，当健康检查，应当判红——判据是「最近收到过自造样本 / 投递日志对得上」，不是「没报错」；一小时内投递失败或断线多次也判红。
  出处：`docs/observations/2026-09-15-事件桥通道死了父进程仍绿.md:15`（子进程重启 4941 次、503 分钟没收回 ping，父进程一直 active）；`scripts/lib/gh-events.mjs:140-161`、`:335-422`。
- **D2 删 webhook 误伤别人、重连无上界**
  测试用例（只在引擎要管仓上 webhook 时适用）：给定仓上有多个 webhook，当引擎清理，应当只删能证明是自家的；重连有指数退避上界。
  出处：`scripts/lib/gh-events.mjs:28-33`、`:166-168`（2026-09-14：宽扫误伤；EOF 后 17709 次重连卡死通道）。

### E 协作与时序

- **E1 拍板写在评论里，执行体看不见**
  测试用例：给定创始人在评论里改了需求口径，当下一个会话开工，应当看得到（纳入任务上下文或同步进 `specs/…/需求.md`）；同时陌生人的评论不得进入上下文（§5.3）。
  出处：windsurf-dao#1675（审查三轮都在引旧正文），修复 PR #1732；判例 memory `decision-in-comment-invisible-to-fleet`；`activities.mjs:937-944`。
- **E2 审查开始后正文又改了**
  测试用例：给定第二意见会话已开始、需求或 PR 正文随后被改，当收结论，应当识别它基于旧版本（记正文摘要），作废重审或标注。
  出处：判例 memory `reviewer-snapshots-body-at-start`（windsurf-dao#1531 三轮才绿，前两轮全是正文证据缺口）。

### F 限流与故障

- **F1 次级限流被当成「配额还多」**
  测试用例：给定写接口返回 secondary rate limit 或 retry-after，当重试，应当串行化、至少等 retry-after 或 60 秒再指数退避；不拿 `rate_limit` 余额证明「没限流」。
  出处：判例 memory `github-secondary-vs-primary-limit`（2026-08-16：剩 4975/5000 仍被限）、`github-quota-is-account-wide`；官方限流页（内容创建 ≤80 次/分、≤500 次/时）。
- **F2 GitHub 局部故障时 404 像「没权限」**
  测试用例：给定 PR 本体可读而 `pulls/N/files` 等回 404/503，当判断，应当判「没查成」按瞬时处理并查 GitHub 状态页，不当「没有文件」或「没权限」。
  出处：判例 memory `github-outage-three-faces`（2026-08-17，往权限方向查了一小时）。

### G 移植

- **G1 写死 master**（审计时新发现，移植风险）
  测试用例：给定仓的默认分支是 main，当引擎开任务、同步、合并、装保护，应当一律读仓库的 `default_branch`；另加一条源码扫描测试：引擎代码里不许出现字面量 `master` 作为分支默认值。
  出处：实测 fleet-dao `default_branch=main`；旧代码 `packages/fleet/src/cli.mjs:206`、`packages/fleet/src/contract.mjs:33`、`:56`、`scripts/lib/push-gate.mjs:30`、`scripts/apply-branch-protection.mjs:67`、`:106`、`scripts/gh-as.mjs:33`；判例 memory `hand-typed-constant-will-be-wrong`。

---

## 7. 不带过去的

- **gh CLI 外壳**（`scripts/gh-as.mjs` + `scripts/lib/gh.mjs` 的 spawnGh）：它招来的坑全是「隔一层命令行」造成的——Windows 上 shell 会把多行参数拆开（windsurf-dao#573 ①实测）、默认 1MiB 输出缓冲 ENOBUFS（PR #1102，`scripts/lib/gh.mjs:11-13`）、FORCE_COLOR 让 `--json` 变成非 JSON（`:319-323`）、正文进命令行参数撞 E2BIG（windsurf-dao#1363）、回执只能从输出里抠 URL（windsurf-dao#1211）。引擎直接用 HTTP（REST/GraphQL）调 GitHub；发令牌那部分（§1.1）照搬。
- 审官、看门狗、消歧官三个 App（新设计只两个机器人）。
- `gh webhook forward` 事件桥与它的 hook 归属逻辑（改 App webhook + Cloudflare）；依赖个人 gh 登录这一条也随之消失。
- `pr ready` 前的 PR 正文五节闸与验收口号闸（`scripts/gh-as.mjs:71-125`）——设计 §7 改成 15 行以内的短正文。
- 收工脚本直推 master、master 哨兵自动回退（设计 §16：改由合并队列 + 分支保护）；推前密钥扫描的判据（`scripts/lib/push-gate.mjs:45-61`）可以搬进「推任务分支前」的硬闸。
- 每台机器一份的本地账本（幂等账、审计、事件桥状态）→ 进 Postgres。

---

## 8. 没查成 / 待实测

1. 两个机器人是否已装到 fleet-dao（需 App JWT 调 `GET /repos/<账号A>/fleet-dao/installation`；审计时为守只读没换发令牌）——之后已查成：实施计划 P1 新建的两个机器人已装到 fleet-dao 与 fleet-dao-canary（[plan.md](../plan.md) 第五节）。
2. 互动限制对 App 机器人自己的评论、开 PR 是否生效。
3. 主线含 workflow 改动时，用 rebase 同步或 `update-branch` 接口推送会不会同样被拒（决定 §1.3 Q1 的 C 路）。
4. 个人账号的仓能否用规则集把「合并/推主线」限定给某一个 App。
5. App 订阅 check_suite / check_run / workflow_run 各需要哪项权限、能收到哪些检查的事件（审计时没逐条核官方事件表）。
6. 次级限流是按 App 安装算还是按账户算；PATCH issue 是否计入「内容创建」。
7. 机器人评论的 `author_association` 取值。
8. 「Update an issue」的官方权限原文（抓取被截断；按 Issues: write 与旧系统 PR #1732 的生产实践写）。

---

## 9. 依据的官方文档

docs.github.com：repository interactions、managing a merge queue、pulls（merge / update-branch）、collaborators、commit statuses、rate limits、REST best practices、webhook events 与 best practices、redelivering webhooks、generating an installation access token。
