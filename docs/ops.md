# 运维手册：两台机器的地基与应用发布

装法在 `deploy/`，这里讲怎么用、怎么看、怎么退。机器的公网 IP 和驾驶舱域名不进仓，下文写作 `<法国IP>`、`<香港IP>`、`<驾驶舱域名>`；域名的真值只在机器配置里（香港 `hk.env`、法国 `release.env` 的 `FLEET_DOMAIN`）。
旧系统（windsurf-dao、ai-gateway-stack 那一套）已于 2026-09-25 从两台机器上全部清退：单元、用户、目录、数据都删了。它留下的坑与由来见 [reference/deploy.md](reference/deploy.md)（文中的 P01、P02 等编号出自那里；那份记的是清退前的现场）。
两层：`deploy/france.sh`、`deploy/hk.sh` 装机器（第一到第八节）；`deploy/release.sh` 发布应用（第九节），连同香港的飞书网关（第十二节）。备份与换机恢复另有一个装机脚本 `deploy/backup/install.sh`（「备份与恢复」一节）。

## 一、两台机器

| | 法国 | 香港 |
|---|---|---|
| 系统 | Ubuntu 24.04，6 核 12G | Ubuntu 22.04，2 核 2G |
| 跑什么 | Temporal、PostgreSQL、引擎工人、驾驶舱后端、AI 会话 | nginx（驾驶舱静态文件、证书、往法国转接口）、WireGuard 服务端、飞书网关（只出站，不听端口） |
| 公网入站（ufw） | 只放 22/tcp；另在隧道网卡上给香港开 8787 | 只放 22/tcp、80/tcp、443/tcp（nginx）、4500/udp（WireGuard） |
| 装机脚本 | `deploy/france.sh` | `deploy/hk.sh` |
| 不归 fleet-dao 管的 | MiraQuota 的 `miraquota-sync`（等 miraquota-win#3 发版后停） | MiraQuota 的 `miraquota-hub`（127.0.0.1:4331）和同一个 nginx 上的站点 `ai-gateway`（只剩 `https://<香港IP>.sslip.io/mq/`），同样等 miraquota-win#3 发版后停；装机不碰 |

两机之间走 WireGuard 隧道 `10.99.0.0/24`：香港 `10.99.0.1` 是服务端；法国 `10.99.0.2` 是客户端，主动连、每 25 秒保活，所以法国不用开任何入站端口。

## 二、端口表

法国（全部只绑本机或隧道地址）：

| 端口 | 绑在 | 是谁 | 说明 |
|---|---|---|---|
| 5432/tcp | 127.0.0.1、::1 | PostgreSQL 16 | |
| 7243/tcp | 127.0.0.1 | Temporal 前端 gRPC | 引擎和 `fleet-temporal` 连这里 |
| 6943/tcp | 127.0.0.1 | Temporal 前端 membership | |
| 7244、6944 | 127.0.0.1 | Temporal history（gRPC、membership） | |
| 7245、6945 | 127.0.0.1 | Temporal matching | |
| 7249、6949 | 127.0.0.1 | Temporal worker | |
| 8787/tcp | 10.99.0.2 | 驾驶舱后端（`FLEET_COCKPIT_LISTEN`） | ufw 只在隧道网卡 `wg-fleet` 上给 10.99.0.1 放行；后端起了才有 |
| 8788/tcp | 127.0.0.1 | fleet 命令接口（`FLEET_AGENT_LISTEN`） | 会话用得到，不对外 |

上表里除了 8788，本机上只有 root 和 fleet 连得上：Temporal 没开认证，谁连得上谁就能给任意工作流发信号，会话就能绕过人闸。拦法是一张单独的 nft 表 `inet fleet_dao`（按连接发起方的属主 skuid，别人连就被复位），由 `fleet-firewall.service` 载入。**别启用 `nftables.service`**：它的默认配置开头是 `flush ruleset`，会把 ufw 的规则和这张表一起冲掉。

选端口的规矩：Temporal 一律「官方默认 +10」（当初为了和旧系统的 7233/8233 错开；旧系统已清退，端口不再改）；都在 32768 以下——32768 起是临时端口段，程序运行中随手要的端口会落在里面，同段里挑端口迟早撞上。

香港：

| 端口 | 绑在 | 是谁 | 说明 |
|---|---|---|---|
| 80/tcp | 0.0.0.0 | nginx | `<驾驶舱域名>`：证书续期的验证路径，其余跳 https |
| 443/tcp | 0.0.0.0 | nginx | `https://<驾驶舱域名>`：静态页；`/api`、`/auth`、`/github/webhook`、`/healthz` 经隧道转法国 `10.99.0.2:8787`（连接留着复用，第八节），转之前清掉 `Authorization`、`X-Fleet-Acting-Feishu`；`/agent` 不转；`/release.json`（带完整提交号）只给法国经隧道来的（`10.99.0.2`），别处来的回 404 |
| 4500/udp | 0.0.0.0 | WireGuard 服务端 | 香港上游只放行少数常见 UDP 端口（2026-09-25 从法国实测：53/67/69/123/161/500/1701/4500 能到），51820 进不来 |

GitHub 事件地址：`https://<驾驶舱域名>/github/webhook`。飞书登录回调：`https://<驾驶舱域名>/auth/feishu/callback`。
整站不让搜索引擎收录：80、443 的回应都带 `X-Robots-Tag: noindex, nofollow`；`/robots.txt` 故意不禁抓——禁抓了爬虫就看不到这个头，网址反而可能凭外链被收进结果（`deploy/hk/nginx-*.conf`）。

## 三、用户、目录、库

| 用户 | 在哪 | 干什么 |
|---|---|---|
| `fleet` | 两台 | 引擎、驾驶舱后端、Temporal（法国），飞书网关（香港）。系统用户，家 `/home/fleet`（750） |
| `fleet-agent-carpool` | 法国 | AI 会话专用，**只有这一个**（称「会话用户」；名字是历史沿用，不改名免得重新登录）：reclaude 一个账户最多挂 4 台设备、一个家目录算一台，本机和另一台机器已占掉两台，法国只能占 1 台（创始人 2026-09-26）。引擎的全部会话都跑在它下面；它平时挂拼车组织，拼车用满时整个用户切到独享组织、手上的会话 fork 续上，拼车窗口恢复再切回（design 第九节，切号 #59 还没做）。没有 sudo、不能提权、只在自己的组里、家里没有 GitHub 凭据、读不到 `/etc/fleet-dao`、连不上 Temporal 和库。原先的 `fleet-agent-dedicated`（挂独享号的第二个会话用户）已删，2026-09-26；france.sh 不再建它、读回不查它 |
| `pilot` | 法国 | 创始人的登录用户：用 Mirasim 桌面端的 ssh 远程模式登进来干活（第五节）。系统用户，家 `/home/pilot`（750）；没有任何 sudo，只在自己的组和 `systemd-journal` 里（看日志）；读不到 `/etc/fleet-dao`、连不上 Temporal 和库 |
| `root` | | 只装机 |

