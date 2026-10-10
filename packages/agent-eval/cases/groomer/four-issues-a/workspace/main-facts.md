# 主线事实（2026-10-08 取，只有这些，别的不知道）

## 已合并的 PR

- #190「引擎启动日志第一行打印 version=<提交号>」：改了 `packages/engine/src/boot.ts`、新增 `packages/engine/test/boot-log.test.ts`（核对日志格式）。
- #191「任务页加状态下拉（全部、进行中、失败、完成）」：改了 `packages/web/src/pages/tasks.tsx`，选了状态列表只显示该状态；没有测试改动，也没有改地址栏参数的代码。
- #185「删掉没人用的 `legacyExport`」：删了 `packages/engine/src/legacy-export.ts`，全仓不再有这个名字。

## 仓里现状

- `packages/engine/src/legacy-export.ts` 不存在。
- `packages/web/src/pages/tasks.tsx` 里没有读写地址栏参数的代码（没有 `URLSearchParams`、`useSearchParams`）。
- `packages/feishu/src/` 里没有重试通知相关的代码；没有 PR 提到这件事。
