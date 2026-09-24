# 部署与运维手册

> **写 `deploy/`（一条命令装好整台机器）、日常部署流水线、备份与看门狗、新旧系统切换之前读。** 对应设计 §三 第 14、17、29 条，§四「两台机器分工」「执行模式与容量」，§十三「高可用」，§十四「安全」，§十六，§十八「迁移」；实施计划 P0、P5、P6。
> 讲清法国 VPS 的现状（只读读数）、切换方案（停哪些、留哪些、改哪些）、旧装法里值得搬的做法、44 条坑 → 测试用例、组件与版本清单、凭据种类清单、「一条命令」的形状与验收。
> 来源：旧系统审计切片 s8（2026-09-25 01:15–01:50，`<VPS>` 本地时区 Asia/Shanghai）。只读：没改任何仓，没在 VPS 上重启、改、装任何东西。全仓记法见 [README](README.md)。
> 出处缩写：`wd:` = windsurf-dao（HEAD `b1ebd88d`）；`ags:` = ai-gateway-stack `origin/master`（`db44877`，2026-09-24 21:18）；`fd:` = fleet-dao `docs/design.md`；「VPS 读数」= 当时在 `<VPS>` 上只读命令的输出摘录；「判例 X」= 旧维护者判例记忆里的条目（不公开）。
> 占位：`<VPS>` = 法国那台；`<跳板>` = 它前面的跳板机；`<服务用户>` = 跑引擎、各 CLI 和 mirasim-server 的那个 Linux 用户；`<账号A>` = 某个账号。本文不含 IP、密钥、token、账号编号、邮箱、组织编号、GitHub App 编号；凭据只写种类不写位置；旧机上的安全问题只写原则（§1.6）。

---

## 〇、先看这 8 条

1. **旧机上反复出现过「root 执行服务用户能改的文件」这一类问题**（旧系统 2026-09-05 修过一次同形态的 dao-sync，wd:host/machine/systemd/dao-sync.service:5-13；windsurf-dao#1051 收录过同类巡检记录）。细节不进公开仓，由维护者在旧机上处置。新系统遵守的原则见 §1.6 与 P01、P02：root 只负责安装，会话、CLI 升级、部署都在服务用户下完成；有效 User 是 root 的单元，ExecStart 链上的文件全属 root、他人不可写，按合并 drop-in 之后的有效配置判。
2. **旧系统在 VPS 上的实际规模**：自家定时器 19 个在用、8 个已停用但文件还在 /etc；自家常驻服务 8 个在跑，另有 1 个「已经停了但仍是 enabled」；还有 2 个守护进程或服务端不归 systemd 管（§1）。新旧并存时有三处硬冲突：Temporal 端口 7233/8233、共用同一个飞书应用、12G 内存（§2.2）。
3. **设计稿少了一块：新系统自己的代码怎么部署到机器上**。旧系统在这件事上踩过一串坑：合进 master 的单元 23 小时没装上机（windsurf-dao#1408）；合了码但进程还在跑旧码（windsurf-dao#1337）；主树同步静默拒绝快进，部署停了 6 小时；同步服务的沙盒让单元上机 7 天失败 101 次（PR #1632）；改了步序导致在途工作流重放失败（windsurf-dao#1633）；重启工人会打断在途活动。fd §16 删掉了 land 和 master 哨兵，但没写用什么替代（§2.4）。
4. **旧机没有任何数据备份**（VPS 读数：没有备份类单元，/var/backups 里只有 apt 和 dpkg 自己的备份）。fd §13 要求「每晚备份到 R2」，这要从零建，并且要配「最近一次成功备份」的新鲜度检查和定期恢复演练（§6、§8）。
5. **Temporal 的生产形态**：Postgres 16（Temporal 官方测试过的最高版本是 16.6，Ubuntu 24.04 自带的也是 16）；服务端 v1.32.0；保留期要显式设（默认只有 24 小时，windsurf-dao#1664）；活动要有心跳；要有回放测试（§6）。
6. **「一条命令装好」这件事，旧系统已经有能直接搬的骨架**：开装前查前提、外部二进制钉版本并校验 sha256、每一步读回三种状态（绿／红／没查成）、装机脚本失败要计入结论、在空机器上演练的 CI（§3）。
7. 「踩过的坑 → 新系统测试用例」共 44 条，每条都有 issue、判例或提交为证（§4）。
8. windsurf-dao#1557 的仓外清单还有一半没收口；另外还有 9 件是 09-20 之后新冒出来的仓外东西（§5）。

---

## 一、VPS 现状（只读读数）

### 1.1 机器基线

| 项 | 读数 | 出处 |
|---|---|---|
| 系统 | Ubuntu 24.04.4 LTS，内核 6.8.0-138；已开 unattended-upgrades | VPS 读数 `/etc/os-release`、`uname -r`、`systemctl is-enabled unattended-upgrades` |
| 规格 | 6 核；内存 11Gi（可用 9.4Gi）；swapfile 8G（已用 338M）；磁盘 193G（已用 24%） | `nproc`、`free -h`、`swapon`、`df -h /` |
| 大户 | `/tmp` 3.0G；`~<服务用户>/.dao` 1.8G；`~<服务用户>/.mirasim` 2.9G；Temporal SQLite 38M | `du -sh` |
| 时区 | **Asia/Shanghai**。旧 timer 的 OnCalendar 都按北京时间写 | `timedatectl` |
| cgroup | v2，PSI 可读；**没有 agents.slice**（2026-09-24 定的隔离方案还没上机） | `stat -fc %T /sys/fs/cgroup`、`/proc/pressure/*`、`list-units --type=slice`；wd:docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:15-20 |
| AppArmor | `kernel.apparmor_restrict_unprivileged_userns=1`；已装 `/etc/apparmor.d/bwrap`、`playwright-chromium` | `sysctl`、`ls /etc/apparmor.d` |
| 防火墙 | ufw 默认拒绝入站，只放行 22/tcp；另有一条显式拒绝 6768（Orca 时代留下的） | `ufw status verbose` |
| SSH | 只允许密钥登录（`passwordauthentication no`，`permitrootlogin without-password`）；fail2ban 开着 sshd 规则 | `sshd -T`、`fail2ban-client status` |
| 监听端口 | 对外开放的只有 22（ufw 挡住其余）；自家服务多只听本机：4315、4316、4317、7233、8233，以及 reclaude 和 temporal 的临时端口 | `ss -ltnp`（地址已脱敏） |
| Node | `/usr/bin/node` v22.23.2，npm 10.9.8 | `node --version` |
| Temporal | `/usr/local/bin/temporal`：CLI 1.8.3（Server 1.31.2、UI 2.50.1），跑的是 `server start-dev` + SQLite | `temporal --version`、`ps` |
| git / gh | git 2.43.0（`/usr/local/bin/git` 是守卫壳，见 §3）；gh 2.99.0 | `git --version`、`gh --version` |
| 没装 | psql/pg_dump、cloudflared、docker、restic、rclone（root 的 PATH 里都没有） | `command -v` |
| Temporal 里的工作流 | Running 的 0 条；保留期内共 28 条；没有 Schedule | 以服务用户身份跑 `temporal workflow count` / `schedule list` |

### 1.2 常驻服务（8 个在跑 + 1 个已停但 enabled + root 的 user 单元 1 个 + 没人托管的守护进程 1 个；root 家里那个 mirasim-remote 服务端见 §1.5）

