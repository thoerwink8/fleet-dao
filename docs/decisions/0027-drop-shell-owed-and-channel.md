# 0027 删掉收尾空壳和欠账账本，失败不再换渠道，通用段再砍短（创始人 2026-10-06 19:15 选定）

- 日期：2026-10-06（北京时间 19:15）
- 谁拍的：创始人。原话「都按照你推荐」，选定上一轮给出的四条。
- 状态：已采纳
- 关联：0026 的「收尾不拦、无人值守走脱离会话的工人」仍然有效。0026 落地时留下的空壳函数和欠账账本，由这一份删掉。

## 原话

```
都按照你推荐
```

上一轮四条推荐，这一句全选定：

1. 删掉没人调用的空壳 `decideStop`、`armForBackground`、`startsBackground`，以及钉住它们的 `agents/test/rules/inflight.rules.test.ts`。
2. 删掉欠账账本（`.owed.json`）。原话已经在 prompt-log 里，开会话对账从 prompt-log 来。
3. 失败分类重试用完就停下，不再换成同一个模型的下一个渠道（#1118 的 `channelFallback`）。分类自己抛错时的 `fallback()` 梯子留下。已经记下的换路历史仍能重放。
4. 通用段再砍短。问法、开单参数、截图口径这些细则不留在每次会话都读的那段里。

## 决定

1. **空壳函数和钉它们的测试删掉。** 生产路径上已经没有调用。
2. **不再写、不再读、不再清 `.owed.json`。** 机器开场白的判断（`isMachineOpening`、`isMachineSession`）留下，prompt-log 和开会话对账还用。
3. **任务失败：分类给出停下就停下并告警。** 一条路由病了仍走熔断。分类函数自己抛错时，仍按原来的梯子（重试、换路由、换模型、停下）。工作流里已经记下的 `swapRoute` / `failChannel` 还能重放，库表和「带着 failedChannel 选路」不删。
4. **通用段只留模型自己猜不到的事。** 字数上限从 2300 压到 2000。被测试钉住的句子不拆。

## 落地

| 决定 | 落地 | 状态 |
|---|---|---|
| 1 空壳 | `agents/hooks/unattended.mjs`；删 `agents/test/rules/inflight.rules.test.ts` | 本 PR（改标准） |
| 2 欠账 | `prompt-log.mjs`、`pretool.mjs`、`stop.mjs`、`unattended.mjs`；`agents/test/rules/stop.rules.test.ts` | 本 PR（改标准） |
| 3 不再换渠道 | `packages/engine` 的失败分类；设计第十二节补一句 | 另 PR |
| 4 通用段 | `agents/shared-rules.md`；字数上限 `agents/test/agents-md-budget.test.ts`（改这个数字不算改标准） | 本 PR（改标准） |
