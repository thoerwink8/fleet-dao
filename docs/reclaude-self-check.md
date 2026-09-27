# 防封环境自检：接 reclaude 的机器该查什么

> 给谁看：拿到这份文档的人（包括之后每一台机器上的 AI）。装了 reclaude 的机器，上机前 / 换机后 / 觉得「怎么老被踢」时照这份做。
> 配套：装法与原理在 `docs/reclaude-in-mirasim.md`。本文讲两件事：先清掉 reclaude 使用前那个 Claude 账号留在本机的 id，再查有没有在产生上报。
>
> **脚本在哪**：`reclaude-old-account-clean.mjs`、`machine-check.mjs`、`reclaude-mirasim.mjs` 都在 ai-gateway-stack 仓 `deploy/` 下；下面写 `deploy/…` 的都是那个仓里的路径，在那个仓的 checkout 里跑。本仓只放这两份文档。

## 0. 立场

reclaude 服务端只服务**官方 Claude Code 客户端本体**。不是本体的请求会被拒（`400 仅支持 Claude Code 客户端访问 reclaude 网关`
= `non_cc_client`），**并且上报**（`~/.reclaude/state.json` 的 `leak_report: true`）。这类上报攒多了会**解绑设备**
（2026-09-21 法国 VPS 实咬）。

非本体请求：**别产生，也不靠删 `daemon.log` 假装没发生。** 账号被封之后的申诉不在本文范围。本文不写任何伪装成官方客户端、绕过服务方判定的做法。

可以清理下旧账号绑定的 id 和痕迹。这里的「旧账号」只指 reclaude 使用前、登录在本机 Claude 配置里的那一个：`~/.claude.json` 的 `oauthAccount.emailAddress` 和 `~/.reclaude/device.json` 的 `user_email` 不是同一个。现账号（两边邮箱相同）不许动。

## 1. 清旧账号绑定的 id 和痕迹

拿到本文就要在**这台机器**上做完。服务器上每个有 Claude 家目录的用户都要做，不是只做当前用户。

账号 id **不在** `~/.claude/settings.json` 的代理 env 里。它在：

| 落点 | 旧账号留下的东西 |
|---|---|
| `~/.claude.json` | `oauthAccount`（邮箱、`accountUuid`、`organizationUuid`）、旁边的 `userID`、以及别的字段里抄出去的同一串 |
| `~/.claude/backups/.claude.json.backup.*` | 上面这份的旧副本 |
| `~/.reclaude/backups/**/claude.json` | reclaude 自己留的 Claude 配置副本。漏了这份，下次起会话会把旧账号写回去。这份里的 `userID` 一并摘掉（对不上现在这串也摘）。只动 `claude.json`，不动 `device.json` |
| `~/.claude/.credentials.json` | `claudeAiOauth`（旧登录的令牌）。`mcpOAuth` 不是这个账号，留下 |
| `~/.claude/projects/<项目>/memory/` | 笔记里出现的那几串 id。memory 若是指向别的目录的链接，跟着链接清里面的文件 |

```bash
node deploy/reclaude-old-account-clean.mjs                  # 干跑，只打印会动哪些文件
node deploy/reclaude-old-account-clean.mjs --apply          # 当前用户
node deploy/reclaude-old-account-clean.mjs --all-homes --apply
#   Linux 上用 root 跑。读 /etc/passwd，每个有 .claude 或 .reclaude 的家都清。
#   Windows 没有 passwd：--all-homes 只会扫当前用户，输出写明 other-homes=not-scanned。
```

脚本规则（不要自己另写一套，免得把现账号或整份 settings 一起抹掉）：

- 旧 = oauth 邮箱 ≠ `device.json` 的 `user_email`。只摘这几串：邮箱、`accountUuid`、`organizationUuid`、`userID`（短显示名、创建时间不拿去全文替换）。
- `settings.json` 里没有这些字符串就**整文件不重写**（覆写这份文件可能 401，改回去也回不来）。
- 不动 `~/.reclaude/device.json` / `device.key`（那是现账号的设备）、不动 `machineID`、不动会话 `jsonl`、不动 `daemon.log`。
- 输出只打条数和键名，不打印邮箱、uuid、token。

判读（「扫完是 0」和「没查成」不是一回事）：

| 输出 | 意思 |
|---|---|
| `status=clean` 且 `memory=no-id-source` | 扫过了，没有旧 oauth，所以 memory **没按 id 扫**。不是「memory 已证明干净」 |
| `status=clean` 且 `memory=none-found` / `no-memory-dir` | 有旧 id 来源，memory 扫过，0 处 |
| `status=dirty` 后 `--apply` 且 `wrote=yes` | 清过。再跑一次应变成 `clean` |
| `status=unscanned` 或退出码 2 | 没查成（读不了文件、device 没有 `user_email`、oauth 没有邮箱、只剩 `claudeAiOauth` 对不上号）。**一个字节没写**。不许当成已经干净 |
| `status=skipped` `reason=no-reclaude` | 这台没装 reclaude，那份 oauth 就是当前登录，不在本文范围 |
| `other-homes=not-scanned` 或退出码 2 且写着 passwd | 别的用户没扫成 |