法国：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/srv/fleet-dao` | root:root 755 | 装机脚本所在的检出（git clone）。fleet 和会话用户都只读。自动发布每发一版之前把它快进到要发的提交（第九节「自动发布」），不用再手动 pull |
| `/srv/fleet-dao-releases` | root:root 755 | 应用的各版（第九节）：`<提交号>/`、`current` 链接、`.history`、`.demo-published`（香港上的演示版是哪一版，发演示版时记）；每一版归 root，fleet 只读 |
| `/srv/fleet-dao-releases/.auto` | root:root 755 | 自动发布的读数 `state.json`（每一轮写，后端 `/healthz` 的 `deploy_lag` 读）、`france-applied`（france.sh 跑完没红时记装到哪个提交） |
| `/usr/local/lib/fleet-dao/auto-release`；`/etc/systemd/system/fleet-auto-release.{service,timer}` | root:root 755（文件 644）；root 644 | 自动发布（第九节「自动发布」）：france.sh 从仓里拷的副本，不从检出直接跑 |
| `/var/lib/fleet-dao`、`/var/log/fleet-dao` | fleet:fleet 750 | 运行数据、日志（服务日志主要在 journald）。引擎自己的临时文件（从镜像打的 bundle）和存档（没合并就收的树里没提交的改动）在 `/var/lib/fleet-dao/engine/` 的 `tmp/`、`archive/` 下，GitHub 的镜像仓在 `/var/lib/fleet-dao/github/` |
| `/var/lib/fleet-dao/demo` | fleet:fleet 750 | 演示版的可见范围（第九节「演示版」）：驾驶舱后端写，`scopes/` 由 `fleet-demo-scopes` 推到香港，`links/` 是只留本机的备注 |
| `/var/lib/fleet-work` | root:root 755 | AI 会话的工作树：`<owner>_<name>/<分支>` 是子任务的树，`<owner>_<name>/<需求号>.<阶段>[.<子任务>]` 是分诊、写文档、审查的检出副本，`_route-probe/<会话用户>` 是路由探针起会话的目录（第五节「路由探针」），`_tmp/<会话编号>` 是每个会话自己的临时目录（会话的 TMPDIR，会话收场就删，工人起来时清上一轮剩下的）。中间各级归 root、别人写不进；每棵树归会话用户、700，建、交、删都经 `fleet-agent-scope`（第五节）。没有在跑的任务在用的树由引擎的每小时对账收（第五节「每小时对账」）：什么都不剩的删掉（能重新生成的编译和工具缓存不算），剩着没推的东西的报「要人拍」 |
| `/etc/fleet-dao` | root:fleet 750 | 本机配置与密钥：`france.env`、`temporal.env`（库口令）、`temporal.yaml`、`nftables.nft`、`github/`（两个 GitHub 机器人的 json，手放）、`catalog.json`（目录配置，从保险箱放上来，第九节「目录配置」）；`reclaude-api.key`（reclaude 网页「设置 → API Key」生成的账号级 Key，只一行，读拼车额度用，手放；网页上重新生成后旧的立刻作废，要换这份再刷新保险箱）；`jev.json`（判断题的机器配置：TypeSafe 的地址、钥匙文件在哪，样例 `packages/jev/config.example.json`，手放；引擎和驾驶舱后端都读，`FLEET_JEV_CONFIG` 可改位置）、`typesafe.key`（TypeSafe 的钥匙，只一行，手放）；应用的 `engine.env`、`api.env`、`release.env`（照仓里样例建一次，之后归人改），随机密钥 `agent-token.env`、`session-secret.env`、`gateway-token.env`（首次生成，之后不动）。卫生检查的已知敏感值名单 `sensitive-values.txt`（真实的组织编号、账号，一行一个，手放；引擎推分支、写需求文档、开 PR 之前都读，缺了一律不推不写，france.sh 读回报待配；见 packages/hygiene）。文件一律 root:fleet 640；只有 `web-upload.key`（往香港传静态文件、演示版的可见范围的钥匙）、`gateway-deploy.key`（往香港发飞书网关的钥匙）和 `hk-known-hosts`（钉住的香港主机钥匙）是 root:root 600 |
| `/opt/fleet-dao/temporal` | root:root 755 | `server-1.32.0/`（temporal-server、temporal-sql-tool）、`cli-1.9.1/`（temporal），`bin/` 链接到在用的版本 |
| `/opt/fleet-dao/uv` | root:root 755 | `<版本>/uv`：只用来给会话用户和 pilot 各装一份 ddgs（第五节），不进谁的 PATH |
| `/opt/fleet-dao/pnpm` | root:root 755 | `<版本>/`：AI 会话用的 pnpm（npm 上的 `pnpm-<版本>.tgz`，版本跟仓根 `package.json` 的 `packageManager`，核过 `france.sh` 顶部钉的 sha512），`.sha256` 记着装完时每个文件的指纹（第五节「会话的 PATH 与 pnpm」） |
| `/usr/local/bin/pnpm` | root 755 | 会话用的 pnpm 的入口：关掉 node 的编译缓存，再用 `/usr/bin/node` 跑上面那一版。在引擎给会话的 PATH 上；pilot、root 的 PATH 里也有它 |
| `/tmp/node-compile-cache` | root:root 755 | node 默认的编译缓存目录：先由 root 建好，别的用户的 node 在里面建不了自己的子目录，就不用编译缓存（只慢一点）。不许归别人、里面不许有别人的东西：读回判红，`france.sh` 删了重建（第五节「node 的编译缓存目录」） |
| `/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf` | root 644 | 开机清空 /tmp 后，systemd-tmpfiles 照它在任何会话之前先把上面那个目录建好 |
| `/usr/local/bin/fleet-temporal` | root 755 | 运维命令行：连 127.0.0.1:7243，默认命名空间 fleet（只有 root 和 fleet 用得了） |
| `/usr/local/sbin/fleet-agent-scope`、`/etc/sudoers.d/fleet-dao` | root 755、root 440 | 起、收 AI 会话（第五节） |
| `/usr/local/sbin/fleet-demo-scopes`；`/etc/systemd/system/fleet-demo-scopes.{service,path,timer}` | root 755；root 644 | 把演示版的可见范围推到香港（第九节「演示版」） |
| `/etc/wireguard/wg-fleet.conf`、`wg-fleet.key` | root 600 | 隧道配置与私钥（私钥本机生成，不出机器） |
| `/etc/postgresql/16/main/conf.d/fleet.conf` | root 644 | 库只听本机 |
| `/etc/systemd/system/`：`fleet-temporal.service`、`fleet-agents.slice`、`fleet-firewall.service`、`postgresql@16-main.service.d/fleet.conf` | root 644 | 单元；最后那个让库的进程没了（干净退出也算）就拉起来——装包自带的是 `Restart=no` |
| `/etc/systemd/system/`：`fleet-engine.service`、`fleet-api.service` | root 644 | 应用单元，发布脚本从要发的那版里取来装上，只装 `release.env` 启用了的（第九节） |
| `/home/fleet/.local/bin/pnpm` | fleet | corepack 的垫片，版本跟仓根 `package.json` 的 `packageManager`；发布（第九节）以 fleet 装依赖、打包用它。会话读不到 fleet 的家，用的是 `/usr/local/bin/pnpm` |
| `/home/fleet-agent-carpool/.local/bin/reclaude` | 会话用户 | reclaude 二进制：france.sh 只在没有时装（和 pilot 同一个版本、sha256），缺了读回判红；登录见第五节 |
| `/home/fleet-agent-carpool/.local/share/cursor-agent/versions` | 会话用户 | cursor-agent，一个版本一个目录（命令还链到 `~/.local/bin/cursor-agent`）：france.sh 照引擎的找法一个能跑的都没有时，以会话用户自己的身份跑官方安装脚本装，之后它自己升级；缺了、跑不成读回判红；不登录，用下面那把 API 密钥 |
| `/home/fleet-agent-carpool/.cursor/fleet-api-key` | 会话用户 600 | Cursor 的 API 密钥，只有一行、不带换行；创始人放（`deploy/cursor-key.sh put`，第五节「会话用户的 Cursor 密钥」），引擎起 Cursor 会话时由会话用户自己读进 cursor-agent 的环境。读回只看在不在、属主、权限、大小，不读值：还没放记待配，放了不对判红 |
| `/home/fleet-agent-carpool/.grok/bin/grok` | 会话用户 | grok 命令行（SuperGrok 订阅的 Grok Build），链到 `~/.grok/downloads/grok-linux-<架构>`：france.sh 看它不是能跑的文件时，以会话用户自己的身份跑官方安装脚本装；不自己升级；缺了、跑不成读回判红（第五节「会话用户的 grok」） |
| `/home/fleet-agent-carpool/.grok/auth.json` | 会话用户 600 | grok 的登录态：创始人以会话用户 `grok login --device-code` 登录一次（第五节「会话用户的 grok」），grok 自己续期。读回只看在不在、属主、权限、大小，不读内容：还没登录记待配，在却不对判红 |
| `/home/pilot/.local/bin/reclaude` | pilot 755 | reclaude 二进制：france.sh 只在没有时装（版本和 sha256 钉在脚本顶部），之后 pilot 自己 `reclaude update`。pilot 不登录 reclaude（第五节），读回也不查登没登录 |
| `/home/pilot/.mirasim-remote/`、`/home/pilot/.mirasim/` | pilot | Mirasim 桌面端连进来时自己装的服务端和它的数据（第五节），不归装机脚本管 |

香港：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/etc/fleet-dao/hk.env` | root:fleet 640 | 域名、证书联系邮箱、法国的 WireGuard 公钥、法国的两把发布公钥（上传静态文件、发飞书网关）、演示版的路径（`FLEET_DEMO_PATH`，和法国 `release.env` 的同一个） |
| `/etc/fleet-dao/gateway-token.env` | root:fleet 640 | 飞书网关的通行证，和法国那份一模一样（第九节「两台同一份」） |
| `/etc/fleet-dao/feishu.env` | root:fleet 640 | 飞书网关的配置：飞书凭据、创始人（人放），后端地址、公网地址、团队群（hk.sh 缺才补，第十二节） |
| `/srv/fleet-dao` | root:root 755 | 装机脚本所在的检出 |
| `/srv/fleet-dao-web` | root:root 755 | 静态文件，归 root：飞书网关以 fleet 跑在这台，网关被打穿也改不了页面。由法国传来：`release.json` 写着根上的驾驶舱是哪一版（只给经隧道来的读），`/health/` 是健康页，`/demo/`（`FLEET_DEMO_PATH`）是演示版、它下面的 `scopes/` 是可见范围（第九节「发静态文件」「演示版」）。装机脚本只在没有 `index.html` 时放占位页，不盖已发布的 |
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
3. 法国：`bash /srv/fleet-dao/deploy/france.sh`。它打印法国的公钥，也建好创始人的登录用户 pilot（放登录公钥、登录 reclaude 见第五节）；照样例建的 `release.env`（`FLEET_DOMAIN`）和 `api.env`（`FLEET_PUBLIC_URL`）同样把域名改成真的。重建时这些配置直接从保险箱取回（README「密钥和本机配置在哪」）。
4. 互填：香港公钥和 `<香港IP>:4500` 填进法国 `/etc/fleet-dao/france.env`；法国公钥填进香港 `/etc/fleet-dao/hk.env`。
5. 先重跑香港、再重跑法国：隧道起来，法国读回里 `ping 10.99.0.1` 通；法国这一遍还会经隧道钉住香港 sshd 的主机钥匙。
6. 发布钥匙：法国 france.sh 打印两把公钥，整行各填进香港 `hk.env`：上传钥匙的填 `FLEET_WEB_UPLOAD_PUBLIC_KEY`，发网关的填 `FLEET_GATEWAY_DEPLOY_PUBLIC_KEY`；重跑香港，再跑法国，读回里「往香港传文件的通路是通的」「香港飞书网关的入口是通的」。
7. 飞书网关的通行证拷一份到香港（第九节「两台同一份」）；飞书凭据和创始人放进香港 `/etc/fleet-dao/feishu.env`，把机器人拉进团队群，重跑香港补齐其余几项（第十二节）。
8. 手放密钥：两个 GitHub 机器人的 json 放进法国 `/etc/fleet-dao/github/`，root:fleet 640（读回会查权限）。目录配置 `catalog.json` 从保险箱放上来（第九节「目录配置」），没有它发布会停在装目录那一步。
9. 会话用户登录 reclaude（第五节，要创始人）。
10. 各再跑一遍，结论应是「本次改动 0 处」。然后发布应用（第九节），再把创始人写进驾驶舱的白名单（第九节「驾驶舱登录的白名单」那一条；不写谁都登不进）。

平时：

- 改了 `deploy/` → 机器上 `git -C /srv/fleet-dao pull` → 重跑。脚本只把它管的东西改回仓里的样子；早先版本放过、后来撤掉的几样，脚本里逐个写死了去删，别的多出来的东西不删（要删见第七节）。法国的检出由自动发布跟着主线快进，pull 可以省；france.sh 本身不自动跑（它碰防火墙、sudoers），主线上它管的文件改了、一天以上没重跑，`/healthz` 的 `deploy_lag` 会报（第九节「自动发布」）。应用那一层（引擎、驾驶舱后端）不用重跑这里，自动发布会发。
- 只看不改：`bash deploy/france.sh --check`、`bash deploy/hk.sh --check`。
- 法国经跳板登录，长连接会被重置：长命令甩到后台跑再看日志，`nohup setsid bash /srv/fleet-dao/deploy/france.sh > /root/fleet-dao-install.log 2>&1 < /dev/null &`。

输出与退出码：每步一行，`✓` 本来就对、`↻` 这次改了、`✗` 红、`…` 待配或没查成；自检里别家单元的问题用 `·` 和 `!` 列出（见第六节）。退出码 0 全绿，1 有红，2 没红但有待配。

验证用的工具：

- `bash deploy/lib/snapshot.sh ours`：fleet-dao 管的东西的指纹。连跑两遍装机，两遍之间各拍一次，diff 为空才算第二遍零改动——和脚本自己数的「改动几处」是两套判据。
- `bash deploy/lib/snapshot.sh others`：不归 fleet-dao 管的单元状态、监听端口、防火墙（系统自带的服务、MiraQuota 等）。装机脚本每次开头结尾自己比一遍：装机不许碰它们。
- `sudo bash deploy/test/run.sh`：语法、shellcheck、自检的违规样本、发布脚本的来回（`release-flow.test.sh`）、香港网关的入口（`gateway-deploy.test.sh`）、网关打包（`gateway-bundle.test.sh`，要先 `pnpm install`）、公网上看得到的几样（`public-site.test.sh`：占位页、健康页不带仓名，`release.json` 只给隧道、整站 noindex；真起 nginx 那段要这台装了 nginx）、健康页的判定（`health-page.test.mjs`）、自动发布的判断和流程（`auto-release.test.mjs`：CI 红不发、读不到不发、没成不重试、等空闲、人手动切过不动；`release.sh --auto` 那几条在 `release-flow.test.sh`）、france.sh 读回自动发布跑得怎么样（`auto-release-state.test.sh`：读每一轮写的状态文件，不看服务正在跑时是空的 `ExecMainExitTimestamp`；没有文件是还没跑过，读不了、认不出判红，读到了写上一轮的时间和干了什么，最近一轮崩了判红）、同步脚本以 root 替别的用户写（`agents-sync.test.sh`）、ddgs 的装和查（`cli-tools.test.sh`）、会话用的 pnpm 的装和查（`session-pnpm.test.sh`：钉的版本和 `package.json` 对得上、核不上不装、引擎给会话的 PATH 怎么读、会话里找不到或找错 pnpm 判红；不出网，要 root）、node 的编译缓存目录（`node-cache.test.sh`：拿真 node 对照为什么要归 root，不对的样子判红、装的时候删了重建，删不掉、建不成判红；要 root）、会话用户的 cursor-agent 的装和查（`cursor-agent.test.sh`：没装才以他自己的身份跑安装脚本、装着的不重装、跑不成和卡住判红、没查成不当成没装；假的安装脚本，不出网，要 root；找法和引擎的一样由 `packages/engine/test/real/hosts.test.ts` 核对）、会话用户的 Cursor 密钥的放、查、撤（`cursor-key.test.sh`：以他自己的身份放、属他、600、剪贴板补的换行去掉，空的、带空白、两行、带控制字符的不换、原来那份留着，读回权限太松、属主不对、空的、符号链接判红，全部输出里搜不到值；要 root）、会话用户的 grok 命令行的装和查、登录态的读回（`grok.test.sh`：没装才以他自己的身份跑安装脚本、PATH 里只有系统目录、SHELL 是 `/bin/sh`（他家 `~/.local/bin` 里 cursor-agent 链的 `agent` 不被盖掉、启动文件不改）、装着的不重装、是目录或不能跑的算没装、跑不成和卡住判红、没查成不当成没装；登录态没有记待配、符号链接、目录、属主不对、权限不是 600、空的判红，全部输出里搜不到文件内容；假的安装脚本，不出网，要 root；判法和引擎起 grok 的一样由 `packages/engine/test/real/hosts.test.ts` 核对位置）、本页端口表和脚本对得上、只有一个会话用户且它的读回拦得下故意造的错（`session-user.test.sh`：不要 root，假的 getent、sudo、id）、`adopt` 的用法校验和改属主（`agent-scope-adopt.test.sh`）。后者改属主那段要建、删真的系统账号（会话用户），只在命令行上给了 `FLEET_TEST_SYSTEM_USERS=1` 时跑（`sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy/test/run.sh`，只在 CI 的一次性机器上这么跑）；没给、或这个用户、组、家目录有一样已经在，这一段报「没跑成」（退出码 2，不算通过），不碰已有的账号。`bash deploy/test/run.sh --ops` 只跑读本页的两块（端口表、`place-file.test.sh`），CI 只改了本页时这么跑；全套里的 `ops-only.test.sh` 核对这两块真跑了、本页改坏了会红。
- `sudo bash deploy/test/agent-scope.e2e.sh`（法国）：会话通路真跑一遍，见第五节；含引擎给的 PATH 里没有会话用户的 `~/.local/bin` 时，会话里照样先找那儿、找得到 ddgs。只测 `run`、`stop`、`list`；`adopt` 在真机上还没有这样的用例，只有上一条在 CI 里跑的。

