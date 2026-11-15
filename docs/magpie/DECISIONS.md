# magpie 取舍

每条都写了依据。仓里、讨论稿和这台程序帮助都对不上的，写 **未查到**。不要凭记忆把未查到的比例填回在跑的配置。

## Claude 不进 magpie

Claude 只走 reclaude，不进 magpie。

出处：决定 [0128](../decisions/0128-magpie-central-gateway-and-repo-consolidation.md) 第 3 条；[讨论稿 4026](../../specs/4026-magpie-vps/讨论稿.md)「不做什么」。

## agy-quota 不上法国

Antigravity（Gemini）只在本机经 agy 用，不装上法国。

出处：决定 0128 第 3 条。名字 **agy-quota** 在决定和讨论稿里没出现，出处未查到。

## grok-pool 的 2:1 和 fast 嵌套

要照着记的取舍：`grok-pool` 用 `routing=weight`，两个成员的份额是 2 和 1。fast 嵌在组上，用 `fast=` 点名走 fast 模式的成员，不把 `:fast` 写进 `weight=` 的键。

组 id `grok-pool` 的出处是公开单 #4033。2:1 和 fast 嵌套是 #4035 要求写明的取舍。决定 0128 和讨论稿 4026 没有这个比例，成文出处未查到。法国在跑的组是不是已经是 2 和 1，要读 magpie 用户的配置再对。本会话没有读到，也没有改它。装新机器时先读法国那份组，再按读到的份额写，不要只凭这一节去改在跑的组。

## account-cap 按账号

封顶按账号算，不按整个供应商一把算。程序命令是 `magpie provider account-cap <供应商> <账号> …`（0.1.4263 的帮助如此）。

这套部署里每个账号的百分比不在决定和讨论稿里，出处未查到。不要按猜的数字去改在跑的账号。

## deepseek / glm：免费轮流，付费兜底

免费的 deepseek 和 glm 轮流用，付费渠道做兜底。

轮流是组的 `rotate`（每条消息换下一个）或 `drain`（一个用尽再换）。决定和讨论稿没有写用哪一种，出处未查到。付费兜底是渠道上的 fallback，不是再开一把总开关。

## 登录不同步

同步不带订阅登录和插件登录（`sign-ins` 关闭）。密钥也不带（`keys=no`）。

讨论稿写过同步可以选 `sign-ins=yes`，并写明 Linux 无桌面能不能靠同步带上登录还没核实。决定 0128 没有把登录写进同步。把「关掉」写成现状，是这张单的口径，成文出处未查到。

## 改完对 smart 的 md5

改完路由，对名为 smart 的那组做 md5，两边一致才算改完。

核对时用的组 id 是 `smart`（`magpie group smart`）。对哪一段字节算，出处未查到。算法不要对着带密钥或账号的输出算。步骤见 [OPERATIONS.md](OPERATIONS.md)。