| 服务 | 运行身份 | Restart | 归属 | 做什么 | 切换后 | 理由 / 出处 |
|---|---|---|---|---|---|---|
| dao-fleet-temporal | <服务用户> | always（NRestarts=15；wd:scripts/install-fleet.sh:35-36 记着装真单元时旧名单元占着 7233、新单元崩溃循环，是不是这 15 次没核） | wd | Temporal 开发服务端 + SQLite（<回环>:7233/8233） | **停** | Temporal 文档：SQLite「只用于开发和测试，不用于生产」（docs.temporal.io/temporal-service/persistence）；wd:NEW-MACHINE.md:655-656；新旧会抢同一个端口 |
| dao-fleet-worker | <服务用户> | always；`Requires=` 上一个 | wd | 旧 fleet 工人 | **停**（先确认没有在途活动） | fd §16/§18；wd:scripts/lib/fleet-worker-fresh.mjs:1-9 |
| feishu-triage | <服务用户> | always | wd | 旧飞书分诊机器人（长连接） | **停** | fd §16「重做」、§15.4；新旧不能同时连同一个飞书应用（投递方式没查成，见 §9） |
| mirasim-server | <服务用户> | always；MemoryHigh 2.5G / MemoryMax 4G；OOMPolicy=continue | 单元在 wd，程序和升级器在 ags | Mirasim 官方服务端（本机 4316），是「Mirasim 云端」渠道的载体 | **留** | fd §4：「Mirasim 中转的路由也走它的程序接口」。注意：机器上另有一份**运行时 drop-in** `/run/systemd/system.control/…/50-MemoryHigh.conf` 把 MemoryHigh 改成了 3.5G。它重启后就没了，仓里也没有（VPS 读数 `systemctl show -p DropInPaths`） |
| mirasim-bridge | —（已弃用，运行身份不再展开） | on-failure | ags `services/mirasim-bridge/` | 把 Mirasim 云端额度转成 OpenAI 兼容接口（4315），是给 new-api 渠道用的 | **停并删** | new-api 已整体弃用（windsurf-dao#1523）；最近 24 小时 journal 0 行 |
| responses-chat-bridge | <服务用户>；drop-in `debug.conf` | on-failure | ags `services/responses-chat-bridge/`，跑的是 `/opt` 下的副本 | codex 的 responses→chat 转接桥（4317） | **待判** | ags:docs/ops/MIRASIM-VPS.md:58 判它「随网关弃用、换机不用装」；但 VPS 上 <服务用户> 默认的 `~/.codex/config.toml` 的 base_url 仍指向本机 4317（luna）。它的上游现在还通不通，没查成 |
| cliproxy | root | always | **两个仓都没有** | CLIProxyAPI（Antigravity/Gemini 转 OpenAI 兼容），pi 的 antigravity 走它 | **待判** | 两个仓都没有它的源与配置（ags:deploy/setup-pi-antigravity.mjs:33-36 只写了怎么接它）；新系统若保留同类代理，只绑回环并设访问密钥（§1.6 原则 3） |
| miraquota-sync | root | always | miraquota-win | MiraQuota 账本同步 | 不属新系统 | — |
| commandcode-native | 专用用户 commandcode-native（加过固） | **on-failure** | 两个仓都没有（`/opt/commandcode-native`，从 <跳板> 手工拷来） | Command Code 协议适配器 | **停、disable、删** | VPS 读数：`UnitFileState=enabled`，`Result=success`，`ExecMainCode=2 / ExecMainStatus=15`（被 SIGTERM），2026-09-09 23:38 起一直停着，**下次开机会自己复活**。它同时是 §4 P06 和 P07 两个坑的现场样本 |
| （root 的 user 单元）reclaude.service | root 的 `systemd --user` | on-failure；**disabled**；root 没开 linger | 两个仓都没有源文件（root 家目录下，09-23 建的） | root 的 reclaude 守护进程 | **停** | 新系统不以 root 跑会话（windsurf-dao#1557 第四节：「新机以服务用户为唯一执行用户」） |
| （不归管）服务用户的 `reclaude _daemon` | <服务用户>，ppid 1 | 没人托管（没开 linger，也没有 user 单元） | ags（reclaude 的配置目录归 ags 管，wd:host/machine/INDEX.md:60） | Claude 订阅通路的本机代理 | **留，但收进 systemd**（Restart=always） | 前提是「Claude 订阅 · 命令行」渠道走 reclaude。VPS 上要用订阅，只能不经 Mirasim 直接起 `reclaude -p`（wd:host/machine/systemd/mirasim-server.service:31-36）。它由谁拉起，没查成 |

### 1.3 定时器（自家的 19 个在用）

| 定时器 | 运行身份 | 频率（北京时间） | 归属 | 切换后 | 理由 |
|---|---|---|---|---|---|
| dao-sync | <服务用户> | 每 5 分钟 | wd | 停 | 它的功能在新系统里还没有着落，见 §2.4 |
| dao-land | <服务用户> | 每小时 | wd | 停 | fd §16：收工脚本删 |
| dao-master-sentinel | <服务用户> | 每 15 分钟 | wd | 停 | fd §16：master 哨兵删，改由合并队列 + 分支保护 |
| dao-dispatcher | <服务用户> | 每 10 分钟 | wd | **并存期第一个停** | 新引擎接管派工；先停，免得抢单、抢内存 |
| dao-judge-triage | <服务用户> | 每小时 :52 | wd | 停 | fd §16：进门标签改成 AI 分诊 |
| dao-board-officer | <服务用户> | 每 6 小时 :12 | wd | 停 | fd §16：盘面班删 |
| dao-repo-hygiene | <服务用户> | 每天 10:23 | wd | 停 | fd §16：清理脚本删，改成「谁创建谁回收」 |
| dao-store-retire | <服务用户> | 每天 03:41 | wd | 停（旧账本存档之后） | fd §16：30 本账删 |
| dao-leg-expiry | <服务用户> | 每 6 小时 :02 | wd | 停，功能搬成 Temporal 定时任务 | fd §16：模型扫描、榜单巡查留下，改用 Temporal 定时 |
| dao-execution-usage | <服务用户> | 约每 5 分钟 | wd | 停，额度读取的接线搬进额度账 | fd §16、§10 |
| dao-skills-heal / dao-skills-heal-root | <服务用户> / root | 每 5 分钟 | wd | 停 | 新系统不靠 skills 装载面；root 那只本身就在以 root 身份跑 |
| mirasim-ws-probe | <服务用户> | 每 10 分钟 | wd | 留，等新引擎接管 Mirasim 健康检查 | 判活看的是 ws 帧，不是端口（windsurf-dao#1151；判例 port-vs-tunnel-two-questions） |
| miraquota-contabo | <服务用户> | 每 10 分钟 | wd（#881） | 待判 | 取决于 MiraQuota 这个产品还要不要 |
| release-train | — | 每天 04:00 | wd（由 `release-train.mjs install` 现场生成） | 停 | 旧仓转只读存档 |
| mirasim-managed-update | root | 每天 04:17 前后随机 15 分钟 | 单元在 wd，本体在 ags | **留** | Mirasim 渠道要用。它判断「空闲」只看 Mirasim 自己的会话（ags:deploy/mirasim-managed-update.mjs:344-357、808-812）；新引擎经 Mirasim 起的会话在它眼里算不算「在途」，要实测 |
| ags-sync | <服务用户> | 每 5 分钟 | ags | 停 | ags 转只读存档 |
| agent-cli-update | root | 每小时（随机延迟 10 分钟） | ags | **改** | 用户 2026-09-22 拍板「不能限制 agent cli 版本」（ags:docs/ops/MIRASIM-VPS.md:20-21），这个功能要保留。新系统把 CLI 装到服务用户自己的目录下，升级不需要 root（§1.6 原则 1） |
| reclaude-org-switch-<服务用户> | <服务用户> | 每 15 分钟（带 `--probe`） | ags（windsurf-dao#1521） | 改，搬进新额度账（Temporal 定时） | 用户 2026-09-23 拍板：VPS 只用独享号，参数 `--no-carpool`（ags:docs/ops/MIRASIM-VPS.md:24） |

fd §3 说旧系统有「约 30 个 systemd 定时器」，实数是：在用 19 个 + 停用 8 个（文件还在）= 27 个，另有系统自带的若干个。

### 1.4 停用但文件还在的残留（都是 disabled/inactive）

- 单元：`commander-act.{service,timer}`、`commander-inventory.{service,timer}`、`dao-board-gc.*`、`dao-board-watch.*`、`dao-close-issues.*`、`dao-patrol.*`、`dao-patrol-failure.service`、`dao-refiner.*`、`dao-gh-events.service`、`reclaude-org-switch-root.*`、`gw-remote-probe.timer.bak-20260905`（VPS 读数：逐个跑 `is-enabled` / `is-active`）。
- drop-in：`commander-act.service.d/{10-anti-hang,path}.conf`、`commander-act.timer.d/10-no-starve.conf`、`commander-inventory.service.d/path.conf`。
- sudoers：`/etc/sudoers.d/dao-gh-events`（对应的服务已退役）。
- 旧的一键装机只做「停 + 禁用」，**不删文件**（wd:scripts/bootstrap-server.mjs:6、164-175）。

### 1.5 游离进程与本不该有的东西（VPS 读数 `ps`）

- root 家目录下有一个桌面端 Mirasim 用 root 远程连过来时留下的第二个服务端（0.0.338），从 09-20 起一直在跑（wd:host/machine/INDEX.md:63 写明服务用户家里不该有它，出现在 root 家目录说明桌面端用 root 连了）。服务用户家里也有两个旧版本目录（0.0.305、0.0.318）。
- 服务用户名下有一个从 09-03 就开着的 tmux（当时用来跑 `cursor-agent login`）；root 名下有一个从 09-14 就开着的 bash（Claude Code 的 shell 快照）。
- `~<服务用户>/.local/bin/orca-ide` 指向已经不存在的 Orca 安装目录（Orca 已退役），是一条悬空链接。
- 一个失败的临时单元 `run-u672304.service`（一条 `gh api` 调用），没人清。