## 五、AI 会话

资源池与起会话：

- 池子 `fleet-agents.slice`（cgroup 路径 `/fleet.slice/fleet-agents.slice`）：只记账（CPU、内存、进程数、IO），池子本身不设上限（按 windsurf-dao 仓 `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md` 的「先观测」）。
- 每个会话一个 scope：`fleet-agent-<编号>.scope`，身份是会话用户，上限由引擎起会话时给。
- 引擎（fleet）自己建不了系统级 scope，会话还得换成会话用户。polkit 管不窄——systemd 255 建临时单元时不把单元名交给 polkit，放行就等于放行任何单元、任何身份——所以 sudoers 只放行 fleet 以 root 跑一个脚本：

```
sudo -n /usr/local/sbin/fleet-agent-scope run <编号> --user fleet-agent-carpool
        [--memory-high 3298M] [--memory-max 3554M --memory-swap-max 0] [--tasks-max 512] [--cpu-weight 100]
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
- 会话降权用 `setpriv --init-groups --no-new-privs`：只在自己的组里，会话里的 sudo、setuid 程序都提不了权。不用 `systemd-run --uid`：它在 scope 里不清附加组，会话会带着 root 组（法国实测）。
- 内存要真封顶，`--memory-max` 和 `--memory-swap-max` 得一起给：只给前者，超出的部分被换进 swap，会话不会被杀（法国实测）。
- 引擎正常停（SIGTERM）：sudo 把信号转给会话，会话跟着退。引擎崩了（SIGKILL）：会话留在自己的 scope 里；引擎起来后 `list` 找回、`stop` 收掉。
- 引擎的 systemd 单元不能开 `NoNewPrivileges`：开了 sudo 提不了权。
- 看用量（不用 root）：`systemctl status fleet-agents.slice`、`systemd-cgtop /fleet.slice/fleet-agents.slice`、`systemctl show fleet-agent-<编号>.scope -p MemoryCurrent,CPUUsageNSec,TasksCurrent`。
- 给池子加上限：写 `/etc/systemd/system/fleet-agents.slice.d/limits.conf`（MemoryHigh、MemoryMax、MemorySwapMax…）再 `systemctl daemon-reload`；回滚就删掉它。

会话的内存上限和测试进程数（#164，按 2026-09-26 的实测定，依据和复测办法见 `specs/164-会话内存与交活测试/方案.md`）：

- 每个会话 scope 的上限是引擎的默认值（`packages/engine/src/limits.ts` 的 `sessionMemoryHighMb`、`sessionMemoryMaxMb`，驾驶舱设置里能改）：硬上限 =（能分给会话的 11G − 平台常驻服务约 0.6G）÷ 同时跑测试的 3 个会话 ≈ 3554M；软上限只比它低 256M（3298M），超了软上限、又没有 swap 可换，内核就压着回收、会话半死不活，夹缝留窄。原来的软 1.5G、硬 2G 连 1 个测试进程加 Claude Code 都放不下（#160 卡在那里十几分钟）。现在没有东西限着「同时跑测试的不超过 3 个」，账号池的并发加起来比 3 大时要一起看。
- 会话里跑测试开几个进程，由仓根的 `vitest.config.ts` 按本进程所在 cgroup 的上限算（`packages/conventions/src/test-run.ts`：每个进程按 900M、给主进程和 Claude Code 留 1300M）：3298M 放得下 2 个；没有上限（本机、CI）照 vitest 默认；读不到、认不出上限直接报错，要硬跑就给 `VITEST_MAX_WORKERS=<进程数>`。

会话的 PATH 与 pnpm（#164 在法国复测时查出：引擎给会话的 PATH 和会话用户的登录 shell 里都没有 pnpm，会话跑不了 `pnpm test:changed`，交活核对又只认命令开头就是它，绕成 `corepack pnpm …` 不算）：

- 会话的 PATH 是这么拼出来的：fleet 命令的目录（`engine.env` 的 `FLEET_CLI_BIN`；没写就是引擎这一版代码里的 `packages/cli/bin`，`packages/engine/src/worker.ts` 的 `DEFAULT_CLI_BIN_DIR`）+ 引擎进程自己的 PATH（`fleet-engine.service` 没设，就是 systemd 给服务的默认 PATH，里面有 `/usr/local/bin`）——引擎起会话时经 `pathPrepend` 拼（`packages/engine/src/activities.ts` → `packages/adapters/src/env.ts` 的 `buildSessionEnv`），调 sudo 时改名 `FLEET_SESSION_PATH`（`packages/adapters/src/procs.ts` 的 `scopeLaunch`），`fleet-agent-scope` 再在最后接上会话用户的 `~/.local/bin`。
- `france.sh` 给会话装一份 pnpm（`deploy/lib/session-pnpm.sh`）：版本跟仓根 `package.json` 的 `packageManager`，从 npm 下 `pnpm-<版本>.tgz`、核 `france.sh` 顶部钉的 sha512（`PNPM_INTEGRITY`，npm 的 `dist.integrity`），解到 `/opt/fleet-dao/pnpm/<版本>`，入口 `/usr/local/bin/pnpm`，都归 root：会话改不动，也不在第一次用时现下。不用 corepack 给会话装：它按调用者的家目录缓存、第一次用时才下，缓存在会话自己家里、会话写得动。入口关掉 node 的编译缓存（`NODE_DISABLE_COMPILE_CACHE=1`）：pnpm 启动时会打开它，默认放在共用的 `/tmp/node-compile-cache` 下，会话能先把别的身份那一格造好、往里放东西。
- 升 pnpm：`package.json` 的 `packageManager` 和 `france.sh` 顶部的 `PNPM_VERSION`、`PNPM_INTEGRITY`（`npm view pnpm@<版本> dist.integrity`）一起改；漏改一处 `deploy/test/session-pnpm.test.sh` 就红，法国上 `france.sh` 也拒装。
- 读回：装着的文件和装的时候一样；再从在跑的引擎进程里读出它给会话的那条 PATH（`/proc/<引擎主进程>/environ` 里只取 `PATH`、`FLEET_CLI_BIN`），照引擎起会话的路子（fleet 经 sudo 调 `fleet-agent-scope`，PATH 走 `FLEET_SESSION_PATH`）以会话用户跑一次 `pnpm --version`：找不到、先找到的不是 `/usr/local/bin/pnpm`、版本不对都判红；引擎没在跑读不到那条 PATH，记待配。

node 的编译缓存目录（查 #164 时发现：会话能借它以 fleet、pilot、root 的身份跑代码）：

- 为什么：pnpm、tsc 这些命令行一起来就开 node 的编译缓存，默认放在 `/tmp/node-compile-cache/<node 版本>-<架构>-<V8 标记>-<uid>/`；node 建这个子目录用的是 mkdir -p，已经在就照用，不查归谁。/tmp 谁都能写，会话用户只要赶在别人前面建出这个目录，就能替 fleet（发布时装依赖）、pilot、root 的 uid 预先建好子目录、放进编译缓存，对方的 node 照读。
- `france.sh` 在第一次以 fleet 跑 node 之前，把这个目录建成 root:root 755（`deploy/lib/node-cache.sh`）；已经在但归别人、权限松、里面有别人的东西、是链接或文件的，整个删了重建。开机时 /tmp 清空，由 `/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf` 在任何会话之前先建好。建好后，非 root 的 node 建不了自己的子目录，就不用编译缓存（只慢一点、不报错）；root 自己的子目录别人换不掉。读回：目录归 root、755、里面只有 root 的东西，开机配置在、内容对，不然判红。
- 撤掉：删 `/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf`，`france.sh` 里去掉 `setup_node_cache` 和读回里的 `readback_node_cache`；目录留着不碍事，下次开机 /tmp 清空时就没了。

会话用户登录 reclaude（要创始人做，一次；`fleet-agent-carpool` 已登录、挂拼车组织，2026-09-26）：

reclaude 按用户记设备：组织写在家里的 `~/.reclaude/device.json`，对这个用户的所有会话一起生效，请求按设备签名。一个账户最多挂 4 台设备、一个家目录算一台，所以法国只登录这一个用户（pilot 不登录，见下面）；不拷别的用户的 `~/.reclaude`（同一设备号从两个家目录跑会互相打架）。

1. 准备（装机这边做）：`france.sh` 给会话用户装 reclaude 二进制到 `/home/fleet-agent-carpool/.local/bin/reclaude`（只在没有时装，版本和 sha256 钉在脚本顶部，以这个用户自己的身份写，之后它自己 `reclaude update`）；读回里它缺了判红——引擎起 Claude 会话用的就是这一份。不拷别的用户的 `~/.reclaude`。
2. 创始人以 root 登法国跑：`sudo -iu fleet-agent-carpool reclaude login`。终端里会打印一行「Open this URL in your browser to authorize this CLI session」和一个链接：在浏览器里打开，用 reclaude 账号登录，授权这个命令行会话；授权完终端自己往下走。
3. 选拼车组织：`sudo -iu fleet-agent-carpool reclaude org list`，找到拼车（team）那个，`sudo -iu fleet-agent-carpool reclaude org use <组织编号>`。之后切独享、切回拼车由引擎做（#59），人不手动切：一切号这个家目录下在跑的会话全断。
4. 重跑 `deploy/france.sh`：读回里「reclaude 还没登录」消失。

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

路由探针（#129，design 第九节「路由探针」）：

- 引擎每 15 分钟（每小时 7、22、37、52 分）以会话用户在 `/var/lib/fleet-work/_route-probe/<会话用户>` 起一次最小的会话（Claude 的路由起 reclaude，Cursor 的起 cursor-agent，Grok 的起 grok，模型照路由上写的）、问一句「只回 OK」，结论写进 `routes` 的 `alive`、`probe_state`、`probed_at`、`probe_detail`。Cursor、Grok 的路由探通了隔 2 小时才再真探（一次扣的是订阅里的用量：Cursor 按月的包含用量，Grok 是 SuperGrok 的额度，都和创始人自己用的是同一份），中间那几轮结论照旧；没通的每轮都探。派工只派在线的路由：一上线（换机器、库清空也一样）第一轮探完之前，引擎一条活都派不出去。发布完不想等，手动跑一轮：`fleet-temporal schedule trigger --schedule-id route-probe`。
- 看结论：驾驶舱调度台顶上「路由在线状态」；库里 `runuser -u fleet -- psql -d fleet -c "select id, alive, probe_state, probed_at, probe_detail from routes order by id"`；每一轮的结局在驾驶舱「定时任务」页（库里 `schedule_runs`、`job = 'route-probe'`）。
- 离线了看 `probe_detail`：登录失效、设备被撤销的，照原因里写的修（Claude 的是上面 reclaude 那节第 2 步重新登录；Cursor 的是换一把密钥或把密钥文件放好，上面「会话用户的 Cursor 密钥」；Grok 的是上面「会话用户的 grok」第 3 步重新登录），下一轮探通就回在线，那条「整池暂停」自动撤掉。按量计费、插头没接、会话用户挂着别的组织的是按规矩不探，不是坏了。
- 派工理由末尾出现「在线是探针 N 前的结论，之后它没再给新结论（探针可能停了）」：探针连着三轮（45 分钟；Cursor、Grok 的路由是 2 小时 30 分，它们探通了隔 2 小时才再探）没给这条路由写新结论，引擎照上一次的结论接着派（不停工）。看驾驶舱「定时任务」页路由探针那一行（没跑、没跑成还是只写进去一部分，`why` 写了原因），再手动跑一轮（上面那条命令）看它报什么。
- Claude 的探针不存会话记录（`--no-session-persistence`），会话用户家里不攒它的记录；cursor-agent、grok 没有这个开关，探针的会话留在会话用户家里的 `~/.cursor/chats`、`~/.grok/sessions` 下（一条路由一天约 12 个）。Grok 的探针不带 `--always-approve`：要权限的工具一律被拒（无头模式没人批就取消），什么命令都跑不了。目录由引擎经 `fleet-agent-scope adopt` 建，归会话用户、700。

每小时对账（工作树残留、提醒按条件撤和再推；design 第十四节「AI 会话」的目录那条、15.3）：

- 引擎每小时 41 分跑一轮（定时任务 `hourly-reconcile`）。发布完不想等，手动跑一轮：`fleet-temporal schedule trigger --schedule-id hourly-reconcile`。
- 工作树：`/var/lib/fleet-work/<owner>_<name>/` 下每一棵（子任务的树 `<需求号>-<子任务>`、检出副本 `<需求号>.<阶段>[.<子任务>]`），这张需求的工作流和它的子任务工作流都不在跑了、树里也没有没结束的会话（`session_runs` 里 `ended_at` 为空的），才算残留；有没结束的会话却没有在跑的工作流，记「没查成」写明是哪个会话（多半是被强行终止的工作流留下的，#247）。残留的以会话用户的身份看里面还剩什么：什么都不剩就经 `fleet-agent-scope remove` 删掉，子任务报的「工作树没收掉」跟着撤；能重新生成的编译和工具缓存（`*.tsbuildinfo`、`node_modules/`、`dist/`、`.turbo/`、`.vite/`、`coverage/`）和 `.fleet-out/`（会话交给引擎的结论文件）不算剩着，是不是 git 仓都一样，只剩这些的照空树删（名单在 `packages/engine/src/real/user-git.ts` 的 `DISPOSABLE`）；还剩没推的提交、没提交的改动、stash、名单以外的文件的不删，报一条「要人拍」（`worktree:<owner>_<name>/<树>`），正文写着哪棵树、剩什么（文件列前 10 个、写明一共几个）、怎么删、怎么留。检出副本里引擎检出过的提交也不算剩着。树里有目录读不了的记「没查成」、不删。`_route-probe/`、`_tmp/` 不碰。一轮最多看 80 棵，多的下一轮再看。
- 收到「要人拍」的树：先看里面，`sudo -u fleet-agent-carpool git -C <路径> status`、`sudo -u fleet-agent-carpool git -C <路径> log --oneline -5`；提醒里写着「这一层不是 git 仓」的，看 `sudo -u fleet-agent-carpool find <路径> ! -type d`。要删：以 root 跑 `/usr/local/sbin/fleet-agent-scope remove <路径>`，下一轮看它不在了就撤掉那条；要留：驾驶舱点「处理」，之后这棵树不再提醒，里面的东西推走或清掉以后下一轮会自己删。
- 提醒：条件没了的撤掉（正文开头「已撤：为什么」，处理人 `engine:hourly-reconcile`，操作记录 `notification.resolve`）；卡住报警超过 24 小时没人处理，每天最多再推一条「还没处理：<原标题>」（`remind:<原提醒编号>:<北京日期>`）。哪种提醒谁撤，清单在 `packages/engine/src/jobs/alert-sweep.ts` 开头。
- 出了事去哪看：驾驶舱「定时任务」页每小时对账那一行（没跑、没跑成、没查全，`why` 写了哪里没查成：读不了的目录、查不了的工作流、删不掉的树都在这里，不算跑成）。库里：
  - 最近几轮：`runuser -u fleet -- psql -d fleet -c "select started_at, outcome, scanned, found, why from schedule_runs where job = 'hourly-reconcile' order by id desc limit 5"`
  - 它撤了什么：`runuser -u fleet -- psql -d fleet -c "select resolved_at, dedupe_key, left(body, 80) from notifications where resolved_by = 'engine:hourly-reconcile' order by resolved_at desc limit 20"`
  - 等人拍的树、再推的提醒：`runuser -u fleet -- psql -d fleet -c "select created_at, dedupe_key, title from notifications where resolved_at is null and (dedupe_key like 'worktree:%' or dedupe_key like 'remind:%') order by created_at"`
  - 日志：`journalctl -u fleet-engine --since '-2h' | grep 每小时对账`
- 还没做的：被强行终止的工作流留下的会话要等引擎下一次起来才收（#247）；路由全熔断那条提醒还不会自己撤（#246）。

已知口子（会话用户的 reclaude 代理端口，2026-09-25 审查官发现，待定机制修，#35）：会话用户的 reclaude 守护在 `127.0.0.1` 上开两个临时端口（一个 HTTP CONNECT 代理，会话的 `HTTPS_PROXY` 指它；一个 MITM TLS 口），端口号每次重启会变。代理口不认客户端身份——本机**别的用户**（`pilot`、`fleet`）也连得上、也会被转发，等于借用这个账号的订阅（从 pilot 借会话用户的额度）。`HTTPS_PROXY` 里没有令牌，靠的是绑回环 + 会话本该只有自己碰，但回环对所有本机用户都通。

- 验证（只读、无害，不打真实模型调用）：`runuser -u fleet -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/<代理口>; printf "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n" >&3; head -1 <&3'`。回 `502 Bad Gateway`（而不是 `407 Proxy Authentication Required`）＝它接了别的用户、没要身份，能借。代理口是两个端口里对这个探测回 502 的那个（`ss -ltnp` 看 reclaude 的两个口，逐个试）。
- nft 挡不干净：端口是临时的、每次变，而 nft 的 `skuid` 只认「发起连接的是谁」，认不出「监听口归谁」，没法表达「只许本人连自己的 reclaude」。粗暴地按 `skuid` 挡住 `pilot`、`fleet` 连临时端口段能挡住这两个借用方（fleet-dao 自己的口都 < 32768，不受影响）；会话用户自己不能挡，挡了就断了它连自己 reclaude 的正路。只剩一个会话用户后，「两个会话用户互相借」这条没了。
- 真正的修法在别处、要单独拍：每个会话一个网络命名空间（回环各自独立，`fleet-agent-scope` 起会话时加，属编排/隔离机制），或请 ai-gateway-stack 让 reclaude 给代理加一个每实例令牌（`HTTPS_PROXY` 带 `token@`，代理验 `Proxy-Authorization`）/ 改绑 0700 的 unix socket。本 PR 不动它，已上报编排。

