# 运维手册：两台机器的地基与应用发布

装法在 `deploy/`，这里讲怎么用、怎么看、怎么退。机器的公网 IP 和驾驶舱域名不进仓，下文写作 `<法国IP>`、`<香港IP>`、`<驾驶舱域名>`；域名的真值只在机器配置里（香港 `hk.env`、法国 `release.env` 的 `FLEET_DOMAIN`）。
旧系统（windsurf-dao、ai-gateway-stack 那一套）已于 2026-09-25 从两台机器上全部清退：单元、用户、目录、数据都删了。它留下的坑与由来见 [reference/deploy.md](reference/deploy.md)（文中的 P01、P02 等编号出自那里；那份记的是清退前的现场）。
两层：`deploy/france.sh`、`deploy/hk.sh` 装机器（第一到第八节）；`deploy/release.sh` 发布应用（第九节），连同香港的飞书网关（第十二节）。备份与换机恢复另有一个装机脚本 `deploy/backup/install.sh`（「备份与恢复」一节）。本机 WSL 演练台已于 2026-10-06 撤掉（第十三节）。

## 一、两台机器

| | 法国 | 香港 |
|---|---|---|
| 系统 | Ubuntu 24.04，6 核 12G | Ubuntu 22.04，2 核 2G |
| 跑什么 | Temporal、PostgreSQL、引擎工人、驾驶舱后端、AI 会话 | nginx（驾驶舱静态文件、证书、往法国转接口）、WireGuard 服务端、飞书网关（只出站，不听端口） |
| 公网入站（ufw） | 只放 22/tcp；另在隧道网卡上给香港开 8787 | 本仓只放 22/tcp、80/tcp、443/tcp（nginx）、4500/udp（WireGuard）；另登记别家的 8443/tcp（self-proxy，不归本仓管）。白名单在 `deploy/hk.sh` 顶部「约定」（`HK_FW_OURS`、`HK_FW_FOREIGN`） |
| 装机脚本 | `deploy/france.sh` | `deploy/hk.sh` |
| 不归 fleet-dao 管的 | MiraQuota 的 `miraquota-sync`（等 miraquota-win#3 发版后停） | MiraQuota 的 `miraquota-hub`（127.0.0.1:4331）和同一个 nginx 上的站点 `ai-gateway`（只剩 `https://<香港IP>.sslip.io/mq/`），同样等 miraquota-win#3 发版后停；装机不碰 |

两机之间走 WireGuard 隧道 `10.99.0.0/24`：香港 `10.99.0.1` 是服务端；法国 `10.99.0.2` 是客户端，主动连、每 25 秒保活，所以法国不用开任何入站端口。

## 二、端口表

<!-- fleet:ports:start -->

| 变量名 | 端口号 | 来源脚本 |
|---|---|---|
| PG_PORT | 5432 | deploy/france.sh |
| TEMPORAL_FRONTEND_PORT | 7243 | deploy/france.sh |
| TEMPORAL_FRONTEND_MEMBERSHIP_PORT | 6943 | deploy/france.sh |
| TEMPORAL_HISTORY_PORT | 7244 | deploy/france.sh |
| TEMPORAL_HISTORY_MEMBERSHIP_PORT | 6944 | deploy/france.sh |
| TEMPORAL_MATCHING_PORT | 7245 | deploy/france.sh |
| TEMPORAL_MATCHING_MEMBERSHIP_PORT | 6945 | deploy/france.sh |
| TEMPORAL_WORKER_PORT | 7249 | deploy/france.sh |
| TEMPORAL_WORKER_MEMBERSHIP_PORT | 6949 | deploy/france.sh |
| API_PORT | 8787 | deploy/france.sh |
| MIRASIM_SESSION_PORT | 4318 | deploy/france.sh |
| WG_PORT | 4500 | deploy/hk.sh |

<!-- fleet:ports:end -->
法国（除了私有项目 self-proxy 的 443，全部只绑本机或隧道地址）：

| 端口 | 绑在 | 是谁 | 说明 |
|---|---|---|---|
| 5432/tcp | 127.0.0.1、::1 | PostgreSQL 16 | |
| 7243/tcp | 127.0.0.1 | Temporal 前端 gRPC | 引擎和 `fleet-temporal` 连这里 |
| 6943/tcp | 127.0.0.1 | Temporal 前端 membership | |
| 7244、6944 | 127.0.0.1 | Temporal history（gRPC、membership） | |
| 7245、6945 | 127.0.0.1 | Temporal matching | |
| 7249、6949 | 127.0.0.1 | Temporal worker | |
| 8787/tcp | 10.99.0.2 | 驾驶舱后端（`FLEET_COCKPIT_LISTEN`），`fleet-api.socket` 攥着 | ufw 只在隧道网卡 `wg-fleet` 上给 10.99.0.1 放行；socket 单元在听，重启后端那几秒也不断 |
| 8788/tcp | 127.0.0.1 | fleet 命令接口（`FLEET_AGENT_LISTEN`），`fleet-api.socket` 攥着 | 会话用得到，不对外。改这两个监听地址要三处一起改：`api.env` 的 `FLEET_COCKPIT_LISTEN`、`FLEET_AGENT_LISTEN`，`deploy/release.sh` 的 `COCKPIT`、`AGENT_API` 两个常量，`deploy/france/fleet-api.socket` 的两个 `ListenStream` |
| 8790/tcp、udp | 10.99.0.2 | self-proxy（不归本仓管，README「两台机器」） | `self-proxy-exit.service`：「法国-中转」的出口，香港经隧道转来；ufw 只在 `wg-fleet` 上给 10.99.0.1 放行（注释 `self-proxy exit`）。别动 |
| 443/tcp | 0.0.0.0、:: | self-proxy（不归本仓管） | `self-proxy-direct.service`：「法国-直连」入口，对公网开，ufw 注释 `self-proxy direct`。别动 |
| 4318/tcp | 127.0.0.1 | 会话用户自己的 Mirasim 服务，本地模式常驻（`fleet-mirasim-session.service`，第五节「会话用户的 Mirasim」，#424） | 避开旧系统仍留着共用的 4316 和另外两个还可能没清干净的 4315/4317（§1.2）；引擎认端口靠现读 `local-<端口>.token` 的文件名，不认这张表 |

上表里除了 8788、4318，本机上只有 root 和 fleet 连得上：Temporal 没开认证，谁连得上谁就能给任意工作流发信号，会话就能绕过人闸。拦法是一张单独的 nft 表 `inet fleet_dao`（按连接发起方的属主 skuid，别人连就被复位），由 `fleet-firewall.service` 载入。同一张表还管会话用户在回环上开的口（它的 reclaude 代理在临时端口上，现在还有 4318 这个固定端口）：只许它自己和 root 连（第五节「会话用户的口只许它自己连」，#35）——4318 是本地模式 Mirasim 服务，引擎（`fleet`）按设计要直连它，这条规则字面上不分端口地拦，`fleet` 连不连得上还没在真机上核实过，见第五节「会话用户的 Mirasim」第 2 步「已知口子（待核）」。**别启用 `nftables.service`**：它的默认配置开头是 `flush ruleset`，会把 ufw 的规则和这张表一起冲掉。

选端口的规矩：Temporal 一律「官方默认 +10」（当初为了和旧系统的 7233/8233 错开；旧系统已清退，端口不再改）；都在 32768 以下——32768 起是临时端口段，程序运行中随手要的端口会落在里面，同段里挑端口迟早撞上。

香港：

对公网的端口白名单和第一节「公网入站」是同一份。本仓管的在 `deploy/hk.sh` 顶部「约定」的 `HK_FW_OURS`（22/tcp、80/tcp、443/tcp、4500/udp），别家登记的在 `HK_FW_FOREIGN`（8443/tcp，不归本仓管）。改白名单改那里，并同步本节和第一节「公网入站」。

| 端口 | 绑在 | 是谁 | 说明 |
|---|---|---|---|
| 22/tcp | 0.0.0.0、:: | sshd | 装机和运维登录 |
| 80/tcp | 0.0.0.0 | nginx | `<驾驶舱域名>`：证书续期的验证路径，其余跳 https |
| 443/tcp | 0.0.0.0 | nginx | `https://<驾驶舱域名>`：静态页；`/api`、`/auth`、`/github/webhook`、`/healthz` 经隧道转法国 `10.99.0.2:8787`（连接留着复用，第八节），转之前清掉 `Authorization`、`X-Fleet-Acting-Feishu`；`/agent` 不转；`/release.json`（带完整提交号）只给法国经隧道来的（`10.99.0.2`），别处来的回 404 |
| 8443/tcp | 0.0.0.0、:: | self-proxy（不归本仓管） | `self-proxy-hk.service`：代理入口，ufw 注释 `self-proxy`；它的订阅在 nginx 站点 `self-proxy`（别家站点，同 ai-gateway）。别动 |
| 4500/udp | 0.0.0.0 | WireGuard 服务端 | 香港上游只放行少数常见 UDP 端口（2026-09-25 从法国实测：53/67/69/123/161/500/1701/4500 能到），51820 进不来 |

GitHub 事件地址：`https://<驾驶舱域名>/github/webhook`。飞书登录回调：`https://<驾驶舱域名>/auth/feishu/callback`。
整站不让搜索引擎收录：80、443 的回应都带 `X-Robots-Tag: noindex, nofollow`；`/robots.txt` 故意不禁抓——禁抓了爬虫就看不到这个头，网址反而可能凭外链被收进结果（`deploy/hk/nginx-*.conf`）。

## 三、用户、目录、库

下面这张表由 deploy/ 脚本生成，别手改：
<!-- fleet:users:start -->

| 用户 | 来源常量 | 来源脚本 |
|---|---|---|
| pilot | PILOT_USER | deploy/france.sh |
| fleet | ensure_service_user | deploy/hk.sh |
| fleet | ensure_service_user | deploy/lib/human-tier.sh |
| fleet-agent-carpool | SESSION_USER | deploy/lib/session-user.sh |

<!-- fleet:users:end -->
<!--
对照（给 diff 核对用；不在用户区块里，手写表未改）：
deploy/france.sh：PILOT_USER=pilot
deploy/hk.sh：ensure_service_user fleet
deploy/lib/human-tier.sh：ensure_service_user fleet
deploy/lib/session-user.sh：SESSION_USER=fleet-agent-carpool
packages/conventions/test/ops-tables.test.ts 本片未改。USERS_BLOCK 原文四行：
| pilot | PILOT_USER | deploy/france.sh |
| fleet | ensure_service_user | deploy/hk.sh |
| fleet | ensure_service_user | deploy/lib/human-tier.sh |
| fleet-agent-carpool | SESSION_USER | deploy/lib/session-user.sh |
-->
| 用户 | 在哪 | 干什么 |
|---|---|---|
| `fleet` | 两台 | 引擎、驾驶舱后端、Temporal（法国），飞书网关（香港）。系统用户，家 `/home/fleet`（750） |
| `fleet-agent-carpool` | 法国 | AI 会话专用，**只有这一个**（称「会话用户」；名字是历史沿用，不改名免得重新登录）：reclaude 一个账户最多挂 4 台设备、一个家目录算一台，本机和另一台机器已占掉两台，法国只能占 1 台（创始人 2026-09-26）。引擎的全部会话都跑在它下面；挂哪个组织以它家里的 reclaude 为准（`reclaude org list` 里带 `*` 的那行；2026-09-26 下午起挂独享），引擎选路、探针之前现读、不假定（第五节「会话用户挂的组织」）。平时挂拼车，用满由引擎整个用户切到独享、拼车窗口恢复再切回（#157；切的那一刻在跑的会话先停下、切完接着干——三段在原分支上重跑那一段，#59；design 第九节）。没有 sudo、不能提权、只在自己的组里、家里没有 GitHub 凭据、读不到 `/etc/fleet-dao`、连不上 Temporal 和库；它在回环上开的口（reclaude 的代理口）别的本机用户连不上（ops 第五节「会话用户的口只许它自己连」）。原先的 `fleet-agent-dedicated`（挂独享号的第二个会话用户）已删，2026-09-26；france.sh 不再建它、读回不查它 |
| `pilot` | 法国 | 创始人的登录用户：用 Mirasim 桌面端的 ssh 远程模式登进来干活（第五节）。系统用户，家 `/home/pilot`（750）；没有任何 sudo，只在自己的组和 `systemd-journal` 里（看日志）；读不到 `/etc/fleet-dao`、连不上 Temporal 和库，也连不上会话用户在本机开的口（借不到它的 reclaude） |
| `root` | | 只装机 |

法国：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/srv/fleet-dao` | root:root 755 | 装机脚本所在的检出（git clone）。fleet 和会话用户都只读。每次发版（驾驶舱按钮、发版车）发之前，那一趟把它快进到要发的提交（第九节），不用再手动 pull |
| `/srv/fleet-dao-releases` | root:root 755 | 应用的各版（第九节）：`<提交号>/`、`current` 链接、`.history`、`.config-applied.json`（上次照期望写进本机配置的公开值、最近 20 次写了什么，发布时记，第九节「配置进仓对账」）；每一版归 root，fleet 只读 |
| `/srv/fleet-dao-releases/.auto` | root:root 755 | 自动发布的读数 `state.json`（每一轮写，后端 `/healthz` 的 `deploy_lag` 读）、`france-applied`（france.sh 跑完没红时记装到哪个提交） |
| `/usr/local/lib/fleet-dao/auto-release`；`/etc/systemd/system/fleet-auto-release.{service,timer}` | root:root 755（文件 644）；root 644 | 自动发布（第九节「自动发布」）：france.sh 从仓里拷的副本，不从检出直接跑 |
| `/var/lib/fleet-dao`、`/var/log/fleet-dao` | fleet:fleet 750 | 运行数据、日志（服务日志主要在 journald）。引擎自己的临时文件（从镜像打的 bundle）和存档（没合并就收的树里没提交的改动）在 `/var/lib/fleet-dao/engine/` 的 `tmp/`、`archive/` 下（任务工作流动手会话的落盘在同级的 `runs/<执行编号>/`：提示词、输出、结局各一个文件，24 小时后由引擎顺手清），GitHub 的镜像仓在 `/var/lib/fleet-dao/github/` |
| `/var/lib/fleet-dao/demo` | fleet:fleet 750 | 已删（创始人 2026-10-07，#1223）：演示版留下的旧可见范围文件，不再有人读写；装机不再建它（#1278），机器上已有的目录和里面的旧文件要不要清由人定（删数据，不自动清） |
| `/var/lib/fleet-work` | root:root 755 | AI 会话的工作树：`<owner>_<name>/<分支>` 是子任务的树，`<owner>_<name>/<需求号>.<阶段>[.<子任务>]` 是分诊、写文档、审查的检出副本，`_route-probe/<会话用户>` 是路由探针起会话的目录（第五节「路由探针」），`_tmp/<会话编号>` 是每个会话自己的临时目录（会话的 TMPDIR，会话收场就删，工人起来时清上一轮剩下的）。中间各级归 root、别人写不进；每棵树归会话用户、700，建、交、删都经 `fleet-agent-scope`（第五节）。没有在跑的任务在用的树由引擎的每小时对账收（第五节「每小时对账」）：什么都不剩的删掉（能重新生成的编译和工具缓存不算），剩着没推的东西的报「要人拍」 |
| `/etc/fleet-dao` | root:fleet 750 | 本机配置与密钥：`france.env`、`temporal.env`（库口令）、`temporal.yaml`、`nftables.nft`、`github/`（两个 GitHub 机器人的 json，手放；目录配置不在这里：它是仓里的 `deploy/catalog.json`，跟着版本走，第九节「目录配置」，早先放在这里的 `catalog.json` 发布不再读，留着无害）；`reclaude-api.key`（reclaude 网页「设置 → API Key」生成的账号级 Key，只一行，读拼车额度用，手放；网页上重新生成后旧的立刻作废，要换这份再刷新保险箱）；`jev.json`（判断题的机器配置：TypeSafe 的地址、钥匙文件在哪，样例 `packages/jev/config.example.json`，手放；引擎和驾驶舱后端都读，`FLEET_JEV_CONFIG` 可改位置）、`typesafe.key`（TypeSafe 的钥匙，只一行，手放）；应用的 `engine.env`、`api.env`、`release.env`（每一项「应该是什么」写在仓里的期望 `deploy/france/desired-config.json`：新机器由 france.sh 照它建，私有值只留空位、由人放；之后发布时照要发的那一版的期望写，自动发布每一轮对账，第九节「配置进仓对账」），随机密钥 `agent-token.env`、`session-secret.env`、`gateway-token.env`（首次生成，之后不动）。文件一律 root:fleet 640；只有 `web-upload.key`（往香港传静态文件的钥匙）、`gateway-deploy.key`（往香港发飞书网关的钥匙）、`hk-known-hosts`（钉住的香港主机钥匙）和 `config-fingerprint.key`（配置对账算私有值指纹的钥匙，france.sh 首次生成，第九节「配置进仓对账」）是 root:root 600 |
| `/opt/fleet-dao/temporal` | root:root 755 | `server-1.32.0/`（temporal-server、temporal-sql-tool）、`cli-1.9.1/`（temporal），`bin/` 链接到在用的版本 |
| `/opt/fleet-dao/uv` | root:root 755 | `<版本>/uv`：只用来给会话用户和 pilot 各装一份 ddgs（第五节），不进谁的 PATH |
| `/opt/fleet-dao/pnpm` | root:root 755 | `<版本>/`：AI 会话用的 pnpm（npm 上的 `pnpm-<版本>.tgz`，版本跟仓根 `package.json` 的 `packageManager`，核过 `france.sh` 顶部钉的 sha512），`.sha256` 记着装完时每个文件的指纹（第五节「会话的 PATH 与 pnpm」） |
| `/usr/local/bin/pnpm` | root 755 | 会话用的 pnpm 的入口：关掉 node 的编译缓存，再用 `/usr/bin/node` 跑上面那一版。在引擎给会话的 PATH 上；pilot、root 的 PATH 里也有它 |
| `/tmp/node-compile-cache` | root:root 755 | node 默认的编译缓存目录：先由 root 建好，别的用户的 node 在里面建不了自己的子目录，就不用编译缓存（只慢一点）。不许归别人、里面不许有别人的东西：读回判红，`france.sh` 删了重建（第五节「node 的编译缓存目录」） |
| `/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf` | root 644 | 开机清空 /tmp 后，systemd-tmpfiles 照它在任何会话之前先把上面那个目录建好 |
| `/usr/local/bin/fleet-temporal` | root 755 | 运维命令行：连 127.0.0.1:7243，默认命名空间 fleet（只有 root 和 fleet 用得了） |
| `/usr/local/sbin/fleet-agent-scope`、`/etc/sudoers.d/fleet-dao` | root 755、root 440 | 起、收 AI 会话（第五节） |
| `/usr/local/sbin/fleet-demo-scopes`；`/etc/systemd/system/fleet-demo-scopes.{service,path,timer}` | （已删，#1223） | 原先把演示版的可见范围推到香港。装机（整套和自动档）会把老机器上还装着的停掉、禁用、删掉，读回核对它们不在 |
| `/etc/wireguard/wg-fleet.conf`、`wg-fleet.key` | root 600 | 隧道配置与私钥（私钥本机生成，不出机器） |
| `/etc/postgresql/16/main/conf.d/fleet.conf` | root 644 | 库只听本机 |
| `/etc/systemd/system/`：`fleet-temporal.service`、`fleet-agents.slice`、`fleet-firewall.service`、`postgresql@16-main.service.d/fleet.conf` | root 644 | 单元；最后那个让库的进程没了（干净退出也算）就拉起来——装包自带的是 `Restart=no` |
| `/etc/systemd/system/fleet-mirasim-session.service` | root 644 | 会话用户自己的 Mirasim 服务，本地模式常驻（第五节「会话用户的 Mirasim」，#424）：服务端本体不在时 france.sh 不装这个单元（待配）；在了才装、`enable`、起来。归自动档：发版后 `france.sh --auto-tier` 也装它，单元文件内容真变了才重启（#1274） |
| `/etc/systemd/system/`：`fleet-engine.service`、`fleet-api.service`、`fleet-api.socket` | root 644 | 应用单元，发布脚本从要发的那版里取来装上，只装 `release.env` 启用了的（第九节）。`fleet-api.socket` 攥着 8787 和 8788；改监听地址要 `api.env`、`release.sh` 的 `COCKPIT` 和 `AGENT_API` 两个常量、socket 单元三处一起改 |
| `/home/fleet/.local/bin/pnpm` | fleet | corepack 的垫片，版本跟仓根 `package.json` 的 `packageManager`；发布（第九节）以 fleet 装依赖、打包用它。会话读不到 fleet 的家，用的是 `/usr/local/bin/pnpm` |
| `/home/fleet-agent-carpool/.local/bin/reclaude` | 会话用户 | reclaude 二进制：france.sh 只在没有时装（和 pilot 同一个版本、sha256），缺了读回判红；登录见第五节 |
| `/home/fleet-agent-carpool/.local/share/cursor-agent/versions` | 会话用户 | cursor-agent，一个版本一个目录（命令还链到 `~/.local/bin/cursor-agent`）：france.sh 照引擎的找法一个能跑的都没有时，以会话用户自己的身份跑官方安装脚本装，之后它自己升级；缺了、跑不成读回判红；不登录，用下面那把 API 密钥 |
| `/home/fleet-agent-carpool/.cursor/fleet-api-key` | 会话用户 600 | Cursor 的 API 密钥，只有一行、不带换行；创始人放（`deploy/cursor-key.sh put`，第五节「会话用户的 Cursor 密钥」），引擎起 Cursor 会话时由会话用户自己读进 cursor-agent 的环境。读回只看在不在、属主、权限、大小，不读值：还没放记待配，放了不对判红 |
| `/home/fleet-agent-carpool/.grok/bin/grok` | 会话用户 | grok 命令行（SuperGrok 订阅的 Grok Build），链到 `~/.grok/downloads/grok-linux-<架构>`：france.sh 看它不是能跑的文件时，以会话用户自己的身份跑官方安装脚本装；不自己升级；缺了、跑不成读回判红（第五节「会话用户的 grok」） |
| `/home/fleet-agent-carpool/.grok/auth.json` | 会话用户 600 | grok 的登录态：创始人以会话用户 `grok login --device-code` 登录一次（第五节「会话用户的 grok」），grok 自己续期。读回只看在不在、属主、权限、大小，不读内容：还没登录记待配，在却不对判红 |
| `/home/fleet-agent-carpool/.mirasim-remote/`、`/home/fleet-agent-carpool/.mirasim/` | 会话用户 | Mirasim 以 ssh 远程模式（桌面端或 `mirasim ssh connect`）连 `fleet-agent-carpool@<法国>` 时自己装的服务端和它的数据，和 pilot 那份各自独立（第五节「会话用户的 Mirasim」，#345）；令牌在 `~/.mirasim/run/local-<端口>.token`——只有 `fleet-mirasim-session.service`（上面那行，#424）常驻着本地模式才会一直有这份令牌，光装远程模式那一下不会有。端口钉在 `deploy/france.sh` 的 `MIRASIM_SESSION_PORT`，引擎照旧现读令牌文件名认端口。读回只看令牌恰好一份，不读内容、不管服务进程在不在跑：还没装记待配，不止一份判红 |
| `/home/pilot/.local/bin/reclaude` | pilot 755 | reclaude 二进制：france.sh 只在没有时装（版本和 sha256 钉在脚本顶部），之后 pilot 自己 `reclaude update`。pilot 不登录 reclaude（第五节），读回也不查登没登录 |
| `/home/pilot/.mirasim-remote/`、`/home/pilot/.mirasim/` | pilot | Mirasim 桌面端连进来时自己装的服务端和它的数据（第五节），不归装机脚本管 |

香港：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/etc/fleet-dao/hk.env` | root:fleet 640 | 域名、证书联系邮箱、法国的 WireGuard 公钥、法国的两把发布公钥（上传静态文件、发飞书网关）。老文件里留着的 `FLEET_DEMO_PATH` 是已删的键（#1223），`hk.sh` 认得、忽略 |
| `/etc/fleet-dao/gateway-token.env` | root:fleet 640 | 飞书网关的通行证，和法国那份一模一样（第九节「两台同一份」） |
| `/etc/fleet-dao/feishu.env` | root:fleet 640 | 飞书网关的配置：飞书凭据、创始人（人放），后端地址、公网地址、团队群（hk.sh 缺才补，第十二节） |
| `/srv/fleet-dao` | root:root 755 | 装机脚本所在的检出 |
| `/srv/fleet-dao-web` | root:root 755 | 静态文件，归 root：飞书网关以 fleet 跑在这台，网关被打穿也改不了页面。由法国传来：`release.json` 写着根上的驾驶舱是哪一版（只给经隧道来的读），`/health/` 是健康页（第九节「发静态文件」）；`/demo/` 已删（#1223），发布脚本把老目录删掉、站点一律回 404。装机脚本只在没有 `index.html` 时放占位页，不盖已发布的 |
| `/srv/fleet-dao-gateway` | root:root 755 | 飞书网关的各版（第十二节）：`<提交号>/gateway.mjs`（法国打好的一个文件）、`current` 链接、`.history`；归 root，fleet 只读 |
| `/opt/fleet-dao/node-v22.23.3`（`/opt/fleet-dao/node` 链接到它） | root:root 755 | 飞书网关用的 node，固定版本、核对过 sha256；不用系统里的 node |
| `/usr/local/sbin/fleet-gateway-deploy` | root 755 | 发飞书网关的入口：法国发布脚本登上来只能跑它（第十二节） |
| `/etc/systemd/system/fleet-feishu.service` | root 644 | 飞书网关的单元；hk.sh 只装，起、重启归发布 |
| `/root/.ssh/authorized_keys2` | root:root 600 | 整份归 fleet-dao：法国两把发布钥匙各一行，都限死成只许从 `10.99.0.2` 来、不给终端：上传钥匙只能跑 `rrsync -wo -munge /srv/fleet-dao-web`，发网关的钥匙只能跑 `fleet-gateway-deploy`。root 原有的 `authorized_keys` 一行不碰 |
| `/var/www/fleet-dao-acme` | root:root 755 | 证书续期的验证文件 |
| `/etc/nginx/sites-available/fleet-dao`（`sites-enabled` 里有链接） | root 644 | fleet-dao 的站点。同一个 nginx 上另有 MiraQuota 的站点 `ai-gateway`（不归 fleet-dao 管，装机不碰） |
| `/etc/letsencrypt/live/<驾驶舱域名>` | certbot 管 | 证书；`certbot.timer` 续期，续完重载 nginx |
| `/etc/wireguard/wg-fleet.conf`、`wg-fleet.key` | root 600 | 隧道配置与私钥 |

库（法国）：PostgreSQL 16 装的是 Ubuntu 自带的源（吃得到自动安全更新）。`fleet` 库属 fleet 角色，本机 socket + peer 认证（系统用户 fleet 就是库角色 fleet），不设口令；`temporal`、`temporal_visibility` 属 temporal 角色，走 127.0.0.1:5432 + 口令（`/etc/fleet-dao/temporal.env`）。Temporal 命名空间 `fleet`，已结束的工作流保留 30 天。

## 四、怎么跑装机脚本

从零装（新机器或重建）：

1. 两台都以 root：`git clone https://github.com/thoerwink8/fleet-dao /srv/fleet-dao`。
2. 香港：`bash /srv/fleet-dao/deploy/hk.sh`。它照样例建 `hk.env`、打印香港的 WireGuard 公钥。样例里的域名是 `cockpit.example.com`，改成真域名再重跑；域名已经解析到这台的话，证书这一轮就签下来。
3. 法国：`bash /srv/fleet-dao/deploy/france.sh`。它打印法国的公钥，也建好创始人的登录用户 pilot（放登录公钥、登录 reclaude 见第五节）；`engine.env`、`api.env`、`release.env` 它照仓里的期望建（第九节「配置进仓对账」），私有值只留空位（`release.env` 的 `FLEET_DOMAIN`、`api.env` 的 `FLEET_PUBLIC_URL` 和凭据），由人填上真的，域名同样改成真的。重建时这些配置直接从保险箱取回（README「密钥和本机配置在哪」）。
4. 互填：香港公钥和 `<香港IP>:4500` 填进法国 `/etc/fleet-dao/france.env`；法国公钥填进香港 `/etc/fleet-dao/hk.env`。
5. 先重跑香港、再重跑法国：隧道起来，法国读回里 `ping 10.99.0.1` 通；法国这一遍还会经隧道钉住香港 sshd 的主机钥匙。
6. 发布钥匙：法国 france.sh 打印两把公钥，整行各填进香港 `hk.env`：上传钥匙的填 `FLEET_WEB_UPLOAD_PUBLIC_KEY`，发网关的填 `FLEET_GATEWAY_DEPLOY_PUBLIC_KEY`；重跑香港，再跑法国，读回里「往香港传文件的通路是通的」「香港飞书网关的入口是通的」。
7. 飞书网关的通行证拷一份到香港（第九节「两台同一份」）；飞书凭据和创始人放进香港 `/etc/fleet-dao/feishu.env`，把机器人拉进团队群，重跑香港补齐其余几项（第十二节）。
8. 手放密钥：两个 GitHub 机器人的 json 放进法国 `/etc/fleet-dao/github/`，root:fleet 640（读回会查权限）。目录配置不用手放：发布时装这一版自带的 `deploy/catalog.json`（第九节「目录配置」）。
9. 会话用户登录 reclaude（第五节，要创始人）。
10. 各再跑一遍，结论应是「本次改动 0 处」。然后发布应用（第九节），再把创始人写进驾驶舱的白名单（第九节「驾驶舱登录的白名单」那一条；不写谁都登不进）。

平时：

- 改了 `deploy/` → 机器上 `git -C /srv/fleet-dao pull` → 重跑。脚本只把它管的东西改回仓里的样子；早先版本放过、后来撤掉的几样，脚本里逐个写死了去删，别的多出来的东西不删（要删见第七节）。法国的检出由发版那一趟快进到要发的提交，pull 可以省；france.sh 本身不自动跑（它碰防火墙、sudoers），主线上它管的文件改了、一天以上没重跑，`/healthz` 的 `deploy_lag` 会报（第九节「自动发布」）。应用那一层（引擎、驾驶舱后端）不用重跑这里，发版（驾驶舱按钮）会发。
- 只看不改：`bash deploy/france.sh --check`、`bash deploy/hk.sh --check`。
- 法国经跳板登录，长连接会被重置：长命令甩到后台跑再看日志，`nohup setsid bash /srv/fleet-dao/deploy/france.sh > /root/fleet-dao-install.log 2>&1 < /dev/null &`。

- 法国 sshd 抗扫描（人工档，#1348）：公网扫描器占满未认证连接槽，sshd 随机丢新连接，本机和发版车就报 `Connection timed out during banner exchange`。`france.sh` 整套跑时放两份仓里的 drop-in：`deploy/france/sshd-hardening.conf` → `/etc/ssh/sshd_config.d/50-fleet-dao-hardening.conf`（`LoginGraceTime 20`、`MaxStartups 30:30:120`、`MaxAuthTries 3`；不改端口、不改认证方式；没写 `PerSourcePenalties`，它要 OpenSSH 9.8 以上，Ubuntu 24.04 的 9.6 认不得），先 `sshd -t`，过了才 `systemctl reload ssh`（不断已登录的连接），不过就撤掉这份、不重载、判红；`deploy/france/fail2ban-sshd.jail` → `/etc/fail2ban/jail.d/fleet-dao-sshd.local`（3 次失败封 1 小时、反复来的越封越长），先 `fail2ban-client -t` 再 reload，没装 fail2ban 只记待配、不装软件包。读回用 `sshd -T` 和 `fail2ban-client get sshd …` 核对真生效的值。是人工档：改的是登录入口，两份文件登记在 `HUMAN_TIER_PATHS`，改了要人以 root 重跑 `bash /srv/fleet-dao/deploy/france.sh`；`MaxAuthTries 3` 下，agent 里钥匙多于 3 把的客户端要加 `-o IdentitiesOnly=yes`。测试 `deploy/test/sshd-hardening.test.sh`（`sshd -t` 不过撤掉文件不重载等故意造的失败）。

输出与退出码：每步一行，`✓` 本来就对、`↻` 这次改了、`✗` 红、`…` 待配或没查成；自检里别家单元的问题用 `·` 和 `!` 列出（见第六节）。退出码 0 全绿，1 有红，2 没红但有待配。

验证用的工具：

- `bash deploy/lib/snapshot.sh ours`：fleet-dao 管的东西的指纹。连跑两遍装机，两遍之间各拍一次，diff 为空才算第二遍零改动——和脚本自己数的「改动几处」是两套判据。
- `bash deploy/lib/snapshot.sh others`：不归 fleet-dao 管的单元状态、监听端口、防火墙（系统自带的服务、MiraQuota 等）。装机脚本每次开头结尾自己比一遍：装机不许碰它们。
- `sudo bash deploy/test/run.sh`：语法、shellcheck、自检的违规样本、发布脚本的来回（`release-flow.test.sh`）、香港网关的入口（`gateway-deploy.test.sh`）、网关打包（`gateway-bundle.test.sh`，要先 `pnpm install`）、公网上看得到的几样（`public-site.test.sh`：占位页、健康页不带仓名，`release.json` 只给隧道、整站 noindex；真起 nginx 那段要这台装了 nginx）、健康页的判定（`health-page.test.mjs`）、被封号邮箱清理（`reclaude-old-account-clean.test.mjs`：只摘点名编号的那一串、不带编号不动会话、编号对不上一个字节不写、输出不带邮箱）、自动发布单元的读数和流程（`auto-release.test.mjs`：没有任何 `v<N>` 标记的仓上读数照常、绝不碰发布脚本和标记、主线头 CI 红或读不到只记结论不报警、读不到不当成绿、规矩同步和装机自动档没成报警、状态文件读不出什么都不做、旧发版报警第一轮撤掉）、配置对账和发布时照期望写（`config.test.mjs`：线上手改报哪一项、私有值只报不一致不带值、期望和钥匙读不到记没查成；只写期望变了的、人手改的不改回、写不成一个字不写，第九节「配置进仓对账」）、france.sh 读回自动发布跑得怎么样（`auto-release-state.test.sh`：读每一轮写的状态文件，不看服务正在跑时是空的 `ExecMainExitTimestamp`；没有文件是还没跑过，读不了、认不出判红，读到了写上一轮的时间和干了什么，最近一轮崩了判红）、同步脚本以 root 替别的用户写（`agents-sync.test.sh`）、ddgs 的装和查（`cli-tools.test.sh`）、会话用的 pnpm 的装和查（`session-pnpm.test.sh`：钉的版本和 `package.json` 对得上、核不上不装、引擎给会话的 PATH 怎么读、会话里找不到或找错 pnpm 判红；不出网，要 root）、node 的编译缓存目录（`node-cache.test.sh`：拿真 node 对照为什么要归 root，不对的样子判红、装的时候删了重建，删不掉、建不成判红；要 root）、会话用户的 cursor-agent 的装和查（`cursor-agent.test.sh`：没装才以他自己的身份跑安装脚本、装着的不重装、跑不成和卡住判红、没查成不当成没装；假的安装脚本，不出网，要 root；找法和引擎的一样由 `packages/engine/test/real/hosts.test.ts` 核对）、会话用户的 Cursor 密钥的放、查、撤（`cursor-key.test.sh`：以他自己的身份放、属他、600、剪贴板补的换行去掉，空的、带空白、两行、带控制字符的不换、原来那份留着，读回权限太松、属主不对、空的、符号链接判红，全部输出里搜不到值；要 root）、会话用户的 grok 命令行的装和查、登录态的读回（`grok.test.sh`：没装才以他自己的身份跑安装脚本、PATH 里只有系统目录、SHELL 是 `/bin/sh`（他家 `~/.local/bin` 里 cursor-agent 链的 `agent` 不被盖掉、启动文件不改）、装着的不重装、是目录或不能跑的算没装、跑不成和卡住判红、没查成不当成没装；登录态没有记待配、符号链接、目录、属主不对、权限不是 600、空的判红，全部输出里搜不到文件内容；假的安装脚本，不出网，要 root；判法和引擎起 grok 的一样由 `packages/engine/test/real/hosts.test.ts` 核对位置）、会话用户自己的 Mirasim 服务的读回（`mirasim.test.sh`：`mirasim_run_dir` 和引擎的 `DEFAULT_MIRASIM_HOME` 拼出同一个位置，目录不在或没有令牌待配、不止一份判红、恰好一份判绿且令牌内容不读、目录真读不了判红且和「目录不在」分开、这个系统用户不存在判红；要 root）、本页端口表和脚本对得上、只有一个会话用户且它的读回拦得下故意造的错（`session-user.test.sh`：不要 root，假的 getent、sudo、id）、会话用户在本机开的口只许它自己和 root 连（`session-ports.test.sh`：要 root；在一次性的网络命名空间里载入真的 `fleet-dao.nft`、以三个临时用户真连——别人连不上会话用户的口（127.0.0.1、::1）、会话用户和 root 连得上、别人之间照常通、固定端口照旧只许 fleet；强制 syncookie 时别人照样一个连接都到不了会话用户那头，拿掉第 4 条规则就到了；读回在规则在时全绿，表没装、挡错了人、挡多了判红，查不到会话用户、起不了探针、ss 跑不成、别的用户查不到或没以他的身份跑起来都记没查成（不当成挡住了），内核里的表被手改过判出来；规则载上之前就连着的连接照样通、读回判红，装的时候断掉，断不掉、ss 跑不成判红）、`adopt` 的用法校验和改属主（`agent-scope-adopt.test.sh`）、`org-use` 切会话用户挂的组织（`agent-scope-org-use.test.sh`：不要 root，假 reclaude 把每种没切成的路径都造一遍——读不了、认不出、带 `*` 的不是恰好一行、那一类的组织不是恰好一个、退出码 1 却切了、退出码 0 却没切、切错了往回切、往回切也不生效、切完核对不了）。后者改属主那段要建、删真的系统账号（会话用户），只在命令行上给了 `FLEET_TEST_SYSTEM_USERS=1` 时跑（`sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy/test/run.sh`，只在 CI 的一次性机器上这么跑）；没给、或这个用户、组、家目录有一样已经在，这一段报「没跑成」（退出码 2，不算通过），不碰已有的账号。`bash deploy/test/run.sh --ops` 只跑读本页的两块（端口表、`place-file.test.sh`），CI 只改了本页时这么跑；全套里的 `ops-only.test.sh` 核对这两块真跑了、本页改坏了会红。
- `sudo bash deploy/test/agent-scope.e2e.sh`（法国）：会话通路真跑一遍，见第五节；含引擎给的 PATH 里没有会话用户的 `~/.local/bin` 时，会话里照样先找那儿、找得到 ddgs。只测 `run`、`stop`、`list`；`adopt` 在真机上还没有这样的用例，只有上一条在 CI 里跑的。