### 1.6 安全面：只写原则

审计时在旧机上查出过几处违反下列原则的配置，细节不进公开仓，由维护者在旧机上处置。同形态的问题旧系统 2026-09-05 修过一次（wd:host/machine/systemd/dao-sync.service:5-13），windsurf-dao#1051 也收录过两份同类巡检记录——修了一处，别处照样长出来，所以新系统把它做成装机时的硬检查（P01、P02），不靠人记。

新系统遵守的原则：
1. **root 只负责安装**：会话、CLI 升级、部署、定时任务都在服务用户下完成，不需要 root 去执行服务用户能写的任何东西。
2. **有效 User 是 root 的单元**：ExecStart 指向的文件和它的所有父目录都属 root，组和其他人不可写；按合并 drop-in 之后的有效配置判（`systemctl show -p User,ExecStart`），只读单元正文会被 drop-in 骗过（P02）。
3. **代理、桥接这类服务只绑回环或 unix socket，并设访问密钥**；不靠防火墙兜底。
4. **root 不在服务用户目录里写文件**：装机与运维动作之后 `find <家> <仓> -user root` 为 0（P01）。
5. **读回用有效值**：`systemctl show`，不只比对单元文件（P21）。

---

## 二、切换方案：停哪些、留哪些、改哪些

### 2.1 原则（带出处）

- 新系统接得住活之前，旧系统原地待命；切换后停掉它的定时任务（fd §18）。
- **「退役」= stop + disable + 删单元文件 + 删 drop-in + 删 sudoers 行，然后读回 is-enabled 和 is-active**。只 stop 不 disable，机器一重启就会复活（判例 stopped-not-disabled-revives-on-reboot；PR #1591）。旧的 `--prune-legacy` 只做停和禁用，不删文件（wd:scripts/bootstrap-server.mjs:164-175）。
- 停工人之前，要等在途**活动**归零，光看「Running 的工作流」不够（wd:scripts/lib/fleet-worker-fresh.mjs:1-9）。现在读数是 Running = 0。
- 旧的 Temporal 历史不搬。先让旧机把在途任务清零，再跑一遍 `fleet-timeline-export` 导出最后几单，新机全新起（wd:NEW-MACHINE.md:714）。

### 2.2 新旧并存期的冲突

| 冲突 | 现状 | 处置建议 |
|---|---|---|
| Temporal 端口 | 旧开发服务端占着本机 7233/8233 | 新 Temporal 换端口，或者先停旧的（停了它，旧 worker 会因为 `Requires=` 一起停） |
| 飞书 | feishu-triage 用应用凭据开着长连接 | 新机器人用一个新的飞书应用；或者保证同一时刻只有一个消费者（多个客户端时消息怎么投递，没查成） |
| 内存（估算） | 旧常驻进程合计约 1.6G RSS（mirasim-server 594M，历史峰值 2.0G；fleet worker 182M；temporal 160M；miraquota 163M；root 那个 mirasim-remote 211M……）。fd §4 的目标是 6 个会话 × 每个 1.2–1.6G，再加上 Postgres、Temporal、API | 并存期新系统先开 2–3 个会话；旧派单器最先停。**经 Mirasim 起的会话都在 mirasim-server 的 cgroup 里，共用一个 4G 上限**（wd:docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:15；单元的 MemoryMax=4G），这部分容量要单独算 |
| GitHub 身份 | 旧的 5 个 App 私钥在服务用户的本地配置里 | 新系统建新 App，不和旧的共用私钥（§7） |
| CLI 登录态与额度 | 新旧都用同一个服务用户家目录里的登录态 | 并存期两边会抢同一份订阅额度，新的额度账要看得到旧系统的用量 |
| Mirasim 轮询 | mirasim-server 是单线程，会逐棵轮询工作树 | 新旧两边的工作树要加起来算（判例 worktree-pileup-starves-mirasim） |
| 时区 | 机器是 Asia/Shanghai | 新的定时任务把时区写进定义里，不依赖机器时区 |

### 2.3 切换当天的顺序（草案）

1. 停 dao-dispatcher、dao-judge-triage、dao-board-officer（不再接新活）。
2. 等 `temporal workflow count --query 'ExecutionStatus="Running"'` 归零，再跑一遍 `fleet-timeline-export.mjs --apply`（wd:NEW-MACHINE.md:714）。
3. 停 dao-fleet-worker、dao-fleet-temporal、feishu-triage。
4. 起新的 Postgres、Temporal、引擎、API、飞书机器人、cloudflared；跑一条从开单到合并的完整巡检任务（fd §6 第 3 条）。
5. 其余旧 timer 按 §2.1 的方法退役；§1.4 的残留一并删掉。
6. 读回：`systemctl list-timers --all` 里没有旧单元；所有旧单元的 `is-enabled` 都是 disabled 或 not-found；`find <服务用户家> /srv -user root` 为 0。
7. 重启演练一次：确认旧单元没有复活，新单元全部自己起来了。

### 2.4 缺口：新系统自己的代码怎么部署到机器上（设计稿没写）

旧系统的做法：dao-sync 每 5 分钟对主树做一次 ff-only，然后 root 钩子装单元、unit-fresh 按白名单 try-restart。围绕这件事咬出了 P11、P13–P20 这一串坑。fd §16 删了 land 和哨兵，§13 的「一条命令重建」管的是灾难恢复，**日常怎么部署没写**。建议把它写成合并队列的最后一步：拉取 → 数据库迁移 → 先排空在途活动 → 重启 API 和 worker → 读回「每个进程报告的版本 = 刚合并的 SHA」→ 不一致就在 N 分钟内报警。具体用例见 P13、P18、P19。

---

## 三、旧装法里值得搬过去的做法

| 做法 | 出处 |
|---|---|
| 一条命令，幂等；每步读回三种状态（绿／红／没查成），读不到的不许当绿 | wd:scripts/bootstrap-server.mjs:13-14、142-162 |
| 装机脚本自己失败也算红：「单元在跑」不等于「装完了」 | wd:scripts/bootstrap-server.mjs:238-242 |
| 开装前查清单元里写死的前提（`/usr/bin/node` ≥ 22、服务用户、仓库路径），缺了就停下并给出装法 | wd:scripts/bootstrap-server.mjs:113-127；wd:NEW-MACHINE.md:730-737 |
| 每个 `install-*.sh` 都必须登记去向（要么装，要么写明为什么不装），漏登记的话测试当场红 | wd:scripts/bootstrap-server.mjs:55-67；PR #1590 |
| 外部二进制钉版本 + 校验 sha256，不用 latest | wd:scripts/install-fleet.sh:14-20 |
| root 自有副本只有一份清单，每次和仓里的源做字节对账；上机钩子里钉着一份「特权行」清单（User/Exec*/EnvironmentFile…），对不上就拒装 | wd:host/machine/root-copies.txt；wd:scripts/dao-install-units.sh:1-17、79-249 |
| sudoers 命令写死、不带通配；落位之前先跑 `visudo -cf` | wd:scripts/install-dao-sync.sh:22-24；wd:host/machine/sudoers.d/dao-sync |
| 单元加固：`UnsetEnvironment=GH_TOKEN GITHUB_TOKEN`、`GH_CONFIG_DIR=/var/empty`（自动化服务不继承个人凭据）、`ProtectSystem`/`ProtectHome`/`ReadWritePaths` | wd:host/machine/systemd/dao-sync.service；windsurf-dao#792 |
| git 守卫壳：root 在别人的仓里跑 git 时，自动换成仓属主的身份去跑 | wd:host/machine/shims/git-owner-guard:1-13；windsurf-dao#1473 |
| 空机器迁移演练 CI：改装机相关文件的 PR 会跑，另外每周一跑一次（上游镜像和下载也会变） | wd:.github/workflows/migration-rehearsal.yml:17-27；PR #1676 |
| 账本搬家用 collect/restore（sqlite 用 VACUUM INTO 拿一致快照，先 dry-run 对账） | wd:NEW-MACHINE.md:719-728 |
| Temporal 保留期显式设成 30 天并读回；任务结束后导出一份长期档案 | wd:scripts/install-fleet.sh:90-115；windsurf-dao#1664 |
| 用 tmpfiles.d 兜底清理测试临时目录 | wd:scripts/install-tmpfiles.sh；wd:NEW-MACHINE.md:474-479 |
| 常驻服务一律 `Restart=always`，真需要人介入的退出码用 `RestartPreventExitStatus` 单独豁免 | windsurf-dao#1037；判例 clean-exit-is-still-down |
| 读回的是「还会不会响」，不是「在不在册」 | wd:scripts/lib/timer-armed.mjs:1-24 |
| 检查器的输出落在它自己不读的地方 | wd:scripts/server-check.mjs:1547-1552 |

