# magpie

magpie（[yetone/magpie](https://github.com/yetone/magpie)）是模型网关。渠道、路由组和资源库维护一份，别的机器用各自的调用 key 来用。法国这台是唯一网关（决定 [0128](../decisions/0128-magpie-central-gateway-and-repo-consolidation.md)）。本机 Windows 再留一层，只放本机独有的和远端不通时的直连兜底。Claude 不进 magpie。Antigravity 只在本机。

网页端口 **3430**，网关端口 **3425**。法国只在内网可达，地址写 `<法国内网地址>`，不写具体 IP。

## 本机 Windows

程序放在 `D:\magpie\magpie.exe`。配置目录是 `~/.config/magpie`。

## 法国 Linux

系统用户 `magpie`，家目录 `/var/lib/magpie`，程序 `/opt/magpie/magpie`。网页和网关由 systemd 单元 `magpie.service` 拉起，单元读 `/etc/magpie.env`。这个文件的权限是 root 和 magpie 才能读，值不抄进仓库。

查在跑的进程、改配置，用环境文件里的 `HOME` 和 `XDG_CONFIG_HOME`：

```sh
sudo -u magpie env HOME=… XDG_CONFIG_HOME=… /opt/magpie/magpie
```

两个变量都从 `/etc/magpie.env` 取。文件里没写 `XDG_CONFIG_HOME` 时，配置在 `$HOME/.config/magpie`。2026-11-16 这台的用户家目录是 `/var/lib/magpie`；环境文件本身没读到。

内网地址只用占位：网页 `http://<法国内网地址>:3430`，网关 `http://<法国内网地址>:3425`。

法国程序版本：`/opt/magpie/magpie --version` 是 `0.1.4263`（2026-11-16）。新机器跟这个版本对齐。本机 Windows 上的版本号未查到。

## 同步

加密同步到 `github://thoerwink8/fleet-setup/magpie`。GitHub 上只有口令封好的文件。

- 不带密钥（`keys=no`）
- 不带登录（`sign-ins` 保持关闭）
- 不带删除（见 [INSTALL.md](INSTALL.md)，这版帮助里没有单独的 delete 开关）
- 每 3 分钟（`magpie github auto 3`）

令牌和口令只从密码管理器取，不写进仓库。登录要在那台机器上自己登。

## 这套文档

| 文件 | 内容 |
|---|---|
| [INVENTORY.md](INVENTORY.md) | 供应商、路由组、轮流、资源库、设置、配置文件名、用量 |
| [DECISIONS.md](DECISIONS.md) | 已经在用的取舍，查不到出处的标了未查到 |
| [INSTALL.md](INSTALL.md) | Windows 和 Linux 从零装到和现有机器一致 |
| [OPERATIONS.md](OPERATIONS.md) | 用量、改权重、暂停、同步冲突、已踩的坑 |

核对用仓库里的 `install/magpie-verify.sh`（Windows 用 `install/magpie-verify.ps1`），对照 `templates/magpie-expected.json`。装目录用 `install/magpie-bootstrap`，`--dry-run` 不改在跑的配置。

fleet-dao 的 `deploy/france.sh` 不装、不删 `magpie.service`。法国单元的运维细节仍以 [docs/ops.md](../ops.md) 里「法国 magpie 的 Cursor 登录」为准；那一节的内网 IP 不要抄进对外步骤，步骤里继续用 `<法国内网地址>`。

## 这次梳理

单号 **#4035**。

来源：local-session `DESKTOP-GET3DBC-2026-11-15T20:53:43.707Z`（单键 `b459e75e5600625a29edb03f4d14dbe8682fc21493a8cfec6e800ea6e97b7c7f`）。
