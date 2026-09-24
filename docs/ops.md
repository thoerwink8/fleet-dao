# 运维手册：两台机器的地基

装法在 `deploy/`，这里讲怎么用、怎么看、怎么退。机器的公网 IP 不进仓，下文写作 `<法国IP>`、`<香港IP>`。
旧系统的坑与由来见 [reference/deploy.md](reference/deploy.md)（文中的 P01、P02 等编号出自那里）。

## 一、两台机器

| | 法国 | 香港 |
|---|---|---|
| 系统 | Ubuntu 24.04，6 核 12G | Ubuntu 22.04，2 核 2G |
| 跑什么 | Temporal、PostgreSQL、引擎、驾驶舱后端、AI 会话 | nginx（驾驶舱入口与证书）、WireGuard 服务端；以后还有飞书网关 |
| 新开的公网入站 | 无 | 80/443（与旧网关共用同一个 nginx）、UDP 4500（WireGuard） |
| 装机脚本 | `deploy/france.sh` | `deploy/hk.sh` |
| 旧系统 | 在跑（旧的开发版 Temporal 占 7233/8233），装机不碰 | 旧网关在跑，nginx 只加一个站点 |

两机之间走 WireGuard 隧道 `10.99.0.0/24`：香港 `10.99.0.1` 是服务端；法国 `10.99.0.2` 是客户端，主动连、每 25 秒保活，所以法国不用开任何入站端口。

## 二、端口表

法国（全部只绑本机或隧道地址）：

| 端口 | 绑在 | 是谁 | 说明 |
|---|---|---|---|
| 5432/tcp | 127.0.0.1、10.99.0.2 | PostgreSQL 16 | 隧道地址上在听，但 pg_hba 和 ufw 都还没放行从隧道来连库 |
| 7243/tcp | 127.0.0.1 | Temporal 前端 gRPC | 引擎和 `fleet-temporal` 连这里 |
| 6943/tcp | 127.0.0.1 | Temporal 前端 membership | |
| 7244、6944 | 127.0.0.1 | Temporal history（gRPC、membership） | |
| 7245、6945 | 127.0.0.1 | Temporal matching | |
| 7249、6949 | 127.0.0.1 | Temporal worker | |
| 8787/tcp | 10.99.0.2 | 驾驶舱后端（`FLEET_COCKPIT_LISTEN`） | ufw 只在隧道网卡 `wg-fleet` 上给 10.99.0.1 放行；后端起了才有 |
| 8788/tcp | 127.0.0.1 | fleet 命令接口（`FLEET_AGENT_LISTEN`） | 不对外 |

选端口的规矩：Temporal 一律「官方默认 +10」，避开旧系统的 7233/8233；都在 32768 以下——旧开发版 Temporal 的内部端口是随机临时端口（32768 起），重启会变，同段里挑端口迟早撞上。

香港：

| 端口 | 绑在 | 是谁 | 说明 |
|---|---|---|---|
| 80/tcp | 0.0.0.0 | nginx（与旧网关共用） | `fleetdao.dpdns.org`：证书续期的验证路径，其余跳 https |
| 443/tcp | 0.0.0.0 | nginx（与旧网关共用） | `https://fleetdao.dpdns.org`：静态页；`/api`、`/auth`、`/github/webhook` 经隧道转法国 `10.99.0.2:8787`；`/agent` 不转 |
| 4500/udp | 0.0.0.0 | WireGuard 服务端 | 香港上游只放行少数常见 UDP 端口（2026-09-25 从法国实测：53/67/69/123/161/500/1701/4500 能到），51820 进不来 |

GitHub 事件地址：`https://fleetdao.dpdns.org/github/webhook`。飞书登录回调：`https://fleetdao.dpdns.org/auth/feishu/callback`。

## 三、用户、目录、库

| 用户 | 在哪 | 干什么 |
|---|---|---|
| `fleet` | 两台 | 引擎、驾驶舱后端、Temporal（法国），以后的飞书网关（香港）。系统用户，家 `/home/fleet`（750） |
| `orca` | 法国（旧系统就有） | AI 会话。各家命令行的登录态都在它家里；读不到 `/etc/fleet-dao` |
| `root` | | 只装机 |