---

## 四、踩过的坑 → 新系统测试用例（44 条）

> 格式：**坑**（出处）→ 用例「给定……，当……，应当……」。只收真实踩过的；单纯的外部事实放到 §6。

### A. 身份与属主

- **P01 root 在服务用户目录里留下 root 属主的文件，之后以各种看起来不像权限问题的样子出错**（判例 root-owned-files-in-service-home，撞过 2 次；windsurf-dao#1473 OPEN；wd:NEW-MACHINE.md:60；审计时还读到第三次现场：服务用户的 Claude 凭据文件属主变成了 root）
  → 给定服务用户的家目录和仓库，当任何装机或运维动作以 root 执行完，应当 `find <家> <仓> -user root` 为 0；装机脚本凡是要往服务用户目录写的步骤，都以服务用户身份（runuser）去写。
- **P02 root 执行服务用户能改的脚本 = 提权**（wd:host/machine/systemd/dao-sync.service:5-13；windsurf-dao#1051 收录的两份巡检记录；旧机上反复出现过同类问题（§1.6））
  → 给定机器上每个 systemd 单元**合并 drop-in 之后的有效配置**（`systemctl show -p User,ExecStart`），当有效 User 是 root，应当 ExecStart 指向的文件和它的所有父目录都属 root，且组和其他人都不可写；否则装机失败。只读单元正文的检查会被 drop-in 骗过（2026-09-13 那份 observation）。
- **P03 `runuser -u` 不会换 HOME，CLI 去读调用者家里的配置，结果 permission denied**（wd:scripts/install-fleet.sh:93-96；PR #1676 第 9 条）
  → 给定以 root 调用服务用户跑 CLI，应当显式给 `env -i HOME=<服务用户家>`，并且测试里要有一条「调用者家目录不可读」的反例。
- **P04 单元的 PATH 里少了 /usr/sbin：手动跑全绿，systemctl 一触发 runuser 就找不到**（ags:deploy/systemd/agent-cli-update.service:11-12，2026-09-22）
  → 给定任何单元，它的验收一律用 `systemctl start` 触发，再读 journal（判例 verify-systemd-via-systemctl，撞过 2 次）。
- **P05 root 调 git 时，别人的仓会报 `dubious ownership`；git 2.43 的 `safe.directory` 通配 `*` 不跨 `/`**（wd:scripts/install-skills-heal.sh:28-31）
  → 给定 root 侧的程序需要读服务用户的仓，应当不调 git，或者以仓属主身份调。

### B. 服务生命周期

- **P06 `Restart=on-failure` 不管干净退出：退出码 0 或被 SIGTERM 都算「成功」，服务就这么躺着**（判例 clean-exit-is-still-down；windsurf-dao#1037；审计时读到的现场：commandcode-native 09-09 被 SIGTERM 后一直没起来）
  → 给定每个常驻服务，当主进程被 `kill -TERM` 或自己 `exit 0`，应当在 RestartSec 内被拉起（journal 里能看到 `Scheduled restart`）。验的时候不能用 `systemctl stop`，那是人为停止，本来就不会重启。
- **P07 只停不禁用，重启就复活**（判例 stopped-not-disabled-revives-on-reboot；PR #1591；审计时的现场：commandcode-native 已停但 enabled）
  → 给定退役清单，退役之后应当 `is-enabled ∈ {disabled, not-found}`、单元文件已删；做一次重启演练后 `is-active` 仍是 inactive。
- **P08 enabled 不等于会响：timer 可能是 enabled + inactive(dead)、NEXT 为空，或者进入 active(elapsed) 死态；自检只看 enabled，停了 7 小时还是绿**（wd:scripts/lib/timer-armed.mjs:3-7；windsurf-dao#1177；wd:docs/decisions/SERVER-LANDING-CHECKLIST.md:265）
  → 在新系统里对应的是 Temporal Schedule：给定每个定时任务，当它被暂停、删除或连续失败，看门狗应当按「上次成功的时间」判红，而不是因为「定义还在」就判绿（fd §6 第 5 条）。
- **P09 刚 `enable --now` 的那一瞬 NEXT 可能还没算出来；oneshot 服务从没激活过时，`OnUnitActiveSec` 会一直空转**（wd:scripts/install-leg-expiry.sh:44，2026-09-23；wd:scripts/install-mirasim-ws-probe.sh:47）
  → 给定装机读回，应当按次数有界重试，不能一次读不到就下结论；不要用依赖首次激活的触发写法。
- **P10 早期用 systemd-run 起的临时单元会遮住同名的文件单元；旧名字的单元占着 7233，新单元一直崩溃重启**（wd:scripts/install-fleet.sh:33-42，脚本注释写明「装真单元当场实咬」）
  → 给定装机之前机器上有同名或旧名的临时单元，应当先撤掉再装；启动前检查端口，被占了要报出是谁占的。
- **P11 退出码是绿的，事情没做成**：dao-sync 拒绝快进但照样 exit 0，部署停了 6 小时；属主不对写不进文件，同步停摆但 exit 0（判例 main-tree-commit-freezes-deploy；wd:docs/decisions/SERVER-LANDING-CHECKLIST.md:263-270）
  → 给定部署同步因为分叉、脏树或权限问题没做成，应当非 0 退出并报警，同时「上次成功部署时间」过期，被看门狗抓到。
- **P12 把「查出问题」也表达成 systemd failed，噪音盖住了真故障**（windsurf-dao#1231：用量采集装上后 493 次全红；windsurf-dao#1838 / PR #1853；审计时读到的现场：dao-board-officer exit 2、dao-repo-hygiene exit 1 都挂在 failed 状态）
  → 给定一个定时任务，当它「跑成了但查出了问题」，应当发业务告警，任务本身算成功；任务失败只留给「这次没跑成」。两者在驾驶舱里分开显示（fd §6 第 5 条）。

### C. 代码与配置上机

- **P13 单元合进 master 23 小时还没装到机器上；代码合了，长连接进程却还在跑 6 小时前的旧码，特权副本停在 09-11**（windsurf-dao#1408；windsurf-dao#1337）
  → 给定主线合入一个改了引擎的提交，部署完成后，每个运行中的进程报告的版本都应当等于这个提交的 SHA；不相等就在 N 分钟内报警。
- **P14 在服务器主树上提交了却没推，同步就静默拒绝快进**（判例 main-tree-commit-freezes-deploy）
  → 给定生产检出里有本地提交或脏文件，部署时应当拒绝并报警。生产检出应当只读，或者每次部署用独立的发布目录。
- **P15 装机脚本对仓里的文件 chmod，树变脏，ff-only 同步当场 Aborting**（wd:scripts/install-dao-sync.sh:14-15；wd:scripts/install-skills-heal.sh:12-13）
  → 给定装机，前后跑一次 `git status`，结果应当完全一样。
- **P16 单元的沙盒把 /etc 挂成只读，经 sudo 起来的 root 钩子也写不进去，7 天失败 101 次；`ProtectHome=read-only` 下漏放行了几个家目录子路径，接线连续三天没跑成**（wd:host/machine/systemd/dao-sync.service:36-46；PR #1632）
  → 给定每个加过固的单元，按单元的实际配置用 `systemctl start` 真跑一次，里面所有写操作都应当成功。改加固项时必须配这条冒烟。
- **P17 root 自有副本不会自己更新；依赖文件清单是手列的，漏了 import，装出来 `ERR_MODULE_NOT_FOUND`**（判例 prod-happens-to-have-it-hides-install-gaps；PR #1676 第 8 条；wd:scripts/install-execution-usage.sh:21-23；ags:docs/ops/MIRASIM-VPS.md:48）
  → 给定装到仓外的副本，文件清单应当顺着 import 现算；每次部署都和源文件做字节对账，不一致就红，并给出重装命令。
- **P18 有在途工作流时改了活动的调度顺序，重放报 TMPRL1100；连查询已结束的工作流也会抛错**（windsurf-dao#1633；wd:packages/fleet/src/workflows.mjs:140；wd:packages/fleet/src/cli.mjs:882）
  → 给定一批用旧版本跑到一半的工作流历史（作为测试夹具），用新代码重放应当全部通过；改步序必须用 `patched()`、换工作流类型，或者按 worker 版本路由。
- **P19 fleet 的活动是 `maximumAttempts: 1` 且没有心跳，带着在途活动重启工人，那一单要干等到 startToCloseTimeout 才知道自己死了**（wd:scripts/lib/fleet-worker-fresh.mjs:1-9；VPS 上 `/usr/local/lib/mirasim-upgrade-when-idle.mjs` 的文件头也记着这件事）
  → 给定一个跑了 40 分钟的写码会话活动，当引擎工人重启，应当在心跳超时（分钟级）之内判定丢失，然后按「续会话 / 重派」处理，不能等上几个小时。