创始人的登录用户 pilot（创始人用 Mirasim 桌面端的 ssh 远程模式连 `pilot@<法国>` 干活）：

- 装机脚本管的（`deploy/lib/login-user.sh`）：建用户、加进 `systemd-journal` 组（`journalctl -u 'fleet-*'` 看日志）、装 `~/.local/bin/reclaude`（只在没有时装，写的事以 pilot 自己的身份做）、确保有 git、ssh 客户端、curl。不给它写任何 sudoers；它也不在 fleet 组里，所以读不到 `/etc/fleet-dao`，连不上 Temporal 和库（nft 表只放行 root 和 fleet）。
- 读回（`--check`）查：用户在、家目录 750、只在自己的组和 `systemd-journal` 里、`sudo -l -U pilot` 说没有、reclaude 它自己执行得了而且登录 shell 里找得到；缺了报红，写明怎么补。reclaude 登没登录、家里放了什么钥匙不查。
- **pilot 不登录 reclaude**（创始人 2026-09-26）：创始人在 VPS 上不开会话，而 reclaude 一个账户最多挂 4 台设备、法国只占 1 台，给了会话用户。reclaude 二进制照装，将来真要在 pilot 下开会话，得先腾出一台设备再登录。
- 家里不预装任何凭据。第一次要 root 帮一件事（以 pilot 自己的身份写，家里不留 root 属主的文件）：放创始人的 ssh 公钥：`sudo -iu pilot sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < <创始人的公钥>.pub`
- Mirasim 的 ssh 远程模式在 pilot 家里自己装服务端：`~/.mirasim-remote/servers/<版本>/`（自带 node 和 node-pty，不用系统的 node），`current` 指在用的那版，`run/` 下是进程号、日志和 unix socket，数据在 `~/.mirasim/`；桌面端经 ssh 把本机一个端口转到那个 socket。服务器这头要的：公钥登得进来、sshd 允许转发到 unix socket（`AllowStreamLocalForwarding`，Ubuntu 默认开）、`curl`（直接下服务端包，下不了由桌面端经 scp 传）、`tar`、`gzip`、`sha256sum`。不需要系统的 node，也不需要另起一个 systemd 管的 mirasim-server。它按登录 shell（`$SHELL -ilc`）取 PATH，Ubuntu 默认的 `~/.profile` 把 `~/.local/bin` 加了进去，所以找得到 reclaude。
- 经 Mirasim 起 Claude 会话、启动命令写 `reclaude` 的，先在 pilot 的 `~/.local/bin` 装 ai-gateway-stack 仓的 reclaude-mirasim 启动器（装法与原理见 `docs/reclaude-in-mirasim.md`）：不装的话 Mirasim 把自己网关的地址塞给 claude，reclaude 回 non_cc_client 并上报，攒多了设备会被解绑。本仓不装它。
- 已知的口子：桌面端起远端服务端时把 `MIRASIM_SECRET_KEY` 写在 ssh 执行的命令行里，那几秒里本机别的用户（包括会话用户）用 `ps` 看得到；要堵得给 `/proc` 加 `hidepid`，还没做。
- 撤掉：`userdel -r pilot`。家里是创始人的活和登录态，删之前先问人。

各家 AI 的全局说明、方法类 skill 和钩子（`packages/agents-sync`；法国的会话用户和 pilot 各一份，开发机见下面「开发机」一条）：

