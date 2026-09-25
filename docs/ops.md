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
| 443/tcp | 0.0.0.0 | nginx | `https://<驾驶舱域名>`：静态页；`/api`、`/auth`、`/github/webhook`、`/healthz` 经隧道转法国 `10.99.0.2:8787`，转之前清掉 `Authorization`、`X-Fleet-Acting-Feishu`；`/agent` 不转 |
| 4500/udp | 0.0.0.0 | WireGuard 服务端 | 香港上游只放行少数常见 UDP 端口（2026-09-25 从法国实测：53/67/69/123/161/500/1701/4500 能到），51820 进不来 |

GitHub 事件地址：`https://<驾驶舱域名>/github/webhook`。飞书登录回调：`https://<驾驶舱域名>/auth/feishu/callback`。

## 三、用户、目录、库

| 用户 | 在哪 | 干什么 |
|---|---|---|
| `fleet` | 两台 | 引擎、驾驶舱后端、Temporal（法国），飞书网关（香港）。系统用户，家 `/home/fleet`（750） |
| `fleet-agent-dedicated`、`fleet-agent-carpool` | 法国 | AI 会话专用：各挂一个 reclaude 组织（独享、拼车），永不切号；引擎按选中的账号池挑用户。没有 sudo、不能提权、只在自己的组里、家里没有 GitHub 凭据、读不到 `/etc/fleet-dao`、连不上 Temporal 和库 |
| `pilot` | 法国 | 创始人的登录用户：用 Mirasim 桌面端的 ssh 远程模式登进来干活（第五节）。系统用户，家 `/home/pilot`（750）；没有任何 sudo，只在自己的组和 `systemd-journal` 里（看日志）；读不到 `/etc/fleet-dao`、连不上 Temporal 和库 |
| `root` | | 只装机 |

法国：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/srv/fleet-dao` | root:root 755 | 装机脚本所在的检出（git clone）。fleet 和会话用户都只读 |
| `/srv/fleet-dao-releases` | root:root 755 | 应用的各版（第九节）：`<提交号>/`、`current` 链接、`.history`；每一版归 root，fleet 只读 |
| `/var/lib/fleet-dao`、`/var/log/fleet-dao` | fleet:fleet 750 | 运行数据、日志（服务日志主要在 journald） |
| `/etc/fleet-dao` | root:fleet 750 | 本机配置与密钥：`france.env`、`temporal.env`（库口令）、`temporal.yaml`、`nftables.nft`、`github/`（两个 GitHub 机器人的 json，手放）；应用的 `engine.env`、`api.env`、`release.env`（照仓里样例建一次，之后归人改），随机密钥 `agent-token.env`、`session-secret.env`、`gateway-token.env`（首次生成，之后不动）。卫生检查的已知敏感值名单 `sensitive-values.txt`（真实的组织编号、账号，一行一个，手放；引擎推分支前读，缺了一律不推，见 packages/hygiene）。文件一律 root:fleet 640；只有 `web-upload.key`（往香港传静态文件的钥匙）、`gateway-deploy.key`（往香港发飞书网关的钥匙）和 `hk-known-hosts`（钉住的香港主机钥匙）是 root:root 600 |
| `/opt/fleet-dao/temporal` | root:root 755 | `server-1.32.0/`（temporal-server、temporal-sql-tool）、`cli-1.9.1/`（temporal），`bin/` 链接到在用的版本 |
| `/usr/local/bin/fleet-temporal` | root 755 | 运维命令行：连 127.0.0.1:7243，默认命名空间 fleet（只有 root 和 fleet 用得了） |
| `/usr/local/sbin/fleet-agent-scope`、`/etc/sudoers.d/fleet-dao` | root 755、root 440 | 起、收 AI 会话（第五节） |
| `/etc/wireguard/wg-fleet.conf`、`wg-fleet.key` | root 600 | 隧道配置与私钥（私钥本机生成，不出机器） |
| `/etc/postgresql/16/main/conf.d/fleet.conf` | root 644 | 库只听本机 |
| `/etc/systemd/system/`：`fleet-temporal.service`、`fleet-agents.slice`、`fleet-firewall.service`、`postgresql@16-main.service.d/fleet.conf` | root 644 | 单元；最后那个让库的进程没了（干净退出也算）就拉起来——装包自带的是 `Restart=no` |
| `/etc/systemd/system/`：`fleet-engine.service`、`fleet-api.service` | root 644 | 应用单元，发布脚本从要发的那版里取来装上，只装 `release.env` 启用了的（第九节） |
| `/home/fleet/.local/bin/pnpm` | fleet | corepack 的垫片，版本跟仓根 `package.json` 的 `packageManager` |
| `/home/fleet-agent-*/.local/bin/reclaude` | 各会话用户 | reclaude 二进制；登录见第五节 |
| `/home/pilot/.local/bin/reclaude` | pilot 755 | reclaude 二进制：france.sh 只在没有时装（版本和 sha256 钉在脚本顶部），之后 pilot 自己 `reclaude update` |
| `/home/pilot/.mirasim-remote/`、`/home/pilot/.mirasim/` | pilot | Mirasim 桌面端连进来时自己装的服务端和它的数据（第五节），不归装机脚本管 |

香港：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/etc/fleet-dao/hk.env` | root:fleet 640 | 域名、证书联系邮箱、法国的 WireGuard 公钥、法国的两把发布公钥（上传静态文件、发飞书网关） |
| `/etc/fleet-dao/gateway-token.env` | root:fleet 640 | 飞书网关的通行证，和法国那份一模一样（第九节「两台同一份」） |
| `/etc/fleet-dao/feishu.env` | root:fleet 640 | 飞书网关的配置：飞书凭据、创始人（人放），后端地址、公网地址、团队群（hk.sh 缺才补，第十二节） |
| `/srv/fleet-dao` | root:root 755 | 装机脚本所在的检出 |
| `/srv/fleet-dao-web` | root:root 755 | 驾驶舱静态文件，归 root：飞书网关以 fleet 跑在这台，网关被打穿也改不了页面。由法国的发布脚本传来（`release.json` 写着是哪一版，`/health/` 是健康页）；装机脚本只在没有 `index.html` 时放占位页，不盖已发布的 |
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
8. 手放密钥：两个 GitHub 机器人的 json 放进法国 `/etc/fleet-dao/github/`，root:fleet 640（读回会查权限）。
9. 会话用户登录 reclaude（第五节，要创始人）。
10. 各再跑一遍，结论应是「本次改动 0 处」。然后发布应用（第九节）。

