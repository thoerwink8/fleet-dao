## 场景

发版车在 `.github/workflows/release.yml` 里的超时太短，偶尔发到一半被掐。需要在代码里把等待时间做成可配。

## 原话

「发版别被超时掐掉」

## 已知的模块

- `packages/conventions/src/release-wait.ts`

## 怎么算做完

1. `releaseWaitMs` 默认 30 分钟，可以用环境变量改。
2. 有一条测试覆盖环境变量覆盖默认值。
