# magpie 取舍

每条都写了依据。仓里、讨论稿和这台程序帮助都对不上的，写 **未查到**。不要凭记忆把未查到的比例填回在跑的配置。

## Claude 不进 magpie

Claude 只走 reclaude，不进 magpie。

出处：决定 [0128](../decisions/0128-magpie-central-gateway-and-repo-consolidation.md) 第 3 条；[讨论稿 4026](../../specs/4026-magpie-vps/讨论稿.md)「不做什么」。

## agy-quota 不上法国

Antigravity（Gemini）只在本机经 agy 用，不装上法国。

出处：决定 0128 第 3 条。名字 **agy-quota** 在决定和讨论稿里没出现，出处未查到。

## grok-pool 的 2:1 和 fast 嵌套

grok 池按 2:1 分流量，fast 嵌在组里面，不写进 `weight=` 的键。

比例、嵌的是哪个成员、fast 占多少：未查到。

## account-cap 按账号

封顶按账号算，不按整个供应商一把算。程序命令是 `magpie provider account-cap <供应商> <账号> …`（0.1.4263 的帮助如此）。

这套部署里每个账号的比例：未查到。

## deepseek / glm：免费轮流，付费兜底

免费的 deepseek 和 glm 轮流用，付费渠道做兜底。

组名、成员、用的是 `rotate` 还是别的路由：未查到。

## 登录不同步

同步不带订阅登录和插件登录（`sign-ins` 关闭）。密钥也不带（`keys=no`）。

讨论稿写过同步可以选 `sign-ins=yes`，并写明 Linux 无桌面能不能靠同步带上登录还没核实。决定 0128 没有把登录写进同步。把「关掉」写成现状，是这张单的口径，成文出处未查到。

## 改完对 smart 的 md5

改完路由，对名为 smart 的那组做 md5，两边一致才算改完。

对哪一段字节算、组的 id 是不是就叫 `smart`：未查到。算法不要对着带密钥或账号的输出算。步骤见 [OPERATIONS.md](OPERATIONS.md)。
