# 主线事实（2026-10-08 取，只有这些，别的不知道）

## 决定记录

- 决定 0003：Fusion 已被替代，不按 Fusion 开新活；调度器代码已整个删除。

## 已合并的 PR

- #150「hygiene 规则加 `*.pem`、`*.key`、`*.p12`」：改了 `packages/hygiene/src/rules.ts`，新增 `packages/hygiene/test/secret-files.test.ts`，覆盖这三类文件名。
- #160「冷验收一节写进 design.md」：`docs/design.md` 新增「十二、冷验收」，写了谁触发、看什么、红了怎么办。
- #161「术语表补冷验收」：`docs/glossary.md` 新增「冷验收」一条。

## 未合并的 PR

- #170「发版车结束后恢复接活开关」：草稿状态（draft），CI 红，没合并；恢复不成功报警的部分还没写。

## 仓里现状

- 仓里没有 Fusion 调度器的任何代码，`FUSION_MAX_CONCURRENT` 全仓搜不到。