- **P20 切换 Mirasim 的全局启动命令会杀掉所有在途回合（一次杀掉一个跑了 4.5 小时的回合）；装机脚本如果真去 try-restart，也会杀掉活着的会话**（判例 mirasim-overrides-reclaude-upstream 第五次；wd:scripts/install-mirasim-ws-probe.sh:51）
  → 给定有在途会话，当装机、升级或改配置需要重启 mirasim-server 或引擎，应当先排空（或等到空窗）再重启；装机脚本默认不重启正在跑的服务。
- **P21 用 `systemctl set-property --runtime` 改的配置落在 /run，重启就没了，而且单元一致性检查只比对 /etc，看不见它**（VPS 读数：mirasim-server 的 `50-MemoryHigh.conf` 在 `/run/systemd/system.control/`；wd:host/machine/systemd/mirasim-server.service:12-17 记着这个上限的来历：服务跑 4 天涨到 6.8G，ws 起会话的入口静默瘫痪）
  → 给定每个常驻单元，读回的应当是有效配置（`systemctl show`），并且和仓里的声明相等；运行时改动要么收进仓，要么判红。

### D. 空机器 vs 生产机

- **P22 生产机上「碰巧都有」，遮住了装机缺口；七遍演练一共咬出 10 处**（PR #1676 的表；判例 prod-happens-to-have-it-hides-install-gaps）：19/22 个单元写死 `/usr/bin/node`；开着 pipefail 时命名空间还没建好，读保留期失败，整个脚本无声退出（wd:scripts/install-fleet.sh:102-104）；root 自愈单元的 `ReadWritePaths` 指向的路径不存在，直接 226；结论只数读回、不数装机失败；失败了只报结果不报原因……
  → 给定一台全新的 Ubuntu 24.04（CI runner），按仓里的一条命令装机，应当全绿；「真缺口」大于 0 就判红。改 `deploy/` 的 PR 必须跑，另外每周跑一次。
- **P23 管道的退出码是最后一段的：`| tee` 吞了失败，报告写着「没过」，job 却是绿的**（PR #1676 第 3 条；判例 pipe-exit-status-is-tails，撞过 2 次）
  → 给定装机或检查脚本，造一个中间某段失败的样本，结论应当是红。

### E. 资源

- **P24 工作树越堆越多，拖垮了 Mirasim：162 棵时主线程 CPU 50%，起会话慢 58 秒，ws 探针连红**（判例 worktree-pileup-starves-mirasim，撞过 2 次；windsurf-dao#1570 OPEN；PR #1758）
  → 给定任务进入**任何**终态（完成、取消、卡住、失败），应当在 N 分钟内回收它的工作树和会话；机器上工作树的总数设上限告警（fd §16「谁创建谁回收」对每种终态都要成立）。
- **P25 同一套测试并发跑两份，固定名字的沙盒被互相删掉，主线随机红**（判例 fixed-name-sandbox-dies-under-concurrent-runners；windsurf-dao#1358；PR #1377）
  → 给定同一套测试两份同时跑，两份都应当绿（临时目录每个进程独占一份）。
- **P26 测试没有全机上限，负载冲到 15**（windsurf-dao#1748；wd:NEW-MACHINE.md:529-534）；agent 和常驻服务在同一个 cgroup 里（wd:docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:15-20，这一半是决定里的风险分析，不是已经发生的事故）
  → 给定 6 个会话同时跑测试，全机的测试并发应当不超过设定值（fd §4：2–3 份）；给定一个会话把内存吃满，应当只有它被限流或被杀，引擎、API、Postgres、Temporal 都不受影响。
- **P27 `/tmp` 顶层堆到 80 万条；用量库有 21 万个小文件，每天还涨 1–3.6 万**（wd:NEW-MACHINE.md:474-479；windsurf-dao#1557 2026-09-21 的评论；windsurf-dao#1231；审计时 `/tmp` 是 3.0G）
  → 给定引擎满负荷跑一周，`/tmp` 和状态目录里的条目数应当有上限；账只进 Postgres，不落成散文件。
- **P28 测试不带账目录参数，就写进了跑测试那台机器上真正的 `~/.dao`**（判例 test-calls-write-real-home-ledger；PR #1718）
  → 给定测试套件在生产机上跑完，生产数据库或数据目录里应当没有多出任何一行（测试用单独的库或 schema）。

### F. 外部 CLI 与运行环境

- **P29 codex 的沙箱需要 bubblewrap，并且要 AppArmor 允许建 user namespace；缺一样，会话能起来但一点活都不干（一晚死了 3 个审官会话）**（wd:NEW-MACHINE.md:1170-1197，2026-09-10）
  → 给定新机，以服务用户身份跑 `bwrap --dev-bind / / --unshare-user true`，应当安静退出。不许用全局 sysctl 关掉这个限制。
- **P30 Ubuntu 23.10 以后 chromium 会因为没有可用沙箱直接 FATAL；`PLAYWRIGHT_BROWSERS_PATH` 默认是按用户存放的**（wd:NEW-MACHINE.md:1100-1102、1155-1162）
  → （如果要保留浏览器能力）给定服务用户，启动 chromium 应当成功，而且不带 `--no-sandbox`。
- **P31 git 拉起编辑器或分页器，把工人挂死 27 分钟**（wd:NEW-MACHINE.md:355-372；windsurf-dao#500）
  → 给定会话里跑 `git rebase --continue`，或者不带 `-m` 的 `git commit`，应当 1 秒内结束，不挂住。
- **P32 Claude Code 无头运行有三道会卡住的门：首次运行选主题、「信任这个目录吗」、bypass 权限的免责页**（wd:NEW-MACHINE.md:627，2.1.258 上实测）
  → 给定一个全新的服务用户，引擎第一次无头起 Claude Code，应当不会停在任何交互提示上（装机时预置好，冒烟测试里真起一次）。
- **P33 同一个 CLI 有两份（npm 壳和自更新的二进制），跑的是哪份取决于 PATH 顺序；手写在配置里的模型 id 没有任何机制会去更新它**（wd:NEW-MACHINE.md:253-257，2026-09-24 实录；审计时的读数：grok 的 npm 版是 1.0.41，`~/.grok/bin` 里的是 1.0.1，两份并存）
  → 给定每种执行方式，引擎用绝对路径调用，启动时把实际版本记下来；配置里不钉默认模型。
- **P34 多个 Claude 实例同时开着，auto-update 会一直失败，版本卡在旧的上，然后出现 `tool call could not be parsed`**（判例 claude-multisession-blocks-autoupdate）；各家 CLI 的自动更新是故意关掉的，统一在会话之外升级（ags:docs/ops/MIRASIM-VPS.md:20-21）
  → 给定某个 CLI 有会话正在跑，升级任务触发时应当等它空闲再升；升级后读回 `--version` 并记下来。
- **P35 在 ssh 里手搓命令去「复现」一个服务的行为，因为 PATH 和生命周期不同，得到的是假失败**（判例 verify-systemd-via-systemctl，撞过 2 次）
  → 同 P04：所有「服务行为」的验收都通过服务管理器触发，并按单元的 Environment 原样执行。

### G. 网络与接入

- **P36 `gh webhook forward` 异常 EOF 之后，孤儿 hook 卡住了；5 秒一次、没有上限地重试了 17709 次；自证 ping 停了大约 30 小时**（wd:docs/decisions/SERVER-LANDING-CHECKLIST.md:492-501；windsurf-dao#1299、#1316）
  → 给定 GitHub 事件通道断了 N 小时，每小时一次的对账应当发现漏掉的事件并补上处理；事件通道有自证 ping，它的新鲜度纳入看门狗（fd §6 第 4、5 条）。
- **P37 端口通不等于隧道通，隧道通不等于应用通；「服务端没起来」和「隧道断了」看起来一样，治法相反**（判例 port-vs-tunnel-two-questions；windsurf-dao#1151 判活看 ws 帧）
  → 给定 cloudflared 进程还在但隧道断了，外部看门狗探活应当判红（它探的是只有经过隧道才能到达的应用端点）。
- **P38 跳板会间歇重置连接，挂在 ssh 前台的长命令会被一起带死**（判例 france-vps-is-contabo-jump）
  → 给定运维通过 ssh 触发长任务，任务应当以服务或后台任务的形式跑，结果能事后查到，不依赖 ssh 会话一直活着。
