# 法国失联速查

半夜法国没了，照这页做。人在自己电脑上，香港用 `ssh hk-jump`。公网 IP 只在本机 ssh 配置里，这页写作 `<法国IP>`。控制台显示 Running 不可信。别改 WireGuard 钥匙，也别为 8787 开公网。

香港每分钟经隧道探 `http://10.99.0.2:8787/healthz`，连续 3 次失败才算失联。先打开 `https://<驾驶舱域名>/health/`：页顶「法国失联自 xx:xx」就是从那一刻起连不上。手机上有没有推送，看香港 `/etc/fleet-dao/hk-probe.env` 的 `FLEET_HK_PROBE_WEBHOOK` 配了没有；没配就只有这一页和 `journalctl -u fleet-hk-france-probe.service`。装法和怎么停写在 ops「香港探法国」一节。下面三条用来分清关机、断网、隧道断了，再决定要不要重启。

## 先从香港判断

`ssh hk-jump` 登上香港，以 root 跑下面三条。三条一起看，不要单凭一条去重启。

看隧道握手时间（接口 `wg-fleet`，对端允许地址含 `10.99.0.2`。保活 25 秒，大约每 2 分钟握手一次；超过 3 分钟没更新就是断了）：

```
wg show wg-fleet dump | awk -v now="$(date +%s)" '$4 ~ /10\.99\.0\.2/ { seen=1; if ($5+0==0) print "从未握手"; else print (now-$5) "秒前" } END { if (!seen) print "没有 10.99.0.2 这个对端" }'
```

探公网 22 端口（把 `<法国IP>` 换成 ssh 配置里的真地址，引号留着）：

```
timeout 5 bash -c 'echo >/dev/tcp/<法国IP>/22' && echo 22通 || echo "22不通 退出码 $?"
```

探 `10.99.0.2:8787/healthz`（只绑隧道。从公网打 8787 超时是预期，不是关机）：

```
curl -sS --noproxy '*' -m 5 -w '\nHTTP %{http_code}\n' http://10.99.0.2:8787/healthz || echo "连不上 退出码 $?"
```

- 握手超过 180 秒或从未握手，并且 22 退出码是 124，并且 healthz 连不上：客机多半没在跑。去下一节重启。
- 22 退出码不是 124（马上失败）：多半没换成真 IP，或对方拒连。不要当成关机。
- 握手停了但 22 通：机器开着，是隧道断了。ssh 进法国看 `wg-quick@wg-fleet`，不要在 Contabo 重启。
- 公网 443 通：机器开着（那是别家 self-proxy），不代表驾驶舱活着，不要重启。
- 握手在 180 秒内、22 通、healthz 是 200 或 503：机器开着。503 是后端在、有一项不好。按「重启后核对」，不用重启。
- 香港登不上，或 `systemctl is-active wg-quick@wg-fleet` 不是 `active`：先看香港。

## Contabo 控制台重启

只在上一节判成客机没在跑时做。ssh 还进得去，就在系统里 `reboot`，不要在控制台硬断电。

1. 浏览器打开 https://my.contabo.com 登录（打不开再用 https://new.contabo.com）。
2. 左边 Servers & Hosting → VPS（法国是 VPS，不是 VDS）。旧版左边是 VPS control。
3. 先勾选法国对应的实例，点上方「Restart selected instance(s)」，在弹出的确认框里确认。页面写 Running 也不可信。不要点重装系统。
4. 确认框核对机器名，IP 对上 ssh 配置里的 `<法国IP>` 再确认。
5. 等大约两分钟，回到上一节把三条再跑一遍。22 通了再往下。

## 重启后核对

用 ssh 配置里的法国那条登上去，以 root 跑。下面每条命令对应 `deploy/france/` 里的一个单元文件。字是 `active` 才算好：slice、socket、timer、path，以及 `fleet-api.service`、`fleet-engine.service`、`fleet-temporal.service`、`fleet-mirasim-session.service`、`fleet-firewall.service`（一次性，退出后仍保持 active）。四个一次性单元空闲时字是 `inactive`、退出码 3，这是正常的：`fleet-auto-release.service`、`fleet-cli-upgrade.service`、`fleet-mirasim-liveness.service`、`fleet-release-request.service`。`failed` 才是坏。没装过的也印 `inactive`，但退出码是 4，不是没起来。隧道和库不在这些文件里，先看，都要 `active`：`systemctl is-active wg-quick@wg-fleet postgresql@16-main`。

```
systemctl is-active fleet-agents.slice; echo exit:$?
systemctl is-active fleet-api.service; echo exit:$?
systemctl is-active fleet-api.socket; echo exit:$?
systemctl is-active fleet-auto-release.service; echo exit:$?
systemctl is-active fleet-auto-release.timer; echo exit:$?
systemctl is-active fleet-cli-upgrade.path; echo exit:$?
systemctl is-active fleet-cli-upgrade.service; echo exit:$?
systemctl is-active fleet-engine.service; echo exit:$?
systemctl is-active fleet-firewall.service; echo exit:$?
systemctl is-active fleet-mirasim-liveness.service; echo exit:$?
systemctl is-active fleet-mirasim-liveness.timer; echo exit:$?
systemctl is-active fleet-mirasim-session.service; echo exit:$?
systemctl is-active fleet-release-request.path; echo exit:$?
systemctl is-active fleet-release-request.service; echo exit:$?
systemctl is-active fleet-temporal.service; echo exit:$?
```

哪条不对：`journalctl -u <单元名> -b -n 30`。

## 2026-10-15 事故

10:38 干净关机。系统内无人下命令、无崩溃和内存耗尽，疑似宿主机侧。关机 1 小时 01 分，11:40 重新开机。控制台显示 Running 不可信。这是第一次真实重启。

留证：`last -x | head` 里 `shutdown` 紧挨着下一次 `reboot` 就是客机干净关过；`/var/crash` 空着就不是内核 panic。谁下的关机：`journalctl -b -1 -u systemd-logind`（会话用户读不到）。

## 回来后看被打断的任务

自己的检出里看进度和没处理的引导：`pnpm progress read`。还在法国上，看没跑完的工作流：`fleet-temporal workflow list --query 'ExecutionStatus="Running"'`。引擎起来后续上，不要手工重开。