## 五、AI 会话

资源池与起会话：

- 池子 `fleet-agents.slice`（cgroup 路径 `/fleet.slice/fleet-agents.slice`）：CPU、内存、进程数、IO 都记账（按 windsurf-dao 仓 `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md` 的「先观测」起步），内存设了总量上限（2026-09-28 起，断链之后：见下面「会话的内存上限和测试进程数」）；CPUWeight、TasksMax 还没实测画像，这两个值目前空着（还没实测，不算推后要做的事）。
- 每个会话一个 scope：`fleet-agent-<编号>.scope`，身份是会话用户，上限由引擎起会话时给。
- 引擎（fleet）自己建不了系统级 scope，会话还得换成会话用户。polkit 管不窄——systemd 255 建临时单元时不把单元名交给 polkit，放行就等于放行任何单元、任何身份——所以 sudoers 只放行 fleet 以 root 跑一个脚本：

```
sudo -n /usr/local/sbin/fleet-agent-scope run <编号> --user fleet-agent-carpool
        [--memory-high 5888M] [--memory-max 6144M --memory-swap-max 0] [--tasks-max 512] [--cpu-weight 100]
        [--cwd /某目录] -- /绝对路径/命令 参数…
sudo -n /usr/local/sbin/fleet-agent-scope stop <编号>     # 已经没了也返回 0
sudo -n /usr/local/sbin/fleet-agent-scope list            # 编号 状态，一行一个
sudo -n /usr/local/sbin/fleet-agent-scope adopt /var/lib/fleet-work/<owner>_<name>/<树>         --user fleet-agent-carpool
sudo -n /usr/local/sbin/fleet-agent-scope remove /var/lib/fleet-work/<owner>_<name>/<树>   # 本来就不在也返回 0
```

- `run` 最后 exec 成会话本身，标准输入输出还是引擎手里那一份。
- 工作树的路径见第三节目录表的 `/var/lib/fleet-work` 一行。引擎建树、收树都经下面两个子命令。
- `adopt`：把工作树交给会话用户。工作树不在就建：中间各级 `root:root 755`，最后一级归会话用户、700（引擎建树走的就是这一条）。在就只改属主（引擎建的、还不归它的树）：`chown -R --no-dereference`。改属主之前先核这台开了 `fs.protected_hardlinks`（值是 1；读不到也当没开），没开就拒、退出码 1——没开时会话用户能在工作树里给自己读不到的文件建硬链接，root 的 `chown -R` 会把那个文件一起改成它的。`--user` 只认会话用户（停用的 `fleet-agent-dedicated` 也拒）。校验：工作树必须是绝对路径、落在 `/var/lib/fleet-work` 之下、至少两层（仓/任务）、路径上每一段都不是符号链接（`realpath` 解出来要和给的路径一模一样）、在的话是目录——不对就是用法错误，退出码 64。
  原先的 `--from <另一个会话用户> --session <会话编号>`（换会话用户时以旧用户身份把过程记录拷给新用户）随第二个会话用户一起拿掉了：只有一个会话用户，续会话、切号后的 fork 都在同一个家目录里，记录就在；旧调用方还带这两个参数一律按「不认识的参数」拒（退出码 64），不悄悄当成只改属主。
  测试专用开关 `AGENT_SCOPE_TEST_WORK_BASE` 能把 `/var/lib/fleet-work` 换成临时目录，`AGENT_SCOPE_TEST_PROTECTED_HARDLINKS_PATH` 能把 `/proc/sys/fs/protected_hardlinks` 换成临时文件：都故意不叫 `FLEET_*`——sudoers 的 `env_keep` 会把 `fleet` 用户环境里的 `FLEET_*` 原样带进这个以 root 跑的脚本，开关要是也叫 `FLEET_*`，`fleet` 用户自己在调用 `sudo` 前设一个同名变量就能把生产上的落点边界改掉、把硬链接保护的检查骗过去；不在 `env_keep` 白名单里的名字，`sudo` 会在进来之前就把它擦掉，所以只在直接跑这个脚本（不经 `sudo`）的测试里生效。
- `remove`：删一棵工作树（引擎收树时用）。路径的校验和 `adopt` 一样；以 root `rm -rf --one-file-system`，不跟随符号链接、不跨文件系统。本来就不在也返回 0。标准输出最后一行是 `removed <路径>` 或 `gone <路径>`，退出码同 `adopt`。
- 环境变量不走命令行（sudo 会把命令行记进日志）：引擎把 `FLEET_*`、`LANG`、`LC_*`、`TZ`、`TERM`、`GIT_TERMINAL_PROMPT` 放进调 sudo 时的环境；会话的 PATH 用 `FLEET_SESSION_PATH` 给，帮手脚本再把会话用户家里的 `~/.local/bin` 接在最后（引擎给的是它自己的 PATH，里面没有；ddgs 这些各用户自己装的命令在那儿。会话自己写得动的目录一律排最后：放在前面，会话放个同名程序就能顶掉 fleet 命令和系统命令）；HOME、USER 是会话用户的。GitHub 凭据（`GH_TOKEN` 之类）一概带不进去：推分支、开 PR 由引擎在会话外做。
- 会话出网经的代理（#731）：`engine.env` 的 `FLEET_SESSION_PROXY`（期望里登记：法国空着、直连）。配了的话，cursor-agent、grok 的会话和探针带上 `http_proxy`、`https_proxy`（大小写各一份）和 `no_proxy`（只放本机回环），写成 `/usr/bin/env` 的参数（`packages/adapters/src/procs.ts` 的 `scopeLaunch`；值只认不带账号密码的 `http://主机:端口`，带了账号密码引擎不起）；Claude 的会话不带：reclaude 自己管上游和代理，会话经它的本地口出去（带了代理变量的 Claude 会话直接拒起）。引擎进程自己的环境里的代理变量不抄给会话。装机脚本以会话用户跑 grok、cursor-agent 的官方安装脚本时带同样几个，值照期望读（`deploy/lib/session-proxy.sh` 的 `session_proxy_load`），root 环境里的代理、同名变量都不认；期望读不出就判红、不装。还有两处要出网、环境同样被清干净（#786）：发布取代码（以 root 跑 `git fetch`）和装依赖（以 fleet `env -i` 跑 `pnpm install`）——`deploy/release.sh` 也照期望读（同一个 `session_proxy_load`），取代码写成 `git -c http.proxy=…`、装依赖把那几个变量加进 `env -i`；`fleet-agent-scope.sh` 的 `org-use`（切会话用户挂的 reclaude 组织，环境也是 `env -i`）同样带上，不带就切不了号。法国登记的代理是空，这三处一个字都不加、行为不变。
- 会话降权用 `setpriv --init-groups --no-new-privs`：只在自己的组里，会话里的 sudo、setuid 程序都提不了权。不用 `systemd-run --uid`：它在 scope 里不清附加组，会话会带着 root 组（法国实测）。
- 内存要真封顶，`--memory-max` 和 `--memory-swap-max` 得一起给：只给前者，超出的部分被换进 swap，会话不会被杀（法国实测）。
- 引擎正常停（SIGTERM）：sudo 把信号转给会话，会话跟着退。引擎崩了（SIGKILL）：会话留在自己的 scope 里；引擎起来后 `list` 找回、`stop` 收掉。
- 引擎的 systemd 单元不能开 `NoNewPrivileges`：开了 sudo 提不了权。
- 看用量（不用 root）：`systemctl status fleet-agents.slice`、`systemd-cgtop /fleet.slice/fleet-agents.slice`、`systemctl show fleet-agent-<编号>.scope -p MemoryCurrent,CPUUsageNSec,TasksCurrent`。
- 池子的总量上限写在 `deploy/france/fleet-agents.slice` 里（`MemoryHigh`、`MemoryMax`），由 `deploy/france.sh` 装到 `/etc/systemd/system/`；改了这份文件重跑一遍 france.sh 再 `systemctl daemon-reload`（脚本会自己做）。临时想加别的（CPUWeight、TasksMax…）不改主文件，写 `/etc/systemd/system/fleet-agents.slice.d/override.conf` 再 `systemctl daemon-reload`；回滚就删掉它。

会话的内存上限和测试进程数（#164 按 2026-09-26 的实测定，2026-09-28 按断链改过推导，依据见 `specs/164-会话内存与交活测试/方案.md` 和 `packages/engine/src/limits.ts` 的注释）：

- 安全垫分两层：父节点 `fleet-agents.slice` 兜「总量不超」，单会话的上限只管「一次放得下最坏情形」，不再严格三等分（cgroup v2 的常见做法：kernel 文档 memory.high/memory.max 一节，k8s requests/limits 同理）。
  - 父节点总上限 =（能分给会话的 11G − 平台常驻服务约 0.6G）≈ 10664M（`packages/engine/src/limits.ts` 的 `SLICE_MEMORY_MAX_MB`），软上限低 512M（`SLICE_MEMORY_HIGH_MB`，10152M）；数值写在 `deploy/france/fleet-agents.slice`，两处对不上 `packages/engine/test/slice-unit.test.ts` 会红。
  - 单会话 scope 的上限是引擎的默认值（`sessionMemoryHighMb`、`sessionMemoryMaxMb`，驾驶舱设置里能改）：硬上限取 tsc -b 全仓约 1.9G + 测试 2–3 个进程约 2.5–3.2G + 代理本身约 0.3–1G 这种最坏组合，取整到 6144M（约总量的一半，比旧的三等分值 3554M 宽松得多，仍明显小于父节点总上限）；软上限只比它低 256M（5888M），超了软上限、又没有 swap 可换，内核就压着回收、会话半死不活，夹缝留窄。原来的软 1.5G、硬 2G 连 1 个测试进程加 Claude Code 都放不下（#160 卡在那里十几分钟）；后来的软 3298M、硬 3554M 又连「tsc -b + 测试 + 代理」这种会话内部的组合都放不下（法国 2026-09-28 06:35–06:45 实测：单会话被自己那道窄墙卡死，整机却还有 6.8G 空闲）。现在同时跑测试的会话数没有单独限着——多个会话同时冲高时由父节点的总上限兜住，不再靠单会话早早卡死自己；账号池的并发（目录配置里的 maxConcurrency）多了终究要看父节点扛不扛得住。
- 会话里跑测试开几个进程，由仓根的 `vitest.config.ts` 按本进程所在 cgroup 的上限算（`packages/conventions/src/test-run.ts`：每个进程按 900M、给主进程和 Claude Code 留 1300M）：新的 5888M 软上限放得下 5 个（一般机器 vitest 默认的「核数 − 1」就到头了，不再被内存上限额外砍）；没有上限（本机、CI）照 vitest 默认；读不到、认不出上限直接报错，要硬跑就给 `VITEST_MAX_WORKERS=<进程数>`。

会话的 PATH 与 pnpm（#164 在法国复测时查出：引擎给会话的 PATH 和会话用户的登录 shell 里都没有 pnpm，会话跑不了 `pnpm test:changed`，交活核对又只认命令开头就是它，绕成 `corepack pnpm …` 不算）：

- 会话的 PATH 是这么拼出来的：fleet 命令的目录（`engine.env` 的 `FLEET_CLI_BIN`；没写就是引擎这一版代码里的 `packages/cli/bin`，`packages/engine/src/worker.ts` 的 `DEFAULT_CLI_BIN_DIR`）+ 引擎进程自己的 PATH（`fleet-engine.service` 没设，就是 systemd 给服务的默认 PATH，里面有 `/usr/local/bin`）——引擎起会话时经 `pathPrepend` 拼（`packages/engine/src/activities.ts` → `packages/adapters/src/env.ts` 的 `buildSessionEnv`），调 sudo 时改名 `FLEET_SESSION_PATH`（`packages/adapters/src/procs.ts` 的 `scopeLaunch`），`fleet-agent-scope` 再在最后接上会话用户的 `~/.local/bin`。
- `france.sh` 给会话装一份 pnpm（`deploy/lib/session-pnpm.sh`）：版本跟仓根 `package.json` 的 `packageManager`，从 npm 下 `pnpm-<版本>.tgz`、核 `france.sh` 顶部钉的 sha512（`PNPM_INTEGRITY`，npm 的 `dist.integrity`），解到 `/opt/fleet-dao/pnpm/<版本>`，入口 `/usr/local/bin/pnpm`，都归 root：会话改不动，也不在第一次用时现下。不用 corepack 给会话装：它按调用者的家目录缓存、第一次用时才下，缓存在会话自己家里、会话写得动。入口关掉 node 的编译缓存（`NODE_DISABLE_COMPILE_CACHE=1`）：pnpm 启动时会打开它，默认放在共用的 `/tmp/node-compile-cache` 下，会话能先把别的身份那一格造好、往里放东西。
- 升 pnpm：`package.json` 的 `packageManager` 和 `france.sh` 顶部的 `PNPM_VERSION`、`PNPM_INTEGRITY`（`npm view pnpm@<版本> dist.integrity`）一起改；漏改一处 `deploy/test/session-pnpm.test.sh` 就红，法国上 `france.sh` 也拒装。
- 读回：装着的文件和装的时候一样；再从在跑的引擎进程里读出它给会话的那条 PATH（`/proc/<引擎主进程>/environ` 里只取 `PATH`、`FLEET_CLI_BIN`），照引擎起会话的路子（fleet 经 sudo 调 `fleet-agent-scope`，PATH 走 `FLEET_SESSION_PATH`）以会话用户跑一次 `pnpm --version`：找不到、先找到的不是 `/usr/local/bin/pnpm`、版本不对都判红；引擎没在跑读不到那条 PATH，记待配。

node 的编译缓存目录（查 #164 时发现：会话能借它以 fleet、pilot、root 的身份跑代码）：

- 为什么：pnpm、tsc 这些命令行一起来就开 node 的编译缓存，默认放在 `/tmp/node-compile-cache/<node 版本>-<架构>-<V8 标记>-<uid>/`；node 建这个子目录用的是 mkdir -p，已经在就照用，不查归谁。/tmp 谁都能写，会话用户只要赶在别人前面建出这个目录，就能替 fleet（发布时装依赖）、pilot、root 的 uid 预先建好子目录、放进编译缓存，对方的 node 照读。
- `france.sh` 在第一次以 fleet 跑 node 之前，把这个目录建成 root:root 755（`deploy/lib/node-cache.sh`）；已经在但归别人、权限松、里面有别人的东西、是链接或文件的，整个删了重建。开机时 /tmp 清空，由 `/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf` 在任何会话之前先建好。建好后，非 root 的 node 建不了自己的子目录，就不用编译缓存（只慢一点、不报错）；root 自己的子目录别人换不掉。读回：目录归 root、755、里面只有 root 的东西，开机配置在、内容对，不然判红。
- 撤掉：删 `/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf`，`france.sh` 里去掉 `setup_node_cache` 和读回里的 `readback_node_cache`；目录留着不碍事，下次开机 /tmp 清空时就没了。

会话用户登录 reclaude（要创始人做，一次；`fleet-agent-carpool` 已登录，2026-09-26；挂哪个组织见下面「会话用户挂的组织」）：

reclaude 按用户记设备：组织写在家里的 `~/.reclaude/device.json`，对这个用户的所有会话一起生效，请求按设备签名。一个账户最多挂 4 台设备、一个家目录算一台，所以法国只登录这一个用户（pilot 不登录，见下面）；不拷别的用户的 `~/.reclaude`（同一设备号从两个家目录跑会互相打架）。

1. 准备（装机这边做）：`france.sh` 给会话用户装 reclaude 二进制到 `/home/fleet-agent-carpool/.local/bin/reclaude`（只在没有时装，版本和 sha256 钉在脚本顶部，以这个用户自己的身份写，之后它自己 `reclaude update`）；读回里它缺了判红——引擎起 Claude 会话用的就是这一份。不拷别的用户的 `~/.reclaude`。
2. 创始人以 root 登法国跑：`sudo -iu fleet-agent-carpool reclaude login`。终端里会打印一行「Open this URL in your browser to authorize this CLI session」和一个链接：在浏览器里打开，用 reclaude 账号登录，授权这个命令行会话；授权完终端自己往下走。**设备名额 4 台已满**（2026-10-04 是 mac、本机、本机 WSL、法国正好四台；本机 WSL 已于 2026-10-06 撤掉，决定 0022，现在占三台）：再加机器、或被撤后重新登录（会多注册一台），都要先去 reclaude 网页「设备」页撤掉一台旧的，不然登录会因为名额满了失败；撤哪台要和创始人确认（#194 方案 4.7）。
3. 选拼车组织：`sudo /usr/local/sbin/fleet-agent-scope org-use carpool --user fleet-agent-carpool`（帮手以会话用户读 `org list`、认出拼车（team）那个切过去、回读核对，标准输出最后一行 `switched carpool` 或 `already carpool` 是成；编号不用人抄）。之后拼车用满切独享、恢复切回由引擎管（下面「会话用户挂的组织」）。人要手动切也用这条（`carpool` 换成 `solo` 是独享），挑手上没有在跑的会话时切：一切号这个家目录下在跑的会话全断；切完不用告诉引擎，它下一次读（最多 30 秒）就发现组织变了、又没有它自己的切号记录——推一条 `session-org:drift`（带前后两次读数），连着 2 分钟读到的都一样才照新的来（这 2 分钟里 Claude 的活等着、不挂起）；切过去又切回来的，回来马上照常（下面「会话用户挂的组织」）。拼车没用满时手动切到独享，下一轮路由探针引擎会切回拼车；整池暂停着的池（驾驶舱设置页「整池暂停」的开关，或旧的 `pool-hold:<池>` 提醒还开着，例如 09-27 起的 `pool-hold:claude-solo`）别手动切过去；开关要撤，在设置页「整池暂停」撤（要写原因），探针探通撤不掉它。
4. 重跑 `deploy/france.sh`：读回里「reclaude 还没登录」消失。

会话用户挂的组织（2026-09-27 起引擎现读，原先写死挂拼车；拼车用满切独享、恢复切回也由引擎管，#157）：

- 引擎怎么读：选路、路由探针、切号、每小时对账每次用之前（读成了的留 30 秒，读失败的不留），经同一个读法、按同一个起点判（#335），以会话用户的身份经 `fleet-agent-scope run` 跑它家里那份 reclaude 的 `org list`（和会话同一份，`engine.env` 的 `FLEET_CLAUDE_BIN`）：带 `*` 的那行是现在挂的，类型那一列 team 是拼车、personal 是独享（`packages/engine/src/real/session-org.ts`；解析和判法跟额度读取器、帮手的 `org-use` 同一个：带 `*` 的要恰好一行、类型要认得出）。编号、名字、邮箱不往外带，不用配文件。两个 Claude 池只派、只探挂着的那个，会话的额度就记在那个池上；另一个池引擎打算切过去的（和切号同一个判法），活等切号、不挂起，不打算切的派不出、写明引擎为什么不切。
- 读数变了、引擎没切过号（人手动切了、reclaude 自己换了挂的组织；09-27 21:53–21:55 帅位的切号实验就是这样，#335）：和上一次认下来的不一样、中间又没有引擎的切号，引擎不照新的来——选路回「这会儿定不下来」、过 30 秒再选（任务不挂起）；路由探针这一轮不探两个 Claude 池、结论照旧（这一轮在「定时任务」页记 partial，写着为什么）；切号这一轮不判。同时推一条 `session-org:drift`（下面「要人看的」），操作记录记 `session-org.drift`（前后两次读数）。读数回到原来的马上照常；连着 2 分钟都是新的才认它（之后要不要切回由下一轮路由探针的切号照常判），两种都自己撤提醒、记 `session-org.settle`。引擎经帮手自己切的号不算：切完读成的第一次就是新的起点。
- 慢的时候：平时一次 0.3 秒；reclaude 更新后首跑先打「Syncing config…」、要上百秒。一次读最多等 150 秒；选路只等 15 秒，没读完就过 30 秒再选（不算认不出，任务不挂起），读在后台接着跑完、下一次直接用上。
- 认不出怎么办：读不到（没跑成、登录失效、封号）、一个组织都认不出、没有带 `*` 的行、带 `*` 的不止一行、类型认不出，一律当「会话用户挂的组织认不出」：两个 Claude 池都不派、不探（探针记没探成、写明原因，调度台看得到；派工理由、挂起原因里也写着），别的渠道照派，不拿拼车顶。原因里不带编号、邮箱。
- 核对：人切了号不用告诉引擎，也不用重启。过 2 分钟认下新组织以后的下一轮路由探针（15 分钟内，或照下面「路由探针」手动跑一轮）之后，调度台上挂着的那个池的 Claude 路由探通在线，另一个写「会话用户现在挂的是拼车（独享）组织」（引擎那一轮要是切回了拼车，就反过来）；两个都写「会话用户挂的组织认不出（…）」就照括号里的原因修。库里 `routes.probe_org` 记着每条 Claude 路由的结论是在哪个组织挂着时下的：独享那条写着「不探」、`probe_org` 是拼车，就是那一轮挂着拼车没探它，不是它坏了。
- 引擎怎么切（#157、#194，判法见 design 第九节「拼车用完，切独享接着干」末尾「#194 之后的切号」）：三个触发共用一个判法、一把单飞锁——拼车会话被拒当场交证据、定时任务 `carpool-watch`（每分钟起一条，自己定这一分钟真不真读 reclaude 开放接口：平时 5 分钟、紧时 1 分钟、读失败 1 → 2 → 5 分钟退避）、路由探针每一轮探之前（兜底）。账本（恢复条件、切回记录、最近几次接口读数）落在库里 `session_org_state`，重启接着用。挂着拼车、拼车「用不了」（本人额度用满 E1 / 整辆车被用光 E2 / 拼车组织本身用不了 E3）就切独享，被拒当场切、不等探针；前提是逐个账号查过状态（可用 ≥ 2、独享那边至少 1 个明确可用，见下面 `session-org:channel`）；挂着独享，恢复只认「被拒之后的真新读数」，过了最小停留、白切退避、切回预算，手上有会话先给宽限（10 分钟，开跑不到 5 分钟的当场停，宽限里新活不往独享派）再切回。先让选路停下（这时选路回「会话用户挂的组织这会儿定不下来」、30 秒后再选），等 15 秒，再把挂着的那个组织的池上在跑的 Claude 会话停下、等它们收场（下一条），经帮手 `sudo -n /usr/local/sbin/fleet-agent-scope org-use <carpool|solo> --user fleet-agent-carpool` 切。切完当场探切过去的那个池（路由探针那一轮切的由那一轮核对），它的 Claude 路由探通了才算切成。帮手切号连着失败按 2 → 10 → 30 分钟退避，不每分钟砸一次。
- 人叫停：驾驶舱「设置」页「引擎暂不用独享」（设置键 `engine.soloPaused`，值 true/false，没设过是关）。开着时拼车用不了也不自动切独享，Claude 的活等拼车恢复或交给别家模型；已经挂着独享的不受影响，拼车恢复照常切回；改它进操作记录（`setting.update`）。库里这一项的值不是 true/false（被人直接改库）：引擎按「暂停」办并在日志里报错，不当成关。
- 各渠道额度留量线（#194 方案 4.8）：驾驶舱「设置」页「各渠道的额度留量线」（设置键 `engine.quotaReserve`，`{账号池编号: {窗口: 比例|null}}`）。线只存在库里：起始值在仓里 `packages/db/quota-reserve.default.json`（独享池 5 小时窗 0.8、周窗 0.7），发布时 `load_routing` 那一步（`packages/db/src/bin/routing.ts`）顺带只补缺装进库，库里已有的一个字不动；种子读不到、认不出（负数、大于 1、非数字）、池编号库里没有，整批不装、发布那一步红。已用到线：选路不再往这个池派新活、不切过去；这个池没写线＝不限。库里没有这一行或值认不出：引擎对所有池不派、不切，推 `session-org:reserve`「要人看」——补法是在设置页填好保存（或重跑发布装载器），好了自己撤。
- 驾驶舱额度页顶上一栏（`GET /api/pools` 的 `orgSwitch`，读 `session_org_state`）：「挂着独享；拼车本人 5 小时额度用满，预计 HH:MM 恢复（来源：接口 / 被拒原文）」、切回宽限中、渠道不可用 / 只剩 1 个账号 / 读不到账号状态、连着白切、最近一次读接口没成；账本在库里却认不出写红字（引擎也因此不切号，见 `session-org:ledger`），没接上（内存版）写「看不到」，不写成「没事」。
- 切号那一刻手上的活（#59）：在跑的那一段交回「切号」（runs 里这一次的结局是 `org_switch`、原因「切号：会话用户从…切到…，先停下，切完接着干（会话被停下）」；失败分流 OS1：马上接着干、不算重试），切完选路照常选到切过去的那个池，动手那一段在原分支、同一棵工作树上重跑（提示词里写着上一次为什么停），验收那一段过 30 秒重验（PR 上的状态是 pending，不是 failure）。还在建树、在等内存的那一段不再起会话，同样交回 `org_switch`。最多等它们收场 2 分钟（`journalctl -u fleet-engine | grep 会话用户切号` 看得到），等不齐这一轮不切、写一条 `session-org:switch` 提醒，下一轮再试。被拒（额度用满）的那个不干等到清零：回去选路等这条路由，切了号就选到切过去的池接着干（选路按清零时刻最多隔 2 分钟再看，#194 起；原来 10 分钟）。操作记录：`session-org.switch` 的切后那一栏写着停了哪几个会话（`stopped`，三段的是 runs 的编号）；三段重跑的看 runs（停下的那一行 `org_switch`，重跑是新的一行），Fusion 的会话续上一个记一条 `session-org.resume`。
- 帮手的 `org-use`：以会话用户（setpriv 降权、环境清空）跑它家里的 reclaude，读 `org list`，要切到的那一类（team 拼车、personal 独享）的组织要恰好一个、带 `*` 的要恰好一行；已经挂着就不动；切完再读一遍核对（`org use` 退出码不是 0 也可能已经切了），没切成、核对不了都切回原来那个（只认正面证据：切完读不回来也当没切成）、再读一遍照实说现在挂的是哪个。标准输出最后一行：`switched <类型>`、`already <类型>` 是成；`failed <现在挂的类型：carpool、solo、other、unknown>` 是没成，原因在标准错误（reclaude 的原话里三位以上的数、邮箱抹掉）。退出码 0 成、64 参数不对、1 没成。时限：一次 reclaude 最多 150 秒（首跑同步配置要上百秒），整个流程总时限 270 秒，每一步只给剩下的时间；切之前给切完的核对留 60 秒，不够就不切（报还挂着原来的）；时间用完照实报 `failed unknown`。引擎等帮手最多 300 秒，比总时限长，不会切到一半把它掐掉。
- 操作记录（驾驶舱「操作记录」页，引擎做的）：`session-org.switch`（切前切后、为什么切；没成的写帮手的原话和现在挂的是哪个）、`session-org.verify`（切完这一轮切过去的池探通了几条；没探通的写每条路由的探针原因）。`journalctl -u fleet-engine | grep 会话用户切号` 看每一轮判的是什么（不切、等、切、卡住）和为什么。
- 要人看的（「要人看」提醒，飞书、驾驶舱都推；开着的时候健康检查 `session_org` 项红，好了引擎自己撤、跟着回绿）：
  - `session-org:switch` 切号没成：看提醒里帮手的原话。下一轮探针还会再判、再试；急的话照上面第 3 步那条帮手命令手动试一次，看它的标准错误。之后切成了、或者不用切了（额度变了、人切好了），引擎撤掉。
  - `session-org:verify` 切过去了、探针读回那个池不在线：看调度台上那个池的 Claude 路由写的探针原因（登录失效、设备被撤销之类照「整池暂停」那套修）；之后哪一轮挂着的那个池探通了，引擎撤掉。
  - `session-org:drift` 会话用户挂的组织变了、引擎没切过号：正文是前后两次读数（北京时间几点、谁读的——选路、路由探针、切号、每小时对账——读到哪个）。先查是不是有人手动切了：`journalctl _COMM=sudo | grep org-use`；是人切的、也该这么挂，等 2 分钟引擎会认它（提醒自己撤）；不是人切的（reclaude 自己换了），照第 3 步那条帮手命令切回该挂的那个。读数回到原来的、认了新的、引擎切了号，引擎都自己撤。
  - `session-org:stuck` 切号卡住了：（1）没有记着的恢复条件（人手动切到独享的）、拼车用满却读不到几点恢复；（2）切回拼车后马上又被拒（白切）连着 3 次；（3）5 小时里已经自动切回 3 次、预算用完。引擎都不再自己切回、不猜：人看拼车到底能不能用（reclaude 网页看拼车额度），能用就用第 3 步那条命令切回；（1）里读数之后带上了清零时刻、（2）（3）里等一阵后条件变了，引擎会自己撤。
  - `session-org:channel` 渠道状态不对（创始人 2026-10-04 约 22:30 的规矩）：账号清单是接口里实际有几个组织就几个，逐个看状态。标题「渠道不可用」= 可用账号 0 个：引擎不切号、选路不往 Claude 池派（派工理由里写「渠道不可用」）；「只剩 1 个可用账号，而且不是现在挂着的…」= 当前挂的账号不可用、唯一可用的在另一边，引擎按「可用 1 个不切」不自动切，要人决定（被封的去 reclaude 网页看账号状态、换号或手动 `org-use`）；「读不到 Claude 账号的状态」= 接口连着 15 分钟读不到账号状态，不当可用也不当不可用、不切号，先查 `carpool-api` 那条提醒。账号恢复（解封、续期、整池暂停处理好、接口读到了）后引擎自己恢复、自己撤，操作记录写 `session-org.channel`。
  - `session-org:overdue` 拼车恢复了（或过了预计恢复时刻 30 分钟）还挂在独享上：正文写卡在哪一步（最小停留、白切退避、读不到接口、预算用完……），条件没了自己撤。
  - `session-org:ledger` 切号账本在库里却认不出（版本不对、字段缺）：引擎不切号、不当成空账本继续（那样白切记账、切回预算全丢）；看 `session_org_state` 那一行，认不出的原因在提醒里，修好（或确认丢了可以重来就删这一行：删后引擎当作从没切过号）后自己撤。
  - `carpool-api` 拼车额度接口（切号用的 `GET /api/v1/carpool/quota`、`/api/v1/orgs`）读不到：Key 失效、回包认不出当场报，网断、5xx、限流连着 2 次才报；读不到不当「拼车能用」也不当「恢复了」，挂着拼车照用、靠被拒兜底，挂着独享不据此切回；读成了自己撤。定时任务页「拼车额度盯读（切号用）」每分钟一轮。

会话用户的 cursor-agent（#212 接上了 cursor-agent；装由 `france.sh` 做，API 密钥要创始人放，一次；Cursor 的路由接真流量之前）：

cursor-agent 装在会话用户自己家里（官方安装脚本：一个版本一个目录，在 `~/.local/share/cursor-agent/versions/<版本>/`）。引擎每次起 cursor 会话（探针也一样），命令分两段、都以会话用户的身份跑（`packages/engine/src/real/hosts.ts` 的 `cursorLaunchCommand`）：先读它家里的 API 密钥、放进环境（下面「会话用户的 Cursor 密钥」），再在 `FLEET_CURSOR_VERSIONS_DIR`（engine.env，默认 `/home/{user}/.local/share/cursor-agent/versions`）下按 `current` → 最新版本目录现找（升级会删掉旧版本目录，所以不钉版本）、exec 成 cursor-agent；一个能跑的都没有就退出 127、报「没装 cursor-agent」，失败分流按执行方式配置不对（CF1）认，这条路由记一次失败。插头固定带 `--trust`（只信任工作目录、不放开命令，探针也带）：不带的话，没信任过的目录里 `-p` 只在 stderr 打一段「⚠ Workspace Trust Required」就退出，撞上了失败分流按 CF1 认（插头把那一句从整段提示里捞出来）。

1. 装（`france.sh` 做，`deploy/lib/cursor-agent.sh`）：以会话用户的身份照引擎的找法（`current` → 最新能跑的版本目录）一个都找不到时，以他自己的身份把官方安装脚本 `https://cursor.com/install` 整个下下来再跑（不以 root 装，不 `curl | bash`），装完再核一遍；找得到就不动（不重装、不升级，之后它自己升级）。安装脚本和包都不核校验和：官方没给，它只以会话用户的身份跑（理由写在 `deploy/lib/cursor-agent.sh` 开头）。读回以会话用户的身份照同一个找法跑 `cursor-agent --version`：没装、跑不成、卡住、输出认不出都判红。手动装（等不及重跑 `france.sh` 时）：`sudo -iu fleet-agent-carpool bash -c 't=$(mktemp) && curl -fsSL https://cursor.com/install -o "$t" && bash "$t"; rm -f "$t"'`。
2. 放 API 密钥：见下面「会话用户的 Cursor 密钥」。不用浏览器登录（`cursor-agent login`）：在这台上批准了也存不下。
3. 查：`bash deploy/france.sh --check` 的读回里有「Cursor 密钥放好了」；Cursor 认不认这一把由路由探针判：调度台哪个阶段挂上 Cursor 的路由、开着，下一轮探针（15 分钟内）就探它，探通就在线，不想等就手动跑一轮（下面「路由探针」那条命令）。别拿 `cursor-agent status` 查：不带密钥跑它，它照样说没登录。

会话用户的 Cursor 密钥（创始人 2026-09-27 拍：Cursor 改用 API 密钥）：

