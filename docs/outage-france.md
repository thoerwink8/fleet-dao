# 法国失联速查

半夜法国没了，照这页做。人在自己电脑上，香港用 `ssh hk-jump`。公网 IP 只在本机 ssh 配置里，这页写作 `<法国IP>`。控制台显示 Running 不可信。

## 先从香港判断

`ssh hk-jump` 登上香港，以 root 跑下面三条。

看隧道握手时间（接口 `wg-fleet`，对端 `10.99.0.2`。保活 25 秒，大约每 2 分钟握手一次；超过 3 分钟没更新就是断了）：

```
wg show wg-fleet latest-handshakes | awk -v now="$(date +%s)" '{if ($2+0==0) print $1, "从未握手"; else printf "%s  %d秒前\n", $1, now-$2}'
```

探公网 22 端口（`<法国IP>` 从自己的 ssh 配置抄）：

```
timeout 5 bash -c 'echo >/dev/tcp/<法国IP>/22' && echo 22通 || echo "22不通 退出码 $?"
```

探 `10.99.0.2:8787/healthz`（只绑隧道。从公网打 8787 超时是预期）：

```
curl -sS --noproxy '*' -m 5 -w '\nHTTP %{http_code}\n' http://10.99.0.2:8787/healthz || echo "连不上 退出码 $?"
```

- 握手超过 180 秒或从未握手，22 退出码 124，healthz 连不上：客机多半没在跑。去下一节重启。
- 握手停了但 22 通：机器开着，是隧道断了。ssh 进法国看 `wg-quick@wg-fleet`，不要在 Contabo 重启。
- 握手在 180 秒内、22 通、healthz 是 200 或 503：机器开着。503 是后端在、有一项不好。按下一节核对，不用重启。
- 香港登不上，或 `systemctl is-active wg-quick@wg-fleet` 不是 `active`：先看香港。

## Contabo 控制台重启

1. 浏览器打开 https://my.contabo.com 登录。
2. Servers & Hosting → VPS。
3. 选法国这台。页面写着 Running 也不可信，照样点重启。
4. 确认框核对机器名，IP 对上 ssh 配置里的 `<法国IP>` 再确认。
5. 等大约两分钟，回到上一节把三条再跑一遍。22 通了再往下。

## 重启后核对

用 ssh 配置里的法国那条登上去，以 root 跑。下面每条命令对应 `deploy/france/` 里的一个单元文件。常驻、socket、timer、path、slice 和 `fleet-firewall.service` 应是 `active`。四个一次性单元空闲时是 `inactive`，`failed` 才是坏：`fleet-auto-release.service`、`fleet-cli-upgrade.service`、`fleet-mirasim-liveness.service`、`fleet-release-request.service`。没装过的单元会说找不到，不是没起来。隧道和库不在这些文件里，先看，都要 `active`：`systemctl is-active wg-quick@wg-fleet postgresql@16-main`。

```
systemctl is-active fleet-agents.slice
systemctl is-active fleet-api.service
systemctl is-active fleet-api.socket
systemctl is-active fleet-auto-release.service
systemctl is-active fleet-auto-release.timer
systemctl is-active fleet-cli-upgrade.path
systemctl is-active fleet-cli-upgrade.service
systemctl is-active fleet-engine.service
systemctl is-active fleet-firewall.service
systemctl is-active fleet-mirasim-liveness.service
systemctl is-active fleet-mirasim-liveness.timer
systemctl is-active fleet-mirasim-session.service
systemctl is-active fleet-release-request.path
systemctl is-active fleet-release-request.service
systemctl is-active fleet-temporal.service
```

哪条不对：`journalctl -u <单元名> -b -n 30`。

## 2026-10-15 事故

10:38 干净关机。系统内无人下命令，无崩溃和内存耗尽，疑似宿主机侧。关机 1 小时 01 分，11:40 重新开机。控制台显示 Running 不可信。这是第一次真实重启。

留证：`last -x | head` 里 `shutdown` 紧挨着下一次 `reboot` 就是客机干净关过；`/var/crash` 空着就不是内核 panic。谁下的关机：`journalctl -b -1 -u systemd-logind`（会话用户读不到）。

## 回来后看被打断的任务

自己的检出里看进度和没处理的引导：`pnpm progress read`。法国上还开着的工作流：`fleet-temporal workflow list --query 'ExecutionStatus="Running"'`。引擎起来后续上，不要手工重开。