平时：

- 改了 `deploy/` → 机器上 `git -C /srv/fleet-dao pull` → 重跑。脚本只把它管的东西改回仓里的样子；早先版本放过、后来撤掉的几样，脚本里逐个写死了去删，别的多出来的东西不删（要删见第七节）。
- 只看不改：`bash deploy/france.sh --check`、`bash deploy/hk.sh --check`。
- 法国经跳板登录，长连接会被重置：长命令甩到后台跑再看日志，`nohup setsid bash /srv/fleet-dao/deploy/france.sh > /root/fleet-dao-install.log 2>&1 < /dev/null &`。

输出与退出码：每步一行，`✓` 本来就对、`↻` 这次改了、`✗` 红、`…` 待配或没查成；自检里别家单元的问题用 `·` 和 `!` 列出（见第六节）。退出码 0 全绿，1 有红，2 没红但有待配。

验证用的工具：

- `bash deploy/lib/snapshot.sh ours`：fleet-dao 管的东西的指纹。连跑两遍装机，两遍之间各拍一次，diff 为空才算第二遍零改动——和脚本自己数的「改动几处」是两套判据。
- `bash deploy/lib/snapshot.sh others`：不归 fleet-dao 管的单元状态、监听端口、防火墙（系统自带的服务、MiraQuota 等）。装机脚本每次开头结尾自己比一遍：装机不许碰它们。
- `sudo bash deploy/test/run.sh`：语法、shellcheck、自检的违规样本、发布脚本的来回（`release-flow.test.sh`）、香港网关的入口（`gateway-deploy.test.sh`）、网关打包（`gateway-bundle.test.sh`，要先 `pnpm install`）、健康页的判定（`health-page.test.mjs`）、本页端口表和脚本对得上。
- `sudo bash deploy/test/agent-scope.e2e.sh`（法国）：会话通路真跑一遍，见第五节。

## 五、AI 会话

资源池与起会话：