- 为什么不用浏览器登录：没有桌面的 Linux 服务器上，cursor-agent 把登录凭据交给系统钥匙串（libsecret），服务器上没有 Secret Service，批准了也落不了盘，`cursor-agent status` 照样说没登录（2026-09-27 法国实测；原因见 https://dev.to/milkyway008/why-your-cli-says-youre-not-logged-in-on-a-headless-linux-server-j1o ）。Cursor 给自动化场景的办法是 `CURSOR_API_KEY`（https://cursor.com/docs/cli/reference/authentication 、https://cursor.com/docs/cli/headless ）。
- 放在哪：`/home/fleet-agent-carpool/.cursor/fleet-api-key`，属会话用户、600、只有一行密钥、不带换行。位置不做成配置：引擎（`hosts.ts` 的 `DEFAULT_CURSOR_API_KEY_FILE`）、装机脚本的读回和放密钥的命令（`deploy/lib/cursor-key.sh` 的 `CURSOR_API_KEY_FILE`）认同一处，`packages/engine/test/real/hosts.test.ts` 核对两边一样。
- 引擎怎么用：起 cursor 会话、探针时，由会话用户自己读这个文件（引擎进不去它的家，帮手脚本也只放 `FLEET_*` 这几样变量），核过（不是符号链接、是普通文件、非空、属它自己、600、只有一行、末尾最多一个换行、没有空白和控制字符）才 `export CURSOR_API_KEY`、往下起 cursor-agent。值只在 cursor-agent 的环境里：不上命令行（sudo 会记日志、`/proc` 里谁都看得到）、不进引擎日志、进度、失败信息和库。
- 失败分流：文件没放好，起它的那段 sh 不往下起，报「Cursor 密钥没放好：<哪里不对>。文件是 …」、退出 78，按 AU6 整池暂停，「要人拍」的提醒里写着哪里不对；Cursor 不认这一把（无效、被撤、过期，原话「⚠ Warning: The provided API key is invalid.」），按 AU5「Cursor 登录失效」整池暂停，提醒写着去后台重新生成、照这里放进法国。两种都不算路由的账；放好后在驾驶舱点「继续」，下一轮探针探通也会自动撤掉整池暂停。
- 生成：Cursor 后台 → API Keys（https://cursor.com/dashboard/api ）新建一把 User API Key，名字写上用在哪（比如「法国引擎」），好认、好撤。复制它，别贴进任何对话、单子、提交。
- 放（在创始人电脑上，Git Bash；值只经过剪贴板和 ssh，不上屏幕）：

  ```
  # 刚在 Cursor 后台复制了密钥（macOS 把 cat /dev/clipboard 换成 pbpaste）
  cat /dev/clipboard | ssh <法国> 'bash /srv/fleet-dao/deploy/cursor-key.sh put'
  ```

  那头（`deploy/cursor-key.sh`，判据和做法在 `deploy/lib/cursor-key.sh`）以会话用户自己的身份先核（非空、只有一行、没有空白和控制字符；末尾那一个换行或 Windows 的回车换行去掉，多出来的空行不收），再在同一个目录里落临时名、改 600、换上；收到空的、不像一把密钥的说「没换」，原来那份原样留着。放完读回一行「放好了：…属 fleet-agent-carpool、600、N 字节（值没读…）」。在终端里直接敲不收（会显示在屏幕上）。
- 查（只看在不在、是不是真文件、属主、权限、大小，不读值）：`ssh <法国> 'bash /srv/fleet-dao/deploy/cursor-key.sh check'`；`france.sh --check` 的读回是同一段（还没放记待配，放了不对判红）。Cursor 认不认看路由探针。
- 换（定期换，或者怀疑漏了）：后台新建一把 → 照上面放进来（直接盖掉旧的）→ 等下一轮探针探通（或手动跑一轮）→ 后台撤掉旧的那把。别先撤后放：中间那段 Cursor 的活全停。
- 撤（不用 Cursor 了，或者漏了）：先在后台撤掉那一把（立刻失效；这之后起的 Cursor 会话、探针按 AU5 整池暂停），再 `ssh <法国> 'bash /srv/fleet-dao/deploy/cursor-key.sh remove'` 删掉文件（以会话用户的身份删），读回变成待配。
- 已知口子：密钥在 cursor-agent 的环境里，会话里跑的命令多半也继承得到（cursor-agent 起命令时滤不滤掉它没核实）；会话用户本来也读得到这个文件。和 reclaude 的登录态一样：会话用户的东西，会话都拿得到。AI 会话要是把它打进了过程记录，照上面「换」。
- 自测：`packages/engine/test/real/hosts.test.ts`（起法的前一段真跑：不在、空的、是目录每台都跑；权限、属主、符号链接、内容不对、放好了只在 Linux 上跑）；`route-probe.test.ts`、`sessions.test.ts` 最后那组（真插头、真起法、经假帮手真起进程，拿一个假值跑一遍，库、引擎日志、帮手收到的参数和环境、cursor-agent 收到的参数里都搜不到它；只在 Linux 上跑）；`deploy/test/cursor-key.test.sh`（放、查、撤的判据和输出里搜不到值，要 root）。

会话用户的 grok（#266 接上 SuperGrok 订阅的 Grok Build 命令行：碰界面的单的开 PR 前验证、副手用它的 Grok 4.7，创始人 2026-09-27 拍；装由 `france.sh` 做，登录要创始人做，一次；`fleet-agent-carpool` 已装 1.0.41、已登录，2026-09-27）：

grok 装在会话用户自己家里：官方安装脚本把二进制放在 `~/.grok/downloads/grok-linux-<架构>`，`~/.grok/bin/grok` 链过去。引擎每次起 grok 会话（探针也一样），以会话用户的身份先看 `FLEET_GROK_BIN`（engine.env，默认 `/home/{user}/.grok/bin/grok`）是不是能跑的文件，是就 exec 成它（`packages/engine/src/real/hosts.ts` 的 `grokLaunchCommand`）；不是就退出 127、报「没装 grok 命令行」，失败分流按执行方式配置不对（CF1）认，这条路由记一次失败。提示词经 `--prompt-file /dev/stdin` 走标准输入，插头在前面垫一个 `cat` 给它一根真管道：直接给 Node 的 socketpair，grok 读 `/dev/stdin` 报「No such device or address (os error 6)」（2026-09-27 法国实测；也按 CF1 认，不是没登录）。所以手动跑 `grok status`、`grok whoami` 这类要读标准输入的命令时，没有终端、没有管道也会报这一句，别认成没登录。

1. 装（`france.sh` 做，`deploy/lib/grok.sh`）：`~/.grok/bin/grok` 不是能跑的文件时，以会话用户自己的身份把官方安装脚本 `https://x.ai/cli/install.sh` 整个下下来再跑（不以 root 装，不 `curl | bash`），装完再核一遍；在就不动（不重装、不升级）。跑安装脚本时 PATH 里只有系统目录、SHELL 给 `/bin/sh`：不然它会往他家的 `~/.local/bin` 里链 `grok` 和 `agent`（`agent` 这个名字 cursor-agent 的安装脚本也在用，会被盖掉），SHELL 是 bash、zsh、fish 还会改它们的启动文件（SHELL 空着也不行：安装脚本是 bash 跑的，bash 会自己照 passwd 填上登录 shell）。安装脚本和二进制都不核校验和：官方没给（安装脚本只核下下来的能跑），它只以会话用户的身份跑（理由写在 `deploy/lib/grok.sh` 开头）。读回以会话用户的身份照引擎的判法跑 `grok --version`：没装、跑不成、卡住、输出认不出都判红。手动装：`sudo -iu fleet-agent-carpool env PATH=/usr/local/bin:/usr/bin:/bin SHELL=/bin/sh bash -c 't=$(mktemp) && curl -fsSL https://x.ai/cli/install.sh -o "$t" && bash "$t"; rm -f "$t"'`。
2. 升级：会话里关了更新检查（插头给 `GROK_DISABLE_AUTOUPDATER=1`，免得会话半路换二进制），所以它不自己升级。要升级：`sudo -iu fleet-agent-carpool /home/fleet-agent-carpool/.grok/bin/grok update`，升完 `bash deploy/france.sh --check` 看读回的版本，再等下一轮探针（或手动跑一轮）看 Grok 的路由还在线。
3. 登录（要创始人做，一次）：`sudo -iu fleet-agent-carpool /home/fleet-agent-carpool/.grok/bin/grok login --device-code`，终端里打出一个链接和一串码：在任意设备的浏览器里打开链接、用 SuperGrok 的账号登录、确认那串码，终端自己往下走。登录态写在 `~/.grok/auth.json`（grok 自己写成 600），是普通文件，没有桌面也存得下、重启还在（不像 Cursor 要系统钥匙串，见上面），grok 自己续期（服务端没给期限的按 30 天算，随装文档 `~/.grok/docs/user-guide/02-authentication.md`），续不上了再登录一次。不用 `XAI_API_KEY`：那是 console.x.ai 的接口钥匙，扣接口的账，不走 SuperGrok 订阅。
4. 查：`bash deploy/france.sh --check` 的读回里有「grok 登录态在：…属 fleet-agent-carpool、600、N 字节（内容没读）」；grok 认不认由路由探针判：调度台哪个阶段挂上 Grok 的路由、开着，下一轮探针就探它（探通了隔 2 小时才再真探，下面「路由探针」），不想等就手动跑一轮。
5. 失败分流：没登录（「Not signed in. … grok login --device-code」）、登录过期续不上（「Token expired. Run `grok login` …」「Your session has expired. Run `grok login` …」这类），按 AU7「Grok 登录失效」整池暂停，「要人拍」的提醒写着在哪台机器以谁跑 `grok login --device-code`；不算路由的账；登录好了在驾驶舱点「继续」，下一轮探针探通也会自动撤掉整池暂停。点的型号它不认（「Couldn't set model … unknown model id」）按 MD1 换模型、报警。
6. 已知口子：登录态在会话用户家里，会话里跑的命令读得到它（和 reclaude 的登录态、Cursor 的密钥一样：会话用户的东西，会话都拿得到）。漏了就以会话用户跑 `grok logout` 再照第 3 步重新登录。grok 的会话记录存在会话用户家里的 `~/.grok/sessions`，续会话时本地找不到还会去它的服务端取（`-r` 一个本地没有的号时它打「restoring conversation from remote」，2026-09-27 法国实测），会话内容在它服务端也有一份。
7. 自测：`packages/engine/test/real/hosts.test.ts`（起法真跑：在、不在、不能跑、是目录；Linux 上真插头接真起法，提示词经真管道到 grok）；`route-probe.test.ts`、`sessions.test.ts` 的 grok 那组（没登录、登录过期、没装、型号不认、回话的不是点名那一代、stdin 不是真管道各造一次，失败样本 X91–X98）；`deploy/test/grok.test.sh`（装、查和登录态读回的判据，要 root）。

额度读取的配置（读哪些池、各池凭据文件在哪，只有池名和路径、不是密钥）写在仓里 `deploy/quota.json`（#1289），随发布的那一版带着：引擎的 `quota-read` 每 15 分钟读自己所在那一版的这份（`packages/adapters/src/quota/config.ts` 的默认路径，`FLEET_QUOTA_CONFIG` 只给命令行和测试换位置），读不到、认不出当场报 `quota-read:config`。不再有手放的 `/etc/fleet-dao/quota.json`（已删这一层）。池要读，得写在这份里：五个池（claude-solo、claude-carpool、mirasim-relay、cursor、grok）都要写上，池 id 要和目录配置里的账号池对上（`packages/db/test/catalog.test.ts` 钉着，多一个或少一个不是写明的例外就红）。目录里的 jev 不配在 `pools` 里，写在 `notRead`：新系统没有旧系统的日账（会话用户家里没有 `~/.dao/judge-spend`），花费记在库里的 `jev_answers`，每天花多少由 `packages/jev` 的 `dailyUsdCap` 自己停；配上那个目录每轮都报 `no_usage_source`。凭据在会话用户家里的，路径写 `/home/fleet-agent-carpool/` 下的绝对路径；密钥本身（Key 文件 `reclaude-api.key`、各家 auth.json）仍手放、不进仓，哪个缺了该池如实报 `no_credentials`（读不到），不会因此少读池。改配置走 PR，随下一次发版生效。额度读取里的 Cursor、Grok 两个池（#1195，#1129 第一步）：两家的登录文件都在会话用户家里（Grok 的 `~/.grok/` 下 auth.json、Cursor 的 `~/.config/cursor/` 下 auth.json），引擎用户进不去。`deploy/quota.json` 里这两种读取器（`cursor-dashboard`、`grok-billing`）读文件时，经 `fleet-agent-scope run` 以会话用户的身份 `cat`（`packages/engine/src/real/index.ts` 的 `catAsUser`、`quotaAsUser`），配置里的 `~` 展开到会话用户的家；值不上命令行、不进日志和提醒；读不到（文件不在 ENOENT、没权限 EACCES）如实报「读不到」、当场提醒，不当成 0 或 ok；一个池读不到不影响另一个。拼车的 Key 文件（引擎自己读得到）不经这条路。写法见 `deploy/quota.json` 里 `cursor`、`grok` 两条。独享组织的 reclaude（`claude-usage`，二进制在会话用户家里）也经同一条 `quotaAsUser`：`fleet-agent-scope run` 以会话用户起，工作目录是它家里的空目录 `~/.cache/fleet-dao/quota-cwd`；引擎用户直接 spawn 是 EACCES。起不来报明确原因（`spawnError`），不写成空读数。已知还欠：法国 Cursor 走 API 密钥文件（`~/.cursor/fleet-api-key`），额度读取器读的是 Cursor 的 auth.json（要有 `accessToken`），两者不是一个文件，法国上有没有那个 auth.json、Dashboard 认不认 API 密钥都没核实，要等法国真机验收；没有 auth.json 时 Cursor 池如实报「读不到」。Mirasim 池（`mirasim-relay`，#1284）：令牌在会话用户家里、回环口又只许会话用户连，引擎用户读令牌、直连都是 EACCES / 连不上；读取器改经桥接（`mirasimDepsFor` 的 `connect`，和账本、路由探针同一条路）以会话用户的身份连，端口、令牌文件由 `discoverMirasimEndpoint` 现找，配置里的 `port`、`tokenFile` 在这条路上不用。**池得写进 `deploy/quota.json` 才会读**：2026-10-06 16:34 起法国那份手放的配置只剩 `claude-carpool`、`jev` 两个池（`pools.last_read_ok_at` 里 `claude-solo`、`cursor`、`grok`、`mirasim-relay` 全空），这四个池没人读、旧提醒也不撤（#1284）；#1289 把配置搬进仓里、删了手放那一层，发版后当时这六个池每轮都读；后来 jev 从这份配置拿掉（没有日账，见上），剩下五个池每轮都读，读成了的 `quota-read:<池>` 自己撤，凭据缺的那个池如实报 `no_credentials`。写在 `notRead` 里的池（现在是 jev）读取器不读、每小时对账不查读数过期；已经开着的 `quota-read:jev`、`reconcile:quota:jev` 下一轮自己撤，不再报 `no_usage_source`。

会话用户的 Mirasim（#345 接上引擎、只开 DeepSeek Flash 一条路由，创始人 2026-09-27 拍「mirasim 额度不太够，先只用 DeepSeek 4.1 flash，接肯定还是要接」；本地模式常驻单元 #424 接上，france.sh 会装）：

和 grok、cursor-agent 不一样：Mirasim 没有能自动跑的无头安装脚本，服务端本体不是装机脚本装的——官方给的路是它自己的桌面端以 ssh 远程模式连上服务器现装、现登录，或者指挥官／创始人在本机用 `mirasim ssh connect` 命令行现装（两条路装出来是同一份东西，见下面第 1 步）。这一步装出来的只是「远程模式」：只听 unix socket、ssh 一断就退出，靠不住——要另外让它常驻在「本地模式」（第 2 步），这才是装机脚本管的那一层。引擎经它派 DeepSeek Flash 的活（`packages/adapters/src/mirasim/`，协议与坑见 `docs/reference/adapters.md` 第八节 MS-01…28），选路、失败分流、记账和别家执行方式同一套（`packages/engine/src/real/hosts.ts` 的 `mirasimDriver`）。

1. 装服务端本体（指挥官或创始人做，一次；这条本身是「怎么装」的说明，不是装机脚本的一步）：
   1. 先给会话用户开一条能连的 ssh 口子（root 做，写法照 pilot 那条；装完留着，以后升级、换账号还要连，创始人 2026-09-29 拍）：`sudo -iu <会话用户> sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < <连接方的公钥>.pub`。只许放创始人登录 pilot 的那几把：`france.sh` 读回照 `/home/pilot/.ssh/authorized_keys` 核对，多一把别人的、`~/.ssh` 里放了私钥或配置、权限不是 700/600、认不出都判红（`deploy/lib/session-user.sh` 的 `check_session_ssh`）
   2. 装：桌面端新建一条 ssh 远程连接，目标 `<会话用户>@<法国的地址>`；或者在本机命令行 `MIRASIM_SERVER_DL_ROOT=https://cdn-assets.mirasim.ai/mirasim/releases mirasim ssh connect <会话用户>@<法国的地址>`。连上那一下会在它家里自己装起服务端（`~/.mirasim-remote/servers/<版本>/`，`current` 链到在用的那版；数据在 `~/.mirasim/`；服务端要的 `curl`、`tar`、`gzip`、`sha256sum`、`AllowStreamLocalForwarding` 法国上都已具备）。
   3. 这一下装出来的是「远程模式」：只听 unix socket（`~/.mirasim-remote/run/server.sock`），带 `stdinShutdown`——连接一断（ssh 断了、命令行退出）它就跟着退出，引擎靠不住，不算「已经装好常驻服务」，只是把服务端本体和账号放到位。
   4. 创始人在桌面端（登录着要给这份服务用的那个账号）连一次这台主机：这一下把中转账号推进 `~/.mirasim/setting.json`（常驻服务读的是同一份状态目录，账号跟着生效，不用给常驻那份另外登录一次）。
2. 常驻（第 3 步 france.sh 自己装，本节剩下写的都是这份）：`setup_mirasim_session`（`deploy/lib/mirasim.sh` 的 `mirasim_server_installed`）先看服务端本体在不在——`~/.mirasim-remote/current/server.cjs` 不在，记待配、这轮不装单元（第 1 步还没做）；在了就渲染、装 `/etc/systemd/system/fleet-mirasim-session.service`（模板在 `deploy/france/fleet-mirasim-session.service`）、`enable`、起来。这个单元把同一份服务端本体加 `--port <固定端口> --host 127.0.0.1 --no-open --no-im --workdir <会话用户家>` 起成「本地模式」：绑回环端口，令牌写在 `~/.mirasim/run/local-<端口>.token`——和远程模式不同，这才是引擎认的那份持久令牌，常驻服务不停，这份令牌就一直在。端口钉在 `deploy/france.sh` 的 `MIRASIM_SESSION_PORT`（避开旧系统仍留着共用的 4316、旧系统另外两个还可能没清干净的 4315/4317，见 `docs/reference/deploy.md` §1.2）；引擎自己认端口靠现读令牌文件名（`discoverMirasimEndpoint`），不认这个常量，钉死只是让单元本身可预测、好排障。单元还给经它起的 grok 设 `GROK_FOLDER_TRUST=0`、`GROK_ASK_USER_QUESTION=0`：`grok agent stdio` 不收 `--trust` 这类旗标，不设的话新工作树不加载 AGENTS.md、会弹「信不信这个目录」，模型还会反问没人答的选择题，`--always-approve` 管不到这两样（和引擎直接起 grok 的 `GROK_UNATTENDED_ENV` 同一对）。单元还设 `MIRASIM_NO_AGENT_EGRESS=1`、`MIRASIM_ACCOUNT_USAGE_PROBE=0`（#1274）：不设时 Mirasim 出网（中转签票、续期、设备验证）会读会话用户 `~/.claude/settings.json` 里 reclaude 写的 `HTTPS_PROXY`，法国 2026-10-01 18:01 重启后 reclaude 守护没再起、settings 里还留着旧的临时端口，journal 里就是每分钟一条 `relay-ticket: mint error (connect ECONNREFUSED 127.0.0.1:<旧端口>)`，随后 `issuer token is past its own exp`，路由探针报「设备验证没能完成」；设了才直连 `relay.mirasim.ai`。这两项不许当「多余」去掉（`docs/reference/deploy.md` P39、`quota.md` Q21）；改了单元要 `systemctl restart fleet-mirasim-session` 才生效（发版装单元时 `ensure_unit_running` 会重启）。
   - 桌面端把服务端升级到新版本后，`current` 链接会换指向，但常驻进程不会自己感知、不会自动重启——升级后要 `systemctl restart fleet-mirasim-session` 才会真的换上新版本。
   - 读回（`deploy/lib/mirasim.sh` 的 `check_mirasim_session_unit`，`france.sh --check`；判据见 `deploy/test/mirasim-session.test.sh`）：服务端本体不在，待配（不算坏，第 1 步没做）；本体在但单元没在跑、或 `/api/health` 连不上／不回 `ok:true`，判红；本体在、单元活着、`/api/health` 回 `ok:true`，判绿。
   - 单元文件也由发版后自动跑的 `france.sh --auto-tier` 装（不用人以 root 重跑整套，#1274）：本体不在记待配（退出码 2，自动发布当装上了，不报警）；本体在，单元文件内容变了才 `daemon-reload` + 重启（重启会让正在跑的 Mirasim 会话断开一次），没变不动。读回（`check_mirasim_session_unit_file`）核对装着的文件带 `MIRASIM_NO_AGENT_EGRESS=1`、`MIRASIM_ACCOUNT_USAGE_PROBE=0`，且和仓里模板渲染出来的一样，缺了或不一样判红；判据见 `deploy/test/mirasim-auto-tier.test.sh`。刚重启时 node 还没 listen，`/api/health` 读回遇到连接被拒会等最多约 15 秒再判。
   - **防火墙的口子（#345 后续，2026-09-28 修过）**：法国的防火墙（`deploy/france/fleet-dao.nft` 第二道隔离，见第五节「会话用户的口只许它自己连」）按套接字属主拦，回环上会话用户开的口只许它自己和 root 连——引擎（`fleet`）不在放行名单里，实测直连确实连不上：这个常驻单元装完、`/api/health` 读回判绿之后，引擎（`fleet` 进程自己直接拿 ws 连 `127.0.0.1:<端口>`）仍然连不上服务。修法见第 4 条「引擎怎么连」：连接不再由 `fleet` 进程直接发起，改经 `fleet-agent-scope` 起一个以会话用户身份跑的桥接进程转发。
3. 查令牌（`deploy/lib/mirasim.sh` 的 `check_mirasim`，`france.sh --check` 的读回；判据见 `deploy/test/mirasim.test.sh`）：认它家里 `~/.mirasim/run/` 下有没有恰好一份 `local-<端口>.token`（会话用户的家由 `FLEET_MIRASIM_HOME` 定，engine.env，默认 `/home/{user}`；端口不钉，引擎每次连都现找，`packages/engine/src/real/index.ts` 的 `discoverMirasimEndpoint`），不读令牌内容、不管服务进程在不在跑（那是路由探针的事，下面「路由探针」）。目录不在或一份都没有：待配，不判红（还没装，不是坏了）；不止一份：判红（认不出该用哪份，只该有一份 Mirasim 服务，可能是重装了一次没清掉旧的常驻单元或旧的远程模式实例留下的令牌，不自动删）；目录真读不了（属主、权限不对）另判红，和「还没装」分开，不能把两者互相认错。
4. 引擎怎么连（#345 后续，2026-09-28 断链修过一次：上面第 2 步「已知口子」发现的、法国防火墙只放行会话用户和 root 连回环口——引擎自己的进程 `fleet` 连不上，这条路由派得出去但连不上服务；旧写法是直连 ws，已经改成下面这条）：Mirasim 是常驻服务、协议是 ws 控制连接（不是起个子进程），令牌文件、账本都在会话用户家里，引擎自己（`fleet` 用户）进不去它 750 的家、也连不上它的回环口。账本（`lsAsUser`、`catAsUser`）照旧经 `fleet-agent-scope`（sudo）代读——这个不受防火墙影响，只是文件权限；连接（拼 `ws://127.0.0.1:<端口>/ws?token=<令牌>`、收发帧）换成经 `fleet-agent-scope` 起一个短命的桥接进程，以会话用户的身份跑（`packages/adapters/src/mirasim/bridge.ts`，装在会话用户读得到的发布检出里，只用 node 自带模块——不保证 node_modules 在），桥接自己读令牌、自己连 ws（都是它自己家里的东西，权限对得上），帧经它的 stdin/stdout 按行 JSON 转给引擎（`packages/adapters/src/mirasim/bridge-connect.ts`）。引擎这边只负责先经 `lsAsUser` 找到端口和令牌文件的路径（`discoverMirasimEndpoint`），再把这两样当参数交给桥接，自己不碰令牌内容、不直连端口（`packages/engine/src/real/index.ts` 的 `mirasimDepsFor`）。桥接脚本的路径默认和引擎同一份检出（`FLEET_MIRASIM_BRIDGE`，engine.env，不用另外配置；见 `DEFAULT_MIRASIM_BRIDGE_SCRIPT`）。
5. 现在开着哪些、挂着哪些（额度紧，创始人 2026-09-27 拍先只开 DeepSeek；2026-10-06 加上 GLM flash，经 Mirasim 的 `zcode` 执行体；2026-10-07 夜按服务端 0.0.425 的执行体表补挂了 codex 的 gpt 几档和 zcode 的 glm-5.3；2026-10-08 起目录配置改成仓里的 `deploy/catalog.json`，又按各渠道的真实模型表补了 dsh 的 `deepseek-v4-pro`、grok 的 `grok-4.7-fast`、`grok-4.6`、claude-code 的 `haiku-4.5`）：路由的开关（`enabled`）在路由骨架 `packages/db/routing.default.json` 里，不在目录配置里。骨架里现在只有 `mirasim-relay:deepseek-flash:mirasim`、`mirasim-relay:glm-5.3-flash:mirasim` 的 `enabled` 是 `true`，`opus-5.5`、`sonnet-5.5`、`gpt-5.6-luna`、`kimi-k3` 四条关着。目录配置（`deploy/catalog.json`）的 `mirasim-relay` 池下另外挂着 `gpt-6-sol`、`gpt-6-luna`、`gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`glm-5.3`、`deepseek-v4-pro` 几条，骨架里也都有，`enabled` 都是 `false`、不进任何用途的顺序（先「可选」，不改现有派活；要开 `gpt-6-sol` 做验收，另开 PR 或在驾驶舱改）。`glm-5.3` 和现有的 `glm-5.3-flash` 要名册帧上的 `zcode` 写进路由的 `executor` 才派得出去：上游串前缀对不上，没写下之前选路标「执行体未知」、不派（#1357）。2026-10-07 路由探针报法国 Mirasim 服务端执行体表里没有 `zcode`（有：claude、codex、dsh、kimi、grok、pi），所以现在探不通、派不出去，等服务端有 `zcode`、名册读到再开 `glm-5.3`。服务端还认 `gemini`、`antigravity`、`qwen` 三个执行体的模型，但法国会话用户下找不到这几个本体（2026-10-08 查的），起不来，所以没挂路由；装上本体、名册帧带上执行体之后再加。`deepseek-flash` 就是 deepseek v4 flash（服务端把 `deepseek-v4-flash` 别名到它），不另挂。目录配置跟着版本走：改 `deploy/catalog.json`、合进主线、发版，新行就装进库（只补缺，已装过的行改不了，要改走第九节「目录配置」）。特别提醒：组织默认的模型顺序里 Opus 本来就有一条经 Mirasim 走的选项（`claude-opus-5-5`、`claude-sonnet-5-5` 按前缀 `claude-` 认成 claude 执行体），接上这条执行方式不会让 Opus 的活跑到 Mirasim 的额度上——挡的不是「引擎认不认得这个模型」，是路由本身关着（选路第 1 步先过滤「路由在线」，关着的路由连候选都进不去，design 第九节）。
6. 失败分流：连不上令牌文件、连不上 ws（服务没装、没起）按执行方式配置不对（CF1）认；选路时认不出执行体（`执行体未知`：名册帧上没有 agent，上游串前缀也对不上 `claude-`、`gpt-`、`grok-`、`kimi-`、`deepseek-`）不派、也不起会话，不落到默认执行体；`kimi-` 前缀判成 kimi，名册帧上的 agent 是 `pi` 时才走 pi。起了会话之后服务端仍不认这个模型，也按 CF1；走中继却查不到账本里一次 2xx 的上游调用（MS-27）判 `relayUnknown`；判法和别家一样经 `packages/adapters/src/judge.ts`，不是 Mirasim 单独一套。协议本身没有「登录过期」这个概念——不像 grok/cursor-agent 是本机命令行、登录态是本机一个文件，Mirasim 的账号状态在服务进程里，服务连得上就代表着已经登录（第 1 步第 4 条推账号的时候顺带登的）。
7. 已知口子：令牌文件、账本都在会话用户家里；引擎代读不代表会话读不到——会话用户本来就是自己家目录的属主，存心翻还是翻得到（和 reclaude 登录态、Cursor 密钥、grok 登录态一样，会话用户的东西会话都拿得到）。防火墙那条见第 2 步和第 4 条「引擎怎么连」，已经修过。
8. 自测：`packages/engine/test/real/hosts.test.ts`（模型 → Mirasim 执行体按名册字段或上游串前缀；驱动本身：新建/续会话、只有 `route:'cloud'`、连接和账本目录的接线、成功/各种失败路径的报告字段，假的连接和账本，不要 root）；`route-probe.test.ts`（Mirasim 的路由和干活的会话走同一个驱动探、判法同一套）；`packages/adapters/test/mirasim-bridge.test.ts`（桥接连接器怎么认 ready / 报错 / 退出 / 超时，配可摆布的假桥接进程；真跑 `bridge.ts` 经假帮手连假 ws 服务端，验令牌读不到 / 是空的 / 服务不在这几条故意造出的失败，不要 root）；`deploy/test/mirasim.test.sh`（令牌那层的读回判据：目录不在待配、目录在没令牌待配、恰好一份判绿且令牌内容不读、不止一份判红、目录真读不了判红且和「不在」分开、这个系统用户不存在判红；要 root）；`deploy/test/mirasim-session.test.sh`（常驻单元那层：单元渲染出来的样子钉住、服务端本体不在待配且 ERR 陷阱安全、本体在单元没起判红、`/api/health` 连不上判红、真起一个假服务端验证判绿这条走得通；要 root、systemd、node）。

路由探针（#129，design 第九节「路由探针」）：

- 引擎每 15 分钟（每小时 7、22、37、52 分）以会话用户在 `/var/lib/fleet-work/_route-probe/<会话用户>` 起一次最小的会话（Claude 的路由起 reclaude，Cursor 的起 cursor-agent，Grok 的起 grok，Mirasim 的路由（现在只有 deepseek-flash）经 Mirasim 起会话，模型照路由上写的）、问一句「只回 OK」，结论写进 `routes` 的 `alive`、`probe_state`、`probed_at`、`probe_detail`。Cursor、Grok、Mirasim 的路由探通了隔 2 小时才再真探（一次扣的是订阅或额度里的用量：Cursor 按月的包含用量、Grok 是 SuperGrok 的额度都和创始人自己用的是同一份，Mirasim 探通即代表真打了一次上游、扣的是那份紧张的中转额度，#345），中间那几轮结论照旧；没通的每轮都探。派工只派在线的路由：一上线（换机器、库清空也一样）第一轮探完之前，引擎一条活都派不出去。定时器在引擎进程里（#1072，不再是 Temporal 的 Schedule）：引擎重启后自己恢复，起来时若最近一格（探针是每小时 7、22、37、52 分）之后还没起过一轮就当场补一轮；没有「手动触发一轮」的命令，发布完最多等到下一格。
- 看结论：驾驶舱调度台顶上「路由在线状态」；库里 `runuser -u fleet -- psql -d fleet -c "select id, alive, probe_state, probed_at, probe_detail from routes order by id"`；每一轮的结局在驾驶舱「定时任务」页（库里 `schedule_runs`、`job = 'route-probe'`）。
- 离线了看 `probe_detail`：登录失效、设备被撤销的，照原因里写的修（Claude 的是上面 reclaude 那节第 2 步重新登录；Cursor 的是换一把密钥或把密钥文件放好，上面「会话用户的 Cursor 密钥」；Grok 的是上面「会话用户的 grok」第 3 步重新登录；Mirasim 的是上面「会话用户的 Mirasim」——多半是服务端本体没装（照第 1 步装一次）或常驻单元没起（`systemctl status fleet-mirasim-session`，照第 2 步的读回看差什么）），下一轮探通就回在线，那条「整池暂停」自动撤掉。按量计费、插头没接、会话用户挂着别的组织的是按规矩不探，不是坏了。
- 派工理由末尾出现「在线是探针 N 前的结论，之后它没再给新结论（探针可能停了）」：探针连着三轮（45 分钟；Cursor、Grok、Mirasim 的路由是 2 小时 30 分，它们探通了隔 2 小时才再探）没给这条路由写新结论，引擎照上一次的结论接着派（不停工）。看驾驶舱「定时任务」页路由探针那一行（没跑、没跑成还是只写进去一部分，`why` 写了原因），再手动跑一轮（上面那条命令）看它报什么。
- Claude 的探针不存会话记录（`--no-session-persistence`），会话用户家里不攒它的记录；cursor-agent、grok 没有这个开关，探针的会话留在会话用户家里的 `~/.cursor/chats`、`~/.grok/sessions` 下（一条路由一天约 12 个）。Grok 的探针不带 `--always-approve`：要权限的工具一律被拒（无头模式没人批就取消），什么命令都跑不了。目录由引擎经 `fleet-agent-scope adopt` 建，归会话用户、700。

每小时对账（工作树残留、两处核对、提醒按条件撤和再推、GitHub 两个机器人的权限自检；design 第十四节「AI 会话」的目录那条、15.3、第六节「断链怎么被发现」第 4 条）：

- 引擎每小时 41 分跑一轮（定时任务 `hourly-reconcile`）。定时器在引擎进程里（#1072），引擎重启后自己恢复，起来时错过了最近一格就当场补一轮；没有「手动触发」的命令，最多等到下一个 41 分。
- 工作树：`/var/lib/fleet-work/<owner>_<name>/` 下每一棵（子任务的树 `<需求号>-<子任务>`、检出副本 `<需求号>.<阶段>[.<子任务>]`），这张需求的工作流和它的子任务工作流都不在跑了、树里也没有没结束的会话（`session_runs` 里 `ended_at` 为空的），才算残留；有没结束的会话却没有在跑的工作流，记「没查成」写明是哪个会话（多半是被强行终止的工作流留下的，#247）。残留的以会话用户的身份看里面还剩什么：什么都不剩就经 `fleet-agent-scope remove` 删掉，子任务报的「工作树没收掉」跟着撤；能重新生成的编译和工具缓存（`*.tsbuildinfo`、`node_modules/`、`dist/`、`.turbo/`、`.vite/`、`coverage/`）和 `.fleet-out/`（会话交给引擎的结论文件）不算剩着，是不是 git 仓都一样，只剩这些的照空树删（名单在 `packages/engine/src/real/user-git.ts` 的 `DISPOSABLE`）；还剩没推的提交、没提交的改动、stash、名单以外的文件的不删，报一条「要人拍」（`worktree:<owner>_<name>/<树>`），正文写着哪棵树、剩什么（文件列前 10 个、写明一共几个）、怎么删、怎么留。检出副本里引擎检出过的提交也不算剩着。树里有目录读不了的记「没查成」、不删。`_route-probe/`、`_tmp/` 不碰。一轮最多看 80 棵，多的下一轮再看。
- 收到「要人拍」的树：先看里面，`sudo -u fleet-agent-carpool git -C <路径> status`、`sudo -u fleet-agent-carpool git -C <路径> log --oneline -5`；提醒里写着「这一层不是 git 仓」的，看 `sudo -u fleet-agent-carpool find <路径> ! -type d`。要删：以 root 跑 `/usr/local/sbin/fleet-agent-scope remove <路径>`，下一轮看它不在了就撤掉那条；要留：驾驶舱点「处理」，之后这棵树不再提醒，里面的东西推走或清掉以后下一轮会自己删。
- 提醒：条件没了的撤掉（正文开头「已撤：为什么」，处理人 `engine:hourly-reconcile`，操作记录 `notification.resolve`）；卡住报警超过 24 小时没人处理，每天最多再推一条「还没处理：<原标题>」（`remind:<原提醒编号>:<北京日期>`），同一条再开一张未排期的缺陷单（每次最多 2 张、每个仓每天最多 4 张，单号写回正文开头「已立案：#号」；同一键一张，关了隔 7 天才再开）。自己会撤的不开；`reconcile:*` 条件没了由对账撤掉，还开着的立案。哪种提醒谁撤，清单在 `packages/engine/src/jobs/alert-sweep.ts` 开头。例外（#1420）：键以 `reconcile:pr:`、`reconcile:ledger:` 开头、对应 PR 已合并超过 7 天的，不立案，也不再每天重推（沿用静默：驾驶舱留原来那一条，不发飞书卡）。说的是已经发生、改不了的历史事实。合并未满 7 天的仍立案；合并时刻读不到的不跳过，记没查成。`canary:broken` 自己会撤，不立案。
- 两处核对（怎么判见 design 第六节「断链怎么被发现」第 4 条）：`reconcile:workflow:<任务>`「开着的单没有着落」——看正文写的卡在哪：在做的单工作流断了，要人判是在驾驶舱重开还是叫停；排队的单补拉没成，照正文的原因处理（门口没收：作者不在白名单、外人改了单子；读不了挂在哪个版本；拉起来了又不在跑……），好了下一轮自己撤。`reconcile:ledger:<仓>#<号>`「合了的 PR 记账不全」——正文写着哪张单缺什么（会话没结局、跑成了的会话用量记成 0、单没记成做完），不自动补，补齐了下一轮自己撤。`reconcile:pr:<仓>#<号>`「机器人开的 PR 没经合并队列合」——合并人不是「引擎」、或账上没有合并队列的合并记录（#431 那种绕过合并队列手动合掉的）：合并前那几道核对（不落后主线、CI 全绿、人闸）可能没走，对账照回执把这一次落进幂等账（receipt.mergedBy 写实际合并人）；提醒不自动撤。超过 24 小时还没人处理的，对账给它立案（#1406）；已合并超过 7 天的 reconcile:pr、reconcile:ledger 不立案、也不再每天重推（#1420）。条件已经没了的（workflow、ledger 那种）在立案前就撤掉，不会立案。（2026-09-28 #445 以「仓里没开合并队列」为由删过，#440 又办回来：队列其实开着。）`reconcile:quota:<池>`「账号池额度读数过期」——渠道开着、有路由、没过期的池，库里最近读成超过 30 分钟（或从没读成、上游数冻住）：先看「定时任务」页 `quota-read` 那一行有没有在跑、`why` 写的这个池为什么没读成，再看有没有同池的 `quota-read:<池>` 提醒；读新了下一轮自己撤。
  - 这两处报了什么：`runuser -u fleet -- psql -d fleet -c "select updated_at, dedupe_key, left(title, 60) from notifications where resolved_at is null and dedupe_key like 'reconcile:%' order by updated_at desc"`
