## 场景

适配层读 Claude 会话输出时，遇到空行会报错。

## 原话

「空行跳过就行」

## 已知的模块

- `packages/adapters/src/claude-code/stream.ts`

## 怎么算做完

1. 空行被跳过，不再报错。
2. CI 绿。