- **P39 去掉 `MIRASIM_NO_AGENT_EGRESS` 大约 90 秒后，reclaude 设备就被服务端解绑了，要人重新登录**（判例 mirasim-overrides-reclaude-upstream 第三次；wd:host/machine/systemd/mirasim-server.service:31-36）
  → 给定 mirasim-server 的单元，应当带 `MIRASIM_NO_AGENT_EGRESS=1` 和 `MIRASIM_ACCOUNT_USAGE_PROBE=0`；改这两项会触发第三方的风控，走人闸。
- **P40 Node 和 Electron 客户端不读操作系统的证书库，自签证书对它们是死路**（判例 node-clients-ignore-os-cert-store）；nip.io 和 duckdns 的域名在 SNI 层被整域阻断（判例 sni-blocklist-nipio-duckdns）
  → 给定任何自家服务要被 Node 客户端访问，应当用正式证书或走 Cloudflare 的边缘，不用自签。

### H. 凭据与 GitHub

- **P41 GitHub App 没有 workflows 权限，推不了 `.github/workflows/` 下的改动，却被判成「可重试」，一直重试**（判例 github-app-cannot-push-workflows；windsurf-dao#1725；PR #1833 修成判「要人」）
  → 给定一个子任务会改 `.github/workflows/`，派工前就应当识别出来，走有权限的身份；推送被拒时按权限错误处理，不重试。
- **P42 建 App 只能账号所有者在网页上操作；直接跳到安装页连续四次被拒（报「App 已被改动」，这句提示是误导）；上传头像后还要再点一次确认，否则静默失败**（wd:NEW-MACHINE.md:85-87、111-119）
  → 装法要点：用 GitHub App Manifest 流程（官方文档 docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest），把权限写进清单，账号所有者点一下就建好。私钥只有一份，丢了只能重建。
- **P43 用 `/v1/models` 这类不耗额度的接口验 key：额度早就耗尽的旧 key 也返回 200，结论判错了**（判例 verify-credential-on-real-endpoint）
  → 给定凭据恢复完成，读回时应当以服务用户身份对真正会消耗额度的接口各打一次（GitHub App：JWT 换安装令牌；各 CLI：问一个最小的问题），不能只看文件在不在。

### I. 数据与迁移

- **P44 主树的 `.git` 借用了 `/tmp` 下两个旧克隆的对象（alternates），`/tmp` 一清，主树就可能坏掉**（windsurf-dao#1557 2026-09-21 的评论）
  → 给定生产检出，`objects/info/alternates` 应当不存在；迁移时用 `git clone`，不整目录拷 `.git`。

---

## 五、windsurf-dao#1557 的仓外清单：逐项对照（09-20 盘点 → 09-25 读回）

windsurf-dao#1557（OPEN，起因 `vps-migration-inventory`）判据是：「只靠 clone 两个仓 + onboard + mirasim-bootstrap + 手动带凭据，能不能重建」。

| 盘点项 | 09-20 的状态 | 09-25 读回 | 对新系统意味着什么 |
|---|---|---|---|
| commander-act / commander-inventory 单元 + 3 个 drop-in | 垫片只在机器上 | disabled 且 inactive；文件和 4 个 drop-in 文件还在 /etc | 不搬；清退时把文件删掉 |
| release-train 单元 | 订正为「现场生成」 | enabled，每天 04:00 | 旧仓存档后停掉 |
| miraquota-sync | ExecStart 指向 miraquota-win 的检出 | 09-23 改指 `/opt` 下的副本 | 不属新系统 |
| cliproxy | 二进制和配置都不在任何仓 | 仍在跑 | 待判 |
| commandcode-native | 手工拷来的 | enabled，但从 09-09 起一直是停的 | 删 |
| reclaude-org-switch 两份 | 仓里一份，机器上两份 | ags 已有按用户安装的脚本；<服务用户> 那份 enabled（带 `--probe`），root 那份 disabled | 额度读取搬进新的额度账 |
| ags-sync / mirasim-bridge / responses-chat-bridge 的仓外副本是否一致 | 没核 | mirasim-bridge 已弃用（停并删，§1.2）；responses-chat-bridge 跑 `/opt` 的副本（一致性仍然没核） | 两座桥怎么处理见 §1.2 |
| 7 个 drop-in | — | 现在有 8 个文件：commander 相关 4 个（随单元停用了）、mirasim-bridge 2 个、mirasim-server 1 个、responses-chat-bridge 1 个；feishu-triage 那份 09-24 已删（wd:NEW-MACHINE.md:1353）。**另有 /run 下的一份运行时 drop-in**（P21） | mirasim-server 的 `managed-update.conf` 归升级器，保留 |
| `/opt` 下四个目录 | 逐个定归属 | 都还在；ms-playwright 可以重装 | 新系统不往 `/opt` 放手工的东西 |
| `~/windsurf-dao-memory`：73 处未提交 + 27 个 root 属主文件 | 迁移前要处理 | 未提交 74 处；root 属主 0 | 迁移前提交或者判弃 |
| `~/mirasim-work`：没有远端 | 待判 | 仍然没有远端 | 这是 Mirasim 自己的工作区，判弃 |
| 家目录里散落的脚本和目录 | 逐个判 | 都还在：ai-gateway-deploy、bin、cc-wt-obs、exam-arena、execution-1174-* ×5、grok-exec-probe-*、mira-ls.mjs、night-metrics.sh、pr-885-resolve、probe-mirasim-env.mjs、tmp、tree-settlement-20260912、wt、zombie-evidence-20260912、feishu-events.ndjson、lark-*.log | 不搬 |
| root 那一侧 | 只留 NEW-MACHINE 写明的东西 | root 家目录下那个 0.0.338 远程服务端从 09-20 起一直在跑；root 有自己的 reclaude 守护和 Claude 登录 | 新系统的 root 不跑任何会话 |
| `~/.dao/worktree-gc/archive/*.patch` 18 份 | 搬走或者判弃 | 仍是 18 份 | 判弃，或随旧系统存档 |
| Mirasim 的机器配置：`agents.pi.model`、自动压缩百分比 60 | 只存在于机器上 | 没读 setting.json | 新系统把这类配置写进部署配置，经 ws `applyConfig` 施加（ags:docs/MIRASIM-CHANNELS.md 第四节） |
| dsh 已装但没启用 | 等诊断 | `@deepseek-ai/dsh` 0.1.5-rc.3 | 看路由表要不要 |
| 升级器本体 | 已进 ags（ags PR #27） | `/usr/local/lib/mirasim-managed-update/` 在 | 保留 |
| `.git` alternates | 已修 | 只剩 `alternates.retired-20260921` | 迁移不拷 `.git` |
| 「做完」的判据：旧机上 server-check ⑳ 和 (21) 是绿的 | — | 没跑（只读约束下不执行仓里的脚本） | — |

**09-20 之后新冒出来、#1557 里没有的 9 件**：① root 的 user 单元 `reclaude.service`（09-23 建，两个仓都没有）；② `/usr/local/lib/mirasim-upgrade-when-idle.mjs`（09-23，两个仓都没有引用它）；③ `agent-cli-update.{service,timer}`（09-23，仓里有；以 root 跑，新系统改掉，见 §1.3）；④ 服务用户的 Claude 凭据文件属主变成 root（09-24，P01 第三次现场）；⑤ mirasim-server 那份 `/run` 下的运行时 drop-in（P21）；⑥ `/etc/cron.d/staticroute`（`@reboot` 时修一次默认路由，从 09-02 开机起就有，看样子是镜像自带的）；⑦ `/etc/sudoers.d/dao-gh-events`（服务已经退役，规则还在）；⑧ 悬空链接 `~<服务用户>/.local/bin/orca-ide`；⑨ 09-03 留下的 tmux 和 09-14 留下的 root bash。

---

## 六、新系统「一条命令装好整台机器」的组件清单

版本来源：GitHub 上的最新发布，经 GraphQL 于 2026-09-24 读取；Node 的支持周期来自 nodejs/Release 的 `schedule.json`；Postgres 来自 Temporal 文档和 postgresql.org。