- 池子 `fleet-agents.slice`（cgroup 路径 `/fleet.slice/fleet-agents.slice`）：只记账（CPU、内存、进程数、IO），池子本身不设上限（按 windsurf-dao 仓 `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md` 的「先观测」）。
- 每个会话一个 scope：`fleet-agent-<编号>.scope`，身份是两个会话用户之一，上限由引擎起会话时给。
- 引擎（fleet）自己建不了系统级 scope，会话还得换成会话用户。polkit 管不窄——systemd 255 建临时单元时不把单元名交给 polkit，放行就等于放行任何单元、任何身份——所以 sudoers 只放行 fleet 以 root 跑一个脚本：

```
sudo -n /usr/local/sbin/fleet-agent-scope run <编号> --user fleet-agent-dedicated|fleet-agent-carpool
        [--memory-high 1536M] [--memory-max 2G --memory-swap-max 0] [--tasks-max 512] [--cpu-weight 100]
        [--cwd /某目录] -- /绝对路径/命令 参数…
sudo -n /usr/local/sbin/fleet-agent-scope stop <编号>     # 已经没了也返回 0
sudo -n /usr/local/sbin/fleet-agent-scope list            # 编号 状态，一行一个
```

- `run` 最后 exec 成会话本身，标准输入输出还是引擎手里那一份。
- 环境变量不走命令行（sudo 会把命令行记进日志）：引擎把 `FLEET_*`、`LANG`、`LC_*`、`TZ`、`TERM`、`GIT_TERMINAL_PROMPT` 放进调 sudo 时的环境；会话的 PATH 用 `FLEET_SESSION_PATH` 给；HOME、USER 是会话用户的。GitHub 凭据（`GH_TOKEN` 之类）一概带不进去：推分支、开 PR 由引擎在会话外做。
- 会话降权用 `setpriv --init-groups --no-new-privs`：只在自己的组里，会话里的 sudo、setuid 程序都提不了权。不用 `systemd-run --uid`：它在 scope 里不清附加组，会话会带着 root 组（法国实测）。
- 内存要真封顶，`--memory-max` 和 `--memory-swap-max` 得一起给：只给前者，超出的部分被换进 swap，会话不会被杀（法国实测）。
- 引擎正常停（SIGTERM）：sudo 把信号转给会话，会话跟着退。引擎崩了（SIGKILL）：会话留在自己的 scope 里；引擎起来后 `list` 找回、`stop` 收掉。
- 引擎的 systemd 单元不能开 `NoNewPrivileges`：开了 sudo 提不了权。
- 看用量（不用 root）：`systemctl status fleet-agents.slice`、`systemd-cgtop /fleet.slice/fleet-agents.slice`、`systemctl show fleet-agent-<编号>.scope -p MemoryCurrent,CPUUsageNSec,TasksCurrent`。
- 给池子加上限：写 `/etc/systemd/system/fleet-agents.slice.d/limits.conf`（MemoryHigh、MemoryMax、MemorySwapMax…）再 `systemctl daemon-reload`；回滚就删掉它。

会话用户登录 reclaude（要创始人做，每个会话用户各一次）：

reclaude 按用户记设备：组织写在各自家里的 `~/.reclaude/device.json`，对这个用户的所有会话一起生效，请求按设备签名。所以不拷别的用户的 `~/.reclaude`（同一设备号从两个家目录跑会互相打架），每个会话用户各自登录一次。

1. 准备（装机这边做，已做完）：reclaude 二进制放在 `/home/<会话用户>/.local/bin/reclaude`，属这个用户。换机时从任何一个装了 reclaude 的用户那儿拷二进制本身（只拷这一个文件，不拷 `~/.reclaude`）。
2. 创始人以 root 登法国，对 `fleet-agent-dedicated` 跑：`sudo -iu fleet-agent-dedicated reclaude login`。终端里会打印一行「Open this URL in your browser to authorize this CLI session」和一个链接：在浏览器里打开，用 reclaude 账号登录，授权这个命令行会话；授权完终端自己往下走。
3. 同一个用户接着选组织：`sudo -iu fleet-agent-dedicated reclaude org list`，找到独享的那个组织，`sudo -iu fleet-agent-dedicated reclaude org use <组织编号>`。
4. `fleet-agent-carpool` 照 2、3 再做一遍，第 3 步选拼车的组织。
5. 重跑 `deploy/france.sh`：读回里两个会话用户的「reclaude 还没登录」消失。

