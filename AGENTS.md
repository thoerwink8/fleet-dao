# fleet-dao 协作约定

<!-- repo-kind: 自用仓 -->

只当目录，细则按需读。通用规矩在 `agents/shared-rules.md`。

本仓是创始人的 AI 研发流水线：法国引擎派各家 CLI 写码、合并、发版，驾驶舱给人看。交互会话只为两件事停下问创始人：要掏新钱、要删找不回又没备份的（细则见 `agents/shared-rules.md`）；对外发布、改标准自己拍、事后报。法国引擎自动派的模型另受引擎护栏管（合并闸、冷验收、改标准路径）。

## 去哪找

| 事 | 读 |
|---|---|
| 进度、单、PR、改标准、发版 | `docs/workflow.md` |
| 引擎 | `packages/engine/AGENTS.md` |
| 驾驶舱后端 | `packages/api/AGENTS.md` |
| 驾驶舱前端 | `packages/web/AGENTS.md` |
| 表结构 | `packages/db/AGENTS.md` |
| Store | `packages/store/AGENTS.md` |
| 检查、pnpm 脚本 | `packages/conventions/AGENTS.md` |
| 为什么 | `docs/design.md` |
| 运维 | `docs/ops.md` |
| 决定 | `docs/decisions/README.md` |
| 创始人引导 | `docs/directives/README.md` |
| 封号清痕迹 | `docs/reclaude.md` |
| 全部命令 | `README.md` |

## 遇到什么就做什么

| 时机 | 做什么 |
|---|---|
| 创始人提了新要求 | 先分拣（照做／讨论稿／记成规矩），首行回执 |
| 要动代码 | 先有单：`pnpm issue:new` 或 `pnpm work claim <号>` |
| 以后要做的 | `pnpm issue:new` 开单进未排期，不在文档另记 |
| 要拍板、根因不清 | `pnpm discuss:new -- <短名> --issue <单号> --ask "…"` |
| 长期拍板 | 写进 `docs/decisions/`，跑 `pnpm decisions:index` |
| 一时变通 | 进 `docs/PROGRESS.md` 的临时调整表 |
| 开 PR | `pnpm pr:open` |
| 没有 PR 的收尾 | `pnpm issue:close <号> --note "…"`，再 `pnpm work done <号>` |
| 推之前 | `npx vitest run <改到的文件>`，再 `pnpm check` |