| 组件 | 现机 | 建议 | 装法要点 | 出处 |
|---|---|---|---|---|
| 系统 | Ubuntu 24.04.4 | 继续用 24.04 LTS | 开机前查：架构、磁盘、时间同步、cgroup v2、PSI；时区是否改成 UTC 待拍（§9） | VPS 读数 |
| 服务用户 | <服务用户>（系统用户，有家目录，shell 是 bash） | **单一执行用户**：引擎、API、各 CLI、mirasim-server 都用它；root 只负责安装 | `useradd --system --create-home --shell /bin/bash`；一切写入服务用户目录的步骤都用 runuser | wd:NEW-MACHINE.md:735；windsurf-dao#1557 第四节；P01/P02 |
| Node.js | 22.23.2（NodeSource，装在 `/usr/bin/node`） | **24 LTS**（2026-10-20 转入维护期，支持到 2028-04-30）；26 在 2026-10-28 转 LTS 之后再评估；**VPS 和 CI 用同一个大版本** | NodeSource apt，单元里写绝对路径；开装前做前提检查 | nodejs/Release schedule.json；判例 local-node24-breaks-dao-check（跨大版本时测试大面积假红）；Temporal TS SDK 1.24.0 要求 node >= 20.3.0 |
| PostgreSQL | 没装 | **16**（Ubuntu 24.04 自带的主版本；Temporal 官方测过 13.18 / 14.15 / 15.10 / 16.6；社区对每个大版本支持 5 年） | apt `postgresql-16`；只监听本机或 unix socket；三个库：应用库、temporal、temporal_visibility；本机用 peer 认证，不设口令；最小权限角色 | docs.temporal.io/temporal-service/persistence；postgresql.org/support/versioning |
| Temporal 服务端 | CLI 1.8.3 自带的 dev server + SQLite | **服务端 v1.32.0**（2026-09-11 发布）+ 建表工具（都在同一个发布包里）；**CLI v1.9.1**；UI server v2.54.1（可选，只听本机，想对外用就放在 Cloudflare Access 后面） | 下载 `temporal_1.32.0_linux_amd64.tar.gz`，用 `checksums.txt` 校验；SQL 插件按当版文档选 postgres 系；命名空间保留期显式设置并读回（有界重试）；worker 版本和 `patched` 的规矩写进开发约定 | gh GraphQL 读到的发布；P18/P19/P22；windsurf-dao#1664 |
| Temporal TS SDK | 旧的 1.13.2（精确钉版本） | 1.24.0（npm latest） | 按 lock 文件 `npm ci`；回放测试夹具随代码走 | registry.npmjs.org；wd:packages/fleet/package.json:14-20 |
| cloudflared | 没装 | **2026.9.3**（2026-09-24 发布），钉版本 | 远程管理的隧道；`--token-file`（2025.4.0 起支持）指向一个 root 0600 的文件，令牌不出现在 `ps` 里；显式加 `--no-autoupdate`（自带的自动升级会重启，而且不等新进程连上）；**把官方单元模板里的 `Restart=on-failure` 改成 always**（P06）。Workers VPC 目前是 beta，所有 Workers 套餐都免费 | developers.cloudflare.com 的 cloudflared run-parameters 页与 workers-vpc 页 |
| 备份 | **没有** | pg_dump（`-Fc`，应用库和 Temporal 库各一份）+ **restic 0.19.1** 推到 R2（S3 兼容，自带加密和去重）；密钥包另外用 **age 1.3.2** 加密 | 每晚一次；`restic forget --prune` 管保留期（「保留多久」在 fd §19 还是待讨论）；看门狗检查「最近一次成功备份 ≤ 26 小时」；每周在一台全新机器上恢复一次并跑冒烟。R2 免费额度是每月 10 GB·月存储、100 万次 A 类操作、1000 万次 B 类操作，只适用于标准存储；超出就要花钱 → 人闸 | GitHub 发布；developers.cloudflare.com/r2/pricing；ags:docs/ops/REPLICATION.md「安全与备份基线」（旧网关机的「48 小时内有新备份」体检） |
| git / gh | git 2.43；gh 2.99.0 | 用发行版自带的 | 服务用户：`core.editor true`、`core.pager cat`（P31）；root 的 PATH 前面放一个 git 守卫壳（P01）；服务器上不留个人的 gh 登录（fd §4：写 GitHub 走机器人） | wd:NEW-MACHINE.md:355-372；wd:host/machine/shims/git-owner-guard |
| 沙盒前置 | bwrap 和 chromium 的 AppArmor 配置都已装 | 照装 | `apt install bubblewrap`，再加 `/etc/apparmor.d/bwrap` 并 `apparmor_parser -r`；这个文件在 /etc，**重装机器时要重建** | wd:NEW-MACHINE.md:1170-1197；P29 |
| Claude Code | `@anthropic-ai/claude-code` 2.1.281（npm 全局）+ 原生版 2.1.281 | 跟最新（用户已拍板） | 装到服务用户自己的目录；无头运行的三道门装机时就预置好（P32）；订阅线路：不经 Mirasim，直接起 `reclaude -p` | 判例 mirasim-overrides-reclaude-upstream；wd:host/machine/systemd/mirasim-server.service:31-36 |
| reclaude | 二进制在 `~/.local/bin/reclaude`，守护进程没人托管 | 跟最新 | 守护进程改由 systemd 托管，User=服务用户，Restart=always；切号用 `--no-carpool`（用户拍板） | ags:docs/ops/MIRASIM-VPS.md:17、24 |
| codex | `@openai/codex` 0.156.1 | 跟最新 | 前置 bubblewrap；两把 key 各用一个 `CODEX_HOME`，不要合并 | wd:NEW-MACHINE.md:291-317 |
| cursor-agent | 2026.09.23-86fc751（curl 安装器装的） | 跟最新 | 登录必须在真 TTY 里做（device-code 流程） | wd:NEW-MACHINE.md:276-277 |
| Grok 命令行 | npm 版 `@xai-official/grok` 1.0.41 与 `~/.grok/bin` 里的 1.0.1 并存 | 跟最新，只留一份 | 调用时写绝对路径；不钉模型（P33） | wd:NEW-MACHINE.md:253-257 |
| 其他 CLI | kimi-code 2.1.1；pi 0.87.1（`@earendil-works` 版，不是上游）；dsh 0.1.5-rc.3；devin 3000.11.3；command-code 1.65.0；lark-cli 1.0.96 | 看路由表需要哪些 | 升级在会话之外做，有会话在跑就等（P34）；pi 别装上游包（wd:NEW-MACHINE.md:215） | VPS 读数 |
| Mirasim | mirasim-server 0.0.355 + 受控升级器 + ws 探活 | 保留 | 先装 ags 的升级器本体，再装单元（ags:docs/ops/MIRASIM-VPS.md:44）；单元带 `NO_AGENT_EGRESS`（P39）、MemoryMax、OOMPolicy=continue；机器上的配置经 `applyConfig` 施加 | §1.2 |
| 飞书 | lark-cli + 旧机器人 | 新机器人（fd §15.4） | 长连接只出站，不开端口 | fd §15.4 |
| Jev | 外部接口（TypeSafe） | 保留 | key 文件在服务用户的 0600 文件里 | wd:host/machine/INDEX.md:52 |
| 防护 | ufw 只开 22，fail2ban | 保留；22 端口关不关待拍（§9） | fd §6 要求「VPS 不开任何端口」，和现在 22 开着冲突 | VPS 读数；fd §3 第 6 条 |
| 资源隔离 | 还没有 | 按 2026-09-24 的决定：建 `agents.slice`，每个会话一个 scope；先只开统计，再加 MemoryHigh/CPUWeight/TasksMax，最后才加 MemoryMax | 经 Mirasim 起的会话进不了引擎自己的 scope，只受 mirasim-server 的上限约束 | wd:docs/decisions/2026-09-24-agent-isolation-and-error-routing.md:61-64 |

**与实施计划不一致的三处（以 [plan.md](../plan.md) 为准，审计建议留作权衡依据）**：
- **Postgres 版本**：plan.md 选 PostgreSQL 17；审计时 Temporal 官方测过的最高是 16.6（13.18 / 14.15 / 15.10 / 16.6）。用 17 之前先在 CI 上把 Temporal 的建表工具与冒烟跑一遍。
- **Node 版本**：plan.md 选 Node 22（VPS 现有 22.23）；审计建议 24 LTS（见 §9 待拍第 2 条）。
- **备份目标**：plan.md 改为每晚法国 → 香港加密备份、保留 7 天 + 4 周（R2 开通要绑支付方式）；上表「备份」一行的 restic、age、「最近一次成功备份」新鲜度检查、每周恢复演练照样适用，只是目标从 R2 换成香港。

**版本策略有两套，要分开写清楚**：基础设施的二进制（Temporal、cloudflared、restic、Node 的大版本）钉死版本并校验 sha256（wd:scripts/install-fleet.sh:14-15）；AI 命令行一律跟最新，在会话之外升级（用户 2026-09-22 拍板，ags:docs/ops/MIRASIM-VPS.md:20）。

---

## 七、机器上的凭据清单（只写种类，不写位置和值）

「新系统」一列是建议。具体落点不进公开仓：在旧机上按旧仓 `host/machine/INDEX.md`（旧系统的落点清单）找。