`node deploy/machine-check.mjs` 会报 `old-claude-account`（只读，不删）。红了就跑上面的 `--apply`。没装 reclaude 的机器这项不报。

先停掉 `claude`，再停掉 `reclaude`，等进程真退出，然后 `--apply`。两头都会把旧登录写回去：`claude` 退出时写内存里那份；`reclaude` 发现本地凭证空了，会写日志 `检测到本地 Claude 凭证缺失/被清空，已用当前登录自动恢复`，把那份登录填回 `~/.claude.json` 和 `.credentials.json`。

拉起 `reclaude` 之后再干跑一次：

- `status=clean`：这台清掉了。
- oauth 又在，邮箱仍和 `device.json` 的 `user_email` 不同：reclaude 把这份当成当前登录，本地删文件留不住。不要隔几分钟删一次。记下这台机器、哪一家目录。要去掉它，是换 reclaude 里的这份登录，不是再删文件。

（2026-09-26 在本机 Windows 上实测到的就是后一种：清完 `status=clean`，一拉起 reclaude，同一份 oauth 又回来了，`machine-check` 的 `old-claude-account` 照旧红。）

## 2. 四步自检（全绿才算接上）

```bash
# ① 启动命令指谁（只读）
node deploy/reclaude-mirasim.mjs
#   绿：✓ agentLaunch.claude.command = <…>/reclaude-mirasim
#   红：✗ … = reclaude（裸 reclaude = 自有流量会被 Mirasim 网关转出去，正是上报的来源）

# ② 两道体检闸
node deploy/machine-check.mjs | grep -i reclaude
#   绿：没有 reclaude-launch-bare / reclaude-shim-missing / old-claude-account
#   红：reclaude-launch-bare（装了 reclaude 却用裸 reclaude）、reclaude-shim-missing（命令指向不存在的启动器）、
#       old-claude-account（第 1 节还没清）

# ③ reclaude 自己记的上报状态
python3 -c "import json;print(json.load(open('$HOME/.reclaude/state.json'))['daemon'].get('leak_report'))"
#   绿：False。True = 这台机器上**发生过**非本体请求被上报（旧账，新账看下面）
grep -c "event: non-cc-client" ~/.reclaude/logs/daemon.log     # 看有没有**新增**（记下当前条数，之后只许不涨）

# ④ 会话账本：有没有请求以非本体身份撞上去
grep -rl "non_cc_client" ~/.mirasim/traffic/ | head
#   绿：空。有 = 某个会话开局走了自有 → 400 → 上报（`upstreamHost=api.anthropic.com` + `status=400`）
```

判定口径（别搞反）：**账本里这些会话的用量显示「未知」是预期的**（接对之后请求不再经过 Mirasim 网关），
不能用「用量有没有涨」当判据；判据是 ①② 两条闸 + ③④ 有没有**新的**上报。

## 3. 绿了之后仍然会红的两件事（不是启动器的问题）

- **会话中途在界面上切「自有 / 平台」**：已经起着的 claude 进程保持起它时的判法，下次重起进程才按新路由。切完想立刻生效，就把那个会话的进程重起一次。
- **服务器（Linux）上装完没重启 Mirasim**：`apply` 改的是 Mirasim 的配置，生效范围是**新起的** claude 进程。

## 4. 环境纪律

- **一号一环境**：同一台机器上多开账号、或让网关以非本体身份替 claude 出网，都会把设备拖进上报链。
- 可以清理下旧账号绑定的 id 和痕迹。清的是第 1 节那一处，不是去擦上报日志。
- **别用「伪装成官方客户端」的路子**过服务端的客户端校验。本仓不做。
- **换机照 `docs/reclaude-in-mirasim.md` 装完，回到本文第 1 节再第 2 节。** 新机器同样要清。

## 5. 怎么保证不是「没查成」

- 第 1 节退出码 2、`status=unscanned`、`memory=not-scanned`、`memory=no-id-source` 都不是「查过没事」。
- ① 读不到 `setting.json` 会报「没查成」，不是绿。
- ② 体检项在「这台机器根本没装 reclaude」时显式 skip（`no-reclaude`），不是绿；`old-claude-account` 在读不到 `user_email` 时记没查成，不是绿。
- ③ `state.json` 读不到 = 没查成。
- ④ `~/.mirasim/traffic/` 不存在 = 没查成（不是「干净」）。

任何一步「没查成」，都按红处理。
