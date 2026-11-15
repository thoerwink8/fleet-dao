# magpie 清单

2026-11-16 核对。没有密钥、令牌、邮箱全名、账号 ID。

能写死的来自决定 0128、讨论稿 4026、公开单 #4027 / #4033、`docs/ops.md`，以及法国这台 `/opt/magpie/magpie` 的版本 `0.1.4263` 的帮助。在跑的配置在用户 `magpie` 的家里，目录权限 `750`。本会话不是这个用户，打不开 `providers.json`、`library.json`、`settings.json` 和 `usage.jsonl`。表里写「未查到」的，就是这几份文件里的实数，没有用空配置或讨论稿去填。

有权限的人可以用 `install/magpie-inventory.sh --config <配置目录>` 把同一份目录收成不含密钥、邮箱和账号 ID 的摘要。设置段打 `键=当前值`（和默认值相同的略去，密钥字段不打）。2026-11-16 对本机 magpie 家目录又跑过，退出码 2，读不到目录。全盘能遍历到的地方没有第二份 `providers.json`、`library.json` 或 `usage.jsonl`。网关不带钥匙返回 401，加入接口是关的。下面的表因此仍没有实数。

## 供应商

| 谁 | 放哪 | 说明 | 出处 |
|---|---|---|---|
| Grok 订阅 | 法国 | 订阅号登在法国。令牌由法国已有的 grok 命令行续 | 决定 0128；`docs/ops.md` |
| Cursor 订阅 | 法国 | 社区插件 `@magpie-community/opencode-cursor-auth`。登录文件是 magpie 用户的 `.config/cursor/auth.json`，内容不进文档 | `docs/ops.md` |
| Devin 订阅 | 法国 | 订阅号登在法国 | 决定 0128 |
| deepseek、glm、kimi | 法国网关里的渠道 | #4033 写本机网关已有 `deepseek-pool`、`glm-pool`、`kimi-pool`。#4027 写渠道和路由组已迁到法国。免费轮流、付费兜底见 [DECISIONS.md](DECISIONS.md) | #4033、#4027 |
| gateway-key | 每台自己的 `caller-keys.json` | 调用法国网关的钥匙，`magpie gateway-key` 管理。每台一把，可单独吊销。不进同步。各台的名字未查到 | #4027 完成说明 |
| Antigravity（agy） | 只在本机 Windows | 不上法国 | 决定 0128 |
| Claude | 不进 magpie | 只走 reclaude | 决定 0128 |

讨论脚本 `agents/skills/discuss/scripts/magpie.mjs` 里的固定型号是 `recodex/gpt-6-astra`、`devin/swe-2`、`chaeng/deepseek-v4.1-flash`、`grok/grok-4.7`、`cursor/claude-haiku-5-5@300k`。那是讨论用的型号，不是这份供应商表，也不当路由组成员。

## 路由组

#4033（2026-11-15）写本机网关已有这些组 id，讨论时模型名就用组 id。#4027 的完成说明写渠道和路由组已迁到法国，本机 `fr-smart` 兜底验证通过。法国迁完后是不是仍是这些 id，要读 magpie 用户的配置才知道，本会话未核对。成员模型 id 未查到，表里不填猜测的模型名。

| 组 | 成员 | 路由方式 | 权重 | 用途 |
|---|---|---|---|---|
| gpt-pool | 未查到 | 未查到 | 未查到 | #4033：讨论用的 GPT 路由组。讨论稿里的「GPT 池」是不是同一个 id，未查到 |
| grok-pool | 未查到 | `weight` | 两个成员 2 和 1。fast 用组上的 `fast=`，不写进权重键 | Grok 分流。组 id 见 #4033。2:1 和 fast 嵌套见 [DECISIONS.md](DECISIONS.md) |
| deepseek-pool | 未查到 | 未查到 | 未查到 | #4033：讨论用的 deepseek 路由组 |
| kimi-pool | 未查到 | 未查到 | 未查到 | #4033：讨论用的 kimi 路由组 |
| glm-pool | 未查到 | 未查到 | 未查到 | #4033：讨论用的 glm 路由组 |
| cn-pool | 未查到 | 未查到 | 未查到 | #4033：国模组 |
| 工程组 | 未查到 | 未查到 | 未查到 | 讨论稿 4026 点过名。组 id 未查到 |
| Luna 池 | 未查到 | 未查到 | 未查到 | 讨论稿 4026 点过名。组 id 未查到 |
| fr-smart | 未查到 | 未查到 | 未查到 | #4027：本机直连兜底，法国网关停掉时落到直连。成员和权重未查到 |