已知口子（会话用户的 reclaude 代理端口，2026-09-25 审查官发现，待定机制修）：每个会话用户的 reclaude 守护在 `127.0.0.1` 上开两个临时端口（一个 HTTP CONNECT 代理，会话的 `HTTPS_PROXY` 指它；一个 MITM TLS 口），端口号每次重启会变。代理口不认客户端身份——本机**别的用户**（`pilot`、`fleet`、另一个会话用户）也连得上、也会被转发，等于借用这个账号的订阅（拿另一个号的额度、或从 pilot 借会话号的额度）。`HTTPS_PROXY` 里没有令牌，靠的是绑回环 + 会话本该只有自己碰，但回环对所有本机用户都通。

- 验证（只读、无害，不打真实模型调用）：`runuser -u fleet -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/<代理口>; printf "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n" >&3; head -1 <&3'`。回 `502 Bad Gateway`（而不是 `407 Proxy Authentication Required`）＝它接了别的用户、没要身份，能借。代理口是两个端口里对这个探测回 502 的那个（`ss -ltnp` 看 reclaude 的两个口，逐个试）。
- nft 挡不干净：端口是临时的、每次变，而 nft 的 `skuid` 只认「发起连接的是谁」，认不出「监听口归谁」，没法表达「只许本人连自己的 reclaude」。粗暴地按 `skuid` 挡住 `pilot`、`fleet` 连临时端口段能挡住这两个借用方（fleet-dao 自己的口都 < 32768，不受影响），但挡不住两个会话用户互相借——把会话用户也挡了就断了它连自己 reclaude 的正路。
- 真正的修法在别处、要单独拍：每个会话一个网络命名空间（回环各自独立，`fleet-agent-scope` 起会话时加，属编排/隔离机制），或请 ai-gateway-stack 让 reclaude 给代理加一个每实例令牌（`HTTPS_PROXY` 带 `token@`，代理验 `Proxy-Authorization`）/ 改绑 0700 的 unix socket。本 PR 不动它，已上报编排。

创始人的登录用户 pilot（创始人用 Mirasim 桌面端的 ssh 远程模式连 `pilot@<法国>` 干活）：

- 装机脚本管的（`deploy/lib/login-user.sh`）：建用户、加进 `systemd-journal` 组（`journalctl -u 'fleet-*'` 看日志）、装 `~/.local/bin/reclaude`（只在没有时装，写的事以 pilot 自己的身份做）、确保有 git、ssh 客户端、curl。不给它写任何 sudoers；它也不在 fleet 组里，所以读不到 `/etc/fleet-dao`，连不上 Temporal 和库（nft 表只放行 root 和 fleet）。
- 读回（`--check`）查：用户在、家目录 750、只在自己的组和 `systemd-journal` 里、`sudo -l -U pilot` 说没有、reclaude 它自己执行得了而且登录 shell 里找得到；缺了报红，写明怎么补。reclaude 登没登录、家里放了什么钥匙是创始人自己的事，不查。
- 家里不预装任何凭据。第一次要 root 帮两件事（都以 pilot 自己的身份写，家里不留 root 属主的文件）：
  1. 放创始人的 ssh 公钥：`sudo -iu pilot sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < <创始人的公钥>.pub`
  2. 登录 reclaude：`sudo -iu pilot reclaude login`，把打印的链接发给创始人在浏览器里授权；用哪个组织由创始人定（`reclaude org list`、`reclaude org use`）。
