---
name: docs-lookup
description: 要上网查资料时读：搜索、查库或框架文档、看 GitHub 内容、抓已知网页，或内置搜索、抓取卡住想换路时；用户说「查一下」「搜一下」也读。
---

# `docs-lookup`：查资料选路

## 按目标选路

- 搜索：用内置 WebSearch。
- 库、框架文档：走 context7，不要搜。
- GitHub 上的内容（私有仓、原始文件、issue、PR）：`gh search`、`gh api`，不用网页抓取。
- 抓一个已知网页：WebFetch；不行就 `curl -L` 拿原文自己读。WebFetch 给的是小模型读完页面后的回答，不是原文，要原文用 `curl -L`。

卡住了换路：搜库文档卡住换 context7，搜 GitHub 卡住换 `gh search`、`gh api`。官方文档站报 `Socket is closed`：先查本机取数路径（代理、TLS、网关），不要据此断言站点下线；Claude Code 的文档另有 context7 的 `/websites/code_claude`、镜像仓 `pleaseai/claude-code-docs`。

## 已经死掉的路（别再写进方案）

- `ddgs`：2026-10-13 实测不可用，默认 auto 11.7 秒超时，`-b brave` 假空（退出码 0、没有结果）。
- `r.jina.ai`：2026-09-17 起全线 401，按出口 IP 的网络信誉拒。
- 裸 `curl` 打搜索引擎：bing 回 96KB 裸 HTML，DuckDuckGo 的 HTML 版回 202 反爬。

## 口诀

记的是「目标 + 取数方式」这一对，不是主机本身：一条路失败 ≠ 目标不可用，换条路比断言「站挂了」便宜；一条路成功一次也不等于它可依赖。
