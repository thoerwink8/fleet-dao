# fleet-dao 协作约定

<!-- repo-contract:skip progress 创始人引导一条一个文件记在 docs/directives/（pnpm progress directive），docs/PROGRESS.md 不放那一节 -->

只当目录，细则按需读。通用规矩在 `agents/shared-rules.md`。

本仓是创始人的 AI 研发流水线：法国引擎派各家 CLI 写码、合并、发版，驾驶舱给人看。只为四类事停下问创始人：对外发布、花钱、删数据、改标准。

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

## 常用

- `pnpm install`
- `npx vitest run <文件>`
- `pnpm check`
- `pnpm pr:open`
- `pnpm progress read`