法国：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/srv/fleet-dao` | root:root 755 | 代码（git clone）。fleet 只读：以别的身份跑的会话改不了引擎的代码 |
| `/var/lib/fleet-dao`、`/var/log/fleet-dao` | fleet:fleet 750 | 运行数据、日志（服务日志主要在 journald） |
| `/etc/fleet-dao` | root:fleet 750 | 本机配置与密钥：`france.env`、`temporal.env`（库口令）、`temporal.yaml`、`github/`（两个 GitHub 机器人的 json，手放）。文件一律 root:fleet 640 |
| `/opt/fleet-dao/temporal` | root:root 755 | `server-1.32.0/`（temporal-server、temporal-sql-tool）、`cli-1.9.1/`（temporal），`bin/` 链接到在用的版本 |
| `/usr/local/bin/fleet-temporal` | root 755 | 运维命令行：连 127.0.0.1:7243，默认命名空间 fleet |
| `/usr/local/sbin/fleet-agent-scope`、`/etc/sudoers.d/fleet-dao` | root 755、root 440 | 起、收 AI 会话（第五节） |
| `/etc/wireguard/wg-fleet.conf`、`wg-fleet.key` | root 600 | 隧道配置与私钥（私钥本机生成，不出机器） |
| `/etc/postgresql/16/main/conf.d/fleet.conf` | root 644 | 库的监听地址 |
| `/etc/systemd/system/`：`fleet-temporal.service`、`fleet-agents.slice`、`postgresql@16-main.service.d/fleet-wireguard.conf` | root 644 | 单元；最后那个让库在隧道起来之后才起 |
| `/home/fleet/.local/bin/pnpm` | fleet | corepack 的垫片，版本跟仓根 `package.json` 的 `packageManager` |

香港：

| 路径 | 属主 权限 | 放什么 |
|---|---|---|
| `/etc/fleet-dao/hk.env` | root:fleet 640 | 域名、证书联系邮箱、法国公钥 |
| `/srv/fleet-dao` | root:root 755 | 代码 |
| `/srv/fleet-dao-web` | fleet:fleet 755 | 驾驶舱静态文件。现在是占位页；装机脚本只在没有 `index.html` 时放占位页，不盖已发布的 |
| `/var/www/fleet-dao-acme` | root:root 755 | 证书续期的验证文件 |
| `/etc/nginx/sites-available/fleet-dao`（`sites-enabled` 里有链接） | root 644 | 只加这一个站点，旧网关的站点不动 |
| `/etc/letsencrypt/live/fleetdao.dpdns.org` | certbot 管 | 证书；`certbot.timer` 续期，续完重载 nginx |
| `/etc/wireguard/wg-fleet.conf`、`wg-fleet.key` | root 600 | 隧道配置与私钥 |

库（法国）：`fleet` 库属 fleet 角色，本机 socket + peer 认证（系统用户 fleet 就是库角色 fleet），不设口令；`temporal`、`temporal_visibility` 属 temporal 角色，走 127.0.0.1:5432 + 口令（`/etc/fleet-dao/temporal.env`）。Temporal 命名空间 `fleet`，已结束的工作流保留 30 天。

## 四、怎么跑装机脚本

从零装（新机器或重建）：

1. 两台都以 root：`git clone https://github.com/thoerwink8/fleet-dao /srv/fleet-dao`。
2. 香港：`bash /srv/fleet-dao/deploy/hk.sh`。它打印香港的 WireGuard 公钥；`hk.env` 里的域名已经解析到这台的话，证书这一轮就签下来。
3. 法国：`bash /srv/fleet-dao/deploy/france.sh`。它打印法国的公钥。
4. 互填：香港公钥和 `<香港IP>:4500` 填进法国 `/etc/fleet-dao/france.env`；法国公钥填进香港 `/etc/fleet-dao/hk.env`。
5. 先重跑香港、再重跑法国：隧道起来，库补听隧道地址，法国读回里 `ping 10.99.0.1` 通。
6. 手放密钥：两个 GitHub 机器人的 json 放进法国 `/etc/fleet-dao/github/`，root:fleet 640（读回会查权限）。
7. 各再跑一遍，结论应是「本次改动 0 处」。