- Mirasim 的 ssh 远程模式在 pilot 家里自己装服务端：`~/.mirasim-remote/servers/<版本>/`（自带 node 和 node-pty，不用系统的 node），`current` 指在用的那版，`run/` 下是进程号、日志和 unix socket，数据在 `~/.mirasim/`；桌面端经 ssh 把本机一个端口转到那个 socket。服务器这头要的：公钥登得进来、sshd 允许转发到 unix socket（`AllowStreamLocalForwarding`，Ubuntu 默认开）、`curl`（直接下服务端包，下不了由桌面端经 scp 传）、`tar`、`gzip`、`sha256sum`。不需要系统的 node，也不需要另起一个 systemd 管的 mirasim-server。它按登录 shell（`$SHELL -ilc`）取 PATH，Ubuntu 默认的 `~/.profile` 把 `~/.local/bin` 加了进去，所以找得到 reclaude。
- 经 Mirasim 起 Claude 会话、启动命令写 `reclaude` 的，先在 pilot 的 `~/.local/bin` 装 ai-gateway-stack 仓的 reclaude-mirasim 启动器（该仓 `docs/RECLAUDE-IN-MIRASIM.md` 第四节）：不装的话 Mirasim 把自己网关的地址塞给 claude，reclaude 回 non_cc_client 并上报，攒多了设备会被解绑。本仓不装它。
- 已知的口子：桌面端起远端服务端时把 `MIRASIM_SECRET_KEY` 写在 ssh 执行的命令行里，那几秒里本机别的用户（包括会话用户）用 `ps` 看得到；要堵得给 `/proc` 加 `hidepid`，还没做。
- 撤掉：`userdel -r pilot`。家里是创始人的活和登录态，删之前先问人。

## 六、怎么看健康

一条命令：`bash /srv/fleet-dao/deploy/france.sh --check`（香港用 `hk.sh --check`），只读回和自检，不改东西。
应用这一层：`bash /srv/fleet-dao/deploy/release.sh --check`（在用哪版、服务、健康检查），和浏览器里的健康页 `https://<驾驶舱域名>/health/`（第九节）。

法国分项：

- `systemctl status fleet-temporal postgresql@16-main wg-quick@wg-fleet fleet-agents.slice fleet-firewall`；应用：`systemctl status fleet-engine fleet-api`、`journalctl -u fleet-api -n 100`
- `fleet-temporal operator cluster health`（应为 SERVING）、`fleet-temporal operator namespace describe fleet`、`fleet-temporal workflow list`
- `sudo -u postgres psql -c '\l'`、`pg_isready -h 127.0.0.1`
- `nft list table inet fleet_dao`
- `wg show wg-fleet`、`ping 10.99.0.1`
- `journalctl -u fleet-temporal -n 100`

香港分项：

- `curl -I https://<驾驶舱域名>`、`certbot certificates`
- `certbot renew --dry-run --cert-name <驾驶舱域名>`：只演练续期，不换证书
- `wg show wg-fleet`（看法国的 latest handshake）、`nginx -t`
- 飞书网关：`fleet-gateway-deploy status`、`journalctl -u fleet-feishu -n 100`（第十二节）

自检（P02：以 root 执行的文件要全链属 root、组和其他人不可写）分三档：

- fleet-dao 自己的单元违规：`✗`，装机判红。
- 别家单元违规：`·` 列出，不计入退出码，交人处置。
- 别家单元违规、但 fleet 或会话用户自己就改得了：`!` 单列成「会话上线前必须清零」，同样不计入退出码。
具体是哪几处不写进公开仓，在机器上跑 `--check` 就能看到。

## 七、怎么回滚

原则：先停用（随时能装回来）；删数据的那一步单独问人。应用退一版用 `bash deploy/release.sh --rollback`（第九节），这里讲整套撤掉。

法国：

```
# 0. 应用：停掉、撤掉单元（各版代码还在 /srv/fleet-dao-releases）
systemctl disable --now fleet-engine.service fleet-api.service
rm -f /etc/systemd/system/fleet-engine.service /etc/systemd/system/fleet-api.service
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

3. 删数据（先问人）：`pg_dropcluster --stop 16 main`、`apt purge postgresql-16`，删 `/opt/fleet-dao`、`/etc/fleet-dao`、`/srv/fleet-dao-releases`、`/var/lib/fleet-dao`、`/var/log/fleet-dao`、`/etc/wireguard/wg-fleet.*`，`userdel -r fleet`、`userdel -r fleet-agent-dedicated`、`userdel -r fleet-agent-carpool`（会话用户家里有 reclaude 的设备，删之前先在 reclaude 里注销）。

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
- PostgreSQL 用 16：Temporal 官方测过的最高大版本是 16（16.6）；装 Ubuntu 自带源里的，跟着系统的自动安全更新走。
- 香港 WireGuard 用 UDP 4500 是因为上游只放行少数 UDP 端口；换端口前先从法国实测新端口到不到得了香港网卡。
- 香港站点配置里，转发给法国的 `location` 不要自己写 `proxy_set_header`：写了一条，server 那一层的就全部不继承，清 `Authorization`、`X-Fleet-Acting-Feishu` 的两条也跟着失效（法国 france.sh 的读回会查出来）。
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
bash /srv/fleet-dao/deploy/release.sh --check      # 只读：在用哪版、服务、健康检查
```

