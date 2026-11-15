# magpie 清单

2026-11-16 核对。没有密钥、令牌、邮箱全名、账号 ID。

在跑的法国配置在用户 `magpie` 的家里，目录权限 `750`。本会话不是这个用户，也没有能切换过去的权限，所以打不开 `providers.json` 和用量。下面能对上决定、公开单、ops 和 `0.1.4263` 帮助的写出来。会话用户自己的 `~/.config/magpie` 不是这台网关，不要把它的空配置当成清单。

## 供应商

| 谁 | 放哪 | 说明 |
|---|---|---|
| Grok 订阅 | 法国 | 决定 0128：订阅号登在法国。ops：令牌由法国已有的 grok 命令行续 |
| Cursor 订阅 | 法国 | ops：社区插件 `@magpie-community/opencode-cursor-auth`。登录文件路径是 magpie 用户的 `.config/cursor/auth.json`，内容不进文档 |
| Devin 订阅 | 法国 | 决定 0128 |
| deepseek、glm | 法国网关里的渠道 | 免费的轮流用，付费渠道兜底，见 [DECISIONS.md](DECISIONS.md) |
| gateway-key | 每台自己的 `caller-keys.json` | 调用法国网关的钥匙。`magpie gateway-key` 管理。#4027：每台一把，可单独吊销。不进同步 |
| Antigravity（agy） | 只在本机 Windows | 不上法国 |
| Claude | 不进 magpie | 只走 reclaude |

讨论脚本 `agents/skills/discuss/scripts/magpie.mjs` 里的 `recodex`、`devin`、`chaeng`、`grok`、`cursor` 是讨论用的固定型号，不是这份供应商清单。

## 路由组

2026-11-15 讨论稿点了本机上的四个组。#4027 的完成说明写了配置（渠道、路由组）已迁到法国，本机 `fr-smart` 兜底验证通过。成员模型 id 在法国那份配置里，本会话打不开那个目录，表里不填猜测的模型名。

| 组 | 成员 | 路由方式 | 权重 | 用途 |
|---|---|---|---|---|
| 工程组 | 迁到法国的工程渠道 | 各机器用自己的 gateway-key 调用这一组 | 决定没有另写数字 | 各机器用的工程路由 |
| grok-pool | fast 嵌在组上（`fast=`），不写进权重键 | `weight` | 2:1 | Grok 分流 |
| GPT 池 | 讨论稿点名，随配置迁到法国 | 讨论稿没有写方式 | 讨论稿没有写数字 | GPT 路由 |
| Luna 池 | 讨论稿点名，随配置迁到法国 | 讨论稿没有写方式 | 讨论稿没有写数字 | Luna 路由 |
| fr-smart | 本机直连兜底 | 本机 magpie 这一层 | #4027 只写了兜底验证通过 | 法国网关停掉时，本机落到直连 |

`0.1.4263` 的组帮助里，权重是 `weight=<模型>=<数字>`，数字表示份额（帮助举例：权重 3 就是每轮里占 3 次）。fast 是另一个字段 `fast=<模型>`，表示这些成员走厂商的 fast 模式。成员也可以写成 `供应商/模型#账号`，同一个模型的两个账号是两个成员。

## workbuddy 与 raccoon 的多账号轮流

WorkBuddy（中国版 provider id `workbuddy`，国际版 `workbuddy-ai`）和 Raccoon（`raccoon`，商汤小浣熊）是 magpie 的订阅插件，一个供应商下可以有多个登录账号。

轮流做在路由组上，不做成一把供应商总开关：

- `rotate`：每发一条消息换下一个账号；这个账号上的工具调用仍留在同一个账号。
- `drain`：一个账号用到尽，再换下一个。
- 封顶是 `magpie provider account-cap <供应商> <账号> …`，按账号算。帮助里的份额是这个账号用量窗口的百分比。

法国实际登了几个、顺序、各封百分之几，都在读不到的那份配置里。这里不补邮箱，也不补账号 ID。

## 资源库分发

决定 0128：规矩、技能、指令改由 magpie 资源库下发。`magpie library` 看三块发给了哪些智能体：instructions、MCP、skills。可以按智能体勾选，也可以只留在这台（`mcp local`、`skill off-here`），同步不带走「只留本机」的那部分。

法国正在下发的名单在 magpie 用户的 `library.json` 一类文件里。本会话读不到，不用空配置的输出来冒充。

## 设置

在跑的设置是配置目录里的 `settings.json`，用 `magpie settings list` 看当前值和默认值。法国那份读不到。空目录里 `settings list` 打出来的是程序默认值，不是这台网关的设置，不要抄进清单。

## 配置目录文件名

两套目录不要混：

- 本会话用户的 `~/.config/magpie` 不是在跑的网关。2026-11-16 这里只有 `plugins.yml`（`preset: all`、`settled: 1`）、`plugins.yml.lock`，以及空的 `caller-keys.json.lock`。
- 在跑的目录跟着 `/etc/magpie.env` 里的 `HOME` 和 `XDG_CONFIG_HOME`。用户家目录是 `/var/lib/magpie`。没设 `XDG_CONFIG_HOME` 时，配置在 `$HOME/.config/magpie`。该目录权限 `750`，本会话列不出文件。

`0.1.4263` 在空目录里添加一个渠道并建一个组之后，落下这些名字（这次试跑用的是临时家目录，跑完已删，没有碰到在跑的配置）：

`providers.json`、`providers.json.bak`、`stash.json`、`usage.jsonl`、`plugins.yml`、`caller-keys.json.lock`、`logins.json.lock`、`plugins.yml.lock`。

程序还会用到这些名字（帮助和先前对二进制里的文件名核对）：`settings.json`、`library.json`、`profiles.json`、`logins.json`、`plugin-auth.json`、`caller-keys.json`、`gateway.json`、`sync-state.json`、`quota-history.json`、`accounts.json`、`memory.json`、`plugins.json`。核对脚本另写不含密钥的 `bootstrap-state.json`。锁文件没有密钥。

## 近 30 天用量

汇总命令是按智能体、模型和订阅账号的 token 与费用：

```sh
sudo -u magpie env HOME=… XDG_CONFIG_HOME=… timeout 30 /opt/magpie/magpie usage 30d
```

`HOME` 和 `XDG_CONFIG_HOME` 从 `/etc/magpie.env` 取。`--csv` 把每次请求摊开，容易带上账号，不要贴进文档。

本会话变不成用户 `magpie`，读不到 `usage.jsonl`，这里没有合计数字。不要把 0 或空配置的输出写成这台的用量。
