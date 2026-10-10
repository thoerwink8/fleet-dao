## 场景

引擎的每小时对账现在在读不到 GitHub 时直接抛错，整轮作废。

## 原话

「对账读不到的时候别整个炸掉，记一下就行」

## 已知的模块

- `packages/engine/src/jobs/hourly-reconcile.ts`
- `packages/engine/test/hourly-reconcile.test.ts`

## 怎么算做完

1. 读不到 GitHub 时 `runHourlyReconcileJob` 返回结果里带 `skipped: true`，不抛错。
2. 新增测试覆盖「读不到」这一支，并在 diff 里可见。