发布和退回自己交给 systemd 跑（临时服务 `fleet-dao-release-<时间>`），终端只跟着看日志：跳板断线、终端关了，发布照样跑完。日志在 `/srv/fleet-dao-releases/.logs/`（开头会打印路径，留最近 30 份），断了之后 `tail -f` 它接着看。`--check` 就在终端里跑。
输出与退出码同装机脚本；没过健康检查、已自动退回，也是 1。

每一步：

1. 取代码：从 GitHub 取主线到 `/srv/fleet-dao-releases/.repo.git`（root 的裸仓）。只发主线上的提交；合并前要在真机上验，加 `--unmerged`，历史里会标出来。
2. 构建：代码解到临时目录，以 fleet 跑 `pnpm install --frozen-lockfile`（依赖整份拷进来，不和 fleet 的 pnpm 仓库共用文件）；有 `packages/web` 就构建它（产出 `dist/client`），没有就用占位页；再放上健康页 `/health/`、版本标记 `release.json`。有 `packages/feishu` 就把飞书网关连同依赖打成一个文件 `gateway/gateway.mjs`（第十二节）。然后整棵树换成 root、fleet 只读，挪到 `/srv/fleet-dao-releases/<提交号>`。第三方代码不以 root 跑；root 照着起服务的单元文件，是换属主之后 root 才从 git 里取出来放进 `.units/` 的。构建日志在这一版目录的 `.fleet-build.log`。
3. 先试通香港这次要发的那几样（`FLEET_HK_PARTS`，见本节末尾）：发静态文件就 `rsync -n`（什么都不传），发网关就问一次网关入口的 `status`。不通就停，不切版本——不然健康检查必不过，新旧两版会一起被记成不健康。
4. 迁移：以 fleet 跑 `packages/db` 的迁移（库 fleet，本机 socket）。在切版本之前跑，只进不退（第八节）。每一版带几个迁移记在它的 `.fleet-release`（`migrations=`）。跑之前先比库：库里跑过的比这一版带的多（直接发了个老提交），就停、不切——drizzle 碰到比代码新的迁移记录什么也不做、也不报错，光靠迁移这一步拦不住。
5. 切版本：`current` 原子地指到这一版；`/etc/fleet-dao/release.env` 的 `FLEET_SERVICES` 里启用的服务装上这一版的单元、起来，没启用的停掉、撤掉单元。要不要重启看服务的主进程在哪个目录（`/proc/<主进程>/cwd`）：不在这一版的目录里就重启——所以上次切完 `current`、还没重启完就被打断，重跑同一版照样会重启；单元或环境文件变了也重启。
6. 发静态文件（`FLEET_HK_PARTS` 里明写了 `web` 才发，默认不发）：经隧道用 rrsync 传到香港 `/srv/fleet-dao-web`（新文件先落临时名、最后一起换上，旧文件最后删；在香港属 root）。按内容比、不带修改时间：内容没变的文件不传、不算变化。目录里不是这一版的文件会被删掉——别往 `/srv/fleet-dao-web` 手放东西，下次发布就没了。接着发飞书网关（第十二节）。
7. 健康检查：启用的服务 10 秒里没退出、没重启，主进程跑的是这一版的目录；`fleet-api` 的驾驶舱接口在答健康报告、切之前好的项没变坏，fleet 命令接口在听；`fleet-engine` 90 秒内到任务队列 fleet 上取活（工作流任务、活动任务都要有它）；发了静态文件的话，香港在发这一版（经隧道读 `release.json`、健康页 200）；这次切了飞书网关的话，它以这一版连上了飞书、起稳了（第十二节）。不过就自动退回上一版（同样的切法、同样的检查），报红；但库里跑过的迁移比上一版带的多时不退，停在新版报红等人（旧代码对着新表结构会出错，健康检查还查不出来）。
8. 清旧版：留 5 版——在用的、上一版，再按最近用过的补满。

