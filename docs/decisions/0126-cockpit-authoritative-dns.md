# 0126 驾驶舱子域权威 DNS 改到多节点免费权威

- 索引状态：生效
- 日期：2026-11-03
- 谁拍的：指挥官（#3893，原话无；不掏新钱，决定 0097 事后报）
- 状态：采纳。部分取代 0043 里「DNS 也用 DigitalPlat 的」那一句。
- 关联：`docs/ops.md`「怎么看健康」；`docs/design.md` 第四节「香港门面」、第五节「CI 策略只读桥」；读桥代码不改（`packages/conventions/src/ci-policy-bridge.ts`）。

## 背景

2026-11-03 15:11–15:17 UTC，驾驶舱域名的权威 DNS 是免费托管的 `dns1.digitalplat.org` / `dns2.digitalplat.org`（两台不同地址，不是任播）。53 端口超时，1.1.1.1 返回 SERVFAIL。合并闸读 CI 策略桥停在解析，PR #3892 合并闸连红三次（run 41659499752）。香港 nginx、WireGuard、法国 fleet-api 当时正常。父区 `ns1.digitalplat.org` 至 `ns4.digitalplat.org` 不是这两台。公开仓仍只写 `<驾驶舱域名>`。

## 决定

1. 驾驶舱主机名这一子域的 NS 不再只放 `dns1.digitalplat.org` 和 `dns2.digitalplat.org`。改到 Cloudflare 免费套餐的权威 DNS（任播、多节点，名字以 `.ns.cloudflare.com` 结尾）。不买域名、不开付费套餐、不部署 Worker（看门狗仍按 design 第四节「Cloudflare」那条，不用）。`FLEET_PUBLIC_URL`、香港 nginx、证书上的名字都不改。A/AAAA 只建在新权威上，地址仍是现有香港机器，真值不进仓。
2. 切换后在法国、香港、GitHub Actions runner 上各解析一次该子域的 NS 和 A：NS 必须是 Cloudflare 那组，A 为 NOERROR。再对公开策略桥 GET 一次（无登录、拒绝重定向），HTTP 200 才算读到。三处结果和这一次 200 写进单，主机名仍写 `<驾驶舱域名>`。
3. 判据不放宽。解析超时、SERVFAIL、连不上、非 200、被重定向，合并闸仍判「没查成」。`readPolicyHttp` 对 `ENOTFOUND` 这类没收到响应头的网络失败最多重读一次，仍失败就失败；不缓存上一份策略，不把没读成当成 off 或通过。本次不改读桥和合并闸。

## 实测

- 2026-11-03 15:32–15:34 UTC，法国本机（隧道 `10.99.0.2`），切换前：父区四台对子域 NS 均 NOERROR，委派仍是 `dns1.digitalplat.org`、`dns2.digitalplat.org`（TTL 3600）。直问 dns1 的 SOA/A，UDP 与 TCP 均超时。dns2 曾答 SOA（serial 2026101301），随后 A 也超时。`1.1.1.1`、`8.8.8.8`、`9.9.9.9` 的 A 查询都是 SERVFAIL。本机 curl 报解析失败，没有 HTTP 码。
- 同一时段经隧道直连香港 `10.99.0.1:443`（不经公网解析）GET 公开策略桥：HTTP 200，`cache-control: no-store`，`version` 1，`ciPolicy` 为 force。这只说明入口和读桥当时通，不能代替「解析成功之后的 200」。
- 2026-11-03 17:10–17:16 UTC，法国本机再量一次，切换仍没发生。父区 `ns1.digitalplat.org` 至 `ns4.digitalplat.org` 对子域 NS 都是 NOERROR，委派仍是 `dns1.digitalplat.org`、`dns2.digitalplat.org`（TTL 3600）。`1.1.1.1` 的 NS 查询同样 NOERROR、同一组委派。本机解析器的 A 是 NOERROR，指向现有香港地址（地址不进仓）。直问 dns1：SOA 答过一次（serial 仍是 2026101301），随后多条查询 UDP 超时。直问 dns2 的 A，UDP 超时。
- 同一时段从法国按普通解析（不写 `--resolve`、`--max-redirs 0`）GET 公开策略桥：HTTP 200，没有重定向，`cache-control: no-store`，`version` 1，`ciPolicy` 为 force。委派仍是上面那两台，这一次 200 不是 NS 换成多节点之后的那一次。
- 切换后的法国、香港、GitHub runner 解析：仍没量成。本会话没有 DigitalPlat / Cloudflare 的登录或 API 凭据；`/etc/fleet-dao` 是 `root:fleet` 750，会话用户不在 `fleet` 组，进程带 NoNewPrivs，sudo 起不来，读不到机器配置和上传钥匙；保险箱钥匙不在这台会话用户家里；`gh` 未登录；隧道和香港公网的 22 都拒绝连接。没有这三样，NS 改不了，香港和 runner 上的 dig 也跑不了。