- 机器人权限：每个受管的仓（`repos` 表）上，「干活的」「引擎」两个机器人的安装实际拿到的权限和 `packages/github/src/github.ts` 的 `REQUIRED_PERMISSIONS` 比，缺的、「干活的」多了 `issues:write`、没查成的（没装到这个仓、凭据读不到）各报一条「要人看」（`github-app:<机器人>:<仓>`，正文写缺什么、去哪改），健康页「GitHub 机器人权限」一项（`github_app`）跟着红；在 GitHub 的 App 设置里改好、再到装它的地方（Settings → Applications → Installed GitHub Apps → Configure）点接受新权限，下一轮自己撤、跟着回绿。没查成的这一轮记没查全。
- 飞书群机器人：`engine.env` 的 `FLEET_FEISHU_WEBHOOK`（人手放，不进期望配置；没配、地址不认、推不出去都记进这一轮的没查成，不当成推过，失败重试 3 次）。整池暂停到了复查日期用它推一条。主线红也用它：主线 `ci.yml` 最近一次已结束的 push 运行变红推一条（提交号前 7 位、运行链接、失败的作业名，同一个提交只推一次），转绿推一句「已恢复」。生产挂不从这里推（法国自己可能也挂了，归 #292）。
- 出了事去哪看：驾驶舱「定时任务」页每小时对账那一行（没跑、没跑成、没查全，`why` 写了哪里没查成：读不了的目录、查不了的工作流、删不掉的树都在这里，不算跑成）。库里：
  - 最近几轮：`runuser -u fleet -- psql -d fleet -c "select started_at, outcome, scanned, found, why from schedule_runs where job = 'hourly-reconcile' order by id desc limit 5"`
  - 它撤了什么：`runuser -u fleet -- psql -d fleet -c "select resolved_at, dedupe_key, left(body, 80) from notifications where resolved_by = 'engine:hourly-reconcile' order by resolved_at desc limit 20"`
  - 等人拍的树、再推的提醒：`runuser -u fleet -- psql -d fleet -c "select created_at, dedupe_key, title from notifications where resolved_at is null and (dedupe_key like 'worktree:%' or dedupe_key like 'remind:%') order by created_at"`
  - 日志：`journalctl -u fleet-engine --since '-2h' | grep 每小时对账`
- 还没做的：被强行终止的工作流留下的会话要等引擎下一次起来才收（#247）。

全流程巡检（#223，design 第六节「断链怎么被发现」第 3 层）：

- 引擎每 6 小时（北京时间 2、8、14、20 点 26 分，定时任务 `canary`）在巡检仓开一张固定的小单（往 `巡检记录.md` 追加一行），看它跟着三段任务工作流（`taskWorkflow`，#632）走：收单（拉单建了任务行、起了任务工作流）、动手（会话交出提交、推上去、开了 PR）、开 PR 过 CI、验收（冷验收通过）、合并、关单、记账（`runs` 里动手、验收的账都有结局、记上了用量，每步耗时进了库）、驾驶舱显示（驾驶舱后端读到任务做完、PR 镜像里这个 PR 合了、挂的是这张单——主页「做完的」就是这么显示的）。每一步有期限（`packages/engine/src/jobs/canary.ts` 的 `CANARY_STAGE_LIMIT_MINUTES`；等并发空位、等额度的时间不算），一轮最长 5 小时。超时或出事（任务工作流停下等人、没做完、被放弃、单子被关成不做了）推一条卡住报警「全流程巡检断在「<哪一步>」」（`canary:broken`，正文写为什么、这一步走了多久、走到哪了（每一步几点走完、用了多久）、单子在哪），下一轮通过了自己撤。断的那张单留着给人看，下一轮开始时给它的任务工作流发「放弃」、关掉单（不做了）。
- 巡检单的需求写全在正文里（场景、原话、已知的模块、要什么，最后是写了字的「## 怎么算做完」——拉单要的三栏都在，测试拿真的 `buildTaskBrief` 核过），没有「文档：」那一行、也不在巡检仓里建需求文档。「已知的模块」只写 `巡检记录.md`，分档按它定成快档。开单时就挂上巡检仓的当前版本。
- 要配齐的（缺一样，这一轮就记没跑成或断在收单、开 PR 过 CI、合并，照写的原因补）：
  1. 引擎配置 `/etc/fleet-dao/engine.env` 写 `FLEET_CANARY_REPO=<owner>/<巡检仓>`：法国的巡检仓是 `thoerwink8/fleet-dao-canary`（2026-10-06 从 `-fr` 改回：本机 WSL 已撤、没有第二个引擎和它抢仓了，`-fr` 仓从来没建过），写在仓里的期望 `deploy/france/desired-config.json`（公开值，#777 起；之前是私有值、只记指纹），发布时照期望写上，换巡检仓照第九节「配置进仓对账」改公开值那条走；引擎下次起来读到；读回 `grep -c '^FLEET_CANARY_REPO=' /etc/fleet-dao/engine.env`。再接一台环境的引擎、要开巡检（#1136）：给它另建巡检仓，`FLEET_CANARY_REPO` 写在那一台自己的期望 `deploy/<环境>/desired-config.json`（公开的 owner/name），法国这一项保持 `thoerwink8/fleet-dao-canary`。两台写成同一个仓（不分大小写）、写成私有值、或认不出 owner/name，配置检查判红（`deploy/france/auto-release/config.mjs` 的 `canaryRepoProblems`，`deploy/test/config.test.mjs` 扫 `deploy/` 下每一份期望）。拉单只收自己写的那一个；别人期望里的巡检仓即使进了受管仓也不收。
  2. 巡检仓受管（在 `repos` 表里）、「让 AI 接活」开着：`fleet-api dispatch <owner>/<巡检仓> on`（第九节），读回 `... dispatch <owner>/<巡检仓> status`。**开关关着的时候巡检不开单、记「跳过」（#1050）**：项目的「让 AI 接活」关着时（新导入的默认关；发版前后保持原样，第九节），拉单不拉巡检单，开了单也只会断在收单、天天报警；所以一轮开头读到巡检仓开关关着，就记 `skipped`（`canary_runs.verdict`，`schedule_runs` 记 partial——看门狗当按期跑过、不报；健康页「全流程巡检」不红，写「跳过：…没开单、没验」；`pnpm drill` 打印「跳过」、退出码 2，不当通过），不开单、不推卡住报警，上一轮断了留下的那条报警也撤掉；前几轮留下的单照收。读不到开关、或撤不掉上一轮断了的报警，都记没跑成（不当正常跳过），不猜开着还是关着。开着以后下一轮照常跑、断了照常报。
  3. 巡检仓有一个一直开着的 `v1 巡检` 里程碑：巡检开单时挂它（版本进度和先后看得见巡检单）。别关它。
  4. 开巡检单的「引擎」机器人在作者白名单里：`users` 表一行 `role = 'bot'`、`github_id` 是这个 App 的机器人账号编号（只按编号认）。不在，拉单不拉，这一轮到期限断在收单。
  5. 巡检仓的 PR 上有 CI 检查（跑 `node --test`）：一项检查都没有，任务工作流等 CI 等不到结果、停下等人，这一轮断在开 PR 过 CI。仓的设置里打开 Allow auto-merge：验收通过后任务工作流挂的是自动合并。
- 收前几轮留下的单（每轮开单前）：放弃它的任务工作流、关单，再把它开过的、还开着的 PR（引擎分支 `fleet/<单号>-t…`，不是 fork 的）一起关掉，已合并、已关的不动（#336，`real/canary.ts` 的 `closeLeftoverPulls`）。单关了但 PR 关不掉：推一条单独的卡住报警 `canary:leftover-pr`（写哪张单、什么原因），这张单不记「收过了」、下一轮接着关，一轮里所有留下的单都收干净了才自己撤；它和断了的 `canary:broken` 是两条，互不撤。
- 手动跑一轮、等结论、打印每一步用时：在跑着引擎的机器上 `pnpm drill`（发布目录里，或 `node packages/engine/src/bin/drill.ts`；只连本机 Temporal，`TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE`、`FLEET_TASK_QUEUE` 默认和引擎一样），起法和引擎的定时器是同一个（`packages/engine/src/jobs/canary-start.ts`，固定编号 `canary` 的工作流）、同一份代码：已经有一轮在跑就接上它，不另起。打印每一步几点走完（北京时间）、用了多久，断了写停在哪一步、为什么；退出码 0 通过、1 断了、2 巡检自己没跑成或这条命令没查成（连不上 Temporal、起不了工作流、工作流没给结论就失败了）。看结论：健康页「全流程巡检」一项（最近一轮的结论和时间；断了、没跑成、12 小时没通过一轮都红）；驾驶舱「定时任务」页 `canary` 一行（巡检自己跑没跑成）；库里 `runuser -u fleet -- psql -d fleet -c "select id, started_at, ended_at, verdict, stage, issue_number, left(why, 120) from canary_runs order by id desc limit 5"`；日志 `journalctl -u fleet-engine --since '-6h' | grep 全流程巡检`。
- 「没跑成」和「断了」分开：没配巡检仓、巡检仓读不到、没有当前版本、开不了单、连着 10 回查不成（库读不到、Temporal 问不了、任务工作流的状态认不出）、一轮的工作流没收尾就没了（被终止、工人丢了；下一轮开始时补记），都记没跑成（`schedule_runs` 里 `failed`，看门狗 #203 照登记表报）；断了的这一轮巡检本身跑成了（`schedule_runs` 记 ok、发现 1 个），报警由巡检推。
- 演练（故意弄断一次）：挑巡检仓里没有在做的巡检单时，先 `fleet-api dispatch <owner>/<巡检仓> on`，再让开单的「引擎」机器人不在作者白名单里（上面第 4 条检查项）、`pnpm drill`：开单后到期限断在「收单」（拉单不拉，期限 20 分钟），推一条卡住报警、退出码 1。把机器人放回白名单、再 `pnpm drill`：通过，那条报警自己撤。（以前用关开关来弄断，#1050 之后开关关着是「跳过」，不再断；也用过暂停拉单的 Temporal 定时任务，#1072 之后拉单是引擎进程里的定时器、没有暂停开关。）
- 换成三段任务工作流之前（跟 Fusion 走）的老几轮记的是老步骤（派活、规划、执行），库里照留，健康页照样写成人话；在途的老一轮从收单接着看。
- 定时：每 6 小时（引擎进程里的定时器起这条工作流，#1072）；没有「暂停」这个要人手恢复的状态，引擎重启后自己恢复；要停巡检就停引擎，或把巡检仓的「让 AI 接活」关掉（演练那条）。

看门狗（#203，design 第六节「断链怎么被发现」第 5 层）：

- 引擎每 5 分钟（每小时 4、9、14……分，定时任务 `watchdog`）按 `scheduled_jobs` 登记表逐个看定时任务（引擎的、备份的都算）新不新鲜，判法和驾驶舱「定时任务」页同一份（`@fleet-dao/db` 的 `scheduleHealth`）。要人知道的推一条卡住报警（提醒中心，飞书照现有的推送发），点进去是「定时任务」页：
  - 最近一次没跑成：「定时任务「<名字>」没跑成」，正文写原因和上次跑成的时刻。任务自己为这次没跑成报过的（键以 `<编号>:run` 开头，备份脚本就这么报），不再报第二条。
  - 过了期望间隔没跑成过：「……停了：超过 <期望间隔>没跑」（期望间隔里一次都没开跑）、「……超过 <期望间隔>没跑成」（还在跑，但一直没跑成，比如一直一个都没扫到）、「……从没跑过」「……从没跑成过」（从登记时算起过了期望间隔）。刚登记、还没轮到第一次的不报。
  - 一段一条（键 `watchdog:job:<任务>:after-<上次跑成那一行的编号>`，从没跑成过是 `no-success`）：同一段里人点了「处理」就不再打开；按期跑成了自己撤（正文开头「已撤：为什么」，处理人 `engine:watchdog`，操作记录 `notification.resolve`）；之后再出事是新的一张卡。超过 24 小时没人处理的，每小时对账照常再推。
  - 读不到登记表、跑记录：这一轮记没跑成（`schedule_runs` 里 `failed`、`why` 写原因），开着的报警一条都不撤；不另推「看门狗没查成」（#1072 删了：和下面后端看着看门狗的「看门狗没跑成」是同一件事）；下一轮读到了就照常。推、撤没写进去：这一轮记没跑成，下一轮照库里的样子重推。
- 看门狗自己停了、没跑成它自己报不了：后端（`fleet-api`）按登记表上 `watchdog` 那一行现算——健康页「看门狗」一项（第九节）；后端每 5 分钟看一次，过了 15 分钟没跑完一轮、最近一轮没跑成、没登记，推一条「看门狗停了 / 没跑成 / 没登记：定时任务没人盯着」（`watchdog-down:…`，一段一条，处理人 `api:watchdog`），看门狗又按期跑完一轮自己撤。引擎整个停了也是这一条报（后端照样在跑）。判法在 `packages/api/src/watchdog-health.ts`。
- 看（没有手动触发一轮的命令，每 5 分钟自己来）：驾驶舱「定时任务」页 `watchdog` 一行（看了几个、几个不对，没跑成的 `why`）；库里
  - 最近几轮：`runuser -u fleet -- psql -d fleet -c "select started_at, outcome, scanned, found, left(why, 120) from schedule_runs where job = 'watchdog' order by id desc limit 5"`
  - 开着的：`runuser -u fleet -- psql -d fleet -c "select created_at, dedupe_key, title from notifications where resolved_at is null and (dedupe_key like 'watchdog%') order by created_at"`
  - 日志：`journalctl -u fleet-engine --since '-1h' | grep 看门狗`、`journalctl -u fleet-api --since '-1h' | grep 看门狗`
- 定时器在引擎进程里（#1072），重启后自己恢复，没有要人手恢复的「暂停」；引擎停了超过 15 分钟后端就推「看门狗停了」，要停引擎得先说好。

### 外部看门狗

外部看门狗（#292，design 第六节第 5 层、design 第十三节）：Cloudflare 定时 Worker 每 5 分钟从外面查香港和法国，挂了推飞书。代码在 `packages/edge`，不跑在法国或香港上。这一片只把判法和 Worker 进仓，不部署。部署要创始人在 Cloudflare 上授权一次（免费、不绑卡）。

判法在 `packages/edge/src/judge.ts`。香港：公网驾驶舱首页回得来（任何 HTTP 状态码都算 nginx 活着），连不上算挂。法国：公网 `/healthz` 回 200，或回 503 但回得来（后端活着、某一项不好，交给健康页和引擎自己报），连不上、502、504 算挂，别的状态码也按挂报。香港连不上时只报香港，不连带报法国。同一次挂着每小时最多再推一次。恢复推「恢复了，挂了多久」。读不到上一轮状态照挂处理并且推一条，不静默。真域名、飞书 webhook、请求头 `x-fleet-watch` 的值只从 Worker 的 secret 读（`packages/edge/wrangler.toml` 里只有占位）。读不到密钥这一轮记没查成、写日志，不当成没挂。

每次探测带请求头 `x-fleet-watch`，值是 secret `FLEET_EDGE_WATCH_ID`（送出去之前去掉首尾空白）。法国 `fleet-api` 的 `/healthz` 见到这个头和 `/etc/fleet-dao/api.env` 里的 `FLEET_EDGE_WATCH_ID` 是同一串，就给 `external-watchdog` 记一轮成功（`packages/api/src/external-watch.ts`）。对不上、没带头：不记，响应跟平时一样。记不上（登记行还没有、库写失败）只写日志，不把 `/healthz` 打成 500，免得这一轮被判成法国挂了。

法国 `fleet-engine` 只在 `/etc/fleet-dao/engine.env` 里这个键非空时，才把 `external-watchdog` 登记进定时任务（期限 15 分钟，`packages/engine/src/jobs/external-watchdog.ts`，要不要登记在 `packages/engine/src/real/jobs.ts`）。两份环境文件要放同一串，放完重启 `fleet-engine` 和 `fleet-api`。只放引擎、不放后端：登记了却记不上一轮，超过 15 分钟引擎里的看门狗会报停。Worker 还没在 Cloudflare 上跑起来就先配：同样会按「登记了还没跑过」报停。这个键还不在 `deploy/france/desired-config.json` 里（部署那一片再收）。人手加进去之后，对账会报这两项多出来（第九节「配置进仓对账」）。先留着，别为了消报警把键删掉。

部署（在仓根，先 `npx wrangler login`，或设好 Cloudflare 的 API 令牌）：

1. 建 KV：`npx wrangler kv namespace create EDGE_STATE`。把返回的 id 换进 `packages/edge/wrangler.toml` 里的占位 `<kv-namespace-id>`。只换这个 id，别把域名和密钥写进这个文件。
2. 放密钥，都用 secret，不进仓。下面每条都在仓根执行，配置指到 `packages/edge/wrangler.toml`：
   - `npx wrangler secret put FLEET_EDGE_HK_URL --config packages/edge/wrangler.toml`，值是 `https://<驾驶舱域名>/`
   - `npx wrangler secret put FLEET_EDGE_FR_URL --config packages/edge/wrangler.toml`，值是 `https://<驾驶舱域名>/healthz`
   - `npx wrangler secret put FLEET_FEISHU_WEBHOOK --config packages/edge/wrangler.toml`，值是飞书群机器人的 webhook
   - `npx wrangler secret put FLEET_EDGE_WATCH_ID --config packages/edge/wrangler.toml`，值自己生成一串，不进仓
3. 部署命令：`npx wrangler deploy --config packages/edge/wrangler.toml`

换密钥：对要换的那一个重跑上面的 `npx wrangler secret put FLEET_FEISHU_WEBHOOK --config packages/edge/wrangler.toml`（另外三个键同样，把名字换成要换的那个）。不必重新部署，新值马上生效。`FLEET_EDGE_WATCH_ID` 换了，`engine.env` 和 `api.env` 里的同一个键要一起换成同一串，再重启 `fleet-engine` 和 `fleet-api`，否则对不上。

停用：

- 整个停掉：`npx wrangler delete --config packages/edge/wrangler.toml`（删掉这个 Worker，定时不再跑）。
- 只停定时、先留着 Worker：Cloudflare 控制台打开 Workers & Pages 里这个 Worker 的 Triggers，删掉那条 cron。用配置文件管的话，把 `packages/edge/wrangler.toml` 的 crons 改成空数组，再执行上面的部署命令。空数组会清掉已部署的 cron；配置里不写 triggers，原来的 cron 还在。
- 法国如果已经配了 `FLEET_EDGE_WATCH_ID`：从 `engine.env` 和 `api.env` 里删掉这个键，重启 `fleet-engine` 和 `fleet-api`。引擎那边没配或是空的，登记行会被摘掉（`packages/engine/src/real/jobs.ts`），避免「登记了还没跑过」误报。

拉单（#632，替掉 webhook 接活加认领；`packages/engine/src/jobs/intake.ts`、`real/intake.ts`）：
- 引擎每 5 分钟（每小时 3、8、13……分，定时任务 `intake`）自己到 GitHub 读该做的单，自己挑（创始人 2026-10-08「让ai自己挑挺好的」「按推荐」，#1336；规则全文见 design 第九节「开着的项目，引擎自己挑单」）：对每个「让 AI 接活」打开的项目（`repos.auto_dispatch_since` 不空，现在只当开关用），读开着的单，**准入**——作者在白名单里、不是母单子单、没贴「本机做」（「本机做」和「交给引擎」一起贴时以「本机做」为准，原因里写明）、还没派过、历史失败不超过 2 次、正文没写工作流路径、没有开着的 PR 挂着、交代齐（`readTaskBrief`；缺则留一次言）、规模不是最重档（「已知的模块」列了超过 50 个路径）；没贴「待补」「要人拍」（整理会话贴的，贴着一律不拉）；未排期的单、别的版本的单和其余单一样进候选，不看里程碑；开单早于「让 AI 接活」打开那一刻的老单要贴了「整理过」（临时指挥官的整理会话判为仍成立后贴）或「交给引擎」才进候选，开关之后新开的单不需要（#1338；#1342 发到法国后引擎第一轮拉了两张前提已过期的老单）。每个仓走完以后，有从没整理过的老单、或有空位却一条都没起且待办还有候选，就叫一次临时指挥官整理待办（下面「叫临时指挥官整理待办」）。过了准入的**排序**（版本先后列表序号 → 挂当前版本 → 规模小 → 同规模里贴了「交给引擎」的 → 失败少 → 开单早），再按空位从前往后**起**：同时在跑的任务工作流 ≤ 6、一轮最多 5 条、**每小时最多 20 条**（滚动一小时，数任务行建出时刻）、熔断没停拉；起之前才现读一遍这张单（开着、不是 PR、母单子单和「本机做」再核一遍）。起的建任务行、起任务工作流（编号 `task:<owner>/<name>#<号>`，`REJECT_DUPLICATE`：同一张单任何时候最多一条，做完、停下的不会自己重来，要人在驾驶舱点「继续」）。交代不全的在单子上留一条言写清缺什么（同一处缺法只留一次）。拉单本身不动单子。#282（驾驶舱「交给 fleet」按钮）被「交给引擎」取代（2026-10-08）：按钮不做，`fleet-api handover` 已删，没有这条命令。
- 开关全关是正常的空闲：这一轮记 ok、不读 GitHub。在跑的任务数、白名单、开着的单、最近一小时已起的条数、熔断状态任何一样读不到：这一轮记没跑成（`schedule_runs` 里 `failed` 或 `partial`，看门狗照登记表报），不拿 0 或「没有」顶。
- **熔断**（#1336）：最近 6 条结束的任务（`done`、`failed`；叫停不算）里失败 4 条以上，拉单整个停下，推一条报警（`intake-breaker`）；冷却 1 小时后只放 1 条试探，试探那条做成了才恢复（报警自己撤，另推一条恢复通知），失败了再冷却 1 小时。看：`select value, updated_at from settings where key = 'engine.intakeBreaker'`（`{"state":"open"|"closed","at":…}`；`open` 的 `at` 是进入或最近一次试探失败的时刻，`closed` 的 `at` 是恢复时刻，只数这之后结束的任务）。要人手恢复：把这一行改成 `{"state":"closed","at":"<现在的 ISO 时间>"}`（不要直接删：删了以后窗口会重数旧的失败，马上又触发），再把 `intake-breaker` 报警标成已处理。
- 看：`select * from schedule_runs where job = 'intake' order by id desc limit 5`、`journalctl -u fleet-engine --since '-1h' | grep 拉单`。
- 停：把项目的「让 AI 接活」关掉（不再有 Temporal 的暂停可手动切：定时器在引擎进程里，引擎重启后自己恢复）。引擎整个停了超过 15 分钟看门狗会报「拉单停了」，要停引擎得先说好。
- **打开「让 AI 接活」之前**：合并闸认冷验收（#625）和冷验收真活动（S2-5b）都已合进主线，`jobs/intake.ts` 的 `MERGE_GATE_REQUIRES_COLD_VERIFY` 已是 true（有测试钉着；改回 false 时，开着开关的仓会让这一轮记没跑成：`schedule_runs` 里 `failed`、看门狗报、一张单都不拉）。但还没真跑过：先过演练仓三连跑（#452，S2-7），再由创始人在驾驶舱逐个项目打开。别的仓要先装上合并闸（一键补齐，#133），引擎任务流程的 PR 才有这道拦。

冷验收（合并之前那一遍，`packages/engine/src/real/task-verify.ts`；工作流停在「验收做不出来」时看这里）：
- 看：PR 页面的 `cold-verify` 检查——`pending` 是在跑或在等（description 写在等什么），`success` 通过，`failure` 是没过或没验成（description 第一句分得开：「验收没过」是模型挑出了问题，「没验成」是读不到、没有别家模型、会话没跑成）。会话的账在 `runs` 表（`segment = 'verify'`，记到这张单名下）。
- 工作流停下等人写的原因：diff 太大（超过 24 万字符）、某个文本文件 GitHub 没给 diff、没有别家的路由（写过这张单的族都跳过了）、作者族认不出（路由的族不在 gpt / claude / deepseek / grok / kimi 里，比如 cursor）、会话没跑成（原因码和执行体的原话在第一句里：额度、模型对不上、中转对不上账）、结论写了 fail 却没有一条算挡的问题。修好之后在驾驶舱点「继续」重验；不验了点「放弃」。
- 过一会儿就行的（没空位、内存放不下、额度要等、引擎在停机）工作流自己睡一会儿再来，不停下、不报人。
- **验不了、又确认要合**（已知缺口）：合并闸只认引擎机器人贴的 `cold-verify`，人没有地方点「放行」。办法：仓管理员绕过必过检查合并，并在单子上留一句为什么；或者关掉这个 PR，把分支改个不是 `fleet/<单号>-t<8 位>` 的名字重开成人手的 PR。

退役的定时任务（断链修复：#445 删掉「提醒派单」整层撞上——代码删了，Temporal 上当初建的 Schedule 不会跟着消失，法国的 `alert-dispatch` 当时只能帅位手动 `fleet-temporal schedule toggle --pause` 止血，见 `specs/445-提醒减负/结果.md`；这里补上「引擎起来自己删」这一步。#1072 把 8 个定时任务摘出 Temporal、改成引擎进程里的定时器，它们在 Temporal 上的老 Schedule 也走这一条删）：

- 名单唯一的出处是 `packages/engine/src/jobs/retired-schedules.ts` 的 `RETIRED_SCHEDULES`（每条 `{ id, retiredBy, moved? }`，`retiredBy` 写哪个 PR 把这个定时任务的代码删掉的；`moved: true` 是任务还在、只是改由进程内定时器跑，那 8 条就是）。两处认它，不各写一份：看门狗（`packages/engine/src/real/watchdog.ts`）把退役的（不含 `moved` 的）从「新不新鲜」的判断里剔除；引擎起来、进程内定时器起之前，先按这份名单把 Temporal 上还在的 Schedule 删掉（`packages/engine/src/jobs/retired-schedules.ts` 的 `deleteRetiredSchedules` 算结局，真装配在 `packages/engine/src/real/retire-schedules.ts` 的 `retireEngineSchedules`，接线在 `worker.ts`）。
- 退役一个定时任务：把它的代码删掉时，在 `RETIRED_SCHEDULES` 里加一条（`retiredBy` 写这个 PR 号），不用再手动去法国暂停或删 Schedule——下一次引擎起来（发新版本、重启）自动删。`moved` 的那 8 条等法国和本机的引擎都起过一次新版本、Temporal 上删干净之后，可以从名单里去掉。
- 定时任务现在怎么跑（#1072）：引擎进程里的定时器（`packages/engine/src/jobs/timers.ts`、登记在 `jobs/engine-timers.ts`），格子和原来的 Schedule 一样（每 N 分钟、错开 M 分钟，从 epoch 算起）；上一轮没完就跳过这一轮；引擎起来时，最近一格的钟点在补跑窗口里（一格，巡检一小时）、且那之后没起过一轮才补一轮，再久就等下一格；一轮超过 15 分钟还没回只记一条 error 日志（`journalctl -u fleet-engine` 里搜「还没回」），不放开「不叠着跑」——它回来之前下一格都跳过，看门狗照登记表报，要人看看卡在哪（卡死了重启引擎）；一轮失败不停定时。**单实例假设**：法国只有一个引擎进程（一个 systemd 单元，发布是先停旧的再起新的），「不叠着跑」只在进程内保证；将来要起第二个引擎进程时，每一轮开头要先抢一把 Postgres 咨询锁（`pg_try_advisory_lock`），抢不到就跳过这一轮——现在不做。没有「暂停/恢复定时任务」这回事了：发版后不用再手动恢复。
- 三种结局：Temporal 上还在——删掉，`journalctl -u fleet-engine` 记一行「退役的定时任务已删：<id>」，之前报过的「删不掉」提醒自动撤；本来就不在——什么都不做（不记日志、不碰库，这是常态）；删的时候出了别的错（连不上、没权限）——不当成删掉了，记一行 error 日志，进 `notifications`（`retired-schedule:<id>`，daily 级，日报能看到，不是要当场拍的事），正文带着原始错误；好了下一次自动撤。
- 手动查：库里 `runuser -u fleet -- psql -d fleet -c "select dedupe_key, title, resolved_at from notifications where dedupe_key like 'retired-schedule:%' order by created_at desc"`；手动删（不想等下一次重启）：`fleet-temporal schedule delete --schedule-id <id>`。

会话用户的口只许它自己连（#35，2026-09-27 堵上；为什么这么挡、比过哪几种做法见 `specs/35-代理口鉴权/方案.md`）：

- 为什么：会话用户的 reclaude 守护在 `127.0.0.1` 上开两个临时端口（一个 HTTP CONNECT 代理，会话的 `HTTPS_PROXY` 指它；一个 MITM TLS 口），端口号每次重启会变。代理不认客户端是谁，`HTTPS_PROXY` 里也没有令牌；回环对本机所有用户都通，堵上之前 `pilot`、`fleet` 连上去就被转发，等于借用会话用户的订阅额度（2026-09-25 审查官发现，2026-09-27 法国复核还开着）。守护不一定跑在会话的 scope 里（那天跑在 root 登录会话的 scope 里），所以不按 cgroup 认，按 uid 认。
- 怎么挡：`deploy/france/fleet-dao.nft` 第二道隔离，和挡 Temporal、库的规则同一张表 `inet fleet_dao`、同一个 `fleet-firewall.service`。端口每次变、按目的端口写不死，所以看应答的一方：root、会话用户以外的人发起的回环连接，第一个 SYN 在连接跟踪上记一位；会话用户的套接字应答这种连接（SYN-ACK 挂在监听套接字上，`skuid` 就是监听的一方）一律拒，发起的一方等不到应答、连不上（等到它自己的超时，不是马上被拒）。SYN 洪水下内核改发 syncookie，那种 SYN-ACK 不挂套接字、认不出是谁，所以再加一条：别人发起、又没证实过对面不是会话用户的连接，往 32768 起的临时端口发的后续包一律复位——代价是正被 SYN 洪水压着的临时口，别人正常连也会被复位（固定端口不受影响）。只写得下一个会话用户（`france.sh` 渲染时核对，多了就判红不写）。规则只管新连接（标记打在第一个 SYN 上）：表载上之前就连着会话用户的口、由别人发起的连接，`france.sh` 载完表当场用 `ss -K` 断掉（内核要开 SOCK_DESTROY，法国的开着），断不掉判红停下。
- 不挡的：root（本来什么都拿得到）；会话用户自己的进程（会话本来就该用它）。`fleet` 本来就能经 sudo 以会话用户起命令（引擎起会话就这么起），挡它直连只是少一条路。
- 读回（`france.sh` 的「会话用户在本机开的口」一段，判据在 `deploy/lib/session-ports.sh`）：以会话用户现起一个探针监听（落在临时端口段，和 reclaude 一样），`fleet`、`pilot` 连上去读不到问候、它自己读得到；它此刻真在听的口（`ss -ltne` 里属它的，reclaude 的两个口就在里面）逐个拿 `fleet`、`pilot` 去连，connect 成功就红；它在听的口上还连着别人发起的连接（表载上之前连上的）也红，写清是谁、哪条，重跑 `france.sh` 会断掉；再让 `pilot` 连 `fleet` 起的临时口，读得到才算没挡多。另核两样：`/etc/fleet-dao/nftables.nft` 和仓里模板渲染出来的一样；内核里那张表就是这份文件（文件放进一次性的网络命名空间里载一遍、让 nft 列出来，和内核里的逐字比），手改过、换了文件没重载都判红。起不了探针、ss 跑不成、比不成、没以 `fleet`、`pilot` 的身份跑起来（用户没了、runuser 没成）记待配，不当成挡住了。
- 手动验（无害，不打真实模型调用）：`runuser -u pilot -- timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/<代理口>; printf "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n" >&3; head -1 <&3'`：挡住时 5 秒内连不上、什么都读不到；回 `502 Bad Gateway`（而不是 `407 Proxy Authentication Required`）就是没挡住、能借。代理口是 reclaude 两个口里对这个探测回 502 的那个（`ss -ltnp` 看它的两个口，以会话用户身份逐个试）。
- 自测：`deploy/test/session-ports.test.sh`（要 root；全在一次性的网络命名空间里，不碰宿主的防火墙）。在法国拿真账号验规则、不建临时用户：`unshare --net bash deploy/test/session-ports.test.sh --inner fleet-agent-carpool fleet pilot /usr/bin/node`。
- 撤掉：`deploy/france/fleet-dao.nft` 里删掉第二道隔离的四条规则、`france.sh` 读回里去掉 `readback_session_ports`，再跑一遍 `france.sh`（重载是一个事务里换整张表，没有空窗）。

创始人的登录用户 pilot（创始人用 Mirasim 桌面端的 ssh 远程模式连 `pilot@<法国>` 干活）：