平时：

- 改了 `deploy/` → 机器上 `git -C /srv/fleet-dao pull` → 重跑。脚本只把它管的东西改回仓里的样子，不删多出来的东西（要删见第七节）。
- 只看不改：`bash deploy/france.sh --check`、`bash deploy/hk.sh --check`。
- 法国经跳板登录，长连接会被重置：长命令甩到后台跑再看日志，`nohup setsid bash /srv/fleet-dao/deploy/france.sh > /root/fleet-dao-install.log 2>&1 < /dev/null &`。

输出与退出码：每步一行，`✓` 本来就对、`↻` 这次改了、`✗` 红、`…` 待配或没查成；最后列出改了哪些、红在哪。退出码 0 全绿，1 有红，2 没红但有待配。

验证用的工具：

- `bash deploy/lib/snapshot.sh ours`：fleet-dao 管的东西的指纹。连跑两遍装机，两遍之间各拍一次，diff 为空才算第二遍零改动——和脚本自己数的「改动几处」是两套判据。
- `bash deploy/lib/snapshot.sh others`：旧系统的单元状态、监听端口、防火墙。装机脚本每次开头结尾自己比一遍。
- `sudo bash deploy/test/run.sh`：语法、shellcheck、自检的违规样本、本页端口表和脚本对得上。
- `sudo bash deploy/test/agent-scope.e2e.sh`（法国）：会话通路真跑一遍，见第五节。

## 五、AI 会话怎么进资源池

- 池子 `fleet-agents.slice`（cgroup 路径 `/fleet.slice/fleet-agents.slice`）：只记账（CPU、内存、进程数、IO），池子本身不设上限（按 windsurf-dao 仓 `docs/decisions/2026-09-24-agent-isolation-and-error-routing.md` 的「先观测」）。
- 每个会话一个 scope：`fleet-agent-<编号>.scope`，身份 orca，上限由引擎起会话时给。
- 引擎（fleet）自己建不了系统级 scope，会话还得换成 orca 身份。polkit 管不窄——systemd 255 建临时单元时不把单元名交给 polkit，放行就等于放行任何单元、任何身份——所以 sudoers 只放行 fleet 以 root 跑一个脚本：

```
sudo -n /usr/local/sbin/fleet-agent-scope run <编号> [--memory-high 1536M] [--memory-max 2G --memory-swap-max 0]
        [--tasks-max 512] [--cpu-weight 100] [--cwd /某目录] -- /绝对路径/命令 参数…
sudo -n /usr/local/sbin/fleet-agent-scope stop <编号>     # 已经没了也返回 0
sudo -n /usr/local/sbin/fleet-agent-scope list            # 编号 状态，一行一个
```

- `run` 最后 exec 成会话本身，标准输入输出还是引擎手里那一份。
- 环境变量不走命令行（sudo 会把命令行记进日志）：引擎把 `FLEET_*`、`LANG`、`LC_*`、`TZ`、`TERM`、`GH_TOKEN`、`GITHUB_TOKEN`、`GIT_TERMINAL_PROMPT`、`GIT_CONFIG_*` 放进调 sudo 时的环境即可；会话的 PATH 用 `FLEET_SESSION_PATH` 给；HOME、USER 是 orca 的。
- 内存要真封顶，`--memory-max` 和 `--memory-swap-max` 得一起给：只给前者，超出的部分被换进 swap，会话不会被杀（法国实测）。
- 降权用 `setpriv --init-groups`：`systemd-run --uid` 在 scope 里不清附加组，会话会带着 root 组（法国实测）。
- 引擎正常停（SIGTERM）：sudo 把信号转给会话，会话跟着退。引擎崩了（SIGKILL）：会话留在自己的 scope 里；引擎起来后 `list` 找回、`stop` 收掉。
- 引擎的 systemd 单元不能开 `NoNewPrivileges`：开了 sudo 提不了权。
- 看用量（不用 root）：`systemctl status fleet-agents.slice`、`systemd-cgtop /fleet.slice/fleet-agents.slice`、`systemctl show fleet-agent-<编号>.scope -p MemoryCurrent,CPUUsageNSec,TasksCurrent`。
- 给池子加上限：写 `/etc/systemd/system/fleet-agents.slice.d/limits.conf`（MemoryHigh、MemoryMax、MemorySwapMax…）再 `systemctl daemon-reload`；回滚就删掉它。