同一个提交跑第二遍，结论是「本次改动 0 处」；两遍之间各拍一次 `bash deploy/lib/snapshot.sh ours`，diff 为空（快照里每一版整棵树的名字、大小、修改时间、属主、权限压成一个指纹，重新构建一定会变）。

退回：

- `--rollback` 退到「上一版」：历史里最近在用过、不是现在这版、没被判过不健康、目录还在的那一版。退之前先比库：库里跑过的迁移比那一版带的多（或读不清），不退、报红；也先试通香港。
- 健康检查没过的版本在历史里记成不健康，`--rollback` 不会退到它；它以后再发一次、过了，就记回健康。
- 历史在 `/srv/fleet-dao-releases/.history`，一行一件事：时间、提交号、事件（`release`、`rollback`、`auto-rollback`、`unhealthy`、`recovered`），合并前发的带 `unmerged`。

本机起哪些服务（`/etc/fleet-dao/release.env`，照 `deploy/france/release.env.example` 建一次，之后归人改）：

```
FLEET_SERVICES=fleet-engine fleet-api   # 空 = 只发代码、迁移，不起服务
FLEET_DOMAIN=<驾驶舱域名>
FLEET_HK_PARTS=gateway                  # 往香港发哪几样：gateway 飞书网关、web 静态文件；不写 = 只发 gateway
```

`FLEET_HK_PARTS` 默认不发静态文件：发了就会把香港根地址上的东西（现在是演示版）整个换成这一版的前端，等于对外发布——先告诉创始人，再在 `release.env` 里加上 `web`。去掉一样，发布就不碰香港上的那一样（也不查它的健康）。

起一个服务之前先把它要的配置备齐：起不来的话健康检查过不了，会自动退回。

| 单元 | 身份 | 跑什么 | 读的配置（都在 `/etc/fleet-dao`） |
|---|---|---|---|
| `fleet-engine` | fleet | `node packages/engine/src/main.ts`（Temporal worker，任务队列 fleet） | `engine.env`（`FLEET_ENGINE_PORTS=fake`：先用假端口）、`agent-token.env` |
| `fleet-api` | fleet | `node packages/api/src/main.ts`：一个进程两个监听，驾驶舱接口 `10.99.0.2:8787`、fleet 命令接口 `127.0.0.1:8788` | `api.env`、`agent-token.env`、`session-secret.env`、`gateway-token.env` |

- 两个都是 `Restart=always`。引擎不开 `NoNewPrivileges`（要经 sudo 调 `fleet-agent-scope` 起会话），也不开挂载隔离（会话是它的子进程，会跟着看不见自己的家目录）；后端不起子进程，照常收紧。
- `engine.env`、`api.env` 照仓里 `deploy/france/*.env.example` 建一次，之后归人改（飞书、GitHub 的凭据填在 `api.env`），改完再发布一次就会重启对应服务。库连接写成 `DATABASE_URL=postgres:///fleet` 加 `PGHOST=/var/run/postgresql`：本机 socket、peer 认证，没有口令（postgres.js 不认连接串里的 `?host=`）。
- 随机密钥各一个文件，france.sh 首次生成，之后不动、不打印：`agent-token.env`（`FLEET_AGENT_TOKEN_SECRET`：引擎签 fleet 通行证、后端验）、`session-secret.env`（`FLEET_SESSION_SECRET`）、`gateway-token.env`（`FLEET_FEISHU_GATEWAY_TOKEN`）。
- 免登 `FLEET_DEV_LOGIN` 永远不开：驾驶舱接口听的不是回环地址，后端也会拒绝启动。

两台同一份（飞书网关的通行证）：法国生成，原样拷到香港，值不过屏幕：

```
# 在能同时登两台的机器上
ssh <法国> 'cat /etc/fleet-dao/gateway-token.env' | ssh <香港> 'f=/etc/fleet-dao/gateway-token.env; t=$(mktemp /etc/fleet-dao/.new.XXXXXX); cat > "$t" && chown root:fleet "$t" && chmod 640 "$t" && mv "$t" "$f"'
# 核对：比指纹，不看值
ssh <法国> 'sha256sum < /etc/fleet-dao/gateway-token.env'; ssh <香港> 'sha256sum < /etc/fleet-dao/gateway-token.env'
```