- 装机脚本管的（`deploy/lib/login-user.sh`）：建用户、加进 `systemd-journal` 组（`journalctl -u 'fleet-*'` 看日志）、装 `~/.local/bin/reclaude`（只在没有时装，写的事以 pilot 自己的身份做）、确保有 git、ssh 客户端、curl。不给它写任何 sudoers；它也不在 fleet 组里，所以读不到 `/etc/fleet-dao`，连不上 Temporal 和库（nft 表只放行 root 和 fleet）。
- 读回（`--check`）查：用户在、家目录 750、只在自己的组和 `systemd-journal` 里、`sudo -l -U pilot` 说没有、reclaude 它自己执行得了而且登录 shell 里找得到；缺了报红，写明怎么补。reclaude 登没登录、家里放了什么钥匙不查。
- **pilot 不登录 reclaude**（创始人 2026-09-26）：创始人在 VPS 上不开会话，而 reclaude 一个账户最多挂 4 台设备、法国只占 1 台，给了会话用户。reclaude 二进制照装，将来真要在 pilot 下开会话，得先腾出一台设备再登录。
- 家里不预装任何凭据。第一次要 root 帮一件事（以 pilot 自己的身份写，家里不留 root 属主的文件）：放创始人的 ssh 公钥：`sudo -iu pilot sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < <创始人的公钥>.pub`
- Mirasim 的 ssh 远程模式在 pilot 家里自己装服务端：`~/.mirasim-remote/servers/<版本>/`（自带 node 和 node-pty，不用系统的 node），`current` 指在用的那版，`run/` 下是进程号、日志和 unix socket，数据在 `~/.mirasim/`；桌面端经 ssh 把本机一个端口转到那个 socket。服务器这头要的：公钥登得进来、sshd 允许转发到 unix socket（`AllowStreamLocalForwarding`，Ubuntu 默认开）、`curl`（直接下服务端包，下不了由桌面端经 scp 传）、`tar`、`gzip`、`sha256sum`。不需要系统的 node，也不需要另起一个 systemd 管的 mirasim-server。它按登录 shell（`$SHELL -ilc`）取 PATH，Ubuntu 默认的 `~/.profile` 把 `~/.local/bin` 加了进去，所以找得到 reclaude。
- 法国 Linux 的自有 Claude 直接 reclaude，无头 Mirasim 固定 cloud，由 Fleet/Temporal 管渠道与接续；不安装桌面的混合来源封装。Windows/macOS 的封装已迁入本仓，旧安装随 `pnpm agents:sync` 自动等待空闲迁移，也可运行 `pnpm mirasim:migrate`；装法和来源验收见 `docs/reclaude-in-mirasim.md`。
- 已知的口子：桌面端起远端服务端时把 `MIRASIM_SECRET_KEY` 写在 ssh 执行的命令行里，那几秒里本机别的用户（包括会话用户）用 `ps` 看得到；要堵得给 `/proc` 加 `hidepid`，还没做。
- 撤掉：`userdel -r pilot`。家里是创始人的活和登录态，删之前先问人。

各家 AI 的全局说明、方法类 skill 和钩子（`packages/agents-sync`；法国的会话用户和 pilot 各一份，开发机见下面「开发机」一条）：

- 写什么：仓根 `AGENTS.md` 上半段（两行 `fleet-dao:通用段` 标记圈起来的那一块）写进各家的全局文件，`agents/skills/`（自研）和 `agents/skills-vendor/`（网上公开的第三方 skill，原样拷进来、照锁文件核过才发，规矩见那边的 `README.md`）下的每个 skill 拷进各家的 skill 目录，`agents/hooks/` 下的钩子脚本拷进 `~/.fleet-dao/hooks/`、在 Claude Code 的 `~/.claude/settings.json` 里登记三条（开会话时跑 `session-start.mjs`；调 Bash、PowerShell、Read、Grep 之前跑 `pretool.mjs`；Devin 借道读这份设置、按它自己的小写工具名匹配，另登记一条 `^(exec|read|grep)$` 也跑 `pretool.mjs`）。同目录还有 `agents/hooks/secret-shape.mjs`（不登记）：`pretool.mjs` 拦下会把密钥文件内容读进对话的命令和 Read、Grep 时指到它，它只打字段名、类型、长度，一个值都不打。拦的密钥文件：法国 `/etc/fleet-dao/` 下的一律算（不按文件名挑），reclaude 的设备文件、各家 AI 命令行和 git、gh 存在家里的登录凭据、SSH 私钥、`.secrets/` 和 .gitignore 密钥名单里的名字；读回时只看个数、指纹、权限的照样放行（`grep -c`、`sha256sum < 文件`、`stat`），往里写的（`install`、`scp` 的目标）也放行。同目录还有一对管「命令的输出」的（也不登记，2026-10-02 加）：`agents/hooks/redact.mjs`（把 `-s` / `--secret` / `--token` / `--password` 这类参数的值、名字带 secret / token / password 的 JSON 字段换成 `***`）和 `agents/hooks/redact-secrets.mjs`（命令行外壳：管道进、打码后的文字出）。进程的整条命令行是公开的（Linux 的 `/proc/<pid>/cmdline`、Windows 的 `Win32_Process.CommandLine`），口令当参数交给别的进程之后就躺在那里，`ps -ef`、`wmic process`、`Get-CimInstance Win32_Process` 这类命令会把它们整段打出来（2026-10-02 lark-mcp 的 `-s <secret>` 就是这么漏的）：`pretool.mjs` 对这类命令拦下不接 redactor 的，接上的放行，只列进程名和 pid 的（`ps -A`、`ps -eo pid,comm`、`tasklist`）照样放行。哪家读哪份、为什么这样放，见 `packages/agents-sync/src/targets.ts`（Windows、Linux 各一列）。
- 法国：`france.sh` 最后一步以 root 跑 `node packages/agents-sync/bin/agents-sync --apply --user <用户>`，给 `fleet-agent-carpool`、`pilot` 各写一份：同步脚本先换成那个用户再动手，写出来的都归他。读回里的 `--check` 逐人逐项列出。只写这台装了的那几家（按 PATH 和家里的 `.local/bin` 找命令），没装的列为「没装，跳过」。每发成一版（驾驶舱按钮），自动发布单元下一轮也以 root 对这两个用户跑同一条（第九节「自动发布」）：同步到哪个提交记在它的读数里，没成报警。带 `--user` 时开会话钩子不登记、同步位置不记（开会话钩子要在那个用户自己能拉、能写的 fleet-dao 检出里快进、同步；法国的检出停在自动发布发出去的那个提交上，等 CI、等空闲时本来就落后主线，拿主线比会误报）。调工具前的钩子照装：会话用户家里就有 reclaude 的设备密钥，在那台上手开的会话、借道读这份设置的 Grok、Cursor 起的会话都要拦读密钥文件。引擎起的 Claude 会话带 `--setting-sources project`、不读用户级设置，这里装的管不到它：调工具前那条由引擎经 `--settings` 另外带上，用发布目录里归 root 的那份（`packages/adapters/src/claude-code/args.ts`，docs/reference/adapters.md 2.2）。
- 只动两样：文件里标记圈起来的那一块（标记外的内容原样留着；第一次接管、文件里还没有标记时，先把原文件整份备份，再整份换成受管块），和清单 `~/.fleet-dao/agents-sync.json` 里记着是它装的 skill（仓里删了的会撤掉；插件链进来的、claude.ai 同步来的一律不碰；同名、但清单里没记的，内容和仓里一样也不接管，判红等人处置）。另外 `~/.claude/agents/` 里只动 `packages/agents-sync/src/targets.ts` 的 `SUBAGENT_TARGET` 列了名字的子代理定义（现在只有 `haiku55.md`，原件 `agents/subagents/haiku55.md`，#1393）：没有就装上，内容和仓里不一样就先备份再换回仓里的；那个目录里别的文件一律不碰。备份在各用户家里的 `~/.fleet-dao/backups/<时间>/`，照原来的相对路径摆。
- 钩子只动 `~/.claude/settings.json` 里命令指向 `~/.fleet-dao/hooks/` 的那几条（以前手装在 `~/.local/share/fleet-guard/` 的两条接管时换掉），别的钩子、别的设置一条不碰；改之前整份备份。设置文件不是 JSON、`hooks` 不是对象就不动、判红；`disableAllHooks` 开着也判红（登记照写，但一条都不跑）。Grok、Devin CLI、Cursor 命令行默认也读这份设置里的钩子，脚本认得它们的输入格式。有自己钩子的几家各登记在自己的设置里（#232，写法和依据在 `packages/agents-sync/src/targets.ts` 的 `HOOK_TARGETS` 上面）：Codex 登记在 `~/.codex/hooks.json`（开会话、调工具前两条，调工具前跑 `pretool-codex.mjs`，先把 Codex 的输入翻成 Claude 的写法再交给同一份判断）。Codex 的钩子要信任了才跑：同步替本脚本那几条在 `~/.codex/config.toml` 末尾的托管块里记上信任（和人在 Codex 里 `/hooks` 点信任写的是同一个值），别人的钩子不替它信任；人在 `/hooks` 里关掉的（`enabled = false`）、`[features] hooks = false` 整个关了的不替人打开，判红。Gemini CLI 登记在 `~/.gemini/settings.json` 的 `hooks`（开会话、`BeforeTool` 两条，timeout 按毫秒；调工具前跑 `pretool-gemini.mjs`，挂跑命令、读文件、搜内容几个工具）；它在 Windows 上用 PowerShell 跑钩子命令，PowerShell 拿不到不带控制台的启动器的退出码，所以这一家的命令一律写 `node "…"`。`hooksConfig.enabled` 是 false、`hooksConfig.disabled` 里列了本脚本的命令，不替人打开，判红。Antigravity 登记在 `~/.gemini/config/hooks.json` 名叫 `fleet-dao` 的那一项（整项归同步，别的项不碰；命令行、桌面版共用这份）：它没有开会话事件，只登记调工具前那条（`pretool-agy.mjs`，拦下在 stdout 回 `decision: deny`，没意见回 `{}`、不回 `allow`），每次同步报一行「没登记开会话钩子」；那一项的 `enabled` 是 false 不替人打开，判红。Kimi Code 登记在 `~/.kimi-code/config.toml` 末尾一块托管块里的两张 `[[hooks]]`（开会话、调工具前，调工具前跑 `pretool-kimi.mjs`；和权限那块同一个文件、各管各的，标记不同）。每张只写 `event`、`matcher`、`command`、`timeout`（多一个键 Kimi Code 整份配置读不起来）；块外跑本脚本命令的 `[[hooks]]`（手抄的，或 Kimi Code 改写配置时丢了块的标记）整张收回块里，别人的不碰；`hooks` 被写成表或内联数组的不动、判红。Kimi Code 的钩子出错、超时一律放行，所以 `pretool-kimi.mjs` 认不出、自己出错都退出 2。没接的逐家列一行为什么：pi 要写成 TypeScript 扩展，dsh 没有自带的全局钩子（出处在 `HOOK_GAPS` 上面）。
- 权限（`agents/config/claude-permissions.json`，#516、#517）：Claude Code 的 `~/.claude/settings.json` 里 `permissions` 按并集合并（补缺、不删机器上自己加的），`defaultMode` 覆盖，`env` 里的子代理默认模型 `CLAUDE_CODE_SUBAGENT_MODEL` 也覆盖（Opus 5.5，源文件只认 Opus 或 Sonnet，决定 0017）；Kimi Code、Codex 各写一块托管块，Devin CLI 走 JSON 合并；Grok 直接读 Claude 那份，不另写；pi、dsh 做不到、Gemini CLI 和 Antigravity 没实测，装了的逐家列一行为什么。`--user`（法国装机）整段不写。2026-09-30 起是「最宽松、只放不收」（创始人：图形界面里没法切模式、没人点确认；`defaultMode` 保持 `auto`，shell 整个放开、不设 deny），原话、前提和撤回条件见 `docs/decisions/0005-agent-permissions-loosest.md`；各家写法、翻译规则、生效的条件、怎么加怎么撤见 `docs/agents-permissions.md`。
- 开发机（跑 Claude Code 的电脑）：规矩、技能、钩子、权限都同步到 **origin/main 上的内容**，靠一份**只归同步工具的检出** `~/.fleet-dao/origin-main`（永远停在 `origin/main` 的分离头上；本机自己的 fleet-dao 检出一个字都不动——在哪个分支、有没有没提交的改动都不影响）。第一次、或钩子没装上、或想现在就看逐项结果时，在任一 fleet-dao 检出里跑一遍 `pnpm agents:sync`（拿这个检出当种子把专用检建立起来，之后不再依赖它；`--check` 只读，`--offline` 不取远端、按上次取到的主线走，`--seed <目录>` 指定种子）；之后每次开会话，开会话钩子取远端、把专用检出切到 `origin/main`、再跑一遍 `--apply`，结论一句话进会话（三分钟内刚同步成功过就跳过）。取不到远端、专用检出建不起来时不同步，会话里写明为什么、这台落后主线几个（取不到远端时按本机上次取到的主线算，并写明是这么算的）。专用检出里要是被人改了（整份挪到 `origin-main.bak-<时间>`，不删，再从零建一份——这条路上永远不拿没推的内容去同步），会话里说一句修过。同一条同步路同一时刻只许一个在跑（锁 `~/.fleet-dao/origin-main.lock`，拿不到就说清是谁拿着、这次什么都没动）。
- 同步到哪：`--apply` 记下同步用的检出（就是专用检出 `~/.fleet-dao/origin-main`）和提交（整次没有 ✗、没有没查成才记提交），放在 `~/.fleet-dao/synced.json`；`--check` 按本机上次取到的 origin/main 报这台同步到哪个提交、落后几个，落后、同步的提交不在主线上都判 ✗。仓不是 git 检出时只写明、不判；带 `--user`（法国）不记不判，见上面「法国」一条。
- 另一台开发机还挂着旧钩子怎么办（创始人 2026-10-04）：用户级开会话钩子自己会同步，可更老的一代（手装在 `fleet-guard` 目录的、同步专用检出出现之前的）自己不会升级。所以仓里有一份项目级钩子 `.claude/settings.json` → `agents/hooks/bootstrap.mjs`：在 fleet-dao 检出里开会话时先离线核一遍用户级钩子是不是现在这一代（登记位置、脚本和专用检出里的是否一样、专用检出在不在）；是就一个字不说，不是就说「发现旧钩子：为什么」并强制走和开会话钩子同一条同步（种子是这个检出），换完再核一遍、没换好明说。只管做过完整同步（有 `synced.json`）或还挂着 fleet-guard 的机器；法国会话用户两样都没有，不动；`FLEET_BOOTSTRAP=off` 也不动。**唯一要人做一次的**：那台机器的检出得先拉到有这个文件的提交（`git fetch origin && git switch main && git pull --ff-only`，再 `pnpm agents:sync` 最稳），之后一切自动；没做过完整同步的新机器第一次也是跑一遍 `pnpm agents:sync`。
- 第三方 skill（`agents/skills-vendor/`）分发前先照 `vendor.lock.json` 核：多了、少了、改了任何一个文件，哈希对不上，有链接，`SKILL.md` 的 `name` 和目录名不一样，许可证不在白名单（MIT、Apache-2.0），都整体「没查成」（退出码 2，说清哪个 skill 哪个文件），规矩和自研的 skill 也一起不同步；和 `agents/skills/` 同名也报错、一个都不发。`node packages/agents-sync/bin/agents-vendor verify` 单独核（`diff`、`rehash` 是手动升级用的，升级步骤见 `agents/skills-vendor/README.md`）。检出里的第三方文件被人改过：`git checkout -- agents/skills-vendor` 换回主线上的，再同步。
- 改了 `AGENTS.md` 上半段、`agents/skills/`、`agents/skills-vendor/` 或 `agents/hooks/`：合进主线后，开发机开会话时自己跟上；法国在发完一版（驾驶舱按钮）之后，由自动发布单元下一轮跟着同步，不用人跑（还没发版、发布没成时还没同步，`release.sh --check` 列出的「自动发布」那一段写着规矩同步到哪个提交）；要马上生效或单元停着，就手动跑上面那条命令（或重跑 `france.sh`）。
- ddgs（skill docs-lookup 首选的搜索命令行）：装机最后一步以各用户自己的身份 `uv tool install ddgs==<版本>`，依赖用 `--with` 写死版本一起装（`france.sh` 顶部的 `DDGS_DEPS`），装在他家里（`~/.local/share/uv/tools/ddgs`，命令在 `~/.local/bin/ddgs`），只用系统的 Python；命令能跑、版本对、虚拟环境里的包和钉住的一样，就不动。用的 uv 装在 `/opt/fleet-dao/uv/<版本>/uv`（钉版本、核 sha256），带 `--no-config` 跑（不读他家里的 `uv.toml`：那里能改装包来源、绕过钉版本）；ddgs 和它的依赖是 PyPI 上的包，只钉版本、不核校验和。读回以各用户的身份跑 `ddgs version`，再按虚拟环境里的 dist-info 逐个核对依赖：没装、跑不起来、卡住、输出认不出、版本不对、依赖不一样、虚拟环境没了都判红（`deploy/lib/cli-tools.sh`）。装和读回用的 PATH 和会话的一样，他写得动的 `~/.local/bin` 排最后；ddgs 他改得动，读回照登录 shell 那一问的做法防卡：输出落进 root 建的临时文件、不带控制终端、10 秒叫停再过 5 秒强杀。下载 uv 失败按装机的规矩判红停下；这一步排在最后，规矩已经写完。
- 自测：`sudo bash deploy/test/run.sh` 里的 `agents-sync.test.sh` 以 root 建临时用户，验换身份再写、写出来的都归他、钩子只登记调工具前那条、第二遍零改动、属主不对判红、root 不带 `--user` 往别人家里写被拦下；`agents-sync-account.test.sh` 用假的同步脚本验装机怎么记账（崩了判红、写时的 ✗ 只打不记）；`cli-tools.test.sh` 用假的 uv、ddgs 验 ddgs 的装和查（装错了、卡住了都判红，不出网）。会话的 PATH、会话里找不找得到 ddgs 在 `agent-scope.e2e.sh` 和 `packages/adapters/test/e2e/scope-e2e.ts`（法国）里查。第三方 skill 的核对在 `packages/agents-sync/test/vendor.test.ts`（每种「不对」各造一次）和 `packages/agents-sync/test/vendor-repo.test.ts`（看仓里这份真目录）。钩子、同步位置、写锁在 `packages/agents-sync/test/hooks.test.ts`、`packages/agents-sync/test/position.test.ts`、`packages/agents-sync/test/lock.test.ts`；同步专用的检出在 `packages/agents-sync/test/sync-source.test.ts`（真 git、临时目录：建起来、跟上主线、种子在功能分支/没有都照样同步、脏了坏了整份挪走重建、取不到远端/离线/git 起不来各说各的），`pnpm agents:sync` 这条命令本身在 `packages/agents-sync/test/sync-now.test.ts`；`packages/agents-sync/test/session-hook.test.ts` 拷一份仓、装上钩子，真跑一遍「主线走了 → 开会话钩子切到主线、同步」和「原件坏了 → 会话里明说没查成」；两个钩子脚本本身在 `agents/test/session-start.test.ts`、`agents/test/rules/pretool.rules.test.ts`。
- 撤掉：删各用户家里受管的那几份文件（要原件就从备份拷回）、清单里列的 skill 目录和清单本身，`~/.fleet-dao/hooks/`、`~/.fleet-dao/synced.json` 和 `~/.claude/settings.json` 里命令指向 `~/.fleet-dao/hooks/` 的两条；ddgs 以各用户的身份 `/opt/fleet-dao/uv/<版本>/uv --no-config tool uninstall ddgs`（和装的时候一样不读他家里的配置），再删 `/opt/fleet-dao/uv`；`france.sh` 里去掉 `setup_agent_rules`、`setup_cli_tools` 两步，和读回里的 `readback_agent_rules`（`agents_sync --check` 加 `check_ddgs`）。

## 六、怎么看健康

一条命令：`bash /srv/fleet-dao/deploy/france.sh --check`（香港用 `hk.sh --check`），只读回和自检，不改东西。
应用这一层：`bash /srv/fleet-dao/deploy/release.sh --check`（在用哪版、自动发布的读数、服务、健康检查），和浏览器里的健康页 `https://<驾驶舱域名>/health/`（第九节）；跟不跟得上主线看健康检查里的 `deploy_lag`（第九节「自动发布」）。

法国分项：

- `systemctl status fleet-temporal postgresql@16-main wg-quick@wg-fleet fleet-agents.slice fleet-firewall`；应用：`systemctl status fleet-engine fleet-api`、`journalctl -u fleet-api -n 100`
- `fleet-temporal operator cluster health`（应为 SERVING）、`fleet-temporal operator namespace describe fleet`、`fleet-temporal workflow list`
- `sudo -u postgres psql -c '\l'`、`pg_isready -h 127.0.0.1`
- `nft list table inet fleet_dao`
- `wg show wg-fleet`、`ping 10.99.0.1`
- `journalctl -u fleet-temporal -n 100`

香港分项：

- `curl -I https://<驾驶舱域名>`、`certbot certificates`
- `curl -s -o /dev/null -w '%{http_code}\n' https://<驾驶舱域名>/release.json`：从公网取应为 404（它只给法国经隧道读，第九节）
- `certbot renew --dry-run --cert-name <驾驶舱域名>`：只演练续期，不换证书
- `wg show wg-fleet`（看法国的 latest handshake）、`nginx -t`
- 往法国的连接有没有复用：`for i in 1 2 3; do curl -s -o /dev/null -w '%{time_starttransfer}\n' https://<驾驶舱域名>/api/me; done`，复用时每次约 0.2 秒（一趟隧道往返），每次新建连接约 0.4 秒；`hk.sh --check` 的读回也核对站点里的 `upstream fleet_dao_api`
- 飞书网关：`fleet-gateway-deploy status`、`journalctl -u fleet-feishu -n 100`；它自己还在不在干活看最近一行心跳 `journalctl -u fleet-feishu -o cat --since -30min | grep 网关心跳 | tail -1`（每 10 分钟一行，超过 10 分钟没有新的就是网关没在跑）；它调不通后端时会自己往团队群报（第十二节）

自检（P02：以 root 执行的文件要全链属 root、组和其他人不可写）分三档：

- fleet-dao 自己的单元违规：`✗`，装机判红。
- 别家单元违规：`·` 列出，不计入退出码，交人处置。
- 别家单元违规、但 fleet 或会话用户自己就改得了：`!` 单列成「会话上线前必须清零」，同样不计入退出码。
具体是哪几处不写进公开仓，在机器上跑 `--check` 就能看到。

## 七、怎么回滚

原则：先停用（随时能装回来）；删数据的那一步单独问人。应用退一版用 `bash deploy/release.sh --rollback`（第九节），这里讲整套撤掉。

法国：

```
# 0. 先停自动发布单元（不然它每 5 分钟还会读一轮、发完版还会装自动档），再停应用、撤掉单元（各版代码还在 /srv/fleet-dao-releases）
systemctl disable --now fleet-auto-release.timer
rm /etc/systemd/system/fleet-auto-release.service /etc/systemd/system/fleet-auto-release.timer && rm -r /usr/local/lib/fleet-dao
systemctl disable --now fleet-engine.service fleet-api.service fleet-api.socket
rm -f /etc/systemd/system/fleet-engine.service /etc/systemd/system/fleet-api.service /etc/systemd/system/fleet-api.socket
# 1. 停用，不删数据
systemctl disable --now fleet-temporal.service fleet-agents.slice wg-quick@wg-fleet.service
systemctl stop postgresql@16-main.service   # 库还在，start 就回来
systemctl disable --now fleet-firewall.service   # 停它就是删掉那张 nft 表
# 2. 撤掉装上去的东西（不含数据）
rm /etc/systemd/system/fleet-temporal.service /etc/systemd/system/fleet-agents.slice /etc/systemd/system/fleet-firewall.service
rm -r /etc/systemd/system/postgresql@16-main.service.d
rm /usr/local/bin/fleet-temporal /usr/local/sbin/fleet-agent-scope /etc/sudoers.d/fleet-dao
ufw delete allow in on wg-fleet from 10.99.0.1 to 10.99.0.2 port 8787 proto tcp
systemctl daemon-reload
```

3. 删数据（先问人）：`pg_dropcluster --stop 16 main`、`apt purge postgresql-16`，删 `/opt/fleet-dao`、`/etc/fleet-dao`、`/srv/fleet-dao-releases`、`/var/lib/fleet-dao`、`/var/log/fleet-dao`、`/etc/wireguard/wg-fleet.*`，`userdel -r fleet`、`userdel -r fleet-agent-carpool`（会话用户家里有 reclaude 的设备，删之前先在 reclaude 里注销，腾出一台设备）。原先的 `fleet-agent-dedicated` 已删，2026-09-26。

香港：

```
# 0. 停飞书网关、撤掉单元和入口（各版还在 /srv/fleet-dao-gateway）
systemctl disable --now fleet-feishu.service
rm -f /etc/systemd/system/fleet-feishu.service /usr/local/sbin/fleet-gateway-deploy && systemctl daemon-reload
# 1. 下掉站点（别的站点不受影响）
rm /etc/nginx/sites-enabled/fleet-dao && nginx -t && systemctl reload nginx
# 2. 停隧道
systemctl disable --now wg-quick@wg-fleet
# 3. 收回法国的两把发布钥匙（整份文件是 fleet-dao 的，root 原有的 authorized_keys 不动）
rm /root/.ssh/authorized_keys2
```

4. 删数据（先问人）：`certbot delete --cert-name <驾驶舱域名>`，删 `/srv/fleet-dao-web`、`/srv/fleet-dao-gateway`、`/opt/fleet-dao`、`/var/www/fleet-dao-acme`、`/etc/fleet-dao`、`/etc/wireguard/wg-fleet.*`，`userdel -r fleet`。

只退一步：`git revert` 那次提交 → 机器上 pull → 重跑；脚本会把它管的文件改回仓里的样子，新加过又撤掉的东西按上面手动删。

## 八、改之前要知道的

- 改了端口要同步第二节的端口表（`deploy/test/run.sh` 会查）；要本机只许 root 和 fleet 连的端口，加进 `france.sh` 的 `PROTECTED_PORTS`。
- Temporal 的历史分片数（`numHistoryShards: 16`）建库后不能改。
- 升 Temporal：改 `france.sh` 顶部的版本号和 sha256 → 重跑。新版本装进新目录、`bin/` 链接切过去、服务重启；表结构由 temporal-sql-tool 升到新版本自带的最新。
- 升 uv、ddgs：改 `france.sh` 顶部的 `UV_VERSION`、`UV_SHA256`（uv 发布页每个包旁边的 `.sha256`）或 `DDGS_VERSION`、`DDGS_DEPS`（新版 ddgs 要的依赖在 PyPI 上它那一版的说明里，逐个写死版本）→ 重跑。uv 装进新的版本目录；ddgs 或依赖和钉住的不一样的，各用户以自己的身份整套重装。
- PostgreSQL 用 16：Temporal 官方测过的最高大版本是 16（16.6）；装 Ubuntu 自带源里的，跟着系统的自动安全更新走。
- 香港 WireGuard 用 UDP 4500 是因为上游只放行少数 UDP 端口；换端口前先从法国实测新端口到不到得了香港网卡。
- 香港站点配置里，转发给法国的 `location` 不要自己写 `proxy_set_header`：写了一条，server 那一层的就全部不继承，清 `Authorization`、`X-Fleet-Acting-Feishu` 的两条也跟着失效（法国 france.sh 的读回会查出来）。
- 香港到法国的连接留着复用（`deploy/hk/nginx-https.conf` 的 `upstream fleet_dao_api`）：香港到法国一趟往返约 0.2 秒，每个请求都新建连接就多付这一趟（2026-09-26 实测单个 `/api/me` 0.40 → 0.20 秒）。空闲连接由香港先关：nginx 的 `keepalive_timeout`（5 分钟）必须比法国后端的空闲超时（`packages/api/src/keep-alive.ts`，6 分钟）短，反过来后端刚关的连接 nginx 还拿去发，POST 会偶尔 502（`packages/api/test/keep-alive.test.ts` 读 nginx 配置核对两边）。所以改这两个值时先发法国后端、再重跑香港。转给法国的普通请求 1 分钟没回音回 504（连接是复用的，隧道断着时不设短了要干等 TCP 自己放弃）；实时推送 `/api/events` 单列一段，读超时 1 小时。香港是 nginx 1.18，`keepalive_time` 这类 1.19.10 才有的指令用不了。
- 数据库迁移只进不退：发布时先迁移再切版本，退回上一版不撤迁移。新迁移要写成旧代码照样能跑（先加列、下一版再删旧的）。做不到的，退回时发布脚本会拦：库里跑过的迁移比要退到的那一版带的多，就不退（第九节）。
- 应用单元（`deploy/france/fleet-*.service`，以及 `fleet-api.socket`）跟着版本走：改单元就是发一版，退回时单元也跟着退。引擎单元不能开 `NoNewPrivileges` 和挂载隔离（第五节、单元里的注释）。改 `fleet-api.socket` 的监听地址要 `api.env`、`release.sh` 的 `COCKPIT` 和 `AGENT_API` 两个常量、socket 单元三处一起改（第二节端口表）。
- 升香港网关的 node：改 `hk.sh` 顶部的 `NODE_VERSION`、`NODE_SHA256`（官方 `SHASUMS256.txt` 里 `linux-x64.tar.gz` 那一行）→ 重跑 hk.sh（网关在跑就重启，换上新 node）。旧版本的目录留着，要删手动删。
- 还没验过的：重启机器（单元开机自起、nft 表在服务之前载入）——这一轮没重启过机器。旧系统的单元文件已经删光，开机不会再复活。

## 九、发布应用（deploy/release.sh）

在法国以 root 跑：

```
bash /srv/fleet-dao/deploy/release.sh              # 发主线最新
bash /srv/fleet-dao/deploy/release.sh <提交号>     # 发主线上的某个提交
bash /srv/fleet-dao/deploy/release.sh --rollback   # 退回上一版
bash /srv/fleet-dao/deploy/release.sh --check      # 只读：在用哪版、自动发布的读数、服务、健康检查
```

`--check` 和人手动敲的 `bash /srv/fleet-dao/deploy/release.sh` 跑的是部署检出 `/srv/fleet-dao/deploy/release.sh`，不是在用那一版目录（`/srv/fleet-dao-releases/current`）里的那份。检出是独立的 git 工作树，往往还停在上一次快进的提交，也就是当时的在用版本（#1294，2026-10-08 发 72a33cb5 时若直接跑检出里那份，就是在用版 baa3d01a 的脚本，目录还从手放的旧位置装，装不进这一版的模型）。

发版车不跑检出里那份。`release-train.mjs` 第 4 步 ssh 的命令是技能里的 `agents/skills/commander/scripts/release-boot.sh`（开会话钩子把技能同步到本机，不靠法国检出更新、也不等这一版先发过）：它把目标提交收进裸仓 `/srv/fleet-dao-releases/.repo.git`，把那一版的 `deploy/` 解到按提交号命名的私有目录 `/srv/fleet-dao-releases/.boot/<完整提交号>`（先解到临时目录、查过再整个挪进来，挪进来以后没人改它；两天前的旧目录顺手清掉），再 exec 它自带的 `release.sh`，参数原样带过去（完整提交号在最前，`--now`、`--unmerged` 照传）。改了 `release.sh` 的这一次发版就用那一版自己的脚本，检出还是旧的也一样。两次发版同时来（A、B 不同提交）各解各的目录，A 一定跑 A 版；两个发布谁先谁后，仍由被 exec 的那份 `release.sh` 拿发布锁（`.lock`）排，历史、排空、读回也都在那份里，这里不另做一套。那一版没有 `deploy/release.sh`、是符号链接、对象读不出、包解不开、提交取不到，命令退出 1，不改跑检出里这份。`--check` 和 `--rollback` 仍跑检出里的 `release.sh`。驾驶舱按钮发之前先把检出快进到目标提交（装在机器上的接活脚本原有的一步），所以它跑检出里的就是那一版。

平时发版走驾驶舱「发布到法国」按钮（发版车同一趟流程；下一节）：点一下发主线头，发之前先排空引擎（本节末尾「发布前排空」）；自动发布单元只读不发（本节末尾「自动发布」）。上面几条留给人手动发、退回、重试。

发版前先用 `agents/skills/commander/scripts/release-train.mjs` 把手头的活暂停（创始人 2026-10-05 约 21:00 定的流程；用法见它的头注释）：本机写暂停标记、`worker.mjs start` 不再起新工人，法国引擎总开关关掉并等在跑的会话收尾（等收尾只等法国在跑的会话 0、主线 CI 绿；本机在跑的工人、挂了自动合并没合的 PR 只提示、不等，2026-10-06 母单 #1121：它们和法国发版无关），收尾后才发，发完打印当前版本的清单。它的第 2、3 阶段（暂停法国、等收尾）就是法国引擎的排空，在 release.sh 之前做；release.sh 自己的「发布前排空」（本节末尾）照样跑，当最后一道兜底。发版是对外发布，`release-train.mjs start` 必须带创始人这一次发版的原话，发完、健康检查过了，法国引擎总开关和各仓「让 AI 接活」恢复到发版前（开着的开回、关着的保持关，见下面「自动发布」里「发完恢复到发版前的开关状态」）。

发布和退回自己交给 systemd 跑（临时服务 `fleet-dao-release-<时间>`），终端只跟着看日志：跳板断线、终端关了，发布照样跑完。日志在 `/srv/fleet-dao-releases/.logs/`（开头会打印路径，留最近 30 份），断了之后 `tail -f` 它接着看。`--check` 就在终端里跑。
输出与退出码同装机脚本；没过健康检查、已自动退回，也是 1。

每一步：

1. 取代码：从 GitHub 取主线到 `/srv/fleet-dao-releases/.repo.git`（root 的裸仓）。只发主线上的提交；合并前要在真机上验，加 `--unmerged`，历史里会标出来。
2. 构建：代码解到临时目录，以 fleet 跑 `pnpm install --frozen-lockfile`（依赖整份拷进来，不和 fleet 的 pnpm 仓库共用文件）；有 `packages/web` 就构建它（产出 `dist/client`），没有就用占位页；再放上健康页 `/health/`、版本标记 `release.json`（带完整提交号，香港只给经隧道来的读）。演示版已删（#1223）：不再构建 `web-demo/`，`.fleet-release` 里也不再写 `demo_path=`。有 `packages/feishu` 就把飞书网关连同依赖打成一个文件 `gateway/gateway.mjs`（第十二节）。然后整棵树换成 root、fleet 只读，挪到 `/srv/fleet-dao-releases/<提交号>`。第三方代码不以 root 跑；root 照着起服务的单元文件，是换属主之后 root 才从 git 里取出来放进 `.units/` 的。构建日志在这一版目录的 `.fleet-build.log`。
3. 先试通香港这次要发的那几样（`FLEET_HK_PARTS`，见本节末尾）：发静态文件（或老配置里还留着已删的演示版键、要清香港上的老目录）就 `rsync -n`（什么都不传），发网关就问一次网关入口的 `status`。不通就停，不切版本——不然健康检查必不过，新旧两版会一起被记成不健康。
4. 迁移：以 fleet 跑 `packages/db` 的迁移（库 fleet，本机 socket）。在切版本之前跑，只进不退（第八节）。每一版带几个迁移记在它的 `.fleet-release`（`migrations=`）。跑之前先比库：库里跑过的比这一版带的多（直接发了个老提交），就停、不切——drizzle 碰到比代码新的迁移记录什么也不做、也不报错，光靠迁移这一步拦不住。迁移完装目录：以 fleet 跑这一版的目录装载器，把这一版自己带的 `deploy/catalog.json` 装进库（下面「目录配置」）；这一版没带它、装不成、装完读不回就停、不切。目录装完接着装路由两层：以 fleet 跑这一版的路由两层装载器，把这一版自己带的默认骨架 `packages/db/routing.default.json` 只补缺地装进库（下面「目录配置」末尾的「路由两层」）；装不成、读不回、装完是 0 行同样停、不切。
5. 切版本：`current` 原子地指到这一版；`/etc/fleet-dao/release.env` 的 `FLEET_SERVICES` 里启用的服务装上这一版的单元、起来，没启用的停掉、撤掉单元。这一版带 `.socket` 的（`fleet-api.socket`），切 current 之前按「这一版带不带、机器上有没有」装上、留着或撤掉；装不上（停不掉正占着端口的旧服务、socket 起不来）就不切。socket 起不来时撤掉刚写上的单元，把刚停的旧服务拉回来，端口仍由旧服务自己听。要不要重启看服务的主进程在哪个目录（`/proc/<主进程>/cwd`）：不在这一版的目录里就重启——所以上次切完 `current`、还没重启完就被打断，重跑同一版照样会重启；单元或环境文件变了也重启。头一次装上 socket、或从带 socket 的版本退回到不带的，服务强制重启。
6. 发静态文件：经隧道用 rrsync 传到香港 `/srv/fleet-dao-web`，每处都是新文件先落临时名、最后一起换上，旧文件最后删（在香港属 root）；按内容比、不带修改时间：内容没变的文件不传、不算变化。香港的 rrsync 同一时刻只让一个进来、后到的直接被拒，所以法国这头往香港推（这一步、第 3 步的试通、france.sh 读回的试跑）都先拿同一把锁 `/run/lock/fleet-dao-hk-rsync.lock` 排队，等 2 分钟还轮不到就照实报红（2026-09-26 发布撞上过，没切版本）。
   - 明写了 `web`（默认不发）：驾驶舱静态文件连健康页、`release.json` 整套发到根地址，根上不是这一版的文件会被删掉（香港上老的 `/demo/` 目录也在内，不再排除）。
   - 香港上老的 `/demo/` 目录（演示版已删，创始人 2026-10-07，#1223）：发了 `web` 的发布、或 `release.env` 里还留着已删的键（`FLEET_DEMO_PATH`、`FLEET_HK_PARTS` 里的 `demo`，读到了认下来、丢掉）的发布，经上传的路删一遍（空目录往上同步，`--delete` 只落在 `/demo/` 这一个目录里，别的一概 exclude），再读回 `https://<域名>/demo/` 要是 404：不是 404、读不出来、删不掉都报红，不当成没事；目录本来就不在也算过（一次性、幂等）；删成了顺手删掉法国上老的发布记录 `.demo-published`。香港站点配置对 `/demo` 一律回 404（不回落到首页），所以站点配置换新前后读回都是 404，不靠它判目录在不在。健康检查再读回一遍。
   接着发飞书网关（第十二节）。根地址上手放的东西，下次发布（发 `web` 时）就没了。