- 写什么：仓根 `AGENTS.md` 上半段（两行 `fleet-dao:通用段` 标记圈起来的那一块）写进各家的全局文件，`agents/skills/` 下的每个 skill 拷进各家的 skill 目录，`agents/hooks/` 下的钩子脚本拷进 `~/.fleet-dao/hooks/`、在 Claude Code 的 `~/.claude/settings.json` 里登记两条（开会话时跑 `session-start.mjs`，调 Bash、PowerShell 之前跑 `pretool.mjs`）。哪家读哪份、为什么这样放，见 `packages/agents-sync/src/targets.ts`（Windows、Linux 各一列）。
- 法国：`france.sh` 最后一步以 root 跑 `node packages/agents-sync/bin/agents-sync --apply --user <用户>`，给 `fleet-agent-carpool`、`pilot` 各写一份：同步脚本先换成那个用户再动手，写出来的都归他。读回里的 `--check` 逐人逐项列出。只写这台装了的那几家（按 PATH 和家里的 `.local/bin` 找命令），没装的列为「没装，跳过」。自动发布每发成一版，也以 root 对这两个用户跑同一条（第九节「自动发布」）：同步到哪个提交记在它的读数里，没成报警、不挡发布。钩子不装、同步位置不记（带 `--user` 时这两段跳过：开会话钩子要在那个用户自己能拉、能写的 fleet-dao 检出里快进、同步，法国的会话由引擎管；法国的检出停在自动发布发出去的那个提交上，等 CI、等空闲时本来就落后主线，拿主线比会误报）。
- 只动两样：文件里标记圈起来的那一块（标记外的内容原样留着；第一次接管、文件里还没有标记时，先把原文件整份备份，再整份换成受管块），和清单 `~/.fleet-dao/agents-sync.json` 里记着是它装的 skill（仓里删了的会撤掉；插件链进来的、claude.ai 同步来的一律不碰；同名、但清单里没记的，内容和仓里一样也不接管，判红等人处置）。备份在各用户家里的 `~/.fleet-dao/backups/<时间>/`，照原来的相对路径摆。
- 钩子只动 `~/.claude/settings.json` 里命令指向 `~/.fleet-dao/hooks/` 的那几条（以前手装在 `~/.local/share/fleet-guard/` 的两条接管时换掉），别的钩子、别的设置一条不碰；改之前整份备份。设置文件不是 JSON、`hooks` 不是对象就不动、判红；`disableAllHooks` 开着也判红（登记照写，但一条都不跑）。Grok、Devin CLI、Cursor 命令行默认也读这份设置里的钩子，脚本认得它们的输入格式；别家没装钩子，装了的逐家列一行为什么：Codex 的每条钩子要人在 Codex 里 `/hooks` 审过才跑，Kimi Code 的钩子在 TOML 里，Antigravity、Gemini CLI 是另一套事件和输入输出，pi 要写成 TypeScript 扩展，dsh 没有自带的全局钩子（依据和出处在 `packages/agents-sync/src/targets.ts` 的 `HOOK_GAPS` 上面；能接的几家接上是 #232）。
- 开发机（跑 Claude Code 的电脑）：第一次在 fleet-dao 检出里跑一遍 `node packages/agents-sync/bin/agents-sync --apply`；之后每次开会话，开会话钩子取远端、把检出的 main 快进到 origin/main，再跑一遍 `--apply`，结论一句话进会话（三分钟内刚同步成功过就跳过）。检出不在 main 上、和 origin/main 分叉、main 或 `AGENTS.md`、`agents/` 有没提交的改动时不同步，会话里写明为什么、这台落后主线几个。同一个家目录同一时刻只许一个 `--apply` 在写（锁 `~/.fleet-dao/agents-sync.lock`，拿不到退出码 2）。
- 同步到哪：`--apply` 记下同步用的检出（linked worktree 记主工作树）和提交（整次没有 ✗、没有没查成才记提交），放在 `~/.fleet-dao/synced.json`；`--check` 按本机上次取到的 origin/main 报这台同步到哪个提交、落后几个，落后、同步的提交不在主线上都判 ✗。仓不是 git 检出时只写明、不判；带 `--user`（法国）不记不判，见上面「法国」一条。
- 改了 `AGENTS.md` 上半段、`agents/skills/` 或 `agents/hooks/`：合进主线后，开发机开会话时自己跟上；法国由自动发布发完那一版跟着同步，不用人跑（在等 CI、等空闲、发布没成时还没同步，`release.sh --check` 列出的「自动发布」那一段写着规矩同步到哪个提交）；要马上生效或自动发布停着，就手动跑上面那条命令（或重跑 `france.sh`）。
- ddgs（skill docs-lookup 首选的搜索命令行）：装机最后一步以各用户自己的身份 `uv tool install ddgs==<版本>`，依赖用 `--with` 写死版本一起装（`france.sh` 顶部的 `DDGS_DEPS`），装在他家里（`~/.local/share/uv/tools/ddgs`，命令在 `~/.local/bin/ddgs`），只用系统的 Python；命令能跑、版本对、虚拟环境里的包和钉住的一样，就不动。用的 uv 装在 `/opt/fleet-dao/uv/<版本>/uv`（钉版本、核 sha256），带 `--no-config` 跑（不读他家里的 `uv.toml`：那里能改装包来源、绕过钉版本）；ddgs 和它的依赖是 PyPI 上的包，只钉版本、不核校验和。读回以各用户的身份跑 `ddgs version`，再按虚拟环境里的 dist-info 逐个核对依赖：没装、跑不起来、卡住、输出认不出、版本不对、依赖不一样、虚拟环境没了都判红（`deploy/lib/cli-tools.sh`）。装和读回用的 PATH 和会话的一样，他写得动的 `~/.local/bin` 排最后；ddgs 他改得动，读回照登录 shell 那一问的做法防卡：输出落进 root 建的临时文件、不带控制终端、10 秒叫停再过 5 秒强杀。下载 uv 失败按装机的规矩判红停下；这一步排在最后，规矩已经写完。
- 自测：`sudo bash deploy/test/run.sh` 里的 `agents-sync.test.sh` 以 root 建临时用户，验换身份再写、写出来的都归他、第二遍零改动、属主不对判红、root 不带 `--user` 往别人家里写被拦下；`agents-sync-account.test.sh` 用假的同步脚本验装机怎么记账（崩了判红、写时的 ✗ 只打不记）；`cli-tools.test.sh` 用假的 uv、ddgs 验 ddgs 的装和查（装错了、卡住了都判红，不出网）。会话的 PATH、会话里找不找得到 ddgs 在 `agent-scope.e2e.sh` 和 `packages/adapters/test/e2e/scope-e2e.ts`（法国）里查。钩子、同步位置、写锁在 `packages/agents-sync/test/hooks.test.ts`、`packages/agents-sync/test/position.test.ts`、`packages/agents-sync/test/lock.test.ts`；`packages/agents-sync/test/session-hook.test.ts` 拷一份仓、装上钩子，真跑一遍「主线走了 → 开会话钩子快进、同步」和「原件坏了 → 会话里明说没查成」；两个钩子脚本本身在 `agents/test/session-start.test.ts`、`agents/test/rules/pretool.rules.test.ts`。
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
# 0. 先停自动发布（不然它会接着发、把应用装回来），再停应用、撤掉单元（各版代码还在 /srv/fleet-dao-releases）
systemctl disable --now fleet-auto-release.timer
rm /etc/systemd/system/fleet-auto-release.service /etc/systemd/system/fleet-auto-release.timer && rm -r /usr/local/lib/fleet-dao
systemctl disable --now fleet-engine.service fleet-api.service
rm -f /etc/systemd/system/fleet-engine.service /etc/systemd/system/fleet-api.service
# 演示版的可见范围不再往香港推（香港上已有的范围文件留着，演示版照旧按它们给人看）
systemctl disable --now fleet-demo-scopes.path fleet-demo-scopes.timer
rm /etc/systemd/system/fleet-demo-scopes.service /etc/systemd/system/fleet-demo-scopes.path /etc/systemd/system/fleet-demo-scopes.timer /usr/local/sbin/fleet-demo-scopes
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
- 应用单元（`deploy/france/fleet-*.service`）跟着版本走：改单元就是发一版，退回时单元也跟着退。引擎单元不能开 `NoNewPrivileges` 和挂载隔离（第五节、单元里的注释）。
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

平时不用人发：自动发布每 5 分钟看一轮主线，CI 全绿的新提交等引擎空闲后自己发（本节末尾「自动发布」）。上面几条留给人手动发、退回、重试。

发布和退回自己交给 systemd 跑（临时服务 `fleet-dao-release-<时间>`），终端只跟着看日志：跳板断线、终端关了，发布照样跑完。日志在 `/srv/fleet-dao-releases/.logs/`（开头会打印路径，留最近 30 份），断了之后 `tail -f` 它接着看。`--check` 就在终端里跑。
输出与退出码同装机脚本；没过健康检查、已自动退回，也是 1。

每一步：

1. 取代码：从 GitHub 取主线到 `/srv/fleet-dao-releases/.repo.git`（root 的裸仓）。只发主线上的提交；合并前要在真机上验，加 `--unmerged`，历史里会标出来。
2. 构建：代码解到临时目录，以 fleet 跑 `pnpm install --frozen-lockfile`（依赖整份拷进来，不和 fleet 的 pnpm 仓库共用文件）；有 `packages/web` 就构建它（产出 `dist/client`，登录页的「看演示版」指向 `FLEET_DEMO_PATH`），没有就用占位页；再放上健康页 `/health/`、版本标记 `release.json`（带完整提交号，香港只给经隧道来的读）。这一版的 `packages/web` 有 `build:demo` 的，再按 `FLEET_DEMO_PATH` 构建演示版（放进这一版的 `web-demo/`，路径记进 `.fleet-release` 的 `demo_path=`）：打包完先查第三方许可证声明 `licenses.txt` 在不在（演示版去掉了注释，声明只在这个文件里，页面上不放链接），再自己扫一遍产物（连声明一起扫），声明缺了，或出现真名、内部叫法、`FLEET_DOMAIN`、GitHub 地址、源码对照文件，就构建失败、不切版本。有 `packages/feishu` 就把飞书网关连同依赖打成一个文件 `gateway/gateway.mjs`（第十二节）。然后整棵树换成 root、fleet 只读，挪到 `/srv/fleet-dao-releases/<提交号>`。第三方代码不以 root 跑；root 照着起服务的单元文件，是换属主之后 root 才从 git 里取出来放进 `.units/` 的。构建日志在这一版目录的 `.fleet-build.log`。
3. 先试通香港这次要发的那几样（`FLEET_HK_PARTS`，见本节末尾）：发静态文件或演示版就 `rsync -n`（什么都不传），发网关就问一次网关入口的 `status`。不通就停，不切版本——不然健康检查必不过，新旧两版会一起被记成不健康。
4. 迁移：以 fleet 跑 `packages/db` 的迁移（库 fleet，本机 socket）。在切版本之前跑，只进不退（第八节）。每一版带几个迁移记在它的 `.fleet-release`（`migrations=`）。跑之前先比库：库里跑过的比这一版带的多（直接发了个老提交），就停、不切——drizzle 碰到比代码新的迁移记录什么也不做、也不报错，光靠迁移这一步拦不住。迁移完装目录：以 fleet 跑这一版的目录装载器，把 `/etc/fleet-dao/catalog.json` 装进库（下面「目录配置」）；装不成、装完读不回就停、不切。
5. 切版本：`current` 原子地指到这一版；`/etc/fleet-dao/release.env` 的 `FLEET_SERVICES` 里启用的服务装上这一版的单元、起来，没启用的停掉、撤掉单元。要不要重启看服务的主进程在哪个目录（`/proc/<主进程>/cwd`）：不在这一版的目录里就重启——所以上次切完 `current`、还没重启完就被打断，重跑同一版照样会重启；单元或环境文件变了也重启。
6. 发静态文件：经隧道用 rrsync 传到香港 `/srv/fleet-dao-web`，每处都是新文件先落临时名、最后一起换上，旧文件最后删（在香港属 root）；按内容比、不带修改时间：内容没变的文件不传、不算变化。香港的 rrsync 同一时刻只让一个进来、后到的直接被拒，所以法国这头往香港推（这一步、第 3 步的试通、france.sh 读回的试跑、`fleet-demo-scopes`）都先拿同一把锁 `/run/lock/fleet-dao-hk-rsync.lock` 排队，等 2 分钟还轮不到就照实报红（2026-09-26 发布撞上过 `fleet-demo-scopes`，没切版本）。
   - `FLEET_HK_PARTS` 里有 `demo`（只有人手动发布、退回才发；自动发布不发，本节末尾「自动发布」）：演示版发到 `FLEET_DEMO_PATH`（默认 `/demo/`），只动这一个目录，根地址不碰；它下面的 `scopes/` 是可见范围，归 `fleet-demo-scopes` 推，发布不删。发成了当场记下香港上的演示版是哪一版：`/srv/fleet-dao-releases/.demo-published`（提交号、发的时间、路径、首页的 sha256），之后的健康检查、`--check` 都照它比；同一版再发一遍不重写。这一版没带演示版（老提交），或演示版是按别的路径构建的（改过 `FLEET_DEMO_PATH`），这次不发、记一项待配。
   - 明写了 `web`（默认不发）：驾驶舱静态文件连健康页、`release.json` 整套发到根地址，根上不是这一版的文件会被删掉，但演示版的目录一概不碰。放在演示版后面：`release.json` 换了就说明这次要发的都发完了。
   在演示版的目录里、根地址上（发 `web` 时）手放的东西，下次发布就没了。接着发飞书网关（第十二节）。
7. 健康检查：启用的服务 10 秒里没退出、没重启，主进程跑的是这一版的目录；`fleet-api` 的驾驶舱接口在答健康报告、切之前好的项没变坏（会随时间自己变红的项除外：待开单积压 `draft_backlog`、判断题 `judge`（最近一次调用没成跟着上游变红）、跟上主线 `deploy_lag`（主线一动就可能落后）、飞书网关 `feishu_gateway`（网关、隧道、香港出事就红，后端刚重启、网关还在退避重连时是「没查成」）只记待处理，不退回），fleet 命令接口在听；`fleet-engine` 90 秒内到任务队列 fleet 上取活（工作流任务、活动任务都要有它）；发了静态文件的话，香港在发这一版（经隧道读 `release.json`、健康页 200）；配了演示版的话（自动发布不发也照样查），香港上的演示版首页和发演示版的记录（`.demo-published`）一字不差——人手动发布刚发的，这时就是这一版的；自动发布不发，就该还是上次人发的那份，和在用的这一版不一样不算错，只列一行「还没发」（对外，按版本由人确认后手动发）。对不上（被改过、没发全）、取不到、记录认不出，报红；还没有记录（没人发过）、记录里的路径不是现在配的，记待处理（没查成，不当成好了）。深链接（`/demo/tasks/…`）要回落到演示版自己的首页——回落到根上的，是香港的站点还是旧的，记一项待配：香港 `git pull` 后重跑 `hk.sh`；这次切了飞书网关的话，它以这一版连上了飞书、起稳了（第十二节）。不过就自动退回上一版（同样的切法、同样的检查），报红；但库里跑过的迁移比上一版带的多时不退，停在新版报红等人（旧代码对着新表结构会出错，健康检查还查不出来）。
8. 清旧版：留 5 版——在用的、上一版，再按最近用过的补满。

同一个提交跑第二遍，结论是「本次改动 0 处」；两遍之间各拍一次 `bash deploy/lib/snapshot.sh ours`，diff 为空（快照里每一版整棵树的名字、大小、修改时间、属主、权限压成一个指纹，重新构建一定会变）。这样比之前先停自动发布（`systemctl stop fleet-auto-release.timer`，比完 `start`）：两遍之间它可能发了新版。

退回：

- `--rollback` 退到「上一版」：历史里最近在用过、不是现在这版、没被判过不健康、目录还在的那一版。退之前先比库：库里跑过的迁移比那一版带的多（或读不清），不退、报红；也先试通香港。
- 健康检查没过的版本在历史里记成不健康，`--rollback` 不会退到它；它以后再发一次、过了，就记回健康。
- 历史在 `/srv/fleet-dao-releases/.history`，一行一件事：时间、提交号、事件（`release`、`rollback`、`auto-rollback`、`unhealthy`、`recovered`），合并前发的带 `unmerged`，自动发布那一次里记的（发布、不健康、自动退回）带 `auto`。

