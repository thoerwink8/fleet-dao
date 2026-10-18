# 法国失联速查

半夜法国没了，照这页做。人在自己电脑上，香港用 `ssh hk-jump`。公网 IP 只在本机 ssh 配置里，这页写作 `<法国IP>`。控制台显示 Running 不可信。别改 WireGuard 钥匙，也别为 8787 开公网。

香港每分钟经隧道探 `http://10.99.0.2:8787/healthz`，连续 3 次失败才算失联。先打开 `https://<驾驶舱域名>/health/`：页顶「法国失联自 xx:xx」就是从那一刻起连不上。香港配了推送（`/etc/fleet-dao/hk-probe.env` 的飞书应用三项，#2705）时，团队群里会收到「法国失联自 xx:xx」，恢复时收到「法国恢复了」；没收到就看 `journalctl -u fleet-hk-france-probe.service`（推送没送成会写原因）。装法和怎么停写在 ops「香港探法国」一节。下面三条用来分清关机、断网、隧道断了，再决定要不要重启。

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

留证：`last -x | head` 里的 `shutdown` 和下一次 `reboot` 用来核对关机、开机时间，再结合 `journalctl -b -1 -u systemd-logind` 确认是否走了干净关机流程（会话用户读不到）；干净关机不等于已查明触发者。`/var/crash` 空只说明该路径没读到转储，不足以排除内核 panic。还要结合前一启动的内核日志（`journalctl -b -1 -k`）、已配置的 kdump/pstore 记录和供应商事件；未配置采集、读不到或没有持久日志时，明确记为未知。[Linux Kdump](https://docs.kernel.org/admin-guide/kdump/kdump.html) 的转储依赖预留内存、加载捕获内核和成功写出，[Ramoops](https://docs.kernel.org/admin-guide/ramoops.html) 的持久记录也依赖相应配置与存储；这里仅核查已有证据，不安装或开启采集器。

## 2026-10-19 事故（#3134，恢复核验未收口）

以下时间均为北京时间（UTC+8），记录截至 02:20 的只读证据。

- 01:25 起香港探针报告法国失联。01:28–01:29，香港 SSH、静态健康页和 WireGuard 服务正常，但至法国公网 22/443、隧道 22/8787 同时超时，握手由 352 秒前增至 401 秒前，香港转发的 `/healthz` 返回 HTTP 504。网络证据只能定位到法国整机或宿主网络，不能独自判定关机原因。
- 恢复后读取上一启动的 `systemd-logind`：01:24:36 记录 `Power key pressed short.`、`Powering off...`；01:25:28 到达 `poweroff.target`，同步文件系统并结束日志。`last -x` 记录 01:25 关机、01:48 再启动，停机约 23 分钟；新启动日志始于 01:48:29。这证明客机响应电源键事件走了干净关机流程，不能据此认定是谁触发。
- 前一启动确有 10 月 17 日会话 cgroup 内的 OOM 记录；它们早于本次关机，不能当成本次整机关机根因。供应商公开维护说明也不是本实例的事件证明。尚未取得 Contabo 控制台操作审计，电源事件和再次开机的触发者均未知。
- 02:17–02:20 的只读快照已能经既有 SSH 读取法国；`fleet-api`、`fleet-engine`、`fleet-temporal`、`fleet-auto-release.timer` 均为 `active`，数据库只读查询成功。在用版本仍为 `7b2897e8bb67`。`fleet-mirasim-session.service` 为 `inactive`、`ConditionResult=no`，不能把所有服务统称为正常，也没有为凑绿启动它。
- 香港独立复核：02:17:28 的公开链路记录为 `down=false`、连续失败 0 次；02:17:39 的直接探测握手 86 秒前、公网 22/443 和隧道 22 均退出码 0，隧道 `/healthz` HTTP 200、耗时 0.584 秒。02:18:44 的具名检查中 `wg-quick@wg-fleet`、`postgresql@16-main`、API 及 socket、engine、Temporal、firewall 均为 `active`。这证实网络和核心服务恢复，不代表全部任务已完成验收。
- 本次记录不把恢复归功于本机会话：排查没有在法国启动服务、发版、改开关或改网络配置。仅有现存恢复证据，不能声称人工重启解决了根因。

本机脱敏留证：`_tmp/followup-france-outage-20261019.md`、`_tmp/followup-france-recovery-20261019-0218-redacted.txt`、`_tmp/followup-france-0220-services-redacted.txt`；这些是现场资料，不作为公开仓附件。服务和数据库命名核验来自同次只读巡检快照，正文不公开实例公网 IP、凭据或原始日志。

#3134 保留开放：还须补控制台实例核对和操作审计（拿不到就明确记录），核对被打断工作流从原持久状态自然接续，以及受影响 PR 精确当前头的策略桥和外部合并闸。服务进程 `active` 不等于任务接续完成，策略桥可读也不等于冷验收已通过；这些结果不得用重派任务、放宽判据或重复报成功代替。

后续进展记在 #3134 的评论里，按时间看。评论 6253675229 记了扩展页重载之后的控制台状态，还记了被打断的工作流按原 workflow/run 身份自然接续，以及对应的任务活动。评论 6253891995 和 04:33 的巡检记了法国在用版本 `3cc9af98`、healthz 200、推送和简报正常。受影响的 PR 仍要各自在精确当前头上过策略桥和合并闸，不能一并算作通过。电源键事件只能证明客机收到电源事件并干净关机，认不出触发者，也排除不了其他来源。根因、控制台操作审计和再次开机的触发者继续记未知，等拿到控制台审计再收口。

## 回来后看被打断的任务

自己的检出里看进度和没处理的引导：`pnpm progress read`。还在法国上，看没跑完的工作流：`fleet-temporal workflow list --query 'ExecutionStatus="Running"'`。引擎起来后续上，不要手工重开。