7. 健康检查：启用的服务 10 秒里没退出、没重启，主进程跑的是这一版的目录；装了 `fleet-api.socket` 的，它也要在听（没在听算没过，下次重启又会拒连）；`fleet-api` 的驾驶舱接口在答健康报告、切之前好的项没变坏（会随时间自己变红的项除外：待开单积压 `draft_backlog`、判断题 `judge`（最近一次调用没成跟着上游变红）、跟上主线 `deploy_lag`（主线一动就可能落后）、飞书网关 `feishu_gateway`（网关、隧道、香港出事就红，后端刚重启、网关还在退避重连时是「没查成」）、会话账号切换 `session_org`（引擎切号没成、切完读回不在线、拼车恢复时刻读不到、组织读数变了引擎没切过号，跟着上游额度、登录、人手动切号变红）、全流程巡检 `canary`（跟着每 6 小时一轮的结论变红）、GitHub 机器人权限 `github_app`（GitHub 上的 App 权限被改了、新权限没点接受，引擎每小时自检一次）、看门狗 `watchdog`（跟着引擎每 5 分钟一轮变红，切版本那一刻它的下一轮还没来）只记待处理，不退回），fleet 命令接口在听；`fleet-engine` 90 秒内到任务队列 fleet 上取活（工作流任务、活动任务都要有它）；发了静态文件的话，香港在发这一版（经隧道读 `release.json`、健康页 200）；香港上老的 `/demo/` 读回要是 404（不是 404 报红：被谁发回去了，或站点配置回落到首页）；这次切了飞书网关的话，它以这一版连上了飞书、起稳了（第十二节）。不过就自动退回上一版（同样的切法、同样的检查），报红；但库里跑过的迁移比上一版带的多时不退，停在新版报红等人（旧代码对着新表结构会出错，健康检查还查不出来）。
8. 清旧版：留 5 版——在用的、上一版，再按最近用过的补满。

同一个提交跑第二遍，结论是「本次改动 0 处」；两遍之间各拍一次 `bash deploy/lib/snapshot.sh ours`，diff 为空（快照里每一版整棵树的名字、大小、修改时间、属主、权限压成一个指纹，重新构建一定会变）。这样比之前先停自动发布单元（`systemctl stop fleet-auto-release.timer`，比完 `start`）：两遍之间它可能跑装机自动档、同步规矩，动到文件。

退回：

- `--rollback` 退到「上一版」：历史里最近在用过、不是现在这版、没被判过不健康、目录还在的那一版。退之前先比库：库里跑过的迁移比那一版带的多（或读不清），不退、报红；也先试通香港。
- 健康检查没过的版本在历史里记成不健康，`--rollback` 不会退到它；它以后再发一次、过了，就记回健康。
- 历史在 `/srv/fleet-dao-releases/.history`，一行一件事：时间、提交号、事件（`release`、`rollback`、`auto-rollback`、`unhealthy`、`recovered`），合并前发的带 `unmerged`，自动发布那一次里记的（发布、不健康、自动退回）带 `auto`。

本机起哪些服务（`/etc/fleet-dao/release.env`；每一项应该是什么在这一档的期望里，法国是 `deploy/france/desired-config.json`：新机器照它建，发布时照要发的那一版的期望写，本节末尾「配置进仓对账」）：

```
FLEET_SERVICES=fleet-engine fleet-api   # 空 = 只发代码、迁移，不起服务
FLEET_DOMAIN=<驾驶舱域名>
FLEET_HK_PARTS=gateway                  # 往香港发哪几样：gateway 飞书网关、web 静态文件；不写 = 只发 gateway
```

`FLEET_HK_PARTS` 默认不发静态文件：发了就会把香港根地址上的东西整个换成这一版的前端，等于对外发布——先告诉创始人，再在期望里给 `FLEET_HK_PARTS` 加上 `web`、合进主线，发布时照期望写进 `release.env`（新加的这一样，写之前照样先试通，不通不写、不切）。去掉一样，发布就不碰香港上的那一样（也不查它的健康）。

起一个服务之前先把它要的配置备齐：起不来的话健康检查过不了，会自动退回。

演示版：已删（创始人 2026-10-07，#1223）。香港站点 `/demo/` 的假数据演示版、驾驶舱里发游客链接的「演示版」页、法国上推可见范围的 `fleet-demo-scopes` 单元都没了；本机假数据模式（`react-router dev --mode mock`）保留。落地分三处，都由发版带过去，不用人手改：

- 发布：`FLEET_HK_PARTS` 只认 `gateway`、`web`；不再构建、不再发、不再核对演示版；发布时把香港上老的 `/demo/` 目录删掉、读回要是 404（本节发静态文件那一步）。老的 `release.env` 里留着的 `FLEET_DEMO_PATH`、`FLEET_HK_PARTS` 里的 `demo` 认下来、丢掉，期望里已去掉，下次照期望写配置时换掉。
- 法国装机：`france.sh`（整套和 `--auto-tier` 的自动档）把老机器上还装着的 `fleet-demo-scopes.{path,timer,service}` 停掉、禁用、删掉，也删 `/usr/local/sbin/fleet-demo-scopes`，读回核对它们不在；`api.env` 的 `FLEET_DEMO_DIR` 从期望里去掉（机器上留着的老值没人读）。数据目录 `/var/lib/fleet-dao/demo` 不动（删数据要人拍）。
- 香港站点：`hk.sh` 重渲染站点配置，演示版那一段换成对 `/demo` 一律回 404；`hk.env` 里留着的 `FLEET_DEMO_PATH` 认得、忽略。香港 `git pull` 后重跑一遍 `hk.sh` 就换上（不重跑也行：发布脚本已经把目录删了，老站点配置对不存在的文件本来就回 404）。

| 单元 | 身份 | 跑什么 | 读的配置（都在 `/etc/fleet-dao`） |
|---|---|---|---|
| `fleet-engine` | fleet | `node packages/engine/src/main.ts`（Temporal worker，任务队列 fleet） | `engine.env`（`FLEET_ENGINE_PORTS=real` 真端口 / `fake` 假端口，必须写；真端口另要机器名、工作树的根、reclaude 的路径，见期望 `deploy/france/desired-config.json`）、`agent-token.env`、`github/`（两个 GitHub 机器人） |
| `fleet-api` | fleet | `node packages/api/src/main.ts`：一个进程两个监听，驾驶舱接口 `10.99.0.2:8787`、fleet 命令接口 `127.0.0.1:8788`。端口由 `fleet-api.socket` 攥着，进程从 systemd 接手 fd | `api.env`、`agent-token.env`、`session-secret.env`、`gateway-token.env`、`github/`（两个机器人的 json） |
| `fleet-api.socket` | root | 不跑进程：两个 `ListenStream` 攥着上面那两个地址（`FreeBind=yes`，隧道没起也能先听上）。重启 `fleet-api` 时新连接排在内核队列里 | 不读配置。改监听地址要 `api.env`、`deploy/release.sh` 的 `COCKPIT`、`AGENT_API` 两个常量、这个 socket 单元三处一起改 |

- 两个都是 `Restart=always`。引擎不开 `NoNewPrivileges`（要经 sudo 调 `fleet-agent-scope` 起会话），也不开挂载隔离（会话是它的子进程，会跟着看不见自己的家目录）；后端不起子进程，照常收紧。
- `engine.env`、`api.env` 新机器由 france.sh 照这一档的期望建（私有值只留空位：飞书、GitHub 的凭据由人填在 `api.env`）。每一项「应该是什么」在仓里的 `deploy/france/desired-config.json`：公开值改期望、合进主线，发布时照期望写上、重启对应服务（本节末尾「配置进仓对账」）；只改机器的，下一轮自动发布就报不一致，发布也不替人改回（期望里 `selfHeal` 关着）。私有值只在机器上改，改完再发布一次就会重启对应服务。库连接写成 `DATABASE_URL=postgres:///fleet` 加 `PGHOST=/var/run/postgresql`：本机 socket、peer 认证，没有口令（postgres.js 不认连接串里的 `?host=`）。
- `api.env` 也要连 Temporal：`TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE` 和 `engine.env` 那两行同一份值，发给工作流的信号和 `/healthz` 的 `temporal` 项都用；`FLEET_TASK_QUEUE` 只给 `/healthz` 的 `engine` 项查任务队列上有没有 poller 用，不给都有默认值（`127.0.0.1:7243`、`fleet`、`fleet`），Temporal 没起来时后端照样能起，健康检查会如实报红。
- 随机密钥各一个文件，france.sh 首次生成，之后不动、不打印：`agent-token.env`（`FLEET_AGENT_TOKEN_SECRET`：引擎签 fleet 通行证、后端验）、`session-secret.env`（`FLEET_SESSION_SECRET`）、`gateway-token.env`（`FLEET_FEISHU_GATEWAY_TOKEN`）。
- france.sh 读这些环境文件和 systemd 同一种读法（`deploy/lib/app-config.sh` 的 `env_parse`）：行首的空白、`=` 两边的空白不算，值去掉一层引号，同一个键写了几行、服务里生效的是最后一行。读回说的就是服务里生效的那个值；同一个键写了几行直接判红（删成一行，脚本不猜该留哪一行）。文件读不到、引号到文件末尾都没配上，判红、不改文件。这些文件和三个随机密钥文件的路径是目录、符号链接（含断链）的，也判红、跳过，什么都不改（属主权限会跟着链接改到别处，写文件会把链接换掉）。
- france.sh 只在文件不在时照期望建一份（`deploy/lib/app-config.sh` 的 `env_from_desired`，内容由 `config.mjs render` 出：公开值照期望写、私有值只留 `KEY=` 空位，值不进仓）；已有的文件不补键（只修属主权限、删退役的键）——原来照仓里的样例补「样例后来加的键」，样例删了（#323）：期望后来加的键，发布时照期望写上（本节末尾「配置进仓对账」）。`FLEET_ENGINE_PORTS` 也照期望写（碰不碰真仓、真会话，法国是 `real`；要换先改期望），没写（或被注释掉）读回判红。`engine.env` 里要钉在约定值上的两项——`FLEET_WORK_DIR`（`/var/lib/fleet-work`，fleet-agent-scope 只认这一个）、`FLEET_ENGINE_STATE_DIR`（`/var/lib/fleet-dao/engine`）——由读回核对：值不对、写了几行判红，没写、被注释掉记待配。读回也核对 `engine.env`、`api.env`、`release.env` 和三个随机密钥文件都是 root:fleet 640：组读不到时 root 读回照样读得到、服务却起不来。
- `api.env` 的 `FLEET_GITHUB_WEBHOOK_SECRET` 要和 GitHub 上「引擎」App 设置里的 Webhook secret 一致（App 级 webhook 挂在引擎机器人上，事件地址见第二节），不是随便生成一个：值就在 `/etc/fleet-dao/github/gh-app-fleet-dao-engine.json` 的 `webhook_secret` 里。这一项空着时 france.sh 照它填上（不打印）；json 里没有、或者值里有写进环境文件会变样的字符（引号、反斜杠、`$`、反引号、空白、非 ASCII；`+ / =` 这类照收），就记待配、不瞎填；这一行被注释掉了也记待配，不替人放开；`api.env` 读不到、这个键写了几行，判红、不改（也不新建一份只有密钥的 `api.env`）。读回只比两边一致不一致，不打印值。改 webhook 密钥：先在 App 设置页改，再把新值填进 json 和 `api.env`（`api.env` 里已有值的，france.sh 不动），发布一次重启后端。
- 香港只转发 `/github/webhook`、不验签，那一侧不放这个密钥。转发时请求体和 `X-Hub-Signature-256`、`X-GitHub-Delivery`、`X-GitHub-Event` 这几个头原样透传：签名是对原始请求体算的，改一个字节（重新序列化 JSON、改编码、压缩）法国验签就全挂。`deploy/hk/nginx-https.conf` 里这一段只加了请求体大小的上限（25MB），server 那一层的公共设置也只改 `Host`、`X-Forwarded-*` 和清掉两个网关用的头；往这一段加 `proxy_set_body`、`gunzip` 这类会改请求体的指令、或者单写一条 `proxy_set_header`（这一层的公共设置就全部不继承了，见那份配置里的注释）之前，先想清楚验签。
- 免登 `FLEET_DEV_LOGIN` 永远不开：驾驶舱接口听的不是回环地址，后端也会拒绝启动。
- 驾驶舱登录的白名单：就是库里的 `users` 表：只放行 `role = 'founder'`、`active` 的行，按飞书 `open_id` 认人；香港飞书网关替创始人办事（带 `X-Fleet-Acting-Feishu`）也按这张表认。新机器上这张表是空的，谁登录都回「不在白名单里」。创始人名单只在香港 `feishu.env` 的 `FEISHU_FOUNDERS`（`open_id:显示名`，逗号分隔；和法国 `api.env` 是同一个飞书应用，`open_id` 两边通用），照它写进法国的库，值不过屏幕（已有的不动，只补缺）：

  ```
  # 在能同时登两台的机器上
  ssh <香港> 'grep "^FEISHU_FOUNDERS=" /etc/fleet-dao/feishu.env' | ssh <法国> 'set -euo pipefail; IFS= read -r line; IFS=, read -ra items <<< "${line#FEISHU_FOUNDERS=}"; for it in "${items[@]}"; do id=${it%%:*}; name=${it#*:}; [[ "$id" =~ ^ou_[A-Za-z0-9]{20,64}$ && -n "$name" ]] || { echo "认不出一项，停" >&2; exit 1; }; printf "%s\n" "insert into users (display_name, role, feishu_open_id) values (:'"'"'nm'"'"', '"'"'founder'"'"', :'"'"'oid'"'"') on conflict (feishu_open_id) do nothing;" | runuser -u fleet -- psql -d fleet -v ON_ERROR_STOP=1 -q -v oid="$id" -v nm="$name" -f - >/dev/null; done'
  # 核对：只看条数，不看值
  ssh <法国> "runuser -u fleet -- psql -d fleet -Atc \"select count(*) from users where role = 'founder' and active and feishu_open_id is not null\""
  ```
  飞书登录回调地址 `https://<驾驶舱域名>/auth/feishu/callback` 要先在飞书开放平台这个应用的「安全设置 → 重定向 URL」里加上，不然飞书授权页直接报错。
- 账密登录（#120，和飞书登录并列，白名单还是 `users` 表）：密码只存加盐的 scrypt 哈希（`users.password_hash`），同一用户名或同一来源（香港 nginx 写的 `X-Real-IP`，只在后端内存里按哈希计、不落日志）连错 5 次锁 15 分钟。创始人平时在驾驶舱「设置」页自己设、改；飞书登录出问题、或被锁了要当场解开时，在法国以 root 给他（重）设一个：

  ```
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api set-password <飞书显示名或用户 id> [--username <用户名>]
  ```
  它换成 fleet、带上 `api.env` 连库（和 `fleet-api.service` 同一份环境），密码从终端读两遍、不回显；不收命令行参数传密码（会进 shell 历史）。标准输入是管道时按行读两行（脚本里用：`printf '%s\n%s\n' "$pw" "$pw" | bash …/fleet-api set-password …`）。只能给在用的创始人设，别的人拒；这个人还没有用户名的，要带 `--username` 或按提示输一个。设完输错计数和锁清零、他所有设备上已登的会话作废（要重新登录），操作记录里记一条 `credentials.set`（来源记成 engine，reason 写明是这条命令）。退出码：0 设上了；1 被拒（不在白名单、两遍不一样、太短、用户名被占……，一句话说原因）；2 参数不对或没带上库连接。
  核对（只看有没有，不看值）：`runuser -u fleet -- psql -d fleet -Atc "select display_name, username is not null, password_hash is not null, locked_until from users where role = 'founder'"`。
- **引擎待命**（创始人 2026-10-05 约 19:10：「关闭」＝引擎进程开着但不接活，不是进程停着；原话「2 3 4 6 7 按照你推荐」，推荐＝待命）：法国期望 `FLEET_SERVICES=fleet-engine fleet-api`（`deploy/france/desired-config.json`），引擎和后端都开着；各项目的「让 AI 接活」新导入的默认关（发版前后保持原样，发完恢复到发版前，见自动发布一节），点开才拉单、派活（驾驶舱「设置 → 仓库」，或下面的命令）。关着时引擎只收单、显示、不派，但**路由探针每 15 分钟仍会起一次最短的模型会话**、读额度每 15 分钟照读、会判要不要切拼车/独享号——这是创始人知情同意的代价（要连探针也不花，只能把进程停掉，那就是看板点不动、开启要 root）。全流程巡检在巡检仓开关关着时记「跳过」、不报警（第五节）。上线这一版（发布一轮，引擎起来）之后不用再手动恢复定时任务：8 个定时任务是引擎进程里的定时器（#1072），起来自己恢复；Temporal 上老的 Schedule（含当初被手动暂停的那四个）引擎起来时自动删，读回 `fleet-temporal schedule list` 应是空的。撤回「待命」（回到进程停着）要改期望、发布一轮，是创始人拍的事。
- 「让 AI 接活」开关（design 第九节「在哪能做与接活开关」，库里是 `repos.auto_dispatch_since`）：驾驶舱的开关页面（#131）做好之前，在法国以 root 用同一个管理命令开关；页面做好以后这条命令留作运维的后备，两边写的是同一份数据、走同一个写入口（`Store.setAutoDispatch`）。

  ```
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch <owner>/<仓名> status   # 只看：开着还是关着、最近一次谁什么时候开关的
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch <owner>/<仓名> on       # 打开：记下此刻。之后引擎自己按依据挑开着的独立 issue（别的版本、未排期的也在内；老单要先被整理会话判过，见第五节「拉单」）；母单、子单、贴了「本机做」的不派，两个标签一起贴以「本机做」为准
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch <owner>/<仓名> off      # 关上：设为空，只收单、显示，不派
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch --all off --reason "<原因>"   # 所有仓一起关（手动用；发版不再自己跑它，#1256）；只许 off
  ```
  和 set-password 一样换成 fleet、带上 `api.env` 连库；仓名不分大小写。已经是要的状态就不改、不记：开着时再 `on` 不重设时刻、不记（时刻现在只显示用，拉单不再拿它和开单时间比）。改了就在同一个事务里记一条操作记录（`repo.auto_dispatch.enable` / `repo.auto_dispatch.disable`，target 是 `repo:<仓的 id>`，来源记成 engine，reason 写明谁跑的哪条命令，before / after 是开关原来和现在的值），改完从库里读回开关和这条记录再打印。退出码：0 查到了、改好了或本来就是；1 没做成（库里没这个仓、连不上库、写库出错、读回来对不上，一句话说原因和怎么核对）；2 参数不对或没带上库连接。
- **关着开关时点名派单**（`fleet-api dispatch-issue`，母单 #1335 第 2 片、#1337；创始人 2026-10-08：「如果按钮不开，可以本机操纵vps派单」「按推荐」）：项目的「让 AI 接活」关着时，本机（指挥官）把某一张单立刻交给法国引擎，不用先把开关打开（打开会让引擎同时去拉别的单）。

  ```
  # 在本机，经 ssh 到法国以 root 跑（ssh 名字同 france.mjs：FLEET_FRANCE_SSH 或 ~/.fleet-dao/france-ssh 第一行）
  ssh "$(head -1 ~/.fleet-dao/france-ssh)" 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch-issue thoerwink8/fleet-dao 1337'
  # 就绪度闸没过、确认没问题时（理由写进操作记录）：
  ssh "$(head -1 ~/.fleet-dao/france-ssh)" 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch-issue thoerwink8/fleet-dao 1337 --force --note "创始人口头说先做这张"'
  ```
  对这一张单跑一遍和拉单同一份的准入（判法是 `jobs/intake.ts` 导出的 `workflowPathIn`、`prClaimedIssues`、`readTaskBrief` 和 `@fleet-dao/core` 的 `versionGate`、`familyGate`、`localGate`，不复制），过了就建任务行、起任务工作流（和拉单同一个 `start`，编号 `task:<owner>/<name>#<号>`，`REJECT_DUPLICATE`，已派过的不会重复派）。本体在引擎包（`packages/engine/src/bin/dispatch-issue.ts`，逻辑在 `jobs/dispatch-issue.ts`）：驾驶舱后端不依赖引擎包，所以 `bin/fleet-api` 见到第一个参数是 `dispatch-issue` 就转给它，其余命令照旧走后端自己的入口；同样换成 fleet 身份、带 `api.env`。**不看**「让 AI 接活」开关，但**引擎总开关关着一律拒**（说明总开关；关着的引擎不起会话，派了也只是排队）。不看容量（同时 6 条的上限是拉单的节流；这是人明说要派的一张）。
  没过就打印是哪一道、为什么，退出码 1，不起工作流。闸分两类：**硬闸**任何情况下都不放行，`--force` 也不行——不是 issue（PR 号）或已关、作者不在白名单、母单或子单、贴了「本机做」、已有开着的 PR 的「需求」栏挂着它、正文写了 `.github/workflows/` 路径、已派过（含工作流编号用过）、版本号认不出（没查成）、交代不全（任务工作流第一步会拒收，放行了只会起一条马上失败的工作流）；硬闸遇到第一个就停。**就绪度闸**一次说全，`--force` 可以放行：不是当前版本（含未排期）、改动规模是最重档（`decideTierFromModules` 判主力档）、历史失败超限（这张单以前各代任务工作流里失败收场的超过 2 条，顺着代数问 Temporal）。`--force` 必须同时带 `--note "<为什么>"`，反过来 `--note` 不带 `--force` 也拒（退出码 2）。
  每次都写一条操作记录（`dispatch.issue`，target 是 `issue:<owner/仓>#<号>`，来源记成 engine、`ops:dispatch-issue`，reason 写明谁跑的哪条命令，after 里有 force、note、被 force 放行的闸、结果；派了 ok=true，没派和没查成 ok=false）。读不到（GitHub、Temporal、库）一律打印「没查成」、退出码 1，不当成过了；派出去之后操作记录写不进，会明说「已经派出去了」让人核对。退出码：0 派了；1 没派或没查成；2 参数不对。
  这一段是 Fusion 时代的接活逻辑（design 第九节「在哪能做与接活开关」、`docs/decisions/0003-fusion-flow.md` 第 2、8 条），009/010 完成后按三段一条龙改成「对题 → 动手 → 验收」，落地 PR 连带删改；**先别照这段做**（现行的拉单是 `intake` 那条，见第五节；这段是旧 Fusion 的接活逻辑）。看哪些单因为版本、母单子单、本机做、本机认领没派：`sudo -u fleet psql fleet -c "select delivery_id, received_at, note from github_events where note ~ 'workflow=(unscheduled|not_current_version|version_unreadable|mother_ticket|sub_issue|reserved_local|claimed_local)' order by received_at desc limit 20"`。
- **叫临时指挥官整理待办**（`fleet-api groom`，母单 #1335 第 3 片、#1338；创始人 2026-10-08：「能不能临时调用指挥官」「怎么唤起这个指挥官……指挥官自主开单」「按推荐」）：引擎里一个短命会话，补写老单、拆大单、开新单、判老单还成不成立（贴「整理过」让老单进候选，过期的留言贴「待补」，要人拍的贴「要人拍」，都不关单）；规则全文见 design 第九节「临时指挥官整理待办」。三条路叫它，同一个入口、同一把锁：引擎拉单一轮自己叫（有从没整理过的老单；或有空位、一条都没起、待办还有候选，且距这个仓上次整理超过 6 小时）、驾驶舱设置页「让指挥官整理」按钮（`POST /api/repos/<项目编号>/dispatch/groom`，`GET` 同路径看今日剩余次数和最近几次结果）、本机经 ssh：

  ```
  ssh "$(head -1 ~/.fleet-dao/france-ssh)" 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api groom thoerwink8/fleet-dao --note "老单堆了，先整理一遍"'
  ```
  只是排队：记一条操作记录 `groom.request`（target `groom`），法国引擎每 5 秒看一眼，接手记 `groom.start`、整理完记 `groom.done`（开了哪几张、补了哪几张、判了哪几张、用的模型和用量）并推一条总结通知；整理失败（选不到路由、模型起不来、超时、回答里没有清单、GitHub 写不进）记 `groom.done` ok=false 并推一条 alert，不当成没事。命令的本体在引擎包（`packages/engine/src/bin/groom.ts`，逻辑在 `jobs/groom-command.ts`，和 `dispatch-issue` 同样由 `bin/fleet-api` 转过去、换成 fleet 身份带 `api.env`，只连库）。拒绝都明说原因、退出码 1：引擎总开关关着（关着的引擎不起会话）、已经有一次在排队或在做（同一时刻只一个，不分仓）、这个仓滚动 24 小时已整理 3 次；退出码 2 是参数不对。要看结果：驾驶舱，或 `sudo -u fleet psql fleet -c "select at, action, ok, error, after from audit_log where target = 'groom' order by at desc limit 10"`。会话用的模型在路由页「整理待办」一行配（默认 Sonnet 5.5、Opus 5.5 在前，永不用 Fable）。
- **续、放弃、重做一张单**（`fleet-api task`，#1402）：任务停下后，本机或法国的指挥官在命令行做，不用再靠仓外脚本直接打 Temporal。驾驶舱上的「继续」「叫停」「重做」按钮还在。

  ```
  ssh "$(head -1 ~/.fleet-dao/france-ssh)" 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api task continue thoerwink8/fleet-dao 1402 --note "卡在检查点，接着做"'
  ssh "$(head -1 ~/.fleet-dao/france-ssh)" 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api task abandon thoerwink8/fleet-dao 1402 --note "这张不做了"'
  ssh "$(head -1 ~/.fleet-dao/france-ssh)" 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api task redo thoerwink8/fleet-dao 1402 --note "叫停之后重来"'
  ```
  `continue` 发 `taskContinue`（和驾驶舱「继续」同一个信号），`abandon` 发 `taskAbandon`（和「叫停」同一个，`--note` 就是原因）。`redo` 走后端现成的 `taskRedo.redo`（`packages/api/src/temporal.ts`），只在库里这张单是已叫停或挂起时另起一代；做完、失败、还在跑的拒绝并说现在是什么状态。`--note` 必填。每条写一条操作记录（`task.continue` / `task.abandon` / `task.redo`，target `issue:<owner/仓>#<号>`，after 里有谁、哪张单、note、结果）。找不到这张单或任务工作流已经不在：退出码 1，标准输出不打成功。退出码：0 做成了；1 没做成；2 参数不对。`dispatch-issue` 碰到已派过，提示改跑这条 `redo`（驾驶舱按钮同样能点）。
- 认领账和提醒（认领账 #556 已删，只剩提醒；design 15.3「谁在处理」）：2026-09-28 起「谁在处理」这份状态只留给驾驶舱看（#445，「提醒派单」整层删掉——不再等没人认领自动开跟进单、不用认领、没有 `alert claim`）；经 ssh 能看的只剩开着的提醒、跟进单（历史上挂过的）、PR、静默：

  ```
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api alert show                 # 开着的提醒：级别、标题、键
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api alert show <键或编号>      # 一条的跟进单、PR、静默（不显示谁在处理、认领）
  ssh <法国> 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api alert silence <键> --until +3d --note "<谁拍的、为什么>" --machine <机器名> --session <会话号>'
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api alert silences --all       # 静默：谁建的、为什么、到几点
  ```
  `alert claim` 已经删掉（#445）：提醒不再等「没人认领 20 分钟」自动开跟进单，也不用认领来标「谁在处理」；`alert show` 的跟进单一栏只显示历史上挂过的（`alert_work` 表还在，只是没有命令能再新挂一条），没挂过的就是「没有」。静默必带到期（最长 7 天）、必带 `--note`（谁拍的、为什么不用处理），只挡 24 小时再提醒、不撤提醒本身；`--term`/`--founder` 随座位整张删掉（#531），给了这些参数在这里就认不出。静默、撤静默各记一条操作记录（`alert.silence`、`alert.unsilence`，target 是 `silence:<静默编号>`）。修复的 PR 如果正文挂了跟进单（需求栏、`Closes #号`），PR 镜像照常记下来，驾驶舱显示「PR 开着 / 合进主线 / 法国已发布」。退出码：0 做成了；1 没做成（库出错、设置认不出）；2 参数不对（不连库）。核对：`runuser -u fleet -- psql -d fleet -Atc "select n.dedupe_key, w.issue_number, w.source, w.linked_by from alert_work w join notifications n on n.id = w.notification_id where n.resolved_at is null"`、`runuser -u fleet -- psql -d fleet -Atc "select match_kind, match, created_by, ends_at, comment from alert_silences where expired_at is null and ends_at > now()"`。
- 后端收 GitHub 事件：原文一次投递一行落进库里的 `github_events`（状态、原因、做了什么都在）。PR、CI 事件要用 `github/` 里两个机器人的凭据写镜像，凭据只在后端启动时读一次：读不到时后端照样起、issue 照收，PR 和 CI 事件记成出错，健康检查的 `github_events` 报红；补上凭据后要重启 `fleet-api` 才读得到。记成出错、等着的投递原文还在，每轮对账（引擎的定时任务 `github-reconcile`，每 15 分钟）按原文重放：出错的最多自动重放 5 次；等着的（重开时上一轮还没结束、这个项目停派）每轮都重放、不占次数。重放到头的没有手动再推的入口，只在健康检查里报红。
- GitHub 不会自己重投没送到的 webhook：漏收的靠对账调它的重投接口、再按仓轮询补回。
- 关单对账 #654 删了（原来对账每天顺带扫一遍「做完没关、关了没结果」，判的前提是 结果.md）：它留在提醒中心的四种日报提醒 `close-sweep:<owner>/<仓名>:{due,mother,merged,no-result}`，引擎下一次起来的第一轮由 `retireCloseSweepAlerts` 一次性撤掉（日志：`journalctl -u fleet-engine --since '-2h' | grep 撤了关单对账`）；之后这段连同它的测试可以整个删。
- 对账每小时顺带一轮单子打标挂版本（design 第七节「标签与里程碑」，#448）：UTC 分钟数 < 15 的那一轮跑（每小时一次，不挑钟点——「新开的一小时内有类别和版本」是相对时长），「引擎」机器人按受管的仓读现状：没有类别标签的新开（或重新打开）issue 问 Jev「issue 归类」题（第十一节），把握够贴需求/缺陷/杂项，把握不够或连不上都不贴（前者进日报，后者记没查成），人摘过的以后不再贴；进门时类别、里程碑都没有的（没走开单脚本漏开的）按创始人开的 / 机器开的分别挂当前版本、留未排期，有类别没里程碑的是有意未排期、不碰；里程碑关了还留着没做完的单挪到（新的）当前版本并留言，没有下一个版本就不挪、记没查成；未排期闲置 `FLEET_ISSUE_GROOM_STALE_DAYS`（默认 30）天贴「过时」，再 `FLEET_ISSUE_GROOM_CLOSE_DAYS`（默认 14）天没动关成「不做了」，贴了「冻结」、母单、已排进当前版本的跳过。这一轮的动静（贴了什么、没把握的、清了哪些）写成一条日报级提醒 `issue-groom:<owner>/<仓名>`，原地更新，不是要人拍的事。当前版本读不出来（没有还开着的 `v<N>` 里程碑）、Jev 没问成、GitHub 写不进去：驾驶舱「定时任务」页那一轮记没查全，`why` 以「单子打标挂版本」开头。日志：`journalctl -u fleet-engine --since '-2h' | grep 单子打标挂版本`。想马上看一遍：没有手动触发一轮的命令（#1072），等下一轮（整点后 15 分钟内的那一轮会带上，不挑北京时间）。PR 不贴类别标签、不挂里程碑（#654 删了 `pr-labels` 工作流：里程碑页的进度只数单子，PR 挂上去会把完成度虚报）。
- 接 GitHub 要齐两样，缺一样 GitHub 上的单就进不来（事件、对账补回来的都被门挡掉，投递账上记「不收」、不算出错），健康检查的 `github_events` 会报红（`no_repos`、`no_github_members`）；驾驶舱还没有加仓、改成员的页面，现在在库里加（新机器上两张表都是空的）：
  - 受管的仓：GitHub App 装在哪几个仓上，就给哪几个仓各加一行（`test_command` 先填个占位 `-`，对账读成仓里的配置后会改成里面的测试命令）：`sudo -u fleet psql fleet -c "insert into repos (owner, name, default_branch, test_command) values ('<owner>', '<仓名>', 'main', '-') on conflict (owner, name) do nothing"`。App 装在哪些仓上，在 GitHub 上 App 的安装页看。
  - 测试命令存在 `repos.test_command`（建仓时填；原来每仓仓根的 `.fleet/flow.json` 和对账同步随 #556 删了）。它是写码会话交活要原样跑的那一条（起会话时记进 `session_runs.test_command`，交活核对只认它，`packages/store/src/done-check.ts`），所以只放会话跑得过的——只跑改动影响到的测试，不放全量检查、卫生检查（那两样慢，也不是「这段代码对不对」：卫生检查归推前钩子和引擎推分支时自己的扫描）；fleet-dao 是 `pnpm test:changed`。
  - **卫生检查只管 fleet-dao 这一个仓**（创始人 2026-10-01 10:50 前后拍：「1-1，但是除了这个仓库，其他仓库不要拦（按照其他仓库自己标准）」）：别的仓（受管的仓里可以有别人的）推分支、写需求文档、开 PR、写单子和评论时都不套这套规则，按那些仓自己的标准。认哪个是它写在 `packages/github/src/hygiene-scope.ts` 的 `HYGIENE_REPO`（默认 `thoerwink8/fleet-dao`，owner、name 都比、大小写不算差别）；测试夹具的仓不是它时，在 `createGitHub({ hygieneRepo })` 上传一份。**认不出是哪个仓（没给 owner/name）明确报错**（`HYGIENE_SCOPE_UNKNOWN`），不默认放过去、也不默认拦下来。
  - 派活不再看流程配置副本（#556 删了）：「让 AI 接活」只剩 `repos.auto_dispatch_since` 一个开关，开着，引擎每 5 分钟拉一次该做的单（`intake` 定时任务，#632）；单的交代不全、没有可用路由，工作流停下等人，提醒里报原因。核对：`sudo -u fleet psql fleet -c "select owner, name, test_command, auto_dispatch_since from repos"`。
  - 带 GitHub 账号的成员：白名单按 `users` 表认 GitHub 作者（有数字编号只按编号认），创始人那一行补上 GitHub 的数字编号和登录名，两个机器人各加一行 `role = 'bot'`（编号是 `<App 的 slug>[bot]` 这个用户的编号，不是 App 的编号）；数字编号用 `gh api users/<登录名>` 查：`sudo -u fleet psql fleet -c "update users set github_id = <编号>, github_login = '<登录名>' where id = '<创始人那一行的 id>' and github_id is null"`、`sudo -u fleet psql fleet -c "insert into users (display_name, role, github_login, github_id) values ('<slug>[bot]', 'bot', '<slug>[bot]', <编号>) on conflict (github_id) do nothing"`。
  - 加完等下一轮对账（每 15 分钟，没有手动触发的命令），已经开着的单这一轮就补进来。