本机起哪些服务（`/etc/fleet-dao/release.env`，照 `deploy/france/release.env.example` 建一次，之后归人改）：

```
FLEET_SERVICES=fleet-engine fleet-api   # 空 = 只发代码、迁移，不起服务
FLEET_DOMAIN=<驾驶舱域名>
FLEET_HK_PARTS=gateway                  # 往香港发哪几样：gateway 飞书网关、demo 演示版、web 静态文件；不写 = 只发 gateway
FLEET_DEMO_PATH=/demo/                  # 演示版的路径，和香港 hk.env 的同一个
```

`FLEET_HK_PARTS` 默认不发静态文件：发了就会把香港根地址上的东西（现在是演示版）整个换成这一版的前端，等于对外发布——先告诉创始人，再在 `release.env` 里加上 `web`。去掉一样，发布就不碰香港上的那一样（也不查它的健康）。

起一个服务之前先把它要的配置备齐：起不来的话健康检查过不了，会自动退回。

演示版（假数据、不用登录、换了一套名字，设计文档第十四节）：

- 在哪：香港站点的 `FLEET_DEMO_PATH`（默认 `/demo/`），法国 `release.env`、香港 `hk.env` 各写一份、写同一个，两边对不上时发布的健康检查会报出来。香港的站点配置里演示版单有一段：深链接回落到它自己的首页，`scopes/` 查不到就是 404、不缓存。
- 游客能看什么：正式驾驶舱的「演示版」页发链接（模块开关、细节级别、有效期）、作废、改默认范围。后端（`api.env` 的 `FLEET_DEMO_DIR=/var/lib/fleet-dao/demo`，后端的单元只放行这一处可写）把可见范围写进 `scopes/`；`fleet-demo-scopes.path` 看到目录一变就拉起 `/usr/local/sbin/fleet-demo-scopes`（root），把 `scopes/` 推到香港演示版目录下的 `scopes/`，`fleet-demo-scopes.timer` 每 10 分钟再补一次。作废、到期 = 那个文件没了，香港跟着删；后端每小时撤一次到期的。推的脚本只推长得和后端写的一模一样的文件，认不出的不推、退出 1。演示版只读这些静态文件，法国停了照样能看；一份都没有时按最严的范围（只看看板、只看状态和耗时）。
- 看：`systemctl status fleet-demo-scopes`、`journalctl -u fleet-demo-scopes -n 20`；france.sh 的读回里有「上次推到香港是……」。手动推一次：`systemctl start fleet-demo-scopes`。
- 头一回上：香港先 `git pull` 重跑 `hk.sh`（站点加上演示版那一段），法国 `git pull` 重跑 `france.sh`（建目录、装推送单元）；`api.env` 加上 `FLEET_DEMO_DIR`、`release.env` 的 `FLEET_HK_PARTS` 加上 `demo`，再发布。法国的 `/srv/fleet-dao` 要先拉到新的：旧的发布脚本不认 `demo`，发 `web` 时还会把演示版的目录一起删掉。

| 单元 | 身份 | 跑什么 | 读的配置（都在 `/etc/fleet-dao`） |
|---|---|---|---|
| `fleet-engine` | fleet | `node packages/engine/src/main.ts`（Temporal worker，任务队列 fleet） | `engine.env`（`FLEET_ENGINE_PORTS=real` 真端口 / `fake` 假端口，必须写；真端口另要机器名、工作树的根、reclaude 的路径、卫生检查的名单 `FLEET_SENSITIVE_VALUES_FILE`，见样例）、`agent-token.env`、`github/`（两个 GitHub 机器人） |
| `fleet-api` | fleet | `node packages/api/src/main.ts`：一个进程两个监听，驾驶舱接口 `10.99.0.2:8787`、fleet 命令接口 `127.0.0.1:8788` | `api.env`、`agent-token.env`、`session-secret.env`、`gateway-token.env`、`github/`（两个机器人的 json） |

- 两个都是 `Restart=always`。引擎不开 `NoNewPrivileges`（要经 sudo 调 `fleet-agent-scope` 起会话），也不开挂载隔离（会话是它的子进程，会跟着看不见自己的家目录）；后端不起子进程，照常收紧。
- `engine.env`、`api.env` 照仓里 `deploy/france/*.env.example` 建一次，之后归人改（飞书、GitHub 的凭据填在 `api.env`），改完再发布一次就会重启对应服务。库连接写成 `DATABASE_URL=postgres:///fleet` 加 `PGHOST=/var/run/postgresql`：本机 socket、peer 认证，没有口令（postgres.js 不认连接串里的 `?host=`）。
- `api.env` 也要连 Temporal：`TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE` 和 `engine.env` 那两行同一份值，发给工作流的信号和 `/healthz` 的 `temporal` 项都用；`FLEET_TASK_QUEUE` 只给 `/healthz` 的 `engine` 项查任务队列上有没有 poller 用，不给都有默认值（`127.0.0.1:7243`、`fleet`、`fleet`），Temporal 没起来时后端照样能起，健康检查会如实报红。
- 随机密钥各一个文件，france.sh 首次生成，之后不动、不打印：`agent-token.env`（`FLEET_AGENT_TOKEN_SECRET`：引擎签 fleet 通行证、后端验）、`session-secret.env`（`FLEET_SESSION_SECRET`）、`gateway-token.env`（`FLEET_FEISHU_GATEWAY_TOKEN`）。
- france.sh 读这些环境文件和 systemd 同一种读法（`deploy/lib/app-config.sh` 的 `env_parse`）：行首的空白、`=` 两边的空白不算，值去掉一层引号，同一个键写了几行、服务里生效的是最后一行。读回说的就是服务里生效的那个值；同一个键写了几行直接判红（删成一行，脚本不猜该留哪一行）。文件读不到、引号到文件末尾都没配上，判红、不改文件。这些文件和三个随机密钥文件的路径是目录、符号链接（含断链）的，也判红、跳过，什么都不改（属主权限会跟着链接改到别处，写文件会把链接换掉）。
- 样例后来加的键，france.sh 在机器上的 `engine.env`、`api.env` 里没有时照样例补上（只补缺、已有的值一概不动，补在文件末尾、前面一行注释写明补了哪几个）。键在文件里出现过就不补：生效的赋值（行首缩进、`KEY = 值` 都算）、注释掉的赋值（`# KEY=…`）、光写了键都算出现过——**注释掉的键不会被补回来**，要恢复就自己放开那一行。`FLEET_ENGINE_PORTS` 要人定（碰不碰真仓、真会话），样例里有也不补，第一次照样例建 `engine.env` 时这一行也写成注释，没写（或还是注释）读回判红。`release.env` 整份不补，它的每一项都要人定。补键不改已有的值，所以 `engine.env` 里要钉在约定值上的三项——`FLEET_WORK_DIR`（`/var/lib/fleet-work`，fleet-agent-scope 只认这一个）、`FLEET_ENGINE_STATE_DIR`（`/var/lib/fleet-dao/engine`）、`FLEET_SENSITIVE_VALUES_FILE`——由读回核对：值不对、写了几行判红，没写、被注释掉记待配。读回也核对 `engine.env`、`api.env`、`release.env` 和三个随机密钥文件都是 root:fleet 640：组读不到时 root 读回照样读得到、服务却起不来。
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
- 「让 AI 接活」开关（design 第九节「在哪能做与接活开关」，库里是 `repos.auto_dispatch_since`）：驾驶舱的开关页面（#131）做好之前，在法国以 root 用同一个管理命令开关；页面做好以后这条命令留作运维的后备，两边写的是同一份数据、走同一个写入口（`Store.setAutoDispatch`）。

  ```
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch <owner>/<仓名> status   # 只看：开着还是关着、最近一次谁什么时候开关的
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch <owner>/<仓名> on       # 打开：记下此刻，只有这之后新开的、挂在当前版本上的 issue 自动派
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch <owner>/<仓名> off      # 关上：设为空，只收单、显示，不派
  ```
  和 set-password 一样换成 fleet、带上 `api.env` 连库；仓名不分大小写。已经是要的状态就不改、不记：开着时再 `on` 不重设时刻（重设会把已经能派的单变成「开关打开以前开的」）。改了就在同一个事务里记一条操作记录（`repo.auto_dispatch.enable` / `repo.auto_dispatch.disable`，target 是 `repo:<仓的 id>`，来源记成 engine，reason 写明谁跑的哪条命令，before / after 是开关原来和现在的值），改完从库里读回开关和这条记录再打印。退出码：0 查到了、改好了或本来就是；1 没做成（库里没这个仓、连不上库、写库出错、读回来对不上，一句话说原因和怎么核对）；2 参数不对或没带上库连接。
  开着也只派当前版本的单（design 第九节「在哪能做与接活开关」，0003 第 2、8 条）：当前版本 = 还开着的 `v<N> …` 里程碑里 N 最小的那个，拉起前「引擎」机器人在 GitHub 上现读这张单挂在哪。没挂里程碑（未排期）、挂在别的版本或已经关了的里程碑上的，任务行照建、不派，投递的 note 写 `workflow=unscheduled` / `workflow=not_current_version`；里程碑认不出版本号写 `workflow=version_unreadable` 并告警；读不到里程碑（GitHub 出错、机器人凭据没读到）这条投递记成出错（原因以「没查成：读不到 … 挂在哪个版本」开头），对账重放时再判。挪进当前版本（`milestoned`）照开关规矩再判一次。看哪些单因为版本没派：`sudo -u fleet psql fleet -c "select delivery_id, received_at, note from github_events where note like '%workflow=unscheduled%' or note like '%workflow=not_current_version%' or note like '%workflow=version_unreadable%' order by received_at desc limit 20"`。
- 交给 fleet（design 第九节「在哪能做与接活开关」）：开关打开以前就开着的、挂在别的版本上的、未排期的单，自动派不碰，由人明说交给引擎。驾驶舱的「交给 fleet」按钮（#282）做好之前，在法国以 root 跑：

  ```
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api handover <owner>/<仓名> <issue 号> --reason "<谁说的、为什么>"
  bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api handover --help   # 只打印用法
  ```
  和 dispatch 一样换成 fleet、带上 `api.env`：连库；还要连 Temporal 起工作流（`TEMPORAL_ADDRESS` 这几项，和后端同一份），读 `/etc/fleet-dao/github` 下「引擎」机器人的凭据去 GitHub 上看这张单此刻开没开着、挂在哪个版本。`--reason` 必带（写进操作记录，最多 500 字），issue 号写 `214` 或 `#214` 都行。依次查、不对就拒（什么都不派）：库里有这个仓；「让 AI 接活」开着（关着一律拒，写明先 `dispatch … on`，开不开由创始人拍）；流程配置副本能用（停派的项目不派）；库里有这张单的任务行（接活收进来过；还没有就等下一轮对账补收）；读得到 GitHub 上这张单（读不到说「没查成」）。再按这张单此刻的样子（判法在 `packages/core/src/dispatch.ts` 的 `handoverDecision`）：GitHub 上关着的拒（任务还在跑也拒：关单会叫停它）；还在排队的拉起 Fusion 工作流；在跑的不重复起（退出码 0）；已经结束的只有 GitHub 上重开过才再起一轮，没重开的拒（要再做一轮先在 GitHub 上关了再开）。没被拒的（起了、没起成、本来就在跑）都记一条操作记录 `task.handover`（target 是 `task:<任务 id>`，来源记成 engine，reason 写明谁跑的和 `--reason` 原话，before 是任务原来的状态，after 是工作流编号、起没起成（`started` / `already_running` / `in_progress` / `failed`）、挂在哪个版本），从库里读回再打印；驾驶舱这张单的时间线显示「交给 fleet：…」。退出码：0 起了，或本来就在跑；1 没交成（被拒、没查成、Temporal 连不上、操作记录没写进去，一句话说原因）；2 参数不对或没带上库连接。