## 六、怎么看健康

一条命令：`bash /srv/fleet-dao/deploy/france.sh --check`（香港用 `hk.sh --check`），只读回和自检，不改东西。

法国分项：

- `systemctl status fleet-temporal postgresql@16-main wg-quick@wg-fleet fleet-agents.slice`
- `fleet-temporal operator cluster health`（应为 SERVING）、`fleet-temporal operator namespace describe fleet`、`fleet-temporal workflow list`
- `sudo -u postgres psql -c '\l'`、`pg_isready -h 127.0.0.1`
- `wg show wg-fleet`、`ping 10.99.0.1`
- `journalctl -u fleet-temporal -n 100`

香港分项：

- `curl -I https://fleetdao.dpdns.org`、`certbot certificates`
- `certbot renew --dry-run --cert-name fleetdao.dpdns.org`：只演练续期，不换证书
- `wg show wg-fleet`（看法国的 latest handshake）、`nginx -t`

自检现状：两台都判红，红的都是旧系统的单元（以 root 执行了别人能改的文件，P02）。具体是哪几处不写进公开仓，在机器上跑 `--check` 就能看到；修它们要动旧系统，交人拍。

## 七、怎么回滚

原则：先停用（随时能装回来）；删数据的那一步单独问人。

法国：

```
# 1. 停用，不删数据
systemctl disable --now fleet-temporal.service fleet-agents.slice wg-quick@wg-fleet.service
systemctl stop postgresql@16-main.service   # 库还在，start 就回来
# 2. 撤掉装上去的东西（不含数据）
rm /etc/systemd/system/fleet-temporal.service /etc/systemd/system/fleet-agents.slice
rm -r /etc/systemd/system/postgresql@16-main.service.d
rm /usr/local/bin/fleet-temporal /usr/local/sbin/fleet-agent-scope /etc/sudoers.d/fleet-dao
ufw delete allow in on wg-fleet from 10.99.0.1 to 10.99.0.2 port 8787 proto tcp
systemctl daemon-reload
```

3. 删数据（先问人）：`pg_dropcluster --stop 16 main`、`apt purge postgresql-16`、删 PGDG 源与签名公钥、删 `/opt/fleet-dao`、`/etc/fleet-dao`、`/var/lib/fleet-dao`、`/var/log/fleet-dao`、`/etc/wireguard/wg-fleet.*`，`userdel -r fleet`。

香港：

```
# 1. 下掉站点（旧站点不受影响）
rm /etc/nginx/sites-enabled/fleet-dao && nginx -t && systemctl reload nginx
# 2. 停隧道
systemctl disable --now wg-quick@wg-fleet
```

3. 删数据（先问人）：`certbot delete --cert-name fleetdao.dpdns.org`，删 `/srv/fleet-dao-web`、`/var/www/fleet-dao-acme`、`/etc/fleet-dao`、`/etc/wireguard/wg-fleet.*`，`userdel -r fleet`。

只退一步：`git revert` 那次提交 → 机器上 pull → 重跑；脚本会把它管的文件改回仓里的样子，新加过又撤掉的东西按上面手动删。

## 八、改之前要知道的

- 改了端口要同步第二节的端口表（`deploy/test/run.sh` 会查）。
- Temporal 的历史分片数（`numHistoryShards: 16`）建库后不能改。
- 升 Temporal：改 `france.sh` 顶部的版本号和 sha256 → 重跑。新版本装进新目录、`bin/` 链接切过去、服务重启；表结构由 temporal-sql-tool 升到新版本自带的最新。
- PostgreSQL 用 16：Temporal 官方测过的最高大版本是 16（16.6）。
- 香港 WireGuard 用 UDP 4500 是因为上游只放行少数 UDP 端口；换端口前先从法国实测新端口到不到得了香港网卡。
- 还没验过的：重启机器（库在隧道之后起、旧单元不复活、新单元自己起来）——这一轮没重启过机器。