- 受管的仓就是库里 `repos` 表的行，别的仓的事件一律不收。「让 AI 接活」开关是 `repos.auto_dispatch_since`：空 = 关着，只收单（建任务行）、不拉起工作流。打开后，引擎拉单（第五节「拉单」）自己按依据挑开着的独立单（别的版本、未排期的也在内）；开关打开以前开的老单，要贴了「整理过」（整理待办的会话判为仍成立）或「交给引擎」才拉，没贴的不拉；贴了「待补」「要人拍」的任何单都不拉。母单、子单、贴了「本机做」的不拉（两个标签一起贴以「本机做」为准）。#282（驾驶舱「交给 fleet」按钮）被「交给引擎」取代（2026-10-08）：按钮不做，没有 `fleet-api handover`。拉起来的是三段一条龙工作流；fleet-dao 和 fleet-dao-canary 现在已打开（创始人 2026-10-07 过夜放行），发版前后保持原样（发版车和驾驶舱按钮发完恢复到发版前，见下面「发完恢复到发版前的开关状态」）。开关用上面的 `fleet-api dispatch`，别直接改库：直接改的不进操作记录。

两台同一份（飞书网关的通行证）：法国生成，原样拷到香港，值不过屏幕。香港那头先落临时名，收到的不是完整的一行通行证（法国那头没读成、传到一半断了、读到的是报错）就不换，原来那份原样留着：

```
# 在能同时登两台的机器上
ssh <法国> 'cat /etc/fleet-dao/gateway-token.env' | ssh <香港> 'f=/etc/fleet-dao/gateway-token.env; t=$(mktemp /etc/fleet-dao/.new.XXXXXX); if cat > "$t" && grep -qE "^FLEET_FEISHU_GATEWAY_TOKEN=[0-9a-f]{64}$" "$t" && chown root:fleet "$t" && chmod 640 "$t"; then mv "$t" "$f"; else rm -f "$t"; echo "没换：收到的不是完整的通行证" >&2; exit 1; fi'
# 核对：比指纹，不看值
ssh <法国> 'sha256sum < /etc/fleet-dao/gateway-token.env'; ssh <香港> 'sha256sum < /etc/fleet-dao/gateway-token.env'
```

目录配置（仓里的 `deploy/catalog.json`：族、渠道、账号池、模型、路由）：它就是真文件，跟着版本走（#1286，删掉了原来放在法国 `/etc/fleet-dao/catalog.json`、经保险箱放上去那一层）。发布时迁移之后，装的是要发的那一版自己带的那份——加模型、加路由就是改这个文件、开 PR、合进主线、发版，不用谁在电脑上解密、再放到法国。目录里没有账号、邮箱、组织编号（测试盯着）。法国上早先放的 `/etc/fleet-dao/catalog.json` 发布不再读，留着无害。

- 账号池的 `runAsUser` 只收 `fleet-agent-carpool`（法国只留一个会话用户，2026-09-26 起），Claude 订阅池还要带 `orgKind`（`carpool` / `solo`，照这份文件里的写法）。
- 发布时迁移之后装进库（上面第 4 步）：只补缺——库里没有的行插进去；已有的行只补空着的会话用户、组织类型（`orgKind`）、到期日、上游名字，别的字段配置和库里不一样也不动（发布日志里一处一行，照实写成「没动：pools.claude-solo.maxConcurrency：库里是 3，配置是 4，没动」这样）；每个阶段只排一次。
- 这一版没带 `deploy/catalog.json`（比这次改动更老的提交；老版本把它放在服务器上，那样的老提交不再能直接发）、它是符号链接、装不成（格式错、引用不存在、撞硬禁令）、装完读不回，发布都停下、不切版本、报红；装完账号池、路由哪张是 0 行也一样。装不成时发布再读回一次，红里写明库和装之前一样、库变了要人看，还是没查成。同一版再发，这一步改动 0 处。
- 装进去之后怎么改。这份文件里已有的行改了值，已经装进库的不跟着变；新加的行发布时会装进去（下面第二条）：
  - 渠道的开关在驾驶舱里改。用途的先后、模型的开关是路由两层（下面那条）的事，不在这份文件里。
  - 往这份文件里新加的渠道、池、模型、路由：发布时装得进库，但要派活还得挂进路由两层（下面那条），不会自动挂上。新加的模型和路由在骨架里先关着（`enabled: false`）、不进任何用途的顺序，不改现有派活。模型串必须是渠道真认的串（Mirasim 的执行体按名册帧的 agent 或上游串前缀判，认不出的不派，#1357）；查得到官方价的写进 `packages/shared/src/model-prices.ts`，明确没有 token 价的写进 `NO_PRICE_MODELS`；没登记的按未知单价显示，不当 0，不编价。
  - 已有池的并发这类字段：装载器不改已有的，驾驶舱也改不了，只能在法国库里直接改（不进操作记录），例如把独享号的并发改成 3：`runuser -u fleet -- psql -d fleet -c "update pools set max_concurrency = 3 where id = 'claude-solo'"`。改完把这份文件也改成一样，换机重装时才不会装回旧值。
- 路由两层（#574：用途 → 模型顺序、模型 → 路由顺序，表 `routing_purpose_models`、`routing_catalog`）：默认骨架是仓里的 `packages/db/routing.default.json`（里面只有模型 id 和路由 id，和这份目录用同一套 id）。发布时装完目录接着装（`packages/db/src/bin/routing.ts`，上面第 4 步）：骨架只做新装机的初始值（#1356）。库里 `routing_purpose_models` 还没有任何一行时，按骨架把每个用途的模型顺序、每个模型的路由整份写一次；已经有任何一行，就不再往用途里补模型、不再改开关、不再追加路由（创始人在页面上删掉的留着）。发布日志在空库写成「补了用途 → 模型几行、模型 → 路由几行」，已经有用途行就写「路由两层已齐，这次一行没改」，再读回两张表的行数。骨架读不到、格式错、引用对不上（骨架里的模型、路由库里没有：多半是这份目录里没有那条路由），或把只有创始人本人能开的模型（Fable，决定 0033）配进用途、写成开着，装载器一行不写、退出 1，发布停下、不切版本、报红，红里写原话和读回核对的结果；装完哪张是 0 行也一样。同一版再发写「路由两层已齐」。骨架里的路由 id 要和这份目录对得上，改了目录里的路由 id 要一起改骨架。
  - 选路、路由探针、切号都按这两张表（#574 起）：先按用途的模型顺序、再按模型下的路由顺序挑；开关在模型下的那一行上、不分用途，关了哪个用途都不派它，探针也不探（模型没排进任何用途的路由同样不探）。两层没有「钉住」。
  - 装进去之后要改：驾驶舱登录后改（先后、开关、把目录里的模型加进用途、移出、改这个用途下的档位），每次进操作记录。发版不再把骨架补回删掉的模型，也不改开关。换一台空机器才按骨架写初始值。

往香港传静态文件的钥匙：法国 `/etc/fleet-dao/web-upload.key`（root 600，france.sh 生成）；香港 root 的 `authorized_keys2` 里那一行限死成 `from="10.99.0.2",restrict,command="/usr/bin/rrsync -wo -munge /srv/fleet-dao-web"`：只许从隧道地址来、不给终端、只能往这一个目录写、读不走任何东西。`-munge`：传来的符号链接落地时改成无效的样子，法国 root 失守也没法借链接让 nginx 读出目录外的文件。香港 sshd 的主机钥匙由 france.sh 经隧道取来钉住（隧道两头靠 WireGuard 钥匙互认），发布时只认这一把。

健康页 `https://<驾驶舱域名>/health/`：

- 读 `/healthz`：香港经隧道转给法国驾驶舱后端，后端逐项探库、Temporal……，全好回 200、有一项不好回 503。每 15 秒刷新。公网 `/healthz` 在香港限流：每个来源每分钟 30 次、突发 10 次，超了回 429（健康页照样报红，写明是限流）。
- 功能还没做的项报「未接」（`{ ok: true, status: "not_wired", message }`，message 带单号，比如飞书草稿开成 issue 的 #91）：不算失败、不让 `/healthz` 变 503，健康页写成「未接：…」、灰点；只认装配时的标记（`HealthCheck.notWired`，由「没接上的那个实现」自带，比如 `notWiredDraftOpener`），检查跑出来抛什么都判不成未接，接上以后读不到、出错照样红；健康页对样子不完整的「未接」（缺原因、status 认不出）也判红。驾驶舱同一个做法：还没做的一块整块显示「待实现」占位（阶段 + 单号，链到单，`components/not-built.tsx`），不把「没读到」说成「没查成」「离线」；接上了就去掉占位，之后读失败照实显示「没查成」。额度读取（#76，引擎 `quota-read` 每 15 分钟读进库）和路由探针（#129）都已接上，额度页、调度台顶上显示的是库里真的读数和在线状态。
- 判断题（`judge` 项，健康页写「判断题」）：`/etc/fleet-dao/jev.json` 在不在定「未接」——后端起来时看一次，没写 `FLEET_JEV_CONFIG`、默认位置上又没有才算未接，补上文件要重启 `fleet-api` 才显示出来。有了就每次探，判法和引擎每次提问是同一份（`packages/jev` 的 `wiring.ts`）：配置读不出来、认不出，调度台判断阶段没有开着的路由，钥匙读不到，报红（`judge_config`）；最近一次真发给上游的调用没成报红（`judge_failing`），下一次调成了自动变绿。原因只进 `journalctl -u fleet-api`（哪道题、为什么、上游原文）；引擎那边起来时登记两道题的结果、每次起不来的原因在 `journalctl -u fleet-engine`。
- 跟上主线（`deploy_lag` 项）：自动发布单元在不在跑、读数新不新、规矩和装机自动档成没成；落后主线几个只是读数、不算红，判法见本节末尾「自动发布」的读数。
- 飞书网关（`feishu_gateway` 项）：香港的网关还来不来。网关带通行证调飞书接口，后端在门口记下每条接口最后一次来的时刻（只在进程里）；好的时候写「推送轮询 12 秒前来过，盘面快照 22 秒前来过」，推送轮询 5 分钟没来报红（`silent`），后端刚起、网关还没来过报「没查成」（`unchecked`，一般半分钟内就好），没配网关通行证报「未接」。判法在 `packages/api/src/gateway-seen.ts`；网关那边自己的心跳和报警见第十二节。
- 会话账号切换（`session_org` 项，健康页写「会话账号切换」）：引擎切会话用户挂的组织出了要人看的（第五节「会话用户挂的组织」那四种 `session-org:*` 提醒，含组织读数变了、引擎没切过号的 `session-org:drift`）就红，对外只说「会话账号切换有要人看的问题」，是哪一条只进 `journalctl -u fleet-api`；提醒撤了自己回绿。判法在 `packages/api/src/session-org-health.ts`。
- GitHub 机器人权限（`github_app` 项，健康页写「GitHub 机器人权限」）：引擎每小时对账自检两个机器人的权限，缺的、多了不该有的、没查成的开着 `github-app:*` 提醒就红（第五节「每小时对账」），对外只说「GitHub 机器人的权限有要人看的问题」，哪个仓、缺哪样只进 `journalctl -u fleet-api`；权限改好、提醒撤了自己回绿。判法在 `packages/api/src/github-app-health.ts`。
- 全流程巡检（`canary` 项，健康页写「全流程巡检」）：最近一轮巡检的结论和时间（第五节「全流程巡检」）。通过、而且 12 小时内通过过：绿，写「最近一轮 09-27 20:26 通过（用时 43 分钟）」；最近一轮断了（写断在哪一步）、巡检自己没跑成、一轮过了 5.5 小时还没有结论（巡检自己没收尾）、12 小时没通过一轮、一轮都还没跑完：红。断的原因原文只进 `journalctl -u fleet-api`，细节看卡住报警。不在法国的正式机器上报「未接」。判法在 `packages/api/src/canary-health.ts`。
- 看门狗（`watchdog` 项，健康页写「看门狗」）：引擎的看门狗自己在不在按期跑（第五节「看门狗」），按登记表上它那一行现算。最近一轮跑完、15 分钟内：绿，写「最近一轮 09-27 20:26 跑完：查了 7 个定时任务，都按期跑成」（或「1 个没按期跑成」，是哪个看提醒）；刚登记还没跑完第一轮：绿、写明；最近一轮没跑成、过了 15 分钟没跑完一轮、从没跑过、没登记、最近一轮一个定时任务都没查到：红（后端同时推一条「看门狗停了」）。没跑成的原因原文只进 `journalctl -u fleet-api` 和那条提醒。不在法国的正式机器上报「未接」。判法在 `packages/api/src/watchdog-health.ts`。
- 必看三项：数据库、Temporal、引擎工人。只有后端明说在线的才绿；连不上（香港回 502、504）、回的不是健康报告、后端没报这一项、后端的结论和逐项对不上，一律红，并写明是哪一种。判定在 `deploy/web/health/health.js`，`deploy/test/health-page.test.mjs` 把每一种「没查成」都造了一遍。
- 从公网打开的，健康页和占位页上都不写仓名、GitHub 账号名和地址（设计文档第十四节），也不显示版本号（`release.json` 公网上读不到）。`deploy/test/public-site.test.sh` 拿公开页的禁词名单扫发布脚本生成的这几页；改了文字，下次发 `web` 才到香港。
- 香港转发时清掉 `Authorization`、`X-Fleet-Acting-Feishu`。france.sh 的读回从公网带着这两个头请求 `/api`，核对法国收到的请求里没有：后端没在跑时在隧道地址上临时起回显直接看，后端在跑时看它答的是「没登录」。

还欠（发布这块）：构建以 fleet 身份跑，构建期间的第三方代码（前端构建工具等）读得到 `/etc/fleet-dao` 里 fleet 能读的全部密钥。换成读不到 `/etc/fleet-dao` 的专用构建用户要动装机（新用户、它的 pnpm、属主交接），留到下一轮（#79）。现在挡着的：pnpm 11 默认不跑依赖的安装脚本，只跑 `pnpm-workspace.yaml` 的 `allowBuilds` 放行的（现在一个都没放行），所以装依赖这一步第三方代码不执行；前端构建那一步照样会执行构建工具的代码。

### 自动发布

`fleet-auto-release`（design 第三节第 42 条）。**2026-10-07 起只读不发**（决定 `docs/decisions/0032-release-by-main-commit.md` 第 1、2、5 条、#1258）：发布只走驾驶舱「发布到法国」按钮（发版车同一趟流程，见下一节），这个单元**不再自己发版**——不调 `release.sh`、不看 `v<N>` 版本标记、不按「人手动切过」「发过没成」去拦谁。以前（2026-10-02 到 10-07）它按版本标记找要发的版本，没有标记就不发，那一整套（挑标记、标记那一版的 CI 闸、人按住 24 小时、没成隔 30 分钟重试、等引擎空闲、发布四步的记录）都删了；由来和旧写法见本节末尾和 git 历史。

- 怎么跑起来：`fleet-auto-release.timer` 每 5 分钟（上一轮跑完再等 5 分钟，不叠着跑）以 root 拉起一轮 `/usr/local/lib/fleet-dao/auto-release/fleet-auto-release.mjs`。一轮最多 30 分钟（`TimeoutStartSec`；最长的是装机自动档 10 分钟和规矩同步每个用户 5 分钟）。
- 每一轮读什么、写什么：读主线头和最近 300 个提交（`git fetch` 只取 `main`、不取 tag）；主线头自己那次 `ci.yml` push 的结论（一轮最多问一次 GitHub，不带凭据一个钟头 60 次；这个头已经读到全绿就不再问；限流、连不上、回的认不出记 `unknown` 和原因，不当成绿）；法国在用的提交（`current` 链接）；落后几个（在用的在主线最近提交里排第几，和驾驶舱「落后主线 N 个提交」同一个口径）；装机层装到哪、配置对账。写进 `/srv/fleet-dao-releases/.auto/state.json`（`schema: 1`；字段 `main`、`ci`、`current`、`last`、`rules`、`tier`、`system`、`config`、`alerts`……）。以前的 `marker`、`markerError`、`attempt`、`hold`、`waitingSince`、`sequence` 没有了；后端（`packages/store/src/deploy-lag.ts`）和指挥官的法国页（`agents/skills/commander/scripts/france-lib.mjs`）读到老状态里多出来的这几样也认，不报错。**没有任何 `v<N>` tag 的仓上读数照常**（以前会因为没有标记写成「不发」；测试 `deploy/test/auto-release.test.mjs` 第一条是故意造的失败）。
- 「这一轮」`last.action`：`up-to-date`（在用的就是主线头）、`behind`（落后几个）、`not-in-recent`（在用的不在主线最近 300 个提交里）、`not-released`（还没发布过）、`main-unreadable`、`current-unreadable`（读不到，原因留着，不拿上一次的当这一次的）。主线或在用的读不到时，装机自动档和规矩同步这一轮不做。
- **落后几个提交不是毛病**：发布只走按钮，没人点就不会上线，报警只会天天挂着。所以 `deploy_lag` 和后端的「线上版本跟不上主线」报警不再因为落后、CI 红、在用的不在主线上而红，落后几个只在驾驶舱版本项、`--check` 的读数里显示。
- 状态文件读不出（不是 JSON、格式版本不对、读不了）：这一轮什么都不做、不覆盖它（里面有没发出去的报警队列，从空的起会丢掉），报 `auto-release:state-unreadable`；人挪走它（`mv … state.json state.json.bad`）后下一轮从空的起、这条自己撤。
- 单元还会发版那会儿开的报警（`auto-release:failed:`、`pending:`、`post-off:`、`marker:`、`marker-unreadable`、`engine-unknown`）：新版**第一次跑那一轮全撤一遍**（状态里 `retiredCleared` 记着做过了；撤不成——库连不上——下一轮接着撤），没发出去的丢掉。不撤的话库里开着的这几条会永远挂在驾驶舱上，没人再有机会解除。
- **发布那一刻的四步**（决定 0011 第 4 条原话：「github actions 通过后可以暂停派活，然后引擎手头活都干完后，自动部署到引擎，然后接着进行活和派活」，0032 保留这个流程、去掉「按版本」）：**停派活 → 等在跑的收尾 → 部署 → 恢复派活**。这四步**复用已有的排空协议**（`packages/engine/src/drain-control.ts` + `.drain-request`），不新加全局开关、不加库里的列、不加迁移：
  - 停派活 = release.sh 发布一开始写的排空请求 `/srv/fleet-dao-releases/.drain-request`（引擎每 5 秒看一眼，认了马上不起新会话）；
  - 等在跑的收尾 = release.sh 读引擎的 `drain.json` 数还在跑的会话，等到截止（有上限，到点照实报、不硬切）；
  - 部署 = release.sh 迁移 + 切版本 + 健康检查（不过自动退回）；
  - 恢复派活 = 切完撤掉排空请求（引擎下一眼就接着派），新引擎起来按编号续上停下的会话。
  引擎关着时（`FLEET_SERVICES` 里没有 `fleet-engine`：法国 2026-09-29 到 2026-10-05 关过，之后改成待命、引擎开着，见 `deploy/france/desired-config.json` 和第九节「引擎待命」）这四步**一步都没跑**，release.sh 不写排空请求；引擎开没开着按 `systemctl is-active fleet-engine.service` 判（release.sh 的 `has_service`）。（自动发布单元以前在状态文件里记这四步「做了」还是「跳过（引擎关着）」，随它不再发版一起删了。）
- **发完恢复到发版前的开关状态**（决定 0032 第 4 条、#1256；取代「里程碑发版置关接活开关」#1050 和「每次发版置关总开关」#1086——那两条创始人 2026-10-05 的原话「每次更上去处于关闭状态，点击开启」说的是按版本的发法，提交一级发版会很频繁、每次都要人点，引擎就白停；他 2026-10-07 夜改成「main new commit 发版」，0011 第 4 条原话「github actions 通过后可以暂停派活，然后引擎手头活都干完后，自动部署到引擎，然后接着进行活和派活」照走）：`release.sh` 发完**不碰**引擎总开关（设置 `engine.master`，驾驶舱环境页点开关，命令行 `fleet-api engine on|off|status`）和各项目的「让 AI 接活」，直接跑它（手动）本来就没暂停过它们、原样留着。暂停和恢复在发版车（`release-train.mjs`）和驾驶舱按钮的接活脚本（`deploy/france/release-request`）里，两边沿用同一份进度记录（`before`）：第 2 步暂停法国时记下总开关和（发版车）各仓开关，第 7 步发完、`release.sh --check` 和验证都过了，按记下的恢复——**发版前开着的开回（`fleet-api engine on --reason "发版后恢复发版前的状态…"`，开关和操作记录同一事务）、发版前关着的保持关**（发版期间被人开了的也不再关回去）。没过健康检查、发版车卡在等部署或验证的，不恢复，引擎还关着等人看。恢复没成（读不到总开关、开不回去、读回来还是关着、进度记录里没有发版前的状态）是**没成，不当成成功**：状态记 failed、发版车退出码 2、驾驶舱法国页红着写「恢复没成：发版已经发出去了…」，到驾驶舱环境页点开或 `fleet-api engine on`；发版车同一个目标再跑一次 `start` 只重试这一步。上一回点发布停在「卡住」（会话没收完、引擎是脚本关的）再点一次，发版前开着的从上一回的进度记录带过来，不会把它当成「本来就关着」。`release-train.mjs --restore` 保留，和不带一样（默认就恢复，不再要创始人在原话里逐次授权，因为只是还原）；`abort` 在还没发版时把总开关开回暂停前的样子，已经动手发过版的保持关（不知道发成没有）。关着的时候引擎进程照常开着待命：拉单、起任务停，路由探针（每 15 分钟起一个最短的模型会话）和读额度照转；总开关关着时拉单、巡检、选路派活、起干活的会话都停，路由探针、读额度、拼车盯读、对账、看门狗照跑，已经在跑的会话做完这一步，不腰斩。手动关全部项目：`fleet-api dispatch --all off --reason "<原因>"`（没有一键全开）。**注意**：驾驶舱按钮的接活脚本在法国装的是副本（人工档，`deploy/france.sh` 整套由 root 跑才更新），主线合了这一条之后，法国要等人重跑一次整套，按钮那一路才换成新的恢复；换之前按钮那一路发完仍是关着（旧行为，不会坏）。判法和自测：`agents/test/release-train.test.ts`、`deploy/test/release-request.test.mjs`（发前开着→发完开着、发前关着→发完仍关着、恢复失败→报警各一条，`release.sh` 里不能再有置关的函数和命令也有一条）、`deploy/test/release-flow.test.sh`。
- 发布前排空（`packages/engine/src/drain.ts`、`drain-control.ts`；像 k8s 先 cordon 再 drain）：release.sh 取到要发的提交、构建之前就写排空请求 `/srv/fleet-dao-releases/.drain-request`（要切到的提交、截止），引擎每 5 秒看一眼，认了马上不起新会话（选路回「过一会儿再选」，驾驶舱每张单写着在等发布；在等额度、空位、人的单子不受影响）、推一条提醒「在为发布排空：最晚几点照发」；在跑的会话接着做手上这一步，最多再做 10 分钟宽限（和构建一起走），到点没做完的由引擎按切号那一套停下（交回 `engine_stop`，失败分流 KL3 不记账、新引擎起来按编号续同一个会话）。release.sh 等引擎手上没会话了（读 `/var/lib/fleet-dao/engine/drain.json`，进程号对上 systemd 的主进程才信），在迁移之前停引擎、撤请求，迁移、切版本，新引擎起来接着派、撤掉提醒。发布没走到切版本（香港不通、迁移没成……）：撤请求、把停下的引擎照原样起回来，马上接着派。请求只在发布锁占着时算数：release.sh 中途没了，引擎不会一直停着不派。人手动发、退回同样排空；急修、急退加 `--now`（不给宽限，马上停下、按编号续上）；新版没过健康检查自动退回时也不给宽限。停机信号（人手动 `systemctl restart fleet-engine`、关机）同样先排空：`fleet-engine.service` 是 `KillMode=mixed`（停机信号只发给引擎主进程，不经 sudo 转给会话；2026-09-27 19:28:51、20:46:26 两次发布就是这样白杀了在干的活）、`TimeoutStopSec=15min`；再发一次停机信号马上停。
- 发布不碰会话（现状，#901 修正）：原来老 Fusion 会话端口做过「会话脱开引擎进程跑、重启后接回」（收发目录 `/var/lib/fleet-sessions/`、接回记录 `meta.json`、`session_runs.output_seq`，2026-09-28 凌晨拍），那条端口早已没有调用方，随 #901 删了；三段会话（动手、验收）从来没脱开：它们挂在引擎起的 scope 里，发布前排空到截止会把它们停下（这一段交回 `org_switch`，新引擎起来在原分支上重跑，#957），引擎起来接活之前由 `reapOrphanSessions`（`packages/engine/src/real/orphan-reap.ts`）收上一轮留下的 scope、临时目录、没收场的 runs 行、预占的名额。`packages/adapters/src/detached.ts`（收发目录读写）还在、没人用；要不要给三段会话也做脱开是创始人的事（`docs/goals.md` H 节「发布不打断在跑的会话」那一行）。`/var/lib/fleet-sessions/` 现在是空目录（france.sh 还在建它）；原来「根目录不对」的那条提醒（`engine-session-io`）不再产生，引擎起来时会把库里还开着的撤掉。发布前排空这一段：release.sh 取到要发的提交、构建之前就写排空请求 `/srv/fleet-dao-releases/.drain-request`（要切到的提交、截止），引擎每 5 秒看一眼，认了马上不起新会话（选路回「过一会儿再选」，驾驶舱每张单写着在等发布；在等额度、空位、人的单子不受影响）、推一条提醒「在为发布排空：最晚几点照发」；在跑的会话接着做手上这一步，最多再做 10 分钟宽限（和构建一起走），到点没做完的由引擎按切号那一套停下（交回 `engine_stop`，失败分流 KL3 不记账、新引擎起来按编号续同一个会话）。release.sh 等引擎手上没会话了（读 `/var/lib/fleet-dao/engine/drain.json`，进程号对上 systemd 的主进程才信），在迁移之前停引擎、撤请求，迁移、切版本，新引擎起来接着派、撤掉提醒。发布没走到切版本（香港不通、迁移没成……）：撤请求、把停下的引擎照原样起回来，马上接着派。请求只在发布锁占着时算数：release.sh 中途没了，引擎不会一直停着不派。人手动发、退回同样排空；急修、急退加 `--now`（不给宽限，马上停下、按编号续上）；新版没过健康检查自动退回时也不给宽限。停机信号（人手动 `systemctl restart fleet-engine`、关机）同样先排空：`fleet-engine.service` 是 `KillMode=mixed`（停机信号只发给引擎主进程，不经 sudo 转给会话；2026-09-27 19:28:51、20:46:26 两次发布就是这样白杀了在干的活）、`TimeoutStopSec=15min`；再发一次停机信号马上停。
- 演示版已删（#1223）：`--auto` 和人手动发布一样，没有「只核对、不发」那一档；香港上老的 `/demo/` 目录按本节发静态文件那一步删、读回 404。驾驶舱静态文件（`web`：明写进 `release.env` 那一步就是对外发布，要先告诉创始人）、飞书网关跟后端同一版。
- 发完装机的自动档（`deploy/france.sh --auto-tier`；`lib.mjs` 的 `tierStep`，在同步规矩之前）：驾驶舱按钮发完一版，检出和在用的就对上了，下一轮单元看到「在用的版本和检出对上、这个提交还没装过」，就以 root 跑检出里的 `bash deploy/france.sh --auto-tier`——只装自动发布脚本副本（`/usr/local/lib/fleet-dao/auto-release/`）和它的两个单元、`fleet-agents.slice`、清老机器上已删的演示版单元（`retire_old_units`，#1223），每步幂等；**不碰**防火墙、sudoers、建用户、`/etc/fleet-dao` 里的钥匙和环境文件（那是「人工档」，实现都在 `deploy/lib/human-tier.sh`，只在人跑整套 `bash deploy/france.sh` 时做）。没成就记下、报警（`auto-release:tier:<提交号>`），同一个提交最快隔 30 分钟再试，成了的不重跑，成了自动撤警。规矩同步仍由下一条那一步做，不在自动档里。自动档整个落地后，主线上改自动发布脚本、单元文件、slice 不用人重跑 france.sh。**这套第一次生效要人以 root 整套跑一遍 `bash /srv/fleet-dao/deploy/france.sh`**（法国上装着的自动发布副本还是旧的、没有这一步），之后人工档的文件没变就不用再跑。
- 发完同步规矩（跟着发出去的那个提交走，不跟主线头）：在用的版本和检出对上、这个提交还没同步过，就以 root 对 `fleet-agent-carpool`、`pilot` 各跑一遍 `node /srv/fleet-dao/packages/agents-sync/bin/agents-sync --apply --user <用户>`（和 france.sh 最后那步同一条、同一份名单，第五节）。没成就记下、报警；同一个提交不重跑，下一个提交再来；要马上补就手动跑那条命令。
- release.sh 的退出码：0 全绿；1 有红（含「没过健康检查、已自动退回」）；2 切上去了、有待配或没查成；以前还有 75、76（`--auto` 才有：另一个发布在跑、会话在跑，什么都没动；#1272 随 `--auto` 一起删了）和 3（发布成了、只是发布后的收尾没成；#1256 删了发版后置关以后没有调用方），#1258 把 `post_alert` 出口和单元那头的处理（`auto-release:post-off:`）一起删了。
- 发布没成怎么办：release.sh 退出码是 1（有红，含「没过健康检查、已自动退回」）等其余的：照 release.sh 的日志（`/srv/fleet-dao-releases/.logs/`）和驾驶舱法国页查；修好后再点一次「发布到法国」，或在法国以 root 手动发：`bash /srv/fleet-dao/deploy/release.sh <提交号>`。没有自动重试了（以前的「隔 30 分钟重试最多 2 次」随单元不再发版删了）。
- 报警（驾驶舱提醒，飞书跟着推）：这个单元当场报的只有：规矩同步没成（`auto-release:rules:<提交号>`）、装机自动档没装成（`auto-release:tier:<提交号>`）、配置和期望不一致（`auto-release:config:<文件>:<键>`，一项一条）、配置没查成（`auto-release:config-unchecked`）、状态文件读不出（`auto-release:state-unreadable`）；好了自动解除；库连不上时留到下一轮再发、再撤，不丢。其余的不对由后端每 5 分钟判一次（和下面 `deploy_lag` 同一个判法），开一条「线上版本跟不上主线：…」，好了解除——单元自己停了、没装、跑崩了，只有后端看得出来。
- 读数：后端 `/healthz` 的 `deploy_lag`（健康页写「跟上主线」），读的时候现算：`current` 链接（在用哪版）、发布历史 `.history` 里这一版切上去的时刻（驾驶舱提醒「法国已发布」用，读不到是 null）、单元每一轮写的 `state.json`。
  - 当场红：读数读不到、认不出；单元 20 分钟没报到；主线头 20 分钟没读到（单元停了时只报「没报到」一条）；在用的读不到；还没发布过；规矩同步没成、同步到哪没读到；装机自动档没装成。
  - **不红**：落后主线几个提交、主线头的 CI 红或结论读不到、在用的不在主线最近 300 个提交里。（以前这几样按「落后多久」红，按版本发时还按版本标记数；发布改走按钮以后没有人会自动去发，所以不再报。）
  - 装机层只有「人工档」会红：整套 france.sh 跑完没红时把装到的提交记进 `.auto/france-applied`；之后主线上人工档那几个文件（`deploy/lib/human-tier.sh`、`deploy/france/fleet-dao.nft`、`fleet-firewall.service`、`sudoers-fleet-dao`、`fleet-agent-scope.sh`、建用户的 `deploy/lib/session-user.sh`、`login-user.sh`、`session-ports.sh`、驾驶舱按钮的接活脚本，清单在 `deploy/france/auto-release/lib.mjs` 的 `HUMAN_TIER_PATHS`）改过、一天以上没重跑整套，红，写明要人重跑（它碰防火墙、sudoers、建用户，不自动跑）。其余装机步骤（自动发布单元的脚本副本和单元、`fleet-agents.slice`、清老单元的 `retire_old_units`、Mirasim 常驻单元 `fleet-mirasim-session.service`）是「自动档」，改了**不红**：见上一条。
  - 公网看得到 `/healthz`：对外的话不带提交号和路径，细节在 `release.sh --check` 列出的「自动发布」那一段和报警正文里。不在法国的正式机器上（开发、测试）报「未接」。
- 看：`bash /srv/fleet-dao/deploy/release.sh --check` 列出的「自动发布」那一段（定时器在不在跑、上一轮什么时候、主线头和它的 CI、在用的落后几个、这一轮读到了什么、规矩同步到哪、装机自动档和装机脚本装到哪）；`journalctl -u fleet-auto-release -n 30`（每轮一行读数）；`systemctl list-timers fleet-auto-release.timer`；发布日志在 `/srv/fleet-dao-releases/.logs/`。
- 停、开：`systemctl disable --now fleet-auto-release.timer` 停（在跑的那一轮照样跑完；20 分钟后 `/healthz` 报自动发布没报到，该报）；`systemctl enable --now fleet-auto-release.timer` 开；马上跑一轮：`systemctl start fleet-auto-release`（别直接跑那个 `.mjs`：两轮叠着跑会互相盖读数）。停着不影响发版（按钮不经它），只是读数不更新、发完版不自动装自动档和同步规矩。
- `release.sh` 的 `--auto`、`--busy-ok` 已删（#1272；原来只给自动发布单元用，单元 #1258 起不再调 release.sh）：再传是用法错（退出 64、什么都不做）；历史行不再带 `auto`，旧历史里已有的 `auto` 标记没人读。
- 由来（2026-09-27）：这之前合并后没有东西发布，全靠人以 root 跑 release.sh；法国跑的版本落后主线 40 个提交、14 个小时，健康检查只看在用的那版自己好不好、不和主线比，没人发现。当时做了定时自动发布（照拉取式持续部署：机器自己定时拉、持续对齐；一个提交只试一次、没成不重试；人手动退回时自动的不跟人抢；单机 systemd 定时器加自动退回），同日夜里改成沿主线往回发最新的全绿提交（主线合并太密、头的 CI 总在跑）。**2026-10-02**（`specs/618-发布按版本停派/需求.md`，决定 0011 第 3、4 条）改成按版本标记发、创始人确认。**2026-10-07 夜**（决定 0032）：创始人「里程碑发版完全没必要？只需要 main new commit 发版就行了」——发布只由驾驶舱按钮（或发版车）发，这个单元只留读数；- 由来（2026-09-27）：这之前合并后没有东西发布，全靠人以 root 跑 release.sh；法国跑的版本落后主线 40 个提交、14 个小时，健康检查只看在用的那版自己好不好、不和主线比，没人发现。当时做了定时自动发布（照拉取式持续部署：机器自己定时拉、持续对齐；一个提交只试一次、没成不重试；人手动退回时自动的不跟人抢；单机 systemd 定时器加自动退回），同日夜里改成沿主线往回发最新的全绿提交（主线合并太密、头的 CI 总在跑）。**2026-10-02**（`specs/618-发布按版本停派/需求.md`，决定 0011 第 3、4 条）改成按版本标记发、创始人确认。**2026-10-07 夜**（决定 0032）：创始人「里程碑发版完全没必要？只需要 main new commit 发版就行了」——发布只由驾驶舱按钮（或发版车）发，这个单元只留读数；版本标记那一层（`publish:pr`、`release.yml` 打标、`/api/release/version`）已由 #1257 删。来源和对比写在各自的 PR 里。

### 驾驶舱「发布到法国」按钮（人工档，#1232）

