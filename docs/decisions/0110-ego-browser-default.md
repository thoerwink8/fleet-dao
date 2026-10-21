# 0110 本机装了 ego lite 就默认用它操作浏览器（部分取代 0086、0087）

- 索引状态：生效
- 日期：2026-10-22（北京时间）
- 谁拍的：创始人 2026-10-22 01:16 在对话里说的（原话见下）。改标准，按决定 0097 自己落、事后报。单 #3516，引导 20261022011600。
- 状态：采纳。
- 关联：`agents/shared-rules.md`「机器」、`agents/subagents/general-purpose.md`（第 5 条界面活）。ego lite 自带的技能装在 `~/.claude/skills/ego-browser/`，不归 `agents-sync` 管。
- 取代：0086 第 4 条里「点页面用 `playwright-cli`」（装了 ego lite 的机器改用 `ego-browser`，`chrome-devtools` 那半句不动）；0087 第 1 条工人「用 `playwright-cli` 真点页面」（改成先 `ego-browser`、没有再 `playwright-cli`）。

## 原话

```
我已经装了ego lite，以后默认都使用它开space怎么做
```

```
前提是本机要有ego lite
```

## 定了什么

1. 看哪台机器上有没有 `ego-browser` 命令：有，AI 操作浏览器（看网页、点页面、截图、界面点验）一律用它开 task space，照它自带的 `ego-browser` 技能（先跑 `ego-browser skill` 拿对得上版本的用法）；不用桌面版自带的浏览器窗格、Claude in Chrome、`playwright-cli`，创始人点名才换。
2. 没装 ego lite 的机器（法国、WSL、别的电脑）照旧，工人点页面退回 `playwright-cli`。
3. 仓里写好的 e2e 测试（Playwright 测试台）不改，照旧在本机和 CI 跑仓里的。
4. 写进通用段（每台机器同一句，靠「装没装」分开）和工人定义（工人定义 `omitClaudeMd: true`，看不到通用段，要单写一遍）。

## 依据

- ego lite 是给人和 AI 共用的 Chromium，AI 能用创始人已登录的网站、和他在同一个浏览器里交接（`ego-browser skill` 输出的用法，版本 2.1.0，2026-10-22 在本机读的）。
- 本机 `ego-browser` 0.6.0.16（chromium 154.0.8037.44、node v24.21.0），装在 `~/.local/share/ego/`。

## 没做的

- 桌面版自带的浏览器工具开关在创始人手里（设置 → Claude Code → Browser），AI 改不了，没关；规矩已经说了不用它。