| # | 凭据 | 现在谁在用 | 新系统 |
|---|---|---|---|
| 1 | GitHub App 私钥和安装信息（5 个旧 App：审官、工人、帅位、看守、消歧），外加缓存的安装令牌 | 旧 fleet、issue 网关 | 新建 App（权限按设计重配）；旧的随旧系统存档 |
| 2 | 已弃用网关的管理员凭据 | 没人（windsurf-dao#1523） | 不带，建议作废 |
| 3 | 服务用户个人的 gh 登录 | master 哨兵重跑检查时用（wd:NEW-MACHINE.md:464-465） | 不带 |
| 4 | Mirasim 登录和中继状态（设置、设备、证书、本机回环令牌——令牌服务一重启就换） | mirasim-server | 要；换机需要人重新登录（ags:docs/ops/MIRASIM-VPS.md「只活在机器上」） |
| 5 | Mirasim 的 keys 目录：飞书应用凭据、飞书机器人调模型的 key、飞书群映射；若干上游的 key；旧网关的分组 key | 飞书机器人、各座桥 | 飞书相关的按新机器人重配；旧网关分组 key 随 windsurf-dao#1523 作废（其中一把审计时还被 4317 桥读着） |
| 6 | Claude 订阅（reclaude）的设备凭据与 CA；root 另有一份 | Claude 订阅线路 | 要；这是**设备绑定**的凭据，换机可能触发风控（P39） |
| 7 | Claude Code 的凭据文件（审计时属主是 root，P01）与 `settings.json`（红线文件，不许整文件覆写，wd:NEW-MACHINE.md:323） | Claude Code | 按新系统的无头配置重建 |
| 8 | Codex 的两个 `CODEX_HOME`（默认那份的 base_url 指本机 4317） | codex | 要；两份必须分开 |
| 9 | 上游 key 原件（pqapi 两把、opencode-go、commandcode，另有备份与一份上游清单） | codex-sol、pi | 看路由表 |
| 10 | Jev（判断题服务）key | Jev | 要 |
| 11 | 其他网关文件（环境文件、windsurf key） | 旧 orca-serve 的 drop-in 等 | 大概率不带 |
| 12 | Cursor 登录态 | cursor-agent | 要 |
| 13 | Grok 登录态 | grok | 要 |
| 14 | Devin 凭据 | devin | 看路由表 |
| 15 | Command Code 登录态 | cmdc | 看路由表 |
| 16 | pi 的 provider key（另有 2 份 `.bak`）与 antigravity 配置 | pi | 看路由表 |
| 17 | Kimi Code、dsh 的登录态 | — | 没看到认证类文件，放在哪没查成；看路由表 |
| 18 | 飞书命令行（lark-cli）配置 | lark-cli | 看新机器人 |
| 19 | 飞书机器人的环境变量文件（密钥一份、公开一份，外加一份旧备份） | feishu-triage | 新机器人另配 |
| 20 | Antigravity 代理的配置、管理 key 和账号授权文件 | cliproxy | 待判 |
| 21 | Command Code 适配器配置 | 已经不在跑 | 不带 |
| 22 | SSH（服务用户与 root 各一套） | 运维登录 | 要 |
| 23 | 浏览器登录态（等同账号凭据）、VNC 口令与证书、一张 sslip 证书 | 手工建 App 时用的有头浏览器 | 如果改用 App Manifest 流程（P42），这一套可以不要 |
| 24 | MiraQuota 状态 | miraquota | 不属新系统 |
| 25 | 升级器配置（windsurf-dao#1557 的评论里核过，没有密钥） | 升级器 | 要 |
| 新 | Cloudflare 隧道令牌 | cloudflared | 新建；放 root 所有、0600 的本地文件，用 `--token-file` 指向它（令牌不出现在 `ps` 里） |
| 新 | R2（或香港备份）访问密钥 + restic 仓库口令 | 备份 | 新建；root 所有、0600 的本地文件 |
| 新 | 密钥包的 age 私钥 | 恢复 | 新建；**不放在机器上**（创始人的密码管理器里） |
| 新 | 续期互动限制用的身份 | 续期任务 | 审计建议单独一个 App，只给它 Administration: write（GitHub 文档：设置互动限制需要这项权限，它同时也能改仓库设置），不要把这项权限加给写码机器人。注：设计 §十四（2026-09-25 版）已定由「引擎」机器人续期，以设计为准，见 [github.md](github.md) 1.3 |

「最坏半小时恢复」（fd §13）的前提是：凭据能从加密备份里直接恢复，而不是每个 CLI 都重新登录一遍。但第 4、6 类是设备绑定的，拷到另一台机器上能不能直接用，没查成（§9）。

---

## 八、「一条命令」的形状（草案）与验收

1. **前提检查**（缺一样就停下，并给出装法）：Ubuntu 版本、x86_64、cgroup v2、时间同步、磁盘余量、服务用户、仓库路径、没有同名的临时单元（P10）、端口没被占。
2. **系统包**：bubblewrap + AppArmor 配置、ufw、fail2ban、git、postgresql-16。
3. **钉版本的二进制**：Node 24（apt）、Temporal 服务端和 CLI、cloudflared、restic、age，全部校验 sha256。
4. **数据库**：建库、建角色、Temporal 建表、命名空间保留期设置并读回。
5. **服务用户那一侧**：git 配置（P31）、各 CLI 装到用户自己的目录、Claude Code 无头预置（P32）、写入服务用户目录的都用 runuser（P01/P03）。
6. **凭据恢复**：用 age 解开密钥包，逐项放到位（权限 0600），再以服务用户身份打一次真接口（P43）。
7. **单元**：每个常驻服务都是 Restart=always；有效 User 不是 root，或者 ExecStart 指向的文件全链属 root（P02）；读回用 `systemctl show` 的有效值（P21）。
8. **读回**（三种状态，读不到的算「没查成」）：每个服务 active；每个定时任务有下一次触发时间（P08/P09）；每个 CLI 的 `--version`；隧道从外面能通（P37）；Postgres 能连上。
9. **冒烟**：跑一条最小的真实任务，从开单一直到合并、关单、记账（fd §6 第 3 条）。
10. **结论**：装机脚本的失败和读回的红都要计入（wd:scripts/bootstrap-server.mjs:238-242）；退出码三种（0 通过 / 1 有红 / 2 有没查成）。

**CI 演练**：在 GitHub 的全新 Ubuntu runner 上真跑第 1–5、7、8 步。凭据和真实会话是「预期内缺口」，要单独列出来；改 `deploy/` 的 PR 必须跑，另外每周跑一次（照 wd:.github/workflows/migration-rehearsal.yml）。备份恢复演练每周一次：从 R2 拉回数据，恢复到一台全新机器上，再跑冒烟。

---

## 九、没查成的，以及待创始人拍板的

**没查成**（需要实测或另外查证）：
- 飞书长连接在同一个应用有多个客户端时，消息怎么投递（本地搜索没结果，官方文档页取不到）。切换期按「同一时刻只跑一个消费者」处理最稳。
- 4317 桥（responses-chat-bridge）的上游现在还通不通。<服务用户> 默认的 codex 还指着它。
- <服务用户> 的 reclaude 守护进程是谁拉起的；如果它死了，下一次 `reclaude -p` 会不会把它自动拉起来。
- 服务用户的 Claude 凭据文件是怎么变成 root 属主的（时间上和 root 的 reclaude 启动接近）。
- 各 CLI 和 Mirasim、reclaude 的登录态整份拷到新机器上还能不能用（设备绑定、风控）。
- Kimi Code、dsh 的登录态放在哪里。
- server-check 在旧机上现在是什么状态（只读约束下没执行仓里的脚本）。
- 提供商的救援控制台能不能用（这决定关掉 22 端口的风险有多大）。

**待拍板**（每条都建议先摆选项再问）：
1. **服务用户**：新系统继续用现在这个服务用户（不用重新登录各 CLI，和 Mirasim 共用工作树，也没有跨用户写文件的问题），还是新建一个用户（家目录干净，但每个 CLI 都要人重新登录一遍，而且经 Mirasim 起的会话写工作树会碰到跨用户权限）。建议：同一台机器上继续用现在这个，先把家目录清理干净；新机器重建时再考虑改名。
2. **Node 24 还是等 26**（26 在 2026-10-28 转 LTS；实施计划当前选的是 22）。
3. **22 端口**：保持现状（只允许密钥登录 + fail2ban），还是把 SSH 也放到 Cloudflare 后面，然后关掉 22。
4. **机器时区**：继续用 Asia/Shanghai，还是改成 UTC（新的定时任务把时区写进定义里，这件事和机器时区无关，必须做）。
5. **cliproxy、responses-chat-bridge、miraquota-sync/contabo、release-train** 这几个是去是留（§1.2、§1.3）。
6. **备份保留多长时间**（fd §19 待讨论；实施计划已写「保留 7 天 + 4 周」）。
