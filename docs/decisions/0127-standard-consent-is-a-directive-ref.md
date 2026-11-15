# 0127 改标准 PR 的同意凭据改成引用引导，不再贴原话

- 索引状态：生效
- 日期：2026-11-16（北京时间）
- 谁拍的：交互会话按决定 0097 第 2 条自己拍（改标准），依据是创始人授权指挥官拍板的那条引导（20261015054500，挂单 #2361）。单 #3990。
- 状态：采纳。
- 部分取代：0097 第 4 条里「贴他这次说的原话；没有就贴他授权指挥官拍板的那句」；0093 里合并闸要正文有「创始人原话」那一行的写法。两份其余条文不动。
- 关联：0123（原话不进公开仓、单、PR）。

## 为什么

决定 0123 起创始人原话只进驾驶舱库，不进公开仓、单、PR。合并闸却仍要改标准 PR 的正文有一行 `**创始人原话**：「…」（时间）`。PR #3989 被拦下，只好把转述当成原话贴进去过闸：要么违反 0123，要么凭据名不副实。

## 决定

1. 改标准 PR 的同意凭据改成一行引用：`**改标准凭据**：引导 <编号>（<时间>），挂单 #<单号>`。原话不进正文。现在认的就一条：决定 0097 的授权，引导 20261015054500（2026-10-15 05:45 +0800），挂单 #2361。认法只有 `packages/conventions/src/pr-columns.ts` 的 `founderConsent` 一处，开 PR 的 `--founder-approved` 和合并闸共用。
2. 合并闸只看正文里这一行和 `STANDARD_CONSENT` 是否一字不差，不去账本核对。引导编号、时间、挂的单对不上、写在注释里、沿用旧的「创始人原话」都不算凭据，判红并点名碰了哪些路径。不放宽成不要凭据。
3. `pnpm pr:open --founder-quote`、`--at` 删掉，换成 `--founder-consent`（不带原话参数）：它写「人闸：改标准」和凭据那一行，并挂自动合并。
4. 引擎开的 PR 照旧没有这行凭据，碰了改标准路径合不进；拉单、派单碰到改标准路径的单仍留给本机。

## 同一个 PR 改的

`packages/conventions/src/{pr-columns,merge-gate,pr-open,pr-compose,work-run}.ts` 和对应测试、`packages/conventions/standard-paths.json`、`packages/engine/src/jobs/{intake,dispatch-issue,auto-merge-check}.ts`、`.github/{workflows/merge-gate.yml,pull_request_template.md}`、`docs/{workflow,design,ops}.md`、`agents/skills/commander/SKILL.md`、`agents/test/wait.test.ts`、0097 头部。
