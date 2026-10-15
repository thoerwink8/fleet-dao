# 法国失联速查

半夜法国没了，照这页做。人在自己电脑上，香港用 `ssh hk-jump`。法国公网 IP 只在本机 ssh 配置里，下面写作 `<法国IP>`。控制台显示 Running 不代表开着。

## 先从香港判断

以 root 登上香港，跑下面三条。

隧道握手时间（接口 `wg-fleet`，对端 `10.99.0.2`。保活 25 秒，握手大约每 2 分钟换一次；超过 3 分钟没握手就是断了）：

```
wg show wg-fleet latest-handshakes | awk -v now="$(date +%s)" '{if ($2+0==0) print $1, "从未握手"; else printf "%s  %d秒前\n", $1, now-$2}'
```

公网 22：

```
timeout 5 bash -c 'echo >/dev/tcp/<法国IP>/22' && echo 22通 || echo "22不通 退出码 $?"
```

`10.99.0.2:8787/healthz`（只绑隧道。从公网打这个地址超时是预期）：

```
curl -sS --noproxy '*' -m 5 -w '\nHTTP %{http_code}\n' http://10.99.0.2:8787/healthz || echo "连不上 退出码 $?"
```

三条一起看：

- 握手超过 180 秒或从未握手，22 退出码 124（等满超时），healthz 连不上：客机多半没在跑。去下一节在 Contabo 重启。
- 握手超过 180 秒或从未握手，但 22 通：机器开着，是隧道断了。用 ssh 配置登法国看 `wg-quick@wg-fleet`，不要在 Contabo 重启。
- 握手在 180 秒内，22 通，healthz 是 HTTP 200 或 503：机器开着。503 是后端在、有一项不好。ssh 上法国按「重启后核对」看哪一项，机器不用重启。
- 握手在 180 秒内、22 立刻被拒（退出码 1）：机器在，sshd 没听。机器不用重启。
- 香港自己登不上，或香港上 `systemctl is-active wg-quick@wg-fleet` 不是 `active`：先看香港。法国不用重启。

## Contabo 重启

1. 浏览器打开 https://my.contabo.com 登录。
2. Servers & Hosting → VPS。
3. 选法国这台。
4. 点重启。
5. 确认框里核对机器名和 IP。IP 对上 ssh 配置里的 `<法国IP>` 再确认。

## 重启后核对

先在香港把上面三条再跑一遍。公网 22 通了，用 ssh 配置里的法国那条登上去，以 root 按顺序各跑一条。这些单元开机自起；nft 表由 `fleet-firewall` 在服务之前载入。

| 顺序 | 服务 | 命令 | 算好 |
|---|---|---|---|
| 1 | WireGuard | `systemctl is-active wg-quick@wg-fleet` | `active` |
| 2 | Postgres | `pg_isready -h 127.0.0.1 -p 5432` | `accepting connections` |
| 3 | Temporal | `fleet-temporal operator cluster health` | `SERVING` |
| 4 | API | `curl -sS --noproxy '*' -m 5 -o /dev/null -w '%{http_code}\n' http://10.99.0.2:8787/healthz` | `200`（`503` 是进程在、有项不好） |
| 5 | 引擎 | `systemctl is-active fleet-engine` | `active` |
| 6 | Mirasim 会话服务 | `curl -fsS --noproxy '*' -m 5 http://127.0.0.1:4318/api/health` | 正文里有 `"ok":true` |

哪项不对，看这一轮开机的日志：`journalctl -u <单元> -b -n 30`。单元名：`wg-quick@wg-fleet`、`postgresql@16-main`、`fleet-temporal`、`fleet-api`、`fleet-engine`、`fleet-mirasim-session`。

## 2026-10-15

10:38 法国被干净关机（系统日志里无人下命令、无崩溃、无内存耗尽，疑似宿主机侧），关机 1 小时 01 分，11:40 重新开机。Contabo 控制台当时仍显示 Running。控制台显示 Running 不代表开着。这是第一次真实重启。

上去留证：`last -x | head` 里 `shutdown` 紧挨着下一次 `reboot`，就是客机干净关过；`/var/crash` 是空的就不是内核 panic。谁下的关机看上一轮：`journalctl -b -1 -u systemd-logind`（会话用户读不到）。

## 回来后看被打断的

自己的检出里看进度和没处理的引导：`pnpm progress read`。法国上还开着的工作流：`fleet-temporal workflow list --query 'ExecutionStatus="Running"'`。引擎起来后续上，不要手工重开。