`0.1.4263` 的组帮助里，权重是 `weight=<模型>=<数字>`，数字是份额（帮助举例：权重 3 就是每轮里占 3 次）。`fast=<模型>` 表示这些成员走厂商的 fast 模式。成员也可以写成 `供应商/模型#账号`，同一个模型的两个账号是两个成员。

## workbuddy 与 raccoon 的多账号轮流

WorkBuddy（中国版 provider id `workbuddy`，国际版 `workbuddy-ai`）和 Raccoon（`raccoon`）是 magpie 的订阅插件，一个供应商下可以有多个登录账号。帮助见 `0.1.4263`。

轮流做在路由组上：

- `rotate`：每发一条消息换下一个账号；这个账号上的工具调用仍留在同一个账号。
- `drain`：一个账号用到尽，再换下一个。

封顶按账号，命令是 `magpie provider account-cap <供应商> <账号> …`。帮助里的份额是这个账号用量窗口的百分比。设置项里另有 `workbuddyCheckin`（WorkBuddy 每日签到），在跑的值未查到。

法国实际登了几个、顺序、各封百分之几：未查到。这里不写邮箱，也不写账号 ID。

## 资源库分发

决定 0128：规矩、技能、指令改由 magpie 资源库下发。`magpie library` 看三块发给了哪些智能体：instructions、MCP、skills。可以按智能体勾选，也可以只留在这台（`mcp local`、`skill off-here`）。同步不带走「只留本机」的那部分。

法国正在下发的指令、MCP 和技能名单：未查到。

## 设置

在跑的设置是配置目录里的 `settings.json`。`magpie settings list` 打出每个键的当前值和默认值。

空目录里这条命令打出的是程序默认值（`0.1.4263` 有 `theme`、`lang`、`workbuddyCheckin`、`redact` 等 90 个键）。那不是法国这台网关改过的值，不抄进这张表。在跑的键和当前值：未查到。清单脚本读到 `settings.json` 时会打非密钥字段的当前值；这次没有文件可打。

## 配置目录文件名

两套目录分开：

- 本会话用户的 `~/.config/magpie` 不是在跑的网关。2026-11-16 这里有 `plugins.yml`（`preset: all`、`settled: 1`）、`plugins.yml.lock`，以及空的 `caller-keys.json.lock`、`logins.json.lock`。
- 在跑的目录跟着 `/etc/magpie.env` 里的 `HOME` 和 `XDG_CONFIG_HOME`。用户家目录是 `/var/lib/magpie`。没设 `XDG_CONFIG_HOME` 时，配置在 `$HOME/.config/magpie`。该目录权限 `750`，本会话列不出文件。

`0.1.4263` 在空目录里添加一个渠道并建一个组之后，落下这些名字（试跑用的是临时家目录，跑完已删，没有碰到在跑的配置）：

`providers.json`、`providers.json.bak`、`stash.json`、`usage.jsonl`、`plugins.yml`、`caller-keys.json.lock`、`logins.json.lock`、`plugins.yml.lock`。

程序还会用到这些名字（帮助，以及先前对二进制里的文件名核对）：`settings.json`、`library.json`、`profiles.json`、`logins.json`、`plugin-auth.json`、`caller-keys.json`、`gateway.json`、`sync-state.json`、`quota-history.json`、`accounts.json`、`memory.json`、`plugins.json`。核对脚本另写不含密钥的 `bootstrap-state.json`。锁文件没有密钥。

## 近 30 天用量

汇总命令：

```sh
sudo -u magpie env HOME=… XDG_CONFIG_HOME=… timeout 30 /opt/magpie/magpie usage 30d
```

`HOME` 和 `XDG_CONFIG_HOME` 从 `/etc/magpie.env` 取。`--csv` 把每次请求摊开，容易带上账号，不要贴进文档。

近 30 天的 token 和费用合计：未查到。本会话读不到 magpie 用户的 `usage.jsonl`，不把 0 写成这台的用量。