往香港传静态文件的钥匙：法国 `/etc/fleet-dao/web-upload.key`（root 600，france.sh 生成）；香港 root 的 `authorized_keys2` 里那一行限死成 `from="10.99.0.2",restrict,command="/usr/bin/rrsync -wo -munge /srv/fleet-dao-web"`：只许从隧道地址来、不给终端、只能往这一个目录写、读不走任何东西。`-munge`：传来的符号链接落地时改成无效的样子，法国 root 失守也没法借链接让 nginx 读出目录外的文件。香港 sshd 的主机钥匙由 france.sh 经隧道取来钉住（隧道两头靠 WireGuard 钥匙互认），发布时只认这一把。

健康页 `https://<驾驶舱域名>/health/`：

- 读 `/healthz`：香港经隧道转给法国驾驶舱后端，后端逐项探库、Temporal……，全好回 200、有一项不好回 503。每 15 秒刷新。公网 `/healthz` 在香港限流：每个来源每分钟 30 次、突发 10 次，超了回 429（健康页照样报红，写明是限流）。

还欠（发布这块）：构建以 fleet 身份跑，构建期间的第三方代码（前端构建工具等）读得到 `/etc/fleet-dao` 里 fleet 能读的全部密钥。换成读不到 `/etc/fleet-dao` 的专用构建用户要动装机（新用户、它的 pnpm、属主交接），留到下一轮。现在挡着的：pnpm 11 默认不跑依赖的安装脚本，只跑 `pnpm-workspace.yaml` 的 `allowBuilds` 放行的（现在一个都没放行），所以装依赖这一步第三方代码不执行；前端构建那一步照样会执行构建工具的代码。
- 必看三项：数据库、Temporal、引擎工人。只有后端明说在线的才绿；连不上（香港回 502、504）、回的不是健康报告、后端没报这一项、后端的结论和逐项对不上，一律红，并写明是哪一种。判定在 `deploy/web/health/health.js`，`deploy/test/health-page.test.mjs` 把每一种「没查成」都造了一遍。
- 香港转发时清掉 `Authorization`、`X-Fleet-Acting-Feishu`。france.sh 的读回从公网带着这两个头请求 `/api`，核对法国收到的请求里没有：后端没在跑时在隧道地址上临时起回显直接看，后端在跑时看它答的是「没登录」。

## 十、「你好」工作流（P0 验收）

让引擎工人跑一次 `helloWorkflow`，耗时查得到：Temporal 把每次执行的开始、结束、耗时记在本机 Postgres（库 `temporal_visibility` 的表 `executions_visibility`）。

跑法（法国，root）：`bash /srv/fleet-dao/deploy/hello.sh`

1. 查任务队列 fleet 上有没有引擎工人在取活；没有就停下（退出码 2），说缺什么。
2. `fleet-temporal workflow execute --type helloWorkflow --task-queue fleet --workflow-id hello-<时间> --input '"法国"'`，90 秒没跑完判红。
3. 从 `executions_visibility` 读这一次的开始、结束、耗时。以后再查：`fleet-temporal workflow describe --workflow-id hello-<时间>`，或以 postgres 在库 `temporal_visibility` 里：
   `select workflow_id, start_time, close_time, execution_duration / 1e6 as ms from executions_visibility where workflow_type_name = 'helloWorkflow' order by start_time desc;`

要先齐的：引擎里注册 `helloWorkflow(name: string): Promise<string>`（不调活动也行）并合进主线；`release.env` 的 `FLEET_SERVICES` 加上 `fleet-engine`，发布一次。

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
- `journalctl -u fleet-feishu -n 100`：一行一个 JSON，消息正文只记长度。
- 法国 `release.sh --check`、香港 `hk.sh --check` 都报这些。

还欠：

- 团队群：机器人不在任何群里时 `FEISHU_TEAM_CHAT_ID` 补不上，网关不起（发布记待配）。建好团队群、把机器人拉进去，重跑 `hk.sh`（补上群号），再发布一次。
- 「收得到事件」要有人在飞书里给机器人发一条消息才验得到：`status` 的 `messages` 加一、日志里有「消息处理完」。
