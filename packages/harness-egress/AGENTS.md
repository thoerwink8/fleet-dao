# packages/harness-egress：影子工人的出网关

决定 0124 的新内核（母单 #3770，第 3 片 #3775）里影子工人的出网限制。影子工人和引擎会话同一个会话用户（法国只占 reclaude 一台设备，不另开用户），按 cgroup 隔离：nftables 认出影子 slice 的连接，发往 443 的重定向到这里，其余出网拒（规则和服务单元跟着法国部署那块接）。reclaude 连上游不认 `HTTPS_PROXY`（本机实测），所以是透明代理。

## 不变量

- 只读首条 TLS 记录里的 SNI，不解密、不改字节；在名单里才按主机名连 `:443` 原样转发。名单外、读不出、不是 TLS、首条记录等太久，一律断开。
- 名单一行一个主机名；以点开头（`.example.com`）匹配它的子域、不含它自己。
- `learn` 模式只记不拦（判定写 `learned`）：先在法国收真实主机名定名单，再切 `enforce`。
- 每个判定一行 JSON 打到 stdout，不打连接里的内容。

## 测试

- `npx vitest run packages/harness-egress`：用真的 TLS 客户端发 ClientHello，上游换成本地口记字节。
