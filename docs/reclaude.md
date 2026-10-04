# reclaude

reclaude 的文档、清理脚本、给另一台机器的提示词，都从这一页进。细则仍在原来的文件里，这里只留入口和被封时要做的那几步。

## 提示词

另一台机器上贴这一句，把编号换成被封的那个（`reclaude org list` 第一列的数字）：

```text
324 账号被封了，根据文档清理痕迹
```

听到「〈编号〉账号被封了，根据文档清理痕迹」就只做下面这一节，不要另写一套，也不要因为这个号是拼车或独享就去清别的号。

## 被封的号

在 fleet-dao 仓根目录做。编号从原话里取。原话里没有数字编号，或 `org list` 里没有这个编号：只列出编号和 `team` / `personal`，不打邮箱、不打名字，问是哪一个。不要猜。

1. `node deploy/reclaude-old-account-clean.mjs --org <编号>`
2. 看输出：没有 `@`。`sessions=scrubbed` 才进入下一步。`sessions=none-found` 就是已经没有了，停。退出码 2 或 `sessions=not-scanned` 是没查成，一个字节都不要写。
3. `node deploy/reclaude-old-account-clean.mjs --org <编号> --apply`
4. 再跑第 1 步。必须是 `sessions=none-found`、退出码 0。

不改 `~/.reclaude/device.json`、凭据、`daemon.log`。不带 `--org` 的那次是清「reclaude 使用前的旧登录」，不是这一句要做的事。细则在 [reclaude-self-check.md](reclaude-self-check.md) 第 1.1 节。

## 东西在哪

| 什么 | 路径 |
|---|---|
| 这一页（入口和提示词） | `docs/reclaude.md` |
| 被封号怎么摘、上机前自检 | [docs/reclaude-self-check.md](reclaude-self-check.md) |
| 接到 Mirasim、换机怎么装 | [docs/reclaude-in-mirasim.md](reclaude-in-mirasim.md) |
| 清理脚本 | `deploy/reclaude-old-account-clean.mjs` |
| 脚本的测试 | `deploy/test/reclaude-old-account-clean.test.mjs` |
| 桌面启动器代码 | `packages/mirasim-reclaude`（装机用，不清账号） |
