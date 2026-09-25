---
name: docs-lookup
description: 要上网查资料时读：搜索、查库或框架文档、看 GitHub 内容、抓已知网页，或内置搜索、抓取卡住想换路时；用户说「查一下」「搜一下」也读。
---

# `docs-lookup`：查资料选路

## 搜索：先用 ddgs，不先试内置搜索

装：`uv tool install ddgs`

```bash
ddgs text -q "关键词" -m 5 -nc          # 默认 auto，一家被挡自动换下一家
ddgs text -q "关键词" -m 5 -nc -b brave # 指定后端更快
```

内置搜索（如 Claude Code 的 WebSearch）是**服务端工具**：模型发出调用，由 API 上游去搜再回传，本机只负责把请求送到上游。所以它慢或断的时候，查本机代理、DNS、TLS 全是白费，本机也没有补救手段。`ddgs` 走本机出网，不碰那条链，这是它当默认的理由。内置搜索留作对照，不当首选。

- **`-o json` 不打到标准输出**，而是在当前目录存成 `text_<关键词>_<时间戳>.json`；在共用工作树里，这就是等着被 `git add -A` 卷走的垃圾。要机器读，就解析标准输出。
- **查不到时退出码照样是 0**，只打印一行 `DDGSException('No results found.')`（ddgs 9.16.0，2026-09-25 实测）。脚本里别拿退出码判「查到了」，要看输出里有没有结果。
- **别指定 `-b google`**：2026-09-17、09-25 在不同出口实测都查不到东西，结果会被当成「网上没有」。

## 其余按目标选路

- 库、框架文档：走 context7，不要搜。
- GitHub 上的内容（私有仓、原始文件、issue、PR）：用 `gh api` / `gh search`，不用网页抓取。
- **抓一个已知 URL**：先走 fetch MCP（Claude Code 里是 `mcp__fetch__fetch`）：本地直连，拿到的是转成 markdown 的原文，可用 `start_index` / `max_length` 翻页。内置网页抓取（Claude Code 的 WebFetch）给的是小模型读完页面后对提示的回答，不是原文；它取页前还要回连 claude.ai 做域名校验，网络挡这一跳时就卡住。fetch MCP 默认遵守 `robots.txt`，撞 disallow 是站点规则、不是链路故障（搜索引擎的 `/search` 基本都禁，所以它抓不了搜索结果页，那是 `ddgs` 的活）。
- 官方文档站报 `Socket is closed`：先按本机取数路径排查（代理、TLS、网关都可能是来源），不要据此断言站点下线。Claude Code 的文档有两条实测替代路：context7 的 `/websites/code_claude`、镜像仓 `pleaseai/claude-code-docs`。

## 两条已经死掉的路（别再写进方案）

- `r.jina.ai`：2026-09-17 起全线 401，按出口 IP 的网络信誉拒。它同一天上午还能用，下午连 `example.com` 都拒——匿名额度按出口 IP 给，验证通过一次不等于它是条能依赖的路。
- 裸 `curl` 打搜索引擎：bing 回 200，但是 96KB 的裸 HTML；DuckDuckGo 的 HTML 版回 202 反爬。用 `ddgs`，别自己解析结果页。

## 口诀

记的是「目标 + 取数方式」这一对，不是主机本身：一条路失败 ≠ 目标不可用，换条路比断言「站挂了」便宜。反过来也成立：一条路**成功一次**也不等于它可依赖（见上面的 `r.jina.ai`）。
