## 场景

共享包里的日期工具 `startOfWeek` 对周日的处理不对，周日被算进了下一周。

## 原话

「周日应该算上一周的最后一天」

## 已知的模块

- `packages/shared/src/dates.ts`
- `packages/shared/test/dates.test.ts`
- `packages/shared/src/index.ts`

## 怎么算做完

1. `startOfWeek` 对周日返回的是那一周周一的日期，测试里有一条周日的用例。
2. 其他星期几的结果不变，已有用例照样过。