创始人在驾驶舱「法国」页「在用版本」那一行点「发布到法国」（#1255，那一行写落后几个提交、要发的主线头；弹窗里写明要发的提交、CI 绿、带哪几个 PR、发完引擎总开关恢复到发版前），就是「对外发布」那一道人闸的同意（创始人 2026-10-07 约 19:30 在对话里同意这个设计）；这一点击在操作记录里记一条（谁、哪个提交、原话「驾驶舱点击发布」，动作 `release.request`）。
- 后端（fleet，没有 root）只收一个参数「提交号」，核它等于此刻主线头、主线 CI 是绿的、法国在用的不是它、没有发版在走，然后往 `/var/lib/fleet-dao/release-request/request.json` 写一份 `{v,sha,at,by}`，**自己不起任何带 root 的进程**。请求目录归 fleet（750），`fleet-api.service` 的 `ReadWritePaths` 放行它。
- root 的 `fleet-release-request.path`（`PathExists=` 请求文件）拉起 `fleet-release-request.service`（以 root 跑 `/usr/local/lib/fleet-dao/release-request/fleet-release-request.mjs`，源在 `deploy/france/release-request/`）。脚本把请求只当数据读：符号链接、超 1024 字节、键不对、提交号不是完整 40 位小写十六进制、不是主线的祖先、发布锁被占着或进度记录说有发版在走（进程还活着）、主线 CI 不是绿的或读不到，一律拒，原因写进 `/srv/fleet-dao-releases/.train/last-request.json`（驾驶舱读它告诉点的人），不动进度记录。读完马上删请求文件。
- 过了核对就走一趟和 `release-train` 同样的发版：暂停法国引擎总开关 → 等在跑的会话收尾（最多 13 分钟，到点卡住，再点一次从头走）→ 部署检出快进、`release.sh <提交>` → 等发布历史末行是它 → `release.sh --check` → 验证 → 发完**恢复到发版前**（发版前开着的开回、关着的保持关；恢复不成功这一趟记 failed、页面红着，到环境页点开）。进度写进 `/srv/fleet-dao-releases/.train/release-train.json`（和 `release-train.json` 同一个格式，`.train` 归 root、后端只读，页面读它）。
- 装：**人工档**（`deploy/lib/human-tier.sh` 的 `setup_release_request`，不在自动档里）：要创始人（或指挥官经创始人同意）在法国以 root 跑一次不带参数的 `bash /srv/fleet-dao/deploy/france.sh`。装之前驾驶舱的按钮置灰、写「法国还没装发版接活单元」（后端看 `/etc/systemd/system/fleet-release-request.path`、`/usr/local/lib/fleet-dao/release-request/fleet-release-request.mjs` 和请求目录是否都在）；装完后四个仓里文件改了要人重跑（`HUMAN_TIER_PATHS` 登记了，后端 `/healthz` 才标「装机脚本落后」）。
- 看：`journalctl -u fleet-release-request -n 100`；`cat /srv/fleet-dao-releases/.train/release-train.json`、`last-request.json`；停：`systemctl disable --now fleet-release-request.path`（请求写了没人接，页面的按钮读不到接活的会提示）。
- 测试：`deploy/test/release-request.test.mjs`（每个拒绝路径一条故意造出失败的测试、单元路径权限读回）。

### 配置进仓对账

（#323：代码已经是先进仓、再由自动发布装到法国，配置照同一个做法——期望进仓、有版本，发布时照期望写上，线上每一轮对账，照 OpenGitOps；做法、比过的几种和出处见 `specs/323-配置进仓对账/方案.md`，和方案不一样的几处见 #323 的 PR）

- 期望在哪：法国 `/etc/fleet-dao` 下 `engine.env`、`api.env`、`release.env`、`france.env` 每一项「应该是什么」写在仓里的 `deploy/france/desired-config.json`，跟着版本走——对账拿在用的那一版（`current`）里的这一份，发布时照要切到的那一版里的这一份写（下面「发布时照期望写」）。公开的值写原值；私有的值（域名、飞书凭据、webhook 密钥、WireGuard 对端；巡检仓 #777 起改成公开值）只写指纹：HMAC-SHA256，钥匙是本机的 `/etc/fleet-dao/config-fingerprint.key`（root:root 600，france.sh 第一次跑时生成，之后不动；保险箱的 `refresh.sh` 连它一起留加密副本），期望里的 `fingerprint.keyId` 是它的编号。私有值本身照旧只在法国和保险箱里。这份期望和别的改动一样 CI 绿就合（决定 0023）。
- 每一轮对账：自动发布每 5 分钟那一轮最后，拿线上这几份文件跟期望比（`deploy/france/auto-release/config.mjs`，照 systemd 的读法读）：公开的值不对、私有值和指纹对不上、缺了（没写或被注释掉）、写了几行、多出来期望里没有的键，一项一条报警（`auto-release:config:<文件>:<键>`，飞书跟着推），线上的值一律不打印；改回去了，下一轮自己撤。期望读不到、认不出（在用的版本里没有这份、不是 JSON、格式不认识）、指纹钥匙读不到或不是期望记的那一把、私有值还没记指纹，记「没查成」、报一条 `auto-release:config-unchecked`，不当成一致。对账只报警、不改回；改回只在发布时，由期望里的 `selfHeal` 管（下一条），两份期望里都关着，开不开等创始人定。
- 发布时照期望写：`release.sh` 发布、`--rollback`、自动退回，都在迁移、装目录、装路由两层之后，切版本之前，照要切到的那一版里这一档的期望写 `engine.env`、`api.env`、`release.env`（`france.env` 不写，归 france.sh）；这一版里没有期望（#323 之前的老提交）就不写、照切。
  - 只写「这一版的期望和上次写的不一样」的公开键：期望里新加的、值改了的写上（文件里有就原地改那一行，没有就补在末尾，前一行注释写明说明和照哪一版写的），期望里删掉的、上次写过的那一行删掉。期望没变的不碰——人手改过的（和期望不一致）不改回，对账照旧报警。私有值一概不写，期望里没登记、也没写过的键不碰。
  - 上次写的是什么记在 `/srv/fleet-dao-releases/.config-applied.json`（只记公开值，连最近 20 次写了哪几项、照哪一版、什么事件）。没有这份记录时，在用的那一版带期望就拿它当上次写的（只写要发的这一版相对它改了的）；在用的也没有（新装的第一次发布），只记基线、一个字不写。
  - `selfHeal` 开了：人手改过的公开值，发布时也照期望改回，发布的输出里说改回了哪一项（线上原来的值不打印），记录里记一笔 `healed`。
  - 写不坏：先算（写成什么样放进临时目录），算出来的 `release.env` 用发布脚本自己的读法核一遍、往香港新加的几样先试通，再照核过的写（重新算的和核过的不一样就不写）；用临时文件换上，属主权限照原来的；写完照 systemd 的读法读回核一遍，不对就把这次写过的文件改回原样。期望认不出、线上文件认不出、要写的键写了几行、算出来的 `release.env` 认不出、新加的往香港发的试不通、写后读回不一致、档位文件认不出，都判红、不切版本，本机配置和原来一样（改回原样也没成的照实说、要人看）。自动退回时照上一版的期望写回去没成：不切回去，照实说没退回，也不把上一版记成不健康。
  - 写了 `release.env` 当场重读：这一版照新的起服务、往香港发。`engine.env`、`api.env` 写了，切版本时对应的服务照常重启（环境文件改过就重启）。
- 看：`release.sh --check` 的「自动发布」那一段最后一行（配置和期望一致 / 哪几项不一致 / 没查成）；`bash deploy/france.sh --check` 的读回里是同一份判法，不一致判红、没查成记待配；手动比一次：`node /srv/fleet-dao/deploy/france/auto-release/config.mjs check`（退出码 0 一致、1 不一致、2 没查成）。
- 改配置：改期望、等发布。
  - 公开的值：改 `deploy/france/desired-config.json`、合进主线，等下一次发布（带着这份期望的那一版切上去时）照期望写上、重启服务，不用再到机器上改。只改机器的，下一轮就报不一致，发布也不替人改回（`selfHeal` 关着）。
  - 私有值：新值照旧从保险箱放到法国（或人手放），再在法国以 root 算它的指纹：`node /srv/fleet-dao/deploy/france/auto-release/config.mjs fingerprint <文件> <键>`（只打印指纹；新值还没放上去就加 `--stdin`，从标准输入给），把指纹写进期望、合进主线，最后跑一遍保险箱的 `refresh.sh`。一次算全部私有值：`… config.mjs fingerprint --all`，打印成能贴进期望的样子，连钥匙编号。
  - 加一个键：写进期望、合进主线：公开的发布时写上；私有的照上一条，先放到机器上、再记指纹。
  - 删一个键：从期望里删掉、合进主线，发布时把上次照期望写的那一行删掉；私有的、没照期望写过的发布不删，人删。
  - 要一直空着的项（法国的会话代理、看板推送的地址和通行证）不是私有值：登记成公开的空值（`"value": ""`），对账照它比——空着对得上，填了值报不一致。`"private": null` 只表示「还没记指纹」，线上空不空都记「没查成」：还没放的私有值（比如还没放的 webhook 密钥）不能因为线上空着就当成对得上，放好后照上面「私有值」那条记指纹。
- 拼车并发总上限登记（#194 方案 4.7）：期望的 `engine.env` 里写 `FLEET_CARPOOL_MAX_CONCURRENCY`（这台最多同时开几个拼车会话；法国 4，创始人本机固定独享、不登记）。`FLEET_CARPOOL_TOTAL_CAP`（总上限，6）原本是「各台登记的加起来不超过它」的配置检查用的（`config.mjs diff-local`），本机 WSL 撤掉、只剩法国一台以后那条检查已删，这一项只是留着的登记，引擎不读；以后再加一台跑引擎的机器要重新做这条检查（#1137）。引擎起来（registerJobs 那一步）拿自己的登记数核库里拼车池（目录配置里 `orgKind` 为 `carpool` 的池）`maxConcurrency` 加起来是不是同一个数：对不上、没登记、写坏了、库里没有拼车池都推 `carpool-cap:registry` 提醒，并且选路不往拼车池派新活（#896：选路每次现核，核对本身读不出也按不派；独享、别家的池照派；驾驶舱路由页在拼车池的路由上写原因；不挡接活，对上了——改目录配置重装后下一次选路、或重启引擎——自己撤、拼车恢复；怎么修：改 `deploy/catalog.json` 里拼车池的 `maxConcurrency`（已装进库的行装载器不改，要在库里直接改，见第九节「目录配置」）重新装，或改仓里的登记，两边要同时过配置检查）。数值只放在期望里，代码里没有默认数。额度配置在仓里 `deploy/quota.json`（随发的那一版装，#1289，不在期望里；里面只有 Key 文件路径，Key 本身手放在 `/etc/fleet-dao/reclaude-api.key`）：里面没有 `reclaude-carpool` 池时切号读接口读不到 Key，盯读当场推 `carpool-api`（`packages/engine/test/real/carpool-api.test.ts` 钉着）。
- 新机器：france.sh 照这一档的期望建 `engine.env`、`api.env`、`release.env`（公开值照期望、私有值只留空位，`deploy/lib/app-config.sh` 的 `env_from_desired`）；已有的文件不照期望改（照旧只修属主权限、删退役的键）。私有值从保险箱放上来或由人填。
- 换机：从保险箱把 `/etc/fleet-dao` 整份放回（连指纹钥匙），对账照旧对得上；`.config-applied.json` 不在保险箱里，换机后第一次发布只记基线。钥匙没放回、france.sh 生成了新的：钥匙编号对不上，私有值全部记没查成（一条报警，不会报成一堆不一致），照上面「一次算全部私有值」重算、改期望。
- 换指纹钥匙（怀疑漏了）：删掉 `/etc/fleet-dao/config-fingerprint.key`、重跑 france.sh 生成新的，重算全部私有值的指纹、改期望、合进主线；中间那段私有值记没查成。
- 指纹漏什么：没有钥匙猜不出值（普通 sha256 对域名、仓名这种低熵的值一撞就出来，所以用带钥匙的 HMAC）；输入绑了文件名和键名，看不出两项的值一样不一样；看得出的只有「这一项哪天换过」（期望文件的历史）。
- 自测：`deploy/test/config.test.mjs`（读法和 `app-config.sh` 的 env_parse 同一批样本、期望认不出的每一种、指纹绑键名、手改报哪一项、私有值不带值、期望和钥匙读不到记没查成、命令行不打印值；发布时照期望写：只写变了的、人手改的不改回、`selfHeal` 开了改回留痕、写不成的每一种都一个字不写、写后读回不对改回原样；照期望建新文件），`deploy/test/auto-release.test.mjs` 最后几条（一轮里报警、不重发、改回自己撤、库连不上下一轮再发再撤），`deploy/test/release-flow.test.sh` 的「照期望写本机配置」一段（先写后切、写不成不切、退回和自动退回写回去、新加的往香港发的先试通），`deploy/test/app-config.test.sh`（新机器照期望建、私有值留空），`deploy/test/session-proxy.test.sh`（会话代理读期望）。

**CI 测试的 Postgres 服务**（#220，只在 CI，不装到任何机器：

- 在哪：`ci.yml` 的 `test` job 里装进了 db 测试的那几台（pg 台，`matrix.pg`；分台见 `packages/conventions/src/test-split.ts`，db 的测试单独装台、不和别的包混）自己 `docker run` 起一个 `postgres:16-alpine` 容器（镜像取自 AWS 公共镜像库 `public.ecr.aws/docker/library/postgres:16-alpine`，不走 Docker Hub：它对匿名拉取限速）（不用 `services:`：那个每台都起，别的台白等约 12 秒；job 一开始就后台起、装完依赖再等 `pg_isready`）（大版本和法国生产一致，第二节），`fleet_test`/`fleet_test`，库 `fleet_test_admin`，健康检查 `pg_isready`。只在那一台的运行期间活，跑完整只容器销毁，不写持久化，也不是生产。
- 用法：`packages/db/src/testing.ts` 在 `FLEET_TEST_PG_URL` 有值时真连过去：第一次跑迁移建一个模板库 `fleet_test_template`（同一台服务的多个测试进程用咨询锁串行，不重建），之后每个测试文件 `CREATE DATABASE <随机名> TEMPLATE fleet_test_template` 克隆一份当自己的测试库，跑完整张删（`drop database … with (force)`），堆不出几 G。`ci.yml` 只把 `FLEET_TEST_PG_URL` 给到 pg 台；别的台不设、本机也不设，都照 PGlite 走。CI 里 db 的测试没拿到这个变量（分台或工作流坏了）`real-pg.test.ts` 直接红，不悄悄跳过。
- 登不上去、建不了模板当场红（packages/db/test/real-pg.test.ts 故意造出失败的那条：`createTestDb` 克隆出来的库里业务表必须全是空的，读到正式库数据一定红）。**不静默退回 PGlite 冒充**——#220「测试库连不上要明确报错」。
- 为什么这么写：每个测试进程不再各建一份内存 PGlite（峰值 800+ MiB），共用一张真库之后降到 ~0.3G；`packages/conventions/src/test-run.ts` 的 `WORKER_MIB`/`RESERVE_MIB` 等实测过再调。CI 上这个容器是 GitHub Actions 的 service container（runner 内部账号、监听 localhost:5432，跟生产用户、登录鉴权没有任何关系）。
- 装机法国侧**不装**：这是 CI 的事，法国那台生产 Postgres 里没有 `fleet_test_template` 这张库，也不应该有——第二条已经讲过它只放 `fleet` 和 `temporal_*`。机器的 docker、镜像源都不为它配。

## 十、「你好」工作流（P0 验收）

让引擎工人跑一次 `helloWorkflow`，耗时查得到：Temporal 把每次执行的开始、结束、耗时记在本机 Postgres（库 `temporal_visibility` 的表 `executions_visibility`）。

跑法（法国，root）：`bash /srv/fleet-dao/deploy/hello.sh`

1. 查任务队列 fleet 上有没有引擎工人在取活；没有就停下（退出码 2），说缺什么。
2. `fleet-temporal workflow execute --type helloWorkflow --task-queue fleet --workflow-id hello-<时间> --input '"法国"'`，90 秒没跑完判红。
3. 从 `executions_visibility` 读这一次的开始、结束、耗时。以后再查：`fleet-temporal workflow describe --workflow-id hello-<时间>`，或以 postgres 在库 `temporal_visibility` 里：
   `select workflow_id, start_time, close_time, execution_duration / 1e6 as ms from executions_visibility where workflow_type_name = 'helloWorkflow' order by start_time desc;`

要先齐的：引擎里注册 `helloWorkflow(name: string): Promise<string>`（不调活动也行）并合进主线；期望里 `release.env` 的 `FLEET_SERVICES` 加上 `fleet-engine`、合进主线，发布一次（发布时照期望写上）。健康页的「引擎」一项要后端也在跑（`FLEET_SERVICES` 里也有 `fleet-api`）：它是后端去 Temporal 查任务队列上有没有引擎工人在取活。`FLEET_SERVICES` 里没有 `fleet-engine`（比如法国 2026-09-29 到 2026-10-05 临时关过引擎）时，这一项报「未接」（`{ ok: true, status: 'not_wired' }`，说明「这台机器按设置没开引擎」）、整体照样 200：后端单元 `fleet-api.service` 把 `release.env` 也读进环境（放在 `api.env` 前面、带「-」），`packages/api/src/config.ts` 的 `engineEnabled` 照这一行定，没读到或认不出的名字一律按开着算（多报红、不漏报）。发布脚本对「没开引擎」的机器另有一条（`compare_api_items`）：切之前引擎还好、这一版把它撤掉，后端报引擎不在，标待处理、不退回。改 `FLEET_SERVICES`（改期望、合进主线）后发布一轮：发布时照期望写进 `release.env`，`release.env` 改过会让 `fleet-api` 重启一次才读到。

## 十一、备份与恢复

装：`deploy/backup/install.sh`，独立于 `france.sh`、`hk.sh`。先法国（打印备份钥匙的公钥）→ 公钥填进香港 `/etc/fleet-dao/backup.env` 的 `FLEET_BACKUP_FRANCE_PUBLIC_KEY`、跑 `install.sh hk` → 法国再跑一遍（建仓库、首跑）。`--check` 只读回。

| 定时器（法国，以 fleet 跑） | 什么时候（北京时间） | 做什么 |
|---|---|---|
| `fleet-backup.timer` | 每天 04:10 | fleet、temporal、temporal_visibility 各 `pg_dump -Fc` 一份，行数清单和导出用同一个快照；restic 加密后经隧道存进香港；按 7 日 + 4 周删过期的 |
| `fleet-backup-drill.timer` | 每周日 05:40 | 最近一份从香港取回，逐个恢复进临时库 `fleet_drill_restore`，核对每张表的行数和各时间列的最新值，删掉临时库；再跑 `restic check` |
| `fleet-backup-watch.timer` | 每小时 17 分 | 两台的磁盘用量（线在法国 `/etc/fleet-dao/backup.env`）。备份多久没开跑不在这里查：引擎的看门狗按登记表看（备份的三个都在），一件事只一张卡（#339）；以前这里推过的 `backup.stale:*` 两条每轮顺手撤 |

- 每跑一次在 `schedule_runs` 记一行，驾驶舱「定时任务」页看；没做成、查出问题都在 `notifications` 发报警，好了自动解除。判活看上次跑成的时刻（`install.sh france --check`），不看定时器下次什么时候响。
- 法国：`/etc/fleet-dao/backup/`（仓库口令 `restic.pass`、连香港的钥匙、钉住的香港主机钥匙，root:fleet 640）、`/opt/fleet-dao/restic`（钉版本）、`/usr/local/lib/fleet-dao/backup/`（任务脚本，归 root）、`/var/lib/fleet-dao/backup/`（暂存，跑完清空）；库角色 `fleet_drill`（不能登录、只能建库，演练的临时库归它，恢复不用超级用户）。
- 香港：用户 `fleet-backup`（shell nologin），sshd 把它关在 `/srv/fleet-dao-backup` 的 chroot 里、只给 sftp（`/etc/ssh/sshd_config.d/60-fleet-dao-backup.conf`，只管这一个用户），钥匙还限死成只许从 10.99.0.2 来；仓库 `/srv/fleet-dao-backup/restic`，只有密文。
- **仓库口令要抄一份到创始人的密码管理器**：法国没了，香港的密文只有它解得开。口令一旦建了仓库就不能换。
- 手动跑一次：`systemctl start fleet-backup.service`（演练、巡检同理）；看快照：`sudo -u fleet /usr/local/lib/fleet-dao/backup/fleet-backup.sh restic snapshots`。每晚备份和演练的单元「3 小时里最多起 3 次」（给失败重试封顶），手动起的也算：撞上时 systemctl 报 `start-limit-hit`，先 `systemctl reset-failed fleet-backup.service` 再起。
- 断网、被杀的那一轮会在香港仓库里留下锁；每晚备份和演练开跑前先 `restic unlock`（只清失效的，还在跑的那边清不到），不用手动管。
- 已知风险：法国被攻破的话，攻击者拿着备份钥匙能删光香港的备份。每晚要按保留规则删过期的，这把钥匙就得有删的权限；改成「只追加」得把删过期挪到一处有口令的第三地，而香港按设计只存密文。补法（还没做）：香港 root 每天把仓库复制一份到备份用户碰不到的地方、留 14 天。

### 换机恢复（法国整台没了）

覆盖线上库是删数据，动手前先问人。前提：密码管理器里有仓库口令，香港还在。

1. 新机跑 `deploy/france.sh`、把应用发布上去（库、Temporal 的表都建好）。
2. 先把口令写回去，再装备份——不然装机脚本会生成一个新口令，香港的密文就解不开了：
   ```
   install -d -o root -g fleet -m 750 /etc/fleet-dao/backup
   install -o root -g fleet -m 640 /dev/null /etc/fleet-dao/backup/restic.pass
   read -rsp '仓库口令：' p && printf '%s\n' "$p" > /etc/fleet-dao/backup/restic.pass; unset p
   ```
3. `bash deploy/backup/install.sh france`：会打印新机备份钥匙的公钥。这时仓库还连不上，每晚备份的定时器不会开。
4. 香港：把新公钥换进 `/etc/fleet-dao/backup.env` 的 `FLEET_BACKUP_FRANCE_PUBLIC_KEY`，跑 `install.sh hk`（旧法国那把钥匙随之作废）。
5. 法国再跑一遍 `install.sh france`。它看到「仓库里已有快照、这台却从没备份成功过」，按换机恢复处理：每晚备份的定时器不开、也不首跑——首跑会把新机的空库备上去，保留规则还会把当天出事前那一份当成同一天的旧份删掉。「这台备份成功过没有」读不出来（运行记录读不到、没登记）时也一样挡着。演练照跑，它只动临时库。
6. 按时间挑出事前的那一份，记下编号：`sudo -u fleet /usr/local/lib/fleet-dao/backup/fleet-backup.sh restic snapshots`
7. 停掉写库的服务（`fleet-temporal`，以及装了的引擎、后端），取回、恢复。导出落在 fleet 700 的目录里，postgres 读不到，所以由 root 打开文件、从标准输入喂给 `pg_restore`。三个库全恢复成了才删取回的文件；有一个没成就停下来问人，别删、也别接着往下做：
   ```
   systemctl stop fleet-temporal.service
   sudo -u fleet /usr/local/lib/fleet-dao/backup/fleet-backup.sh restic restore <编号>:/var/lib/fleet-dao/backup/nightly/dumps --target /var/lib/fleet-dao/backup/restore
   all=1
   for db in fleet temporal temporal_visibility; do
     if ! runuser -u postgres -- pg_restore --clean --if-exists --single-transaction -d "$db" < "/var/lib/fleet-dao/backup/restore/$db.dump"; then
       echo "$db 没恢复成：停下来问人，取回的文件先留着"; all=0; break
     fi
   done
   if [ "$all" = 1 ]; then rm -rf /var/lib/fleet-dao/backup/restore; fi
   ```
8. 再跑一遍 `install.sh france`：恢复出来的库里带着旧机的运行记录，这回每晚备份的定时器才会开。
9. 手动补一份新备份：`systemctl start fleet-backup.service`。恢复出来的运行记录里，上次备份成功停在出事前，不补这一份，`--check` 会按过期把每晚备份判红。然后起服务，`install.sh france --check` 全绿。

停用：`systemctl disable --now fleet-backup.timer fleet-backup-drill.timer fleet-backup-watch.timer`。香港上的备份和 `fleet-backup` 用户、法国的口令属于数据，删之前先问人。

## 十二、香港飞书网关（fleet-feishu）

网关（`packages/feishu`）以 fleet 跑在香港：出站连飞书的长连接收消息、按钮、菜单事件，经隧道调法国驾驶舱后端 `10.99.0.2:8787`；不听端口、不写磁盘。代码由法国的发布脚本发来，香港上不放仓库、不装依赖、不连 GitHub。

装（`hk.sh`）：

- node：固定版本（`hk.sh` 顶部 `NODE_VERSION`、`NODE_SHA256`），从 nodejs.org 下官方包、核对 sha256，装到 `/opt/fleet-dao/node-v<版本>`，`/opt/fleet-dao/node` 指着它。系统里的 node 不用，也不碰。
- 单元 `fleet-feishu.service`（仓里 `deploy/hk/fleet-feishu.service`）：只装不起。起网关归发布——配置备齐了、有这一版了才起。`Restart=always`，停机时网关先断长连接、把手上的活做完再退。进程看不见 `/etc/fleet-dao`（配置由 systemd 起进程之前读好、放进环境变量），也看不见别人的进程；只许 IPv4、IPv6、本机套接字，系统调用只放行常规服务那一组。加固到什么程度：`systemd-analyze security fleet-feishu`。
- 入口 `/usr/local/sbin/fleet-gateway-deploy`（仓里 `deploy/hk/fleet-gateway-deploy.sh`）：法国发网关的钥匙登上来只能跑它，它只认四种命令，别的一律拒——
  `has <提交号>`、`receive <提交号> <sha256>`（从标准输入收 gateway.mjs，大小、sha256 都对才落地，同一个提交号不许换内容）、`activate <提交号>`、`status`。香港 root 也能直接跑，比如 `fleet-gateway-deploy status`。
- 配置 `/etc/fleet-dao/feishu.env`（root:fleet 640）：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_FOUNDERS` 由人放（样例 `packages/feishu/deploy/feishu.env.example`）。下面三项缺才补、已有的不改：`FLEET_BACKEND_URL=http://10.99.0.2:8787`、`FLEET_PUBLIC_URL=https://<域名>`、`FEISHU_TEAM_CHAT_ID`（机器人只在一个群里，就是那个群；不在任何群里、或在好几个群里，记待配，等人拉群或写明）。通行证不抄进来：单元另读 `gateway-token.env`（第九节「两台同一份」）。
- 读回：node 版本、单元和入口在不在、配置缺什么、配的团队群里有没有机器人、网关在不在跑、连没连上飞书、连不连得上法国后端。

发（法国 `release.sh`，和应用同一次发布）：

1. 构建每一版时，有 `packages/feishu` 就用 esbuild 把网关连同依赖打成一个文件 `gateway/gateway.mjs`（`deploy/france/bundle-gateway.sh`）；打完拷到仓库外头、不给配置跑一次，要停在读配置那一步（打包漏了东西会先报别的错）。它的 sha256 记进这一版的 `.fleet-release`（`gateway_sha256=`）。
2. 切版本时先问香港 `status`：这一版没有网关（早于 `packages/feishu`），或香港的配置没备齐，就不动香港网关、记待配。否则 `has`，没有就 `receive`（传坏了不收），再 `activate`：`current` 原子地指过去、写 `.history`；主进程不在这一版的目录里、或环境文件在它起来之后改过，就重启；只留最近 5 版（在用的一定留）。
3. 健康检查：60 秒内主进程跑的是这一版、长连接连着飞书（看这次起来之后最后一条「已连上／重连上了／断了正在重连」），再看 10 秒没退出、没重启。连不上法国后端不算这一版的错：法国 `fleet-api` 没起时就是这样，网关照实回用户「后端连不上」、不会崩，记待配。
4. 退回：网关跟着版本走，`--rollback`、自动退回都会把香港网关切回那一版（那一版没有网关就不动）。

看：

- 香港 `fleet-gateway-deploy status`：`current`（在用哪版）、`running`（主进程跑的是哪版）、`connected`（`yes`／`reconnecting`／`no`）、`messages`（这次起来后处理过几条消息）、`backend`（`reachable`；`refused` 法国后端没起；`timeout` 隧道不通；`unknown` 没配地址；`invalid` 地址认不出，要写成 `http://主机:端口`）、`config`（`ok` 或缺哪几项）。
- `journalctl -u fleet-feishu -n 100`：一行一个 JSON，消息正文只记长度。每条消息一行「消息处理完」，带 `ackMs`（收到到回上「收到」花了多久，都没回上是 null）、`deliveryMs`（飞书从用户发出到推给网关花了多久）。
- 心跳：`journalctl -u fleet-feishu -o cat --since -1h | grep 网关心跳 | tail -3`，每 10 分钟一行（停机时也写一行）：`link`（`ok`；`down` 有一条定时活超时限没走通；`recovering` 通了、还在等稳住）、`push`（这段时间推送轮了几轮、没走通几轮，发了、改了、推迟、不发、没发成各几件，经飞书的平均和最慢毫秒，最后一次走通的时刻）、`board`（盘面快照取到几次、没取到几次、平均和最慢）、`messages`（几条消息，「收到」的平均、最慢、最近一条，超 2 秒几条、没回上几条，确认卡超 10 秒几条）、`lastError`（这段时间最近一次没走通的原因）。安静时 `push.rounds` 照样在涨；一轮都没有、`link` 是 `down`，才是挂了；超过 10 分钟没有新的心跳，是网关进程没在跑。
- 调不通后端时网关自己报：推送、盘面快照有一条 5 分钟没走通，往团队群发一张卡住报警（写明从几点起、最近一次为什么），日志里一行 error「网关调不通后端超过时限」；同一次只报一次，免打扰时段里的等时段过了再报；全部连续走通 1 分钟后在那张卡下面回「通了」、卡改灰。报警走网关自己的飞书连接，不经后端。时限和理由在 `packages/feishu/src/watch.ts` 开头；状态只在进程里，网关重启后从起来那一刻重新算。
- 法国后端 `/healthz` 的 `feishu_gateway`（健康页「飞书网关」）从后端那头看网关来不来：网关整个没了、它自己报不了的时候靠它（第九节讲健康页的那几条）。
- 法国 `release.sh --check`、香港 `hk.sh --check` 都报上面 `status` 的那几项；`release.sh --check` 的健康检查里也有 `feishu_gateway`。

还欠：

- 团队群：机器人不在任何群里时 `FEISHU_TEAM_CHAT_ID` 补不上，网关不起（发布记待配）。建好团队群、把机器人拉进去，重跑 `hk.sh`（补上群号），再发布一次。
- 「收得到事件」要有人在飞书里给机器人发一条消息才验得到：`status` 的 `messages` 加一、日志里有「消息处理完」。

## 十三、本机 WSL 演练台（fleet-local）：2026-10-06 已撤

本机曾装过一台 WSL2 的 Ubuntu 24.04（`fleet-local`，#450/#451），用 `deploy/france.sh` 的「本机档」装，用来让新版本先在本机全流程走通（#452 演练 2026-10-05 02:47 已通）。2026-10-06 创始人撤掉它（决定 [0022](decisions/0022-retire-local-wsl.md)，#1107）：

> 创始人 2026-10-06 10:21：「话说内存吃紧是不是因为wsl搞的；如果要占用那么大空间，我认为不需要了；如果法国vps可以实现暂停功能，部署后再继续，是不是相当于只有法国vps也可以了？再加上本机帅位；如果可以的话，我需要你先把本机wsl机制清理」

往后只剩「法国 VPS 跑引擎 + 本机当指挥官」两台。新版本在法国发，发版先暂停、等收尾、部署、恢复靠 release-train（#1095）。

- **机器侧**：已 `wsl --export` 备份到 `D:\wsl\backup\fleet-local-20261006.tar`，`wsl --unregister fleet-local`，删了 `%UserProfile%\.wslconfig`。要找回里面的东西，`wsl --import` 这个 tar。
- **仓里**：本机档的装机目录（原 deploy 下的 local 子目录）、`FLEET_PROFILE` 与档位文件、`deploy/france.sh` 里「本机档跳过」那几处、自动发布里本机档跟主线那一路、`config.mjs diff-local`、本机档的测试都已删。**要重建，看这个提交之前的 git 历史**（`git log --diff-filter=D --stat -- 'deploy/local/*'` 找到删除那次提交，它的上一个提交就是最后有这套机制的样子）。
- **法国看板里「本机」那行**：`node_reports` 里环境编号 `local` 那行不会再有人推快照，会一直失联。下次在法国发版之后，以 root 在法国删掉它：

  ```
  runuser -u fleet -- psql -d fleet -c "delete from node_reports where node_id = 'local'"
  ```

  法国 `api.env` 的 `FLEET_NODE_KEYS` 里给 `local` 发的那把通行证的哈希没人持有了，可以顺手删掉那一项（删了要用法国的指纹钥匙重算 `deploy/france/desired-config.json` 里这一项的指纹，算法见第九节「配置进仓对账」）；不删也无害，只是多一把没人用的钥匙。
- **留着的通用机制**：驾驶舱多环境切换器（#820）、`node_reports`、`/api/nodes/report` 收件口和 `FLEET_NODE_KEYS`、会话代理 `FLEET_SESSION_PROXY`（法国登记成空＝直连）。以后接别的环境照下面这一节。

### 接上法国看板

要在法国的看板顶栏切着看另一个环境（下面以环境编号 `local` 为例；本机 WSL 那台已撤，见上一节）：那个环境每 60 秒把自己的主页、环境页快照推给法国（`packages/api/src/node-reporter.ts`），法国收下存进 `node_reports`（`packages/api/src/node-report.ts`，对公网开的写口 `POST /api/nodes/report`，只认专用通行证）。通行证明文只在生成时显示一次，法国只存它的 sha256，推送方存明文。这几步要以 root 在两台机器上手工做，**先法国、后推送方**（顺序反了推送方会一直被拒，`/healthz` 的 `node_report` 报红）。键写在两份期望里：`FLEET_NODE_KEYS`（`deploy/france/desired-config.json` 的 `api.env`，私有值）、`FLEET_NODE_REPORT_URL` 和 `FLEET_NODE_REPORT_TOKEN`（推送方那台自己的期望的 `api.env`，私有值），每个和对面不一样的地方都在各自的「说明」里。

1. 法国生成钥匙：`bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api node-key new local`（和 `set-password` 同一个入口，换成 fleet、带上 `api.env` 连库）。它先写一条操作记录（`node_key.new`，只记哈希前 12 位当指纹）再打印：通行证明文（只显示这一次，别进聊天、仓库、日志）和要贴进 `FLEET_NODE_KEYS` 的那一项 `"local":"<sha256>"`。记不进操作记录就什么都不打印，重跑。参数：环境编号只许小写字母开头、小写字母数字短横线。
2. 法国放哈希：`/etc/fleet-dao/api.env` 里加 `FLEET_NODE_KEYS={"local":"<sha256>"}`（已有别的环境就接在同一个 JSON 对象里；整行只写一次），重启 `fleet-api`。写错（不是 JSON、值是明文或不够 64 位小写十六进制、和别的密钥相同）后端拒绝启动、报错里不印哈希。
3. 法国读回：`bash deploy/france.sh --check`，读回里有一条「从公网带一把假的 X-Fleet-Node-Token POST /api/nodes/report」：配好之后要回 401（✓），没配 `FLEET_NODE_KEYS` 时后端回 503、记成待配（不算通过）；回 200/400 判红（假通行证被放进来了）。
4. 推送方放地址和通行证：推送方的 `/etc/fleet-dao/api.env` 里加 `FLEET_NODE_REPORT_URL=https://<法国看板域名>/api/nodes/report` 和 `FLEET_NODE_REPORT_TOKEN=<第 1 步的明文>`（两项一起配才推，都没配不推；直连法国不通时再加 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY=http://127.0.0.1:7890`，Node 22.21 起认），重启 `fleet-api`。
5. 读回：推送方 `curl -s http://10.99.0.2:8787/healthz` 的 `node_report` 一项是绿的（写着上次推成的时刻）；法国登录后 `/api/nodes` 里 `local` 的 `freshness` 是 `fresh`（收到后 3 分钟内算新鲜，过了是 `stale`，配了钥匙却一次没收到是 `never`）。
6. 记指纹：两份期望里三个键现在是 `"private": null`（还没记指纹，对账记「没查成」）。第 2、4 步做完后，各用本台自己的指纹钥匙算好指纹，把 `null` 换成指纹再提 PR（算法和钥匙见第九节「配置进仓对账」）。

要换钥匙或撤掉一个环境：重跑第 1 步拿新的一把，在法国 `FLEET_NODE_KEYS` 里换掉哈希（删掉那一项就作废）、本机换 `FLEET_NODE_REPORT_TOKEN`，两台各重启 `fleet-api`。收不到快照时看法国 `journalctl -u fleet-api`：只记环境编号和原因（`node_token_invalid`、`too_frequent`、`reported_at_in_future`……），不记通行证和载荷。
