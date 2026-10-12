# 0086 本机工具基准：浏览器走官方命令行，CodeGraph 留着

- 日期：2026-10-12（北京时间 19:46）
- 谁拍的：创始人「按照你的推荐走」，选的是上一问的第 1 条。不是改标准。
- 状态：本机已装。清单只在这份决定里。不同步到别的仓，`pnpm agents:sync` 不装这些。
- 关联：本机 `~/.claude.json`、`D:\Tools\mcp`、`D:\Tools\node`、`D:\Tools\python312`。
- 不改：决定 0025（读代码先用 CodeGraph）、规格 #380（同步脚本不给没配过的机器新增 MCP）。子代理说明里的浏览器 MCP 名字这次不动，改那两份是改标准，会装到每台机器。

## 原话

```
2026-10-12 19:46，创始人在对话里

按照你的推荐走
```

「推荐」是上一问的第 1 条：基准写进 fleet-dao，只服务这台机器；CodeGraph 留着并升到 1.6.2；浏览器改成官方命令行，两套浏览器 MCP 不再每次会话都加载；`ddgs` 继续查网站；不同步到别的仓。

## 决定

1. 基准只记在本仓这份决定里，只服务这一台电脑。不写进 `packages/agents-sync`，不推到别的仓。
2. 查网站用 `ddgs` 9.16.0，装在 `D:\Tools\python312`。命令是 `ddgs text -q "关键词"`，抽正文是 `ddgs extract <网址>`。
3. 读代码继续用 CodeGraph 的 MCP。本机包装到 1.6.2，目录是 `D:\Tools\mcp`。用户级登记留着。
4. 点页面、看控制台用官方命令行，不再每次会话加载 Playwright MCP 和 Chrome DevTools MCP。
   - `@playwright/cli` 0.1.22，命令 `playwright-cli`。
   - `chrome-devtools-mcp` 1.10.1 自带的命令 `chrome-devtools`。官方把这个命令行标成实验性的。
5. 本机 `~/.claude.json` 的 `mcpServers` 去掉 `playwright` 和 `chrome-devtools`。`context7`、`memory`、`codegraph` 留着。

## 依据

2026-10-12 抓的原文：编程代理用命令行，MCP 留给要一直握着同一个浏览器的长流程。

- https://github.com/microsoft/playwright-mcp/blob/main/README.md
- https://github.com/microsoft/playwright-cli/blob/main/README.md
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/README.md
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md
- https://github.com/colbymchenry/codegraph
- https://colbymchenry.github.io/codegraph/reference/mcp-server/

同一天在本机量过：三件服务直接拉起都在 1 秒内给出工具清单。CodeGraph 经 quiet-node 查询有结果。这个窗口里 Playwright 和 memory 的客户端等了 70 秒，服务本身是通的。npm 上 Chrome DevTools MCP 最新是 1.10.1，Playwright MCP 最新是 0.0.83，CodeGraph 最新是 1.6.2。

## 没做的

- `agents/subagents/fleet-ui-builder.md` 和 `fleet-ui-verifier.md` 仍写着 `mcp__playwright`、`mcp__chrome-devtools`。本机卸掉这两条之后，那两个子代理在这台点页面要改用上面的命令行。
- 没跑 `pnpm agents:sync`。订阅加载器要等那次同步才在这台登记。
