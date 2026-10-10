## 场景

以前有人排查这类问题是靠 grep 日志找关键字，很慢。现在想让日志摘要函数直接把失败的那几行挑出来。

## 原话

「别让我再去 grep 了，直接给我失败那几行」

## 已知的模块

- `packages/conventions/src/log-digest.ts`
- `packages/conventions/test/log-digest.test.ts`

## 怎么算做完

1. `digestLog` 对含 `FAIL` 的行原样返回，其余行丢掉。
2. 新增的测试在 diff 里可见，覆盖「没有失败行」返回空数组。