- 后端收 GitHub 事件：原文一次投递一行落进库里的 `github_events`（状态、原因、做了什么都在）。PR、CI 事件要用 `github/` 里两个机器人的凭据写镜像，凭据只在后端启动时读一次：读不到时后端照样起、issue 照收，PR 和 CI 事件记成出错，健康检查的 `github_events` 报红；补上凭据后要重启 `fleet-api` 才读得到。记成出错、等着的投递原文还在，每轮对账（引擎的定时任务 `github-reconcile`，每 15 分钟）按原文重放：出错的最多自动重放 5 次；等着的（重开时上一轮还没结束、这个项目停派）每轮都重放、不占次数。重放到头的没有手动再推的入口，只在健康检查里报红。
- GitHub 不会自己重投没送到的 webhook：漏收的靠对账调它的重投接口、再按仓轮询补回。
- 接 GitHub 要齐两样，缺一样 GitHub 上的单就进不来（事件、对账补回来的都被门挡掉，投递账上记「不收」、不算出错），健康检查的 `github_events` 会报红（`no_repos`、`no_github_members`）；驾驶舱还没有加仓、改成员的页面，现在在库里加（新机器上两张表都是空的）：
  - 受管的仓：GitHub App 装在哪几个仓上，就给哪几个仓各加一行（`test_command` 先填个占位 `-`，对账读成仓里的配置后会改成里面的测试命令）：`sudo -u fleet psql fleet -c "insert into repos (owner, name, default_branch, test_command) values ('<owner>', '<仓名>', 'main', '-') on conflict (owner, name) do nothing"`。App 装在哪些仓上，在 GitHub 上 App 的安装页看。
  - 测试命令、流程配置写在各仓仓根的 `.fleet/flow.json`（只写和全组织默认 `packages/core/flow.default.json` 不同的，格式见 `packages/core/src/config.ts`；fleet-dao 自己的在仓根）：要改就改那个文件、合进主线，对账每 15 分钟读一次默认分支头上的这份，合并校验后同步进库里的副本（`repos` 表的 `flow_*` 列，`test_command` 跟着改成一样的给人看），最多一刻钟生效；不在库里手改。测试命令是写码会话交活要原样跑的那一条（起会话时记进 `session_runs.test_command`，交活核对只认它，`packages/api/src/done-check.ts`），所以只放会话跑得过的——只跑改动影响到的测试，不放全量检查、卫生检查（会话用户按设计读不到敏感值名单，那两样归 CI 和引擎推分支时自己的扫描）；fleet-dao 是 `pnpm test:changed`。
  - 派活只认副本（判法在 `packages/core/src/replica.ts`）：仓里没有这个文件就用全组织默认（副本标 `org_default`），但全组织默认里不放测试命令，这种仓的写码会话会停下说「项目没写测试命令」；文件认不出（坏 JSON、格式不对）这个项目停派，提醒中心报一条 `flow-config:<owner>/<仓名>`；读的时候 GitHub 出错只记「没查成」、副本不动，超过 45 分钟没同步成同样停派、报提醒。停派时新来的单照收（建任务行），投递记成等着，副本好了那一轮对账重放、自动拉起。核对（加完仓想马上同步，先手动跑一轮下面那条对账）：`sudo -u fleet psql fleet -c "select owner, name, test_command, flow_source, flow_commit, flow_synced_at, flow_error, flow_unread from repos"`。
  - 带 GitHub 账号的成员：白名单按 `users` 表认 GitHub 作者（有数字编号只按编号认），创始人那一行补上 GitHub 的数字编号和登录名，两个机器人各加一行 `role = 'bot'`（编号是 `<App 的 slug>[bot]` 这个用户的编号，不是 App 的编号）；数字编号用 `gh api users/<登录名>` 查：`sudo -u fleet psql fleet -c "update users set github_id = <编号>, github_login = '<登录名>' where id = '<创始人那一行的 id>' and github_id is null"`、`sudo -u fleet psql fleet -c "insert into users (display_name, role, github_login, github_id) values ('<slug>[bot]', 'bot', '<slug>[bot]', <编号>) on conflict (github_id) do nothing"`。
  - 加完手动跑一轮对账（`fleet-temporal schedule trigger --schedule-id github-reconcile`），已经开着的单这一轮就补进来。
- 受管的仓就是库里 `repos` 表的行，别的仓的事件一律不收。「让 AI 接活」开关是 `repos.auto_dispatch_since`：空 = 关着，只收单（建任务行）、不拉起工作流（打开后给挂在当前版本上的单起 Fusion 工作流，design 第五节、第九节）；打开以前就开着的、别的版本的、未排期的 issue 也不自动派，要交用上面的 `fleet-api handover`。开关用上面的 `fleet-api dispatch`，别直接改库：直接改的不进操作记录。

两台同一份（飞书网关的通行证）：法国生成，原样拷到香港，值不过屏幕。香港那头先落临时名，收到的不是完整的一行通行证（法国那头没读成、传到一半断了、读到的是报错）就不换，原来那份原样留着：

```
# 在能同时登两台的机器上
ssh <法国> 'cat /etc/fleet-dao/gateway-token.env' | ssh <香港> 'f=/etc/fleet-dao/gateway-token.env; t=$(mktemp /etc/fleet-dao/.new.XXXXXX); if cat > "$t" && grep -qE "^FLEET_FEISHU_GATEWAY_TOKEN=[0-9a-f]{64}$" "$t" && chown root:fleet "$t" && chmod 640 "$t"; then mv "$t" "$f"; else rm -f "$t"; echo "没换：收到的不是完整的通行证" >&2; exit 1; fi'
# 核对：比指纹，不看值
ssh <法国> 'sha256sum < /etc/fleet-dao/gateway-token.env'; ssh <香港> 'sha256sum < /etc/fleet-dao/gateway-token.env'
```

目录配置（`/etc/fleet-dao/catalog.json`：族、渠道、账号池、模型、路由、各阶段的路由顺序）：真文件在保险箱仓的 `france/etc/fleet-dao/catalog.json.age`，取值和仓里的样例 `deploy/examples/catalog.example.json` 一样——目录里没有账号、邮箱、组织编号。法国解不开保险箱，所以在创始人电脑上、保险箱仓里放上去。法国那头先落临时名，收到的是空的、不是完整的 JSON 就不换：解密失败（那头收到空的）、传到一半断了（半截也能正常收完，光看空不空挡不住），法国上原来那份原样留着：

```
# 在创始人电脑上、保险箱仓里（解密钥匙 ~/.fleet-dao/vault-key.txt；age 装在 ~/.fleet-dao/bin，不在 PATH 里）
~/.fleet-dao/bin/age -d -i ~/.fleet-dao/vault-key.txt france/etc/fleet-dao/catalog.json.age | ssh <法国> 'f=/etc/fleet-dao/catalog.json; t=$(mktemp /etc/fleet-dao/.new.XXXXXX); if cat > "$t" && [ -s "$t" ] && node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "$t" && chown root:fleet "$t" && chmod 640 "$t"; then mv "$t" "$f"; else rm -f "$t"; echo "没换：收到的是空的或不是完整的 JSON" >&2; exit 1; fi'
# 核对：比指纹
~/.fleet-dao/bin/age -d -i ~/.fleet-dao/vault-key.txt france/etc/fleet-dao/catalog.json.age | sha256sum; ssh <法国> 'sha256sum < /etc/fleet-dao/catalog.json'
```

- 2026-09-26 起（法国只留一个会话用户）：账号池的 `runAsUser` 只收 `fleet-agent-carpool`，Claude 订阅池还要带 `orgKind`（`carpool` / `solo`，照样例）。旧的这份里写着 `fleet-agent-dedicated`，装载器会明确拒收、发布停在装目录那一步：先把它改成 `fleet-agent-carpool`、两个 Claude 池补上 `orgKind`，放上来、刷新保险箱，再发。库里已有的行由迁移 0007 改好（挂在停用用户下的池改到会话用户，按原来的用户记下组织类型），不用手改。
- 发布时迁移之后装进库（上面第 4 步）：只补缺——库里没有的行插进去；已有的行只补空着的会话用户、组织类型（`orgKind`）、到期日、上游名字，别的字段配置和库里不一样也不动（发布日志里一处一行，照实写成「没动：pools.claude-solo.maxConcurrency：库里是 3，配置是 4，没动」这样）；每个阶段只排一次。
- 文件不在、是符号链接、不是 root:fleet 640、装不成（格式错、引用不存在、撞硬禁令）、装完读不回，发布都停下、不切版本、报红；装完账号池、路由、阶段、阶段里挂的路由哪张是 0 行也一样。装不成时发布再读回一次，红里写明库和装之前一样、库变了要人看，还是没查成。同一版再发，这一步改动 0 处。
- 装进去之后怎么改。这份文件里已有的行改了值，已经装进库的不跟着变，只管以后换机重装；新加的行发布时会装进去（下面第二条）：
  - 阶段的顺序、挂上摘下、钉住，和渠道的开关：在驾驶舱里改（驾驶舱后端写目录只写这两样）。阶段里单条路由的开关驾驶舱还没有：先摘下、再挂上，挂上的就是开着的。
  - 往这份文件里新加的渠道、池、模型、路由：发布时装得进库，但不会自动挂到排过的阶段上（发布日志里点名「没挂上」），去驾驶舱挂。
  - 已有池的并发这类字段：装载器不改已有的，驾驶舱也改不了，只能在法国库里直接改（不进操作记录），例如把独享号的并发改成 3：`runuser -u fleet -- psql -d fleet -c "update pools set max_concurrency = 3 where id = 'claude-solo'"`。改完把这份文件也改成一样、刷新保险箱，换机重装时才不会装回旧值。
- 在法国改了这份，就在创始人电脑上跑一遍保险箱仓的 `refresh.sh` 刷新副本。反过来，法国上还没有它的时候别跑 `refresh.sh`：它以服务器为准，会把保险箱里的这份删掉（git 历史里还找得回）。

往香港传静态文件的钥匙：法国 `/etc/fleet-dao/web-upload.key`（root 600，france.sh 生成）；香港 root 的 `authorized_keys2` 里那一行限死成 `from="10.99.0.2",restrict,command="/usr/bin/rrsync -wo -munge /srv/fleet-dao-web"`：只许从隧道地址来、不给终端、只能往这一个目录写、读不走任何东西。`-munge`：传来的符号链接落地时改成无效的样子，法国 root 失守也没法借链接让 nginx 读出目录外的文件。香港 sshd 的主机钥匙由 france.sh 经隧道取来钉住（隧道两头靠 WireGuard 钥匙互认），发布时只认这一把。

健康页 `https://<驾驶舱域名>/health/`：

- 读 `/healthz`：香港经隧道转给法国驾驶舱后端，后端逐项探库、Temporal……，全好回 200、有一项不好回 503。每 15 秒刷新。公网 `/healthz` 在香港限流：每个来源每分钟 30 次、突发 10 次，超了回 429（健康页照样报红，写明是限流）。
- 功能还没做的项报「未接」（`{ ok: true, status: "not_wired", message }`，message 带单号，比如飞书草稿开成 issue 的 #91）：不算失败、不让 `/healthz` 变 503，健康页写成「未接：…」、灰点；只认装配时的标记（`HealthCheck.notWired`，由「没接上的那个实现」自带，比如 `notWiredDraftOpener`），检查跑出来抛什么都判不成未接，接上以后读不到、出错照样红；健康页对样子不完整的「未接」（缺原因、status 认不出）也判红。驾驶舱同一个做法：还没做的读取器（`packages/api/src/main.ts` 的 `notWired`：现在只剩额度读取 #76；路由探针 #129 已接上，调度台顶上是真的在线状态）让对应那一块整块显示「待实现」占位（阶段 + 单号，链到单），不把「没读到」说成「没查成」「离线」；接上哪个就删掉 `notWired` 里哪一项，之后读失败照实显示「没查成」。
- 判断题（`judge` 项，健康页写「判断题」）：`/etc/fleet-dao/jev.json` 在不在定「未接」——后端起来时看一次，没写 `FLEET_JEV_CONFIG`、默认位置上又没有才算未接，补上文件要重启 `fleet-api` 才显示出来。有了就每次探，判法和引擎每次提问是同一份（`packages/jev` 的 `wiring.ts`）：配置读不出来、认不出，调度台判断阶段没有开着的路由，钥匙读不到，报红（`judge_config`）；最近一次真发给上游的调用没成报红（`judge_failing`），下一次调成了自动变绿。原因只进 `journalctl -u fleet-api`（哪道题、为什么、上游原文）；引擎那边起来时登记两道题的结果、每次起不来的原因在 `journalctl -u fleet-engine`。
- 跟上主线（`deploy_lag` 项）：线上版本落后主线多少、自动发布在不在跑，判法见本节末尾「自动发布」的落后读数。
- 飞书网关（`feishu_gateway` 项）：香港的网关还来不来。网关带通行证调飞书接口，后端在门口记下每条接口最后一次来的时刻（只在进程里）；好的时候写「推送轮询 12 秒前来过，盘面快照 22 秒前来过」，推送轮询 5 分钟没来报红（`silent`），后端刚起、网关还没来过报「没查成」（`unchecked`，一般半分钟内就好），没配网关通行证报「未接」。判法在 `packages/api/src/gateway-seen.ts`；网关那边自己的心跳和报警见第十二节。
- 必看三项：数据库、Temporal、引擎工人。只有后端明说在线的才绿；连不上（香港回 502、504）、回的不是健康报告、后端没报这一项、后端的结论和逐项对不上，一律红，并写明是哪一种。判定在 `deploy/web/health/health.js`，`deploy/test/health-page.test.mjs` 把每一种「没查成」都造了一遍。
- 从公网打开的，健康页和占位页上都不写仓名、GitHub 账号名和地址（设计文档第十四节「演示版」），也不显示版本号（`release.json` 公网上读不到）。`deploy/test/public-site.test.sh` 拿演示版打包扫描的同一份名单（`packages/web/src/build/scan.ts`）扫发布脚本生成的这几页；改了文字，下次发 `web` 才到香港。
- 香港转发时清掉 `Authorization`、`X-Fleet-Acting-Feishu`。france.sh 的读回从公网带着这两个头请求 `/api`，核对法国收到的请求里没有：后端没在跑时在隧道地址上临时起回显直接看，后端在跑时看它答的是「没登录」。

