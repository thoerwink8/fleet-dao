# magpie 清单

2026-11-16 在法国这台核对。在跑的配置在用户 `magpie` 的家里，目录权限 `750`，本会话列不出文件、也打不开网关（网页和网关都要钥匙，钥匙不在这台会话里）。下面能对上决定和程序的写出来，读不到的写 **未查到**。没有密钥、令牌、邮箱、账号 ID。

## 供应商

决定 [0128](../decisions/0128-magpie-central-gateway-and-repo-consolidation.md) 和 [讨论稿 4026](../../specs/4026-magpie-vps/讨论稿.md) 点了名，不是从 `providers.json` 读出来的：

| 谁 | 放哪 | 说明 |
|---|---|---|
| Grok、Cursor、Devin 订阅 | 法国 | 订阅号登在法国这台 |
| Antigravity（Gemini） | 只在本机，经 agy | 不上法国 |
| Claude | 不进 magpie | 只走 reclaude |
| 各机器的调用 key | 每台自己的 `caller-keys.json` | 不进同步 |

讨论脚本 `agents/skills/discuss/scripts/magpie.mjs` 里写过模型前缀 `recodex`、`devin`、`chaeng`、`grok`、`cursor`。那是讨论用的固定型号，不是法国配置目录的供应商清单。

渠道 key、插件包、账号分别有几个：未查到。

## 路由组

讨论稿点了四个组。成员、路由方式、权重都要看配置，这次没读到。

| 组 | 成员 | 路由方式 | 权重 | 用途 |
|---|---|---|---|---|
| 工程组 | 未查到 | 未查到 | 未查到 | 各机器用自己的调用 key 访问的工程路由 |
| grok 池 | 未查到 | 未查到 | 未查到 | 讨论稿点名的 Grok 路由组 |
| GPT 池 | 未查到 | 未查到 | 未查到 | 讨论稿点名的 GPT 路由组 |
| Luna 池 | 未查到 | 未查到 | 未查到 | 讨论稿点名的 Luna 路由组 |

grok 池的 2:1 和 fast 嵌套见 [DECISIONS.md](DECISIONS.md)，数目本身未查到。

## workbuddy 与 raccoon 的多账号轮流

程序能把 WorkBuddy、Raccoon 这类订阅做成多账号，用组的 `rotate` / `drain` 轮流，并用 `account-cap` 按账号封顶。这台实际有几个账号、什么顺序、各封多少：未查到。不要把账号邮箱或 ID 补进这份清单。

## 资源库分发

决定 0128：规矩、技能、指令改由 magpie 资源库下发。`magpie library` 能看指令、MCP、技能发给了哪些智能体。法国这份实际下发了什么：未查到。

## 设置

设置在配置目录的 `settings.json`。在跑的那份：未查到。不要把 `magpie settings list` 在空目录里打出来的默认值当成这台的设置。

## 配置目录文件名

两套目录不要混：

- 本会话用户的 `~/.config/magpie` 不是在跑的法国网关。2026-11-16 这里能看见的只有 `plugins.yml`、`plugins.yml.lock`、空的 `caller-keys.json.lock`。
- 在跑的目录在 `magpie` 用户家里（`/var/lib/magpie` 下，再由 `/etc/magpie.env` 的 `XDG_CONFIG_HOME` 决定）。文件名清单：未查到。

`magpie 0.1.4263` 的程序会用到这些名字（从二进制里的文件名核对，不是目录清点）：`providers.json`、`settings.json`、`usage.json`、`library.json`、`profiles.json`、`logins.json`、`plugin-auth.json`、`caller-keys.json`、`gateway.json`、`sync-state.json`、`quota-history.json`、`accounts.json`、`memory.json`、`plugins.json`，以及磁盘上见过的 `plugins.yml`。

空配置第一次跑 CLI，还会落下 `logins.json.lock` 和 `plugins.yml.lock`。锁文件没有密钥。

## 近 30 天用量

未查到。在跑的用量在 `magpie` 用户的 `usage.json` 里。要汇总时用那台的环境，命令套超时，输出里的邮箱和账号 ID 不要抄进文档：

```sh
sudo -u magpie env HOME=… XDG_CONFIG_HOME=… timeout 30 /opt/magpie/magpie usage 30d
```

`usage 30d` 是按智能体、模型和订阅账号的 token 与费用。`--csv` 会把每次请求摊开，更容易带上账号，汇总时不要用它往文档里贴。