还欠（发布这块）：构建以 fleet 身份跑，构建期间的第三方代码（前端构建工具等）读得到 `/etc/fleet-dao` 里 fleet 能读的全部密钥。换成读不到 `/etc/fleet-dao` 的专用构建用户要动装机（新用户、它的 pnpm、属主交接），留到下一轮（#79）。现在挡着的：pnpm 11 默认不跑依赖的安装脚本，只跑 `pnpm-workspace.yaml` 的 `allowBuilds` 放行的（现在一个都没放行），所以装依赖这一步第三方代码不执行；前端构建那一步照样会执行构建工具的代码。

### 自动发布

`fleet-auto-release`（design 第三节第 42 条：fleet-dao 自己的法国引擎、驾驶舱随主线自动发布；对外的照 0003 第 18 条按版本由创始人确认）：

- 做什么：`fleet-auto-release.timer` 每 5 分钟（上一轮跑完再等 5 分钟，不叠着跑）以 root 拉起一轮 `/usr/local/lib/fleet-dao/auto-release/fleet-auto-release.mjs`：从 GitHub 取主线到检出 `/srv/fleet-dao`，主线最新的提交和在用的一样就收工；不一样就按下面的顺序一样样查，都过了才 `bash /srv/fleet-dao/deploy/release.sh <提交号> --auto` 发它（发布的每一步照上面，健康检查不过照样自动退回）。只发主线最新的那一个，中间的提交不一个个发。
- 发之前查的（哪一样没过，这一轮就停在那，读数里写明卡在哪）：
  1. 人手动切过版本：历史里最近一次不带 `auto` 的 `release`、`rollback`、`auto-rollback` 之后，主线上还没有更新的提交，就不动——人退回了坏版本、合并前用 `--unmerged` 在真机上验，自动发布不跟人抢；主线出了新提交（修复、那个 PR 合进来）再接着发。
  2. 这个提交自动发过、没成，或发过、没过健康检查：不再自动试，等主线出新提交。
  3. CI：只认这个提交在 main 上 push 触发的 `ci.yml` 那次运行的结论，不带凭据读 GitHub 的接口（一个钟头 60 次，一轮最多问一次；有了绿、红的结论就记下不再问）。全绿才发；还在跑、还没开跑，等下一轮；红了不发；读不到（限流、连不上、回的认不出、提交落到主线 30 分钟了还查不到它的 CI）记「没查成」、不发。
  4. 另一个发布在跑（发布锁 `/srv/fleet-dao-releases/.lock` 占着）：等下一轮。
  5. 部署脚本的检出：`git merge --ff-only` 快进到要发的提交；有没提交的改动、和主线分叉了，就停（`/healthz` 当场报）。检出已经在更新的提交上（人 pull 过）不往回退。
  6. 引擎有会话在跑（`fleet-agent-scope list`；读不到、认不出按在跑算）：等，最多等 60 分钟，到点照发——会话按编号续上（design 第四节「会话断了接着干」）；Temporal 里在途的工作流，重放测试（`packages/engine/test/replay.test.ts`）在 CI 里先把过关。release.sh 构建完、切版本之前再看一眼，这时又有会话在跑就不切（构建留着，下一轮直接用）。
- 不发演示版：演示版是对外的，换它就是对外发布，要人确认；`release.env` 的 `FLEET_HK_PARTS` 里有 `demo` 也跳过，香港上的演示版原样留着，要换就人手动发一次（`bash /srv/fleet-dao/deploy/release.sh`，连演示版一起发、记下）。不发但照样核对：健康检查照发演示版的记录比，香港上的得还是上次人发的那份（往根地址发驾驶舱静态文件和它在同一个目录底下，碰坏了这一轮不过、照常退回、报警）；在用的这一版的演示版和它不一样只列一行「还没发」，不算错（2026-09-27 之前拿在用的这一版去比，自动发布发了带前端改动的版本后 `--check` 一直误报红）。驾驶舱静态文件（`web`：明写进 `release.env` 那一步就是对外发布，要先告诉创始人）、飞书网关跟后端同一版。
- 发完同步规矩：在用的版本和检出对上、这个提交还没同步过，就以 root 对 `fleet-agent-carpool`、`pilot` 各跑一遍 `node /srv/fleet-dao/packages/agents-sync/bin/agents-sync --apply --user <用户>`（和 france.sh 最后那步同一条、同一份名单，第五节）。没成就记下、报警，不挡发布；同一个提交不重跑，下一个提交再来；要马上补就手动跑那条命令。
- 没成怎么办：release.sh 退出码不是 0、2（1 = 有红，含「没过健康检查、已自动退回」），或上一轮跑到一半没了（被杀、机器重启，发布锁空了、在用的不是它），都记成没成、报警，这个提交不再自动试。照报警里的日志路径查，修好后合一个修复进主线（自动发布发它），或在法国以 root 手动发：`bash /srv/fleet-dao/deploy/release.sh <提交号>`（手动发的按上面第 1 条算人按住，主线出了新提交再自动接着发）。
- 报警（驾驶舱提醒，飞书跟着推）：自动发布当场报两种——发布没成（`auto-release:failed:<提交号>`）、规矩同步没成（`auto-release:rules:<提交号>`），之后发成了、同步成了自动解除；库连不上时这一轮不发，定时器下次醒来再看。其余的不对由后端每 5 分钟判一次（和下面 `deploy_lag` 同一个判法），开一条「线上版本跟不上主线：…」，好了解除——自动发布自己停了、没装、跑崩了，只有后端看得出来。
- 落后读数：后端 `/healthz` 的 `deploy_lag`（健康页写「跟上主线」），读的时候现算：`current` 链接（在用哪版）加自动发布每一轮写的读数 `/srv/fleet-dao-releases/.auto/state.json`。
  - 当场红：读数读不到、认不出；自动发布 20 分钟没报到；主线头 20 分钟没读到；最近一次自动发布没成；部署脚本的检出跟不上主线；规矩同步没成、同步到哪没读到；在用的版本不在主线最近 300 个提交里（落后太多；是没合进主线的提交的，人按住 90 分钟后才红）。
  - 落后超过时限才红：CI 红了、CI 的结论读不到，30 分钟；在等 CI、等空闲、人按住的，90 分钟（从最老的没上线的提交合进主线、或人按住那一刻算）；一轮里在发，60 分钟还没完。
  - 装机层：france.sh 跑完没红时把装到的提交记进 `.auto/france-applied`；之后主线上它管的文件（`france.sh`、`deploy/lib/`、`deploy/france/` 里除两个应用单元和网关打包脚本以外的）改过、一天以上没重跑，红，写明要人重跑（它碰防火墙、sudoers，不自动跑）。自动发布本身也是 france.sh 装的副本，改了 `deploy/france/auto-release/` 同样要重跑 france.sh 才换上。
  - 公网看得到 `/healthz`：对外的话不带提交号和路径，细节在 `release.sh --check` 列出的「自动发布」那一段和报警正文里。不在法国的正式机器上（开发、测试）报「未接」。
- 看：`bash /srv/fleet-dao/deploy/release.sh --check` 列出的「自动发布」那一段（定时器在不在跑、上一轮什么时候、主线头和它的 CI、在用的落后几个、这一轮卡在哪、规矩同步到哪、装机脚本装到哪）；`journalctl -u fleet-auto-release -n 30`（每轮一行读数）；`systemctl list-timers fleet-auto-release.timer`；发布日志在 `/srv/fleet-dao-releases/.logs/`。
- 停、开：`systemctl disable --now fleet-auto-release.timer` 停（在跑的那一轮照样跑完；20 分钟后 `/healthz` 报自动发布没报到——停着就跟不上主线，该报）；`systemctl enable --now fleet-auto-release.timer` 开；马上跑一轮：`systemctl start fleet-auto-release`（别直接跑那个 `.mjs`：两轮叠着跑会互相盖读数）。
- `release.sh --auto` 只给自动发布用：历史行带 `auto`、不发演示版（只核对）、切之前看会话；另一个发布在跑退出 75，切之前看到会话在跑退出 76，这两种什么都没动，自动发布不记成没成。`--busy-ok`（等空闲到了上限）只能跟着 `--auto`。
- 由来（2026-09-27）：这之前合并后没有东西发布，全靠人以 root 跑 release.sh；法国跑的版本落后主线 40 个提交、14 个小时，健康检查只看在用的那版自己好不好、不和主线比，没人发现。做法照拉取式持续部署（机器自己定时拉、持续对齐；一个提交只试一次、没成不重试；人手动退回时自动的不跟人抢）、单机 systemd 定时器加自动退回、等空闲再换版，来源和对比写在引入它的 PR 里。

## 十、「你好」工作流（P0 验收）

让引擎工人跑一次 `helloWorkflow`，耗时查得到：Temporal 把每次执行的开始、结束、耗时记在本机 Postgres（库 `temporal_visibility` 的表 `executions_visibility`）。

跑法（法国，root）：`bash /srv/fleet-dao/deploy/hello.sh`

1. 查任务队列 fleet 上有没有引擎工人在取活；没有就停下（退出码 2），说缺什么。
2. `fleet-temporal workflow execute --type helloWorkflow --task-queue fleet --workflow-id hello-<时间> --input '"法国"'`，90 秒没跑完判红。
3. 从 `executions_visibility` 读这一次的开始、结束、耗时。以后再查：`fleet-temporal workflow describe --workflow-id hello-<时间>`，或以 postgres 在库 `temporal_visibility` 里：
   `select workflow_id, start_time, close_time, execution_duration / 1e6 as ms from executions_visibility where workflow_type_name = 'helloWorkflow' order by start_time desc;`

要先齐的：引擎里注册 `helloWorkflow(name: string): Promise<string>`（不调活动也行）并合进主线；`release.env` 的 `FLEET_SERVICES` 加上 `fleet-engine`，发布一次。健康页的「引擎」一项要后端也在跑（`FLEET_SERVICES` 里也有 `fleet-api`）：它是后端去 Temporal 查任务队列上有没有引擎工人在取活。

## 十一、备份与恢复

装：`deploy/backup/install.sh`，独立于 `france.sh`、`hk.sh`。先法国（打印备份钥匙的公钥）→ 公钥填进香港 `/etc/fleet-dao/backup.env` 的 `FLEET_BACKUP_FRANCE_PUBLIC_KEY`、跑 `install.sh hk` → 法国再跑一遍（建仓库、首跑）。`--check` 只读回。

| 定时器（法国，以 fleet 跑） | 什么时候（北京时间） | 做什么 |
|---|---|---|
| `fleet-backup.timer` | 每天 04:10 | fleet、temporal、temporal_visibility 各 `pg_dump -Fc` 一份，行数清单和导出用同一个快照；restic 加密后经隧道存进香港；按 7 日 + 4 周删过期的 |
| `fleet-backup-drill.timer` | 每周日 05:40 | 最近一份从香港取回，逐个恢复进临时库 `fleet_drill_restore`，核对每张表的行数和各时间列的最新值，删掉临时库；再跑 `restic check` |
| `fleet-backup-watch.timer` | 每小时 17 分 | 两台的磁盘用量（线在法国 `/etc/fleet-dao/backup.env`）；前两个任务多久没开跑 |

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
